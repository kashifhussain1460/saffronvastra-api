// Applies the reviewed SEO copy in docs/seo/content-drafts/{products,categories}.json to the catalogue.
//
//   node scripts/seo-content/apply-seo-content.cjs                 dry run: prints what would change, writes nothing
//   node scripts/seo-content/apply-seo-content.cjs --apply         backs up the current values, then writes
//   node scripts/seo-content/apply-seo-content.cjs --restore FILE  puts back the values from a backup file
//   add --meta-only to change only the product meta title and description (seoTitle, seoDescription) from
//   docs/seo/content-drafts/meta.json; nothing else (product names, descriptions, categories) is touched
//
// Run from D:\saff\backend. It uses the database in backend/.env — which is the PRODUCTION database.
// Only these fields are touched: product title, seoTitle, seoDescription, shortDescription, description,
// careInstructions; category shortDescription, detailedDescription; and (full mode) the product photos' alt text.
// Slugs (URLs) never change.
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

const ROOT = path.resolve(__dirname, "../../..");
const DRAFTS = path.join(ROOT, "docs/seo/content-drafts");
const BACKUPS = path.join(ROOT, "backups");
const args = process.argv.slice(2);
const metaOnly = args.includes("--meta-only");
const PRODUCT_FIELDS = metaOnly
  ? ["seoTitle", "seoDescription"]
  : ["title", "seoTitle", "seoDescription", "shortDescription", "description", "careInstructions"];
const CATEGORY_FIELDS = metaOnly ? [] : ["shortDescription", "detailedDescription"];
const PRODUCTS_FILE = metaOnly ? "meta.json" : "products.json";
const apply = args.includes("--apply");
const restoreIdx = args.indexOf("--restore");
const restoreFile = restoreIdx >= 0 ? args[restoreIdx + 1] : null;

const pick = (row, fields) => Object.fromEntries(fields.filter((f) => row[f] !== undefined).map((f) => [f, row[f]]));

async function main() {
  const prisma = new PrismaClient();
  try {
    if (restoreFile) {
      const backup = JSON.parse(fs.readFileSync(restoreFile, "utf8"));
      for (const p of backup.products) await prisma.product.update({ where: { slug: p.slug }, data: pick(p, PRODUCT_FIELDS) });
      for (const c of backup.categories) await prisma.category.update({ where: { slug: c.slug }, data: pick(c, CATEGORY_FIELDS) });
      for (const img of backup.images || []) await prisma.productImage.update({ where: { id: img.id }, data: { altText: img.altText } });
      console.log(`Restored ${backup.products.length} products, ${backup.categories.length} categories and ${(backup.images || []).length} image alt texts from ${restoreFile}`);
      return;
    }

    const products = JSON.parse(fs.readFileSync(path.join(DRAFTS, PRODUCTS_FILE), "utf8"));
    const categories = metaOnly ? [] : JSON.parse(fs.readFileSync(path.join(DRAFTS, "categories.json"), "utf8"));
    const categoryRows = Array.isArray(categories) ? categories : Object.entries(categories).map(([slug, v]) => ({ slug, ...v }));

    const currentProducts = await prisma.product.findMany({
      where: { slug: { in: products.map((p) => p.slug) } },
      select: { slug: true, ...Object.fromEntries(PRODUCT_FIELDS.map((f) => [f, true])) },
    });
    const currentCategories = await prisma.category.findMany({
      where: { slug: { in: categoryRows.map((c) => c.slug) } },
      select: { slug: true, ...Object.fromEntries(CATEGORY_FIELDS.map((f) => [f, true])) },
    });

    const missing = [
      ...products.filter((p) => !currentProducts.some((c) => c.slug === p.slug)).map((p) => `product ${p.slug}`),
      ...categoryRows.filter((r) => !currentCategories.some((c) => c.slug === r.slug)).map((r) => `category ${r.slug}`),
    ];
    if (missing.length) console.warn(`Not found (skipped):\n  ${missing.join("\n  ")}`);

    // Full mode also renames the photos' alt text after the new product name: the first photo gets the name, the others
    // "<name> – view N" (the stored alt text is the old Etsy title).
    const altPlan = [];
    if (!metaOnly) {
      const images = await prisma.productImage.findMany({
        where: { product: { slug: { in: products.map((p) => p.slug) } } },
        select: { id: true, altText: true, sortOrder: true, isCover: true, product: { select: { slug: true } } },
        orderBy: [{ sortOrder: "asc" }],
      });
      for (const draft of products) {
        if (!draft.title) continue;
        const own = images.filter((i) => i.product.slug === draft.slug).sort((a, b) => Number(b.isCover) - Number(a.isCover) || a.sortOrder - b.sortOrder);
        own.forEach((img, i) => {
          const altText = (i === 0 ? draft.title : `${draft.title} – view ${i + 1}`).slice(0, 200);
          if (altText !== img.altText) altPlan.push({ id: img.id, before: img.altText, altText });
        });
      }
      console.log(`Image alt texts that would change: ${altPlan.length}`);
    }

    let changes = 0;
    for (const draft of products) {
      const cur = currentProducts.find((c) => c.slug === draft.slug);
      if (!cur) continue;
      const diff = PRODUCT_FIELDS.filter((f) => draft[f] !== undefined && draft[f] !== cur[f]);
      if (diff.length) changes++;
      console.log(`${diff.length ? "UPDATE" : "same  "} product ${draft.slug}: ${diff.join(", ") || "-"}`);
    }
    for (const draft of categoryRows) {
      const cur = currentCategories.find((c) => c.slug === draft.slug);
      if (!cur) continue;
      const diff = CATEGORY_FIELDS.filter((f) => draft[f] !== undefined && draft[f] !== cur[f]);
      if (diff.length) changes++;
      console.log(`${diff.length ? "UPDATE" : "same  "} category ${draft.slug}: ${diff.join(", ") || "-"}`);
    }
    console.log(`\n${changes} record(s) would change.`);
    if (!apply) {
      console.log("Dry run: nothing written. Add --apply to write (a backup is taken first).");
      return;
    }

    fs.mkdirSync(BACKUPS, { recursive: true });
    const backupFile = path.join(BACKUPS, `seo-${metaOnly ? "meta" : "content"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(
      backupFile,
      JSON.stringify({ products: currentProducts, categories: currentCategories, images: altPlan.map((a) => ({ id: a.id, altText: a.before })) }, null, 2)
    );
    console.log(`Backup written: ${backupFile}`);

    for (const draft of products) {
      if (!currentProducts.some((c) => c.slug === draft.slug)) continue;
      await prisma.product.update({ where: { slug: draft.slug }, data: pick(draft, PRODUCT_FIELDS) });
    }
    for (const draft of categoryRows) {
      if (!currentCategories.some((c) => c.slug === draft.slug)) continue;
      await prisma.category.update({ where: { slug: draft.slug }, data: pick(draft, CATEGORY_FIELDS) });
    }
    for (const a of altPlan) await prisma.productImage.update({ where: { id: a.id }, data: { altText: a.altText } });
    console.log(`Applied. To undo: node scripts/seo-content/apply-seo-content.cjs --restore "${backupFile}"`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
