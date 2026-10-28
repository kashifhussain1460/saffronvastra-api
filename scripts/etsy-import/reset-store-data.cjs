// Wipes all test/mock store data and keeps the admin account(s), roles and store settings.
//   node scripts/etsy-import/reset-store-data.cjs          -> dry run (counts only)
//   node scripts/etsy-import/reset-store-data.cjs apply    -> backup to D:\saff\backups\pre-reset-<time>, then delete
// Run from D:\saff\backend with the servers stopped.
const fs = require("fs");
const path = require("path");
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient();

// Everything here is emptied (TRUNCATE ... CASCADE also clears the rows that hang off them).
const WIPE = [
  "Order", "Cart", "Wishlist", "Review", "Notification", "Product", "Category", "Collection", "MediaAsset", "Coupon", "Article",
  "NewsletterSubscriber", "NewsletterCampaign", "ContactMessage", "EmailMessage", "GuestProfile", "TrackingSession", "ActivityEvent",
  "SessionSummary", "AdminAuditLog", "WebhookEvent", "OutboxEvent", "IdempotencyKey", "PasswordResetToken", "EmailVerificationToken",
];
const jsonSafe = (_k, v) => (typeof v === "bigint" ? v.toString() : v);

(async () => {
  const apply = process.argv[2] === "apply";
  const models = Prisma.dmmf.datamodel.models;
  const table = (name) => models.find((m) => m.name === name).dbName || name;
  const delegate = (name) => prisma[name[0].toLowerCase() + name.slice(1)];

  const admins = await prisma.user.findMany({ where: { userRoles: { some: { role: { code: "ADMIN" } } } }, select: { id: true, email: true } });
  if (admins.length === 0) throw new Error("No admin account found; refusing to continue");
  const adminIds = admins.map((a) => a.id);
  const others = await prisma.user.count({ where: { id: { notIn: adminIds } } });

  const counts = {};
  for (const m of WIPE) counts[m] = await delegate(m).count();
  console.log("keeping admins:", admins.map((a) => a.email).join(", "), "| removing customer accounts:", others);
  console.log("rows to remove:", counts);
  if (!apply) return;

  // 1. backup (every model, JSON) and upload files
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join("D:/saff/backups", `pre-reset-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const m of models) {
    const rows = await delegate(m.name).findMany();
    fs.writeFileSync(path.join(dir, `${m.name}.json`), JSON.stringify(rows, jsonSafe));
  }
  const uploads = path.resolve("public/uploads");
  const moved = [];
  if (fs.existsSync(uploads)) {
    fs.mkdirSync(path.join(dir, "uploads"), { recursive: true });
    for (const f of fs.readdirSync(uploads)) {
      fs.renameSync(path.join(uploads, f), path.join(dir, "uploads", f));
      moved.push(f);
    }
  }
  console.log("backup written to", dir, "| upload files moved:", moved.length);

  // 2. delete
  const list = WIPE.map((m) => `"${table(m)}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  const removed = await prisma.user.deleteMany({ where: { id: { notIn: adminIds } } }); // profiles, addresses, sessions, roles cascade
  console.log("customer accounts removed:", removed.count);

  const after = {};
  for (const m of ["Product", "Order", "Category", "MediaAsset", "User", "StoreSetting", "Role"]) after[m] = await delegate(m).count();
  console.log("now:", after);
})().catch((e) => { console.error(String(e.message).split("\n").slice(-6).join("\n")); process.exit(1); }).finally(() => prisma.$disconnect());
