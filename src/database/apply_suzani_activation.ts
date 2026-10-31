import fs from "fs";
import path from "path";
import { prisma } from "./prisma.js";

export interface DryRunSummary {
  categoriesTotal: number;
  categoriesToActivate: string[];
  categoriesToDeactivate: string[];
  productsTotal: number;
  productsToSuzaniJackets: { id: string; slug: string; title: string }[];
  productsToSuzaniKimonos: { id: string; slug: string; title: string }[];
  ambiguousProducts: { id: string; slug: string; title: string; reason: string }[];
  unrelatedProducts: { id: string; slug: string; title: string; reason: string }[];
}

export async function exportBackup(): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = fs.existsSync(path.resolve("src/database"))
    ? path.resolve("src/database/backups")
    : path.resolve("backend/src/database/backups");
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const categories = await prisma.category.findMany({
    orderBy: { sortOrder: "asc" },
  });
  const products = await prisma.product.findMany({
    select: {
      id: true,
      slug: true,
      title: true,
      categoryId: true,
      status: true,
    },
    orderBy: { title: "asc" },
  });

  const backupData = {
    exportedAt: new Date().toISOString(),
    categoriesCount: categories.length,
    productsCount: products.length,
    categories,
    products,
  };

  const backupPath = path.join(backupDir, `backup_categories_and_products_${timestamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2), "utf8");
  console.log(`✓ Database state snapshot backed up to:\n  ${backupPath}\n`);
  return backupPath;
}

export async function analyzeProducts(): Promise<DryRunSummary> {
  const categories = await prisma.category.findMany({
    include: { parent: true },
    orderBy: { sortOrder: "asc" },
  });

  const products = await prisma.product.findMany({
    orderBy: { title: "asc" },
  });

  const categoriesToActivate = ["suzani-stitchwork", "suzani-jackets", "suzani-kimonos"];
  const categoriesToDeactivate = [
    "suzani-coats",
    "suzani-accessories",
    "kashmiri-kari",
    "kashmiri-jackets",
    "kashmiri-shawls",
    "kashmiri-kimonos",
    "kashmiri-coats",
    "chikankari",
    "chikankari-kurtas",
    "chikankari-jackets",
    "chikankari-shirts",
    "chikankari-dresses",
  ];

  const productsToSuzaniJackets: { id: string; slug: string; title: string }[] = [];
  const productsToSuzaniKimonos: { id: string; slug: string; title: string }[] = [];
  const ambiguousProducts: { id: string; slug: string; title: string; reason: string }[] = [];
  const unrelatedProducts: { id: string; slug: string; title: string; reason: string }[] = [];

  for (const p of products) {
    const titleLower = p.title.toLowerCase();
    const isKimono = /\bkimonos?\b/.test(titleLower);
    const isJacket = /\bjackets?\b/.test(titleLower);

    if (isKimono) {
      productsToSuzaniKimonos.push({ id: p.id, slug: p.slug, title: p.title });
    } else if (isJacket) {
      productsToSuzaniJackets.push({ id: p.id, slug: p.slug, title: p.title });
    } else {
      ambiguousProducts.push({
        id: p.id,
        slug: p.slug,
        title: p.title,
        reason: "Title does not contain 'jacket' or 'kimono'",
      });
    }
  }

  return {
    categoriesTotal: categories.length,
    categoriesToActivate,
    categoriesToDeactivate,
    productsTotal: products.length,
    productsToSuzaniJackets,
    productsToSuzaniKimonos,
    ambiguousProducts,
    unrelatedProducts,
  };
}

export async function executeActivation(apply = false) {
  console.log("===================================================================");
  console.log(apply ? "  APPLYING SUZANI ACTIVATION & PRODUCT ASSIGNMENTS (TRANSACTION)" : "  DRY-RUN: SUZANI ACTIVATION & PRODUCT ASSIGNMENTS");
  console.log("===================================================================\n");

  // Step 1: Export backup
  await exportBackup();

  // Step 2: Analyze
  const summary = await analyzeProducts();

  console.log("--- 1. CATEGORY STATUS PLAN ---");
  console.log(`Active Categories (${summary.categoriesToActivate.length}):`);
  summary.categoriesToActivate.forEach((slug) => console.log(`  [+] ${slug} -> Active`));
  console.log(`\nInactive Categories (${summary.categoriesToDeactivate.length}):`);
  summary.categoriesToDeactivate.forEach((slug) => console.log(`  [-] ${slug} -> Inactive`));

  console.log("\n--- 2. PRODUCT ASSIGNMENT PLAN ---");
  console.log(`Total Products Inspected:                 ${summary.productsTotal}`);
  console.log(`Products Assigned to 'Suzani Jackets':   ${summary.productsToSuzaniJackets.length}`);
  console.log(`Products Assigned to 'Suzani Kimonos':   ${summary.productsToSuzaniKimonos.length}`);
  console.log(`Ambiguous Products (Left Unchanged):      ${summary.ambiguousProducts.length}`);
  console.log(`Unrelated Products (Left Unchanged):      ${summary.unrelatedProducts.length}`);

  if (!apply) {
    console.log("\n[DRY RUN COMPLETE] Zero database records were modified.");
    console.log("Run with '--apply' flag to execute atomic transaction.\n");
    return;
  }

  // Step 3: Atomic Transaction
  const suzaniJacketsCat = await prisma.category.findUnique({ where: { slug: "suzani-jackets" } });
  const suzaniKimonosCat = await prisma.category.findUnique({ where: { slug: "suzani-kimonos" } });

  if (!suzaniJacketsCat || !suzaniKimonosCat) {
    throw new Error("Target categories 'suzani-jackets' or 'suzani-kimonos' not found in database!");
  }

  await prisma.$transaction(
    async (tx) => {
      // 1. Update Active Categories (Single batch update)
      const activeRes = await tx.category.updateMany({
        where: { slug: { in: summary.categoriesToActivate } },
        data: { status: "Active" },
      });
      console.log(`✓ Set status = Active for ${activeRes.count} categories (${summary.categoriesToActivate.join(", ")})`);

      // 2. Update Inactive Categories (Single batch update)
      const inactiveRes = await tx.category.updateMany({
        where: { slug: { in: summary.categoriesToDeactivate } },
        data: { status: "Inactive" },
      });
      console.log(`✓ Set status = Inactive for ${inactiveRes.count} categories`);

      // 3. Assign Suzani Jacket products
      const jacketIds = summary.productsToSuzaniJackets.map((p) => p.id);
      const jacketUpdate = await tx.product.updateMany({
        where: { id: { in: jacketIds } },
        data: { categoryId: suzaniJacketsCat.id },
      });
      console.log(`✓ Assigned ${jacketUpdate.count} products to Suzani Jackets (ID: ${suzaniJacketsCat.id})`);

      // 4. Assign Suzani Kimono products
      const kimonoIds = summary.productsToSuzaniKimonos.map((p) => p.id);
      const kimonoUpdate = await tx.product.updateMany({
        where: { id: { in: kimonoIds } },
        data: { categoryId: suzaniKimonosCat.id },
      });
      console.log(`✓ Assigned ${kimonoUpdate.count} products to Suzani Kimonos (ID: ${suzaniKimonosCat.id})`);
    },
    {
      maxWait: 20000, // 20 seconds to acquire connection from pool
      timeout: 60000, // 60 seconds execution timeout for remote cloud DB latency
    }
  );

  console.log("\n===================================================================");
  console.log("  TRANSACTION COMMITTED SUCCESSFULLY");
  console.log("===================================================================\n");

  // Step 4: Verification
  const verifyCats = await prisma.category.findMany({
    include: {
      parent: true,
      _count: { select: { products: true } },
    },
    orderBy: { sortOrder: "asc" },
  });

  console.log("--- FINAL DATABASE CATEGORY STATE ---");
  for (const c of verifyCats) {
    console.log(
      `${c.slug.padEnd(25)} | status: ${c.status.padEnd(9)} | productsCount: ${c._count.products}`
    );
  }

  const assignedProductsCount = await prisma.product.count({
    where: { categoryId: { not: null } },
  });
  console.log(`\nTotal products with categoryId: ${assignedProductsCount} / ${summary.productsTotal}`);
}

const isApply = process.argv.includes("--apply");
executeActivation(isApply)
  .catch((err) => {
    console.error("Execution failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

