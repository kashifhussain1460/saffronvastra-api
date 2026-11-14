// Fills Product.measurements from the standard Indian unisex size chart (src/modules/catalogue/measurements.ts), for
// the sizes each product is sold in. Long kimono jackets get the long-kimono chart, vests and waistcoats the vest chart (no sleeve), everything else the jacket chart.
//
//   node node_modules/tsx/dist/cli.mjs scripts/seo-content/seed-measurements.ts               dry run (writes nothing)
//   node node_modules/tsx/dist/cli.mjs scripts/seo-content/seed-measurements.ts --apply       backup, then write
//   … --overwrite   also replace measurements a product already has (by default those are kept)
//   … --restore <backup.json>   put back the values from a backup
//
// Run from D:\saff\backend. It uses the database in backend/.env, which is the PRODUCTION database.
import fs from "node:fs";
import path from "node:path";
import { PrismaClient, Prisma } from "@prisma/client";
import { standardMeasurementsFor } from "../../src/modules/catalogue/measurements.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const overwrite = args.includes("--overwrite");
const restoreIdx = args.indexOf("--restore");
const restoreFile = restoreIdx >= 0 ? args[restoreIdx + 1] : null;
const BACKUPS = path.resolve(process.cwd(), "../backups");

const kindOf = (p: { slug: string; title: string }) => {
  const text = `${p.slug} ${p.title}`.replace(/-/g, " ");
  if (/\b(vest|waistcoat|sleeveless)\b/i.test(text)) return "vest" as const;
  if (/\blong\s+kimono\b/i.test(text)) return "long-kimono" as const;
  return "jacket" as const;
};

async function main() {
  const prisma = new PrismaClient();
  try {
    if (restoreFile) {
      const backup = JSON.parse(fs.readFileSync(restoreFile, "utf8")) as { id: string; measurements: unknown }[];
      for (const row of backup) {
        await prisma.product.update({
          where: { id: row.id },
          data: { measurements: row.measurements === null ? Prisma.DbNull : (row.measurements as Prisma.InputJsonValue) },
        });
      }
      console.log(`Restored measurements of ${backup.length} products from ${restoreFile}`);
      return;
    }

    const products = await prisma.product.findMany({
      where: { deletedAt: null },
      select: { id: true, slug: true, title: true, measurements: true, variants: { where: { status: "Active" }, select: { size: true } } },
      orderBy: { createdAt: "asc" },
    });

    const plan = products.map((p) => {
      const sizes = [...new Set(p.variants.map((v) => v.size))];
      const kind = kindOf(p);
      const next = standardMeasurementsFor(kind, sizes);
      const skip = p.measurements !== null && !overwrite;
      return { p, kind, sizes, next, skip: skip || next.rows.length === 0 };
    });

    for (const { p, kind, sizes, next, skip } of plan) {
      console.log(`${skip ? "keep  " : "SET   "} ${p.slug.slice(0, 70).padEnd(70)} ${kind.padEnd(11)} sizes=${sizes.join(",")} rows=${next.rows.length}`);
    }
    const todo = plan.filter((x) => !x.skip);
    console.log(`\n${todo.length} of ${plan.length} products would get measurements (${plan.filter((x) => x.kind === "long-kimono").length} long kimono, ${plan.filter((x) => x.kind === "vest").length} vest).`);
    if (!apply) {
      console.log("Dry run: nothing written. Add --apply to write (a backup is taken first).");
      return;
    }

    fs.mkdirSync(BACKUPS, { recursive: true });
    const backupFile = path.join(BACKUPS, `measurements-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(todo.map(({ p }) => ({ id: p.id, slug: p.slug, measurements: p.measurements })), null, 2));
    console.log(`Backup written: ${backupFile}`);

    for (const { p, next } of todo) {
      await prisma.product.update({ where: { id: p.id }, data: { measurements: next as unknown as Prisma.InputJsonValue } });
    }
    console.log(`Applied to ${todo.length} products. To undo: node node_modules/tsx/dist/cli.mjs scripts/seo-content/seed-measurements.ts --restore "${backupFile}"`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
