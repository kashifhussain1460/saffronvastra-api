/**
 * Removes ALL data from the database named by APP_DATABASE_URL, except:
 *   - the administrator account(s) (users holding the ADMIN role) and their role links
 *   - the roles table and the migration history (_prisma_migrations)
 * Everything else (orders, customers, products, images records, emails, sessions, settings...) is deleted.
 * Settings are not needed afterwards: the app falls back to its built-in defaults.
 *
 *   node scripts/cleanup-live-data.cjs                       DRY RUN: shows what would be deleted, changes nothing
 *   node scripts/cleanup-live-data.cjs --apply --confirm=<database host shown by the dry run>
 *
 * Safety:
 *   - dry run by default; --apply also needs --confirm with the exact host name, so a wrong database is not wiped
 *   - refuses a database on this machine (localhost) unless --allow-local
 *   - refuses to run when no administrator exists (it would lock everyone out)
 *   - before deleting, every table is saved as JSON in D:/saff/backups/cleanup-<timestamp>/ (stop if that fails)
 *   - the deletes run in ONE transaction: any error rolls everything back
 *   - files in Blob storage are NOT touched (this script only changes the database)
 * Run it from the backend folder. Nothing secret is printed.
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const allowLocal = args.includes("--allow-local");
const confirm = (args.find((a) => a.startsWith("--confirm=")) || "").slice("--confirm=".length);
const KEEP_WHOLE = new Set(["_prisma_migrations", "roles"]);

const prisma = new PrismaClient({ log: ["error"] });
const q = (sql, ...params) => prisma.$queryRawUnsafe(sql, ...params);
const quote = (t) => `"${t.replace(/"/g, '""')}"`;

async function main() {
  const raw = process.env.APP_DATABASE_URL || "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("APP_DATABASE_URL is missing or not a valid address.");
  }
  const host = url.hostname;
  const dbName = url.pathname.slice(1);
  const isLocal = /^(localhost|127\.0\.0\.1|::1)$/.test(host);
  console.log(`Database: host=${host}  name=${dbName}  (${isLocal ? "THIS MACHINE" : "remote"})`);
  if (isLocal && !allowLocal) throw new Error("This is a local database. Refusing (use --allow-local to clean a local database on purpose).");

  const tables = (await q(`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1`)).map((r) => r.table_name);
  if (tables.length === 0) {
    console.log("The database has no tables. Nothing to clean.");
    return;
  }

  const admins = await q(`select u.id, u.email from users u join user_roles ur on ur."userId"=u.id join roles r on r.id=ur."roleId" where r.code='ADMIN' order by u."createdAt"`);
  console.log(`Administrators that will be KEPT: ${admins.length}`);
  for (const a of admins) console.log("  - " + a.email.replace(/^(.).*(@.*)$/, "$1***$2"));
  if (admins.length === 0) throw new Error("No administrator account exists. Refusing: after the cleanup nobody could sign in.");
  const adminIds = admins.map((a) => a.id);

  const counts = {};
  for (const t of tables) counts[t] = (await q(`select count(*)::int as n from ${quote(t)}`))[0].n;
  const willKeep = { users: adminIds.length, user_roles: (await q(`select count(*)::int as n from user_roles where "userId" = any($1::text[])`, adminIds))[0].n };
  console.log("\nTable                        rows now   rows after");
  let total = 0;
  for (const t of tables) {
    const after = KEEP_WHOLE.has(t) ? counts[t] : willKeep[t] ?? 0;
    if (counts[t] === 0 && after === 0) continue;
    total += counts[t] - after;
    console.log(`${t.padEnd(28)} ${String(counts[t]).padStart(8)}   ${String(after).padStart(9)}`);
  }
  console.log(`\nRows that would be deleted: ${total}`);

  if (!apply) {
    console.log(`\nDRY RUN: nothing was changed. To delete for real run:\n  node scripts/cleanup-live-data.cjs --apply --confirm=${host}`);
    return;
  }
  if (confirm !== host) throw new Error(`--confirm must be exactly the database host (${host}). Nothing was changed.`);

  // 1. Backup every table as JSON before touching anything.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.resolve("D:/saff/backups", `cleanup-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const t of tables) {
    if (counts[t] === 0) continue;
    const rows = await q(`select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) as data from ${quote(t)} x`);
    fs.writeFileSync(path.join(backupDir, `${t}.json`), JSON.stringify(rows[0].data));
  }
  console.log(`Backup written to ${backupDir}`);

  // 2. Delete children before parents (foreign keys), all in one transaction.
  const fks = await q(`
    select c.relname as child, p.relname as parent
    from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_class p on p.oid=k.confrelid
    join pg_namespace n on n.oid=c.relnamespace
    where k.contype='f' and n.nspname='public' and c.relname <> p.relname`);
  const parentsOf = new Map(tables.map((t) => [t, new Set()]));
  for (const { child, parent } of fks) if (parentsOf.has(child) && parentsOf.has(parent)) parentsOf.get(child).add(parent);
  // order: a table is deleted before the tables it references (its parents)
  const order = [];
  const remaining = new Set(tables.filter((t) => !KEEP_WHOLE.has(t)));
  while (remaining.size) {
    const ready = [...remaining].filter((t) => ![...remaining].some((other) => other !== t && parentsOf.get(other).has(t)));
    if (ready.length === 0) throw new Error("Foreign keys form a cycle; stopping without changes: " + [...remaining].join(", "));
    for (const t of ready) {
      order.push(t);
      remaining.delete(t);
    }
  }

  await prisma.$transaction(
    async (tx) => {
      for (const t of order) {
        if (t === "users") await tx.$executeRawUnsafe(`delete from users where not (id = any($1::text[]))`, adminIds);
        else if (t === "user_roles") await tx.$executeRawUnsafe(`delete from user_roles where not ("userId" = any($1::text[]))`, adminIds);
        else await tx.$executeRawUnsafe(`delete from ${quote(t)}`);
      }
      const left = await tx.$queryRawUnsafe(`select count(*)::int as n from users u join user_roles ur on ur."userId"=u.id join roles r on r.id=ur."roleId" where r.code='ADMIN'`);
      if (left[0].n < 1) throw new Error("The administrator would be lost; rolling everything back.");
    },
    { timeout: 120000, maxWait: 20000 }
  );

  console.log("\nDone. Rows left:");
  for (const t of tables) {
    const n = (await q(`select count(*)::int as n from ${quote(t)}`))[0].n;
    if (n > 0) console.log(`  ${t}: ${n}`);
  }
}

main()
  .catch((e) => {
    console.error("STOPPED:", String(e.message || e).replace(/postgres(ql)?:\/\/[^\s"']+/g, "<url>"));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
