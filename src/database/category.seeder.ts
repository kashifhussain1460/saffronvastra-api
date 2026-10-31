import { PrismaClient } from "@prisma/client";
import { prisma } from "./prisma.js";

export interface SubcategorySeedDef {
  name: string;
  slug: string;
  shortDescription: string;
  detailedDescription?: string;
  sortOrder: number;
  status?: string;
}

export interface MainCategorySeedDef {
  name: string;
  slug: string;
  shortDescription: string;
  detailedDescription?: string;
  sortOrder: number;
  status?: string;
  subcategories: SubcategorySeedDef[];
}

export const SAFFRON_VASTRA_CATEGORIES: MainCategorySeedDef[] = [
  {
    name: "Suzani Stitchwork",
    slug: "suzani-stitchwork",
    status: "Active",
    shortDescription: "Central Asian and Rajasthani heritage needlework featuring sunburst, medallion, and floral motifs.",
    detailedDescription: "Rooted in historical Silk Road trade and royal Jaipur ateliers, Suzani stitchwork combines bold decorative motifs with fine needlecraft on premium silk, velvet, and hand-loomed textiles.",
    sortOrder: 10,
    subcategories: [
      {
        name: "Suzani Jackets",
        slug: "suzani-jackets",
        status: "Active",
        shortDescription: "Artisanal cropped and structured jackets featuring intricate hand-embroidered Suzani patterns.",
        detailedDescription: "Tailored statement jackets accented with handcrafted floral medallions and contrast stitching for discerning contemporary wardrobes.",
        sortOrder: 1,
      },
      {
        name: "Suzani Coats",
        slug: "suzani-coats",
        status: "Inactive",
        shortDescription: "Longline luxury coats adorned with full-panel Suzani needlework and premium quilted linings.",
        detailedDescription: "Regal evening and winter coats showcasing extensive heritage embroidery across flowing outerwear silhouettes.",
        sortOrder: 2,
      },
      {
        name: "Suzani Kimonos",
        slug: "suzani-kimonos",
        status: "Active",
        shortDescription: "Flowing artisanal wrap kimonos featuring ornate Suzani borders and effortless drape.",
        detailedDescription: "Fluid robe-inspired silhouettes merging traditional Central Asian motifs with modern drape and luxury evening wear appeal.",
        sortOrder: 3,
      },
      {
        name: "Suzani Accessories",
        slug: "suzani-accessories",
        status: "Inactive",
        shortDescription: "Handcrafted clutches, belts, and artisanal textiles bearing authentic Suzani embroidery.",
        detailedDescription: "Curated heirloom accessories designed to complement bespoke ensembles with authentic handcrafted threadwork.",
        sortOrder: 4,
      },
    ],
  },
  {
    name: "Kashmiri Kari",
    slug: "kashmiri-kari",
    status: "Inactive",
    shortDescription: "Masterful Kashmiri needlecraft featuring intricate Aari, Sozni, and Paisley botanical flora.",
    detailedDescription: "Centuries of Himalayan artisan mastery expressed through needlepoint Sozni and Aari embroidery, creating lightweight yet richly ornamented heirloom garments.",
    sortOrder: 20,
    subcategories: [
      {
        name: "Kashmiri Jackets",
        slug: "kashmiri-jackets",
        status: "Inactive",
        shortDescription: "Tailored jackets adorned with dense Kashmiri Aari needlework and traditional Chinar motifs.",
        detailedDescription: "Structured silhouettes layered with fine woolen and silk threadwork inspired by the verdant valleys of Kashmir.",
        sortOrder: 1,
      },
      {
        name: "Kashmiri Shawls",
        slug: "kashmiri-shawls",
        status: "Inactive",
        shortDescription: "Featherweight luxury pashmina and wool shawls hand-embroidered with classic Kashmiri craftsmanship.",
        detailedDescription: "Exquisite heirloom wraps displaying needle-embroidered paisley patterns, delicate jamawar weaves, and hand-finished borders.",
        sortOrder: 2,
      },
      {
        name: "Kashmiri Kimonos",
        slug: "kashmiri-kimonos",
        status: "Inactive",
        shortDescription: "Graceful open-front kimonos embellished with intricate Kashmiri floral embroidery.",
        detailedDescription: "Modern fusion robes combining relaxed silhouettes with opulent Himalayan threadwork along lapels and hems.",
        sortOrder: 3,
      },
      {
        name: "Kashmiri Coats",
        slug: "kashmiri-coats",
        status: "Inactive",
        shortDescription: "Heavy woolen and velvet coats tailored with ornate Kashmiri embroidery across cuffs and yokes.",
        detailedDescription: "Warm, sophisticated outerwear elevated by traditional artisan embroidery, designed for regal winter evenings.",
        sortOrder: 4,
      },
    ],
  },
  {
    name: "Chikankari",
    slug: "chikankari",
    status: "Inactive",
    shortDescription: "Delicate Awadhi shadow-work and tonal needlecraft rooted in the royal courts of Lucknow.",
    detailedDescription: "The quintessence of refined grace, featuring timeless Bakhiya, Phanda, and Murri stitches hand-wrought on airy mulmul, fine cotton, and sheer silks.",
    sortOrder: 30,
    subcategories: [
      {
        name: "Chikankari Kurtas",
        slug: "chikankari-kurtas",
        status: "Inactive",
        shortDescription: "Classic hand-embroidered Lucknowi kurtas with exquisite tonal needlecraft.",
        detailedDescription: "Timeless traditional and contemporary kurtas adorned with authentic Lucknowi floral jaals, delicate chikan motifs, and hand-finished seams.",
        sortOrder: 1,
      },
      {
        name: "Chikankari Jackets",
        slug: "chikankari-jackets",
        status: "Inactive",
        shortDescription: "Ethereal cropped and waist-length jackets displaying intricate tonal Chikankari threadwork.",
        detailedDescription: "Sophisticated layering pieces featuring fine shadow-work and geometric jaali patterns for celebratory occasions.",
        sortOrder: 2,
      },
      {
        name: "Chikankari Shirts",
        slug: "chikankari-shirts",
        status: "Inactive",
        shortDescription: "Modern artisanal shirts with subtle Chikankari embroidery on breathable natural fabrics.",
        detailedDescription: "Contemporary button-down silhouettes accented with minimalist Chikankari motifs for versatile day-to-evening style.",
        sortOrder: 3,
      },
      {
        name: "Chikankari Dresses",
        slug: "chikankari-dresses",
        status: "Inactive",
        shortDescription: "Graceful flowing dresses and maxi silhouettes embellished with intricate Lucknowi needlework.",
        detailedDescription: "Effortless designer dresses featuring airy silhouettes adorned with ornate Chikankari borders and delicate floral vines.",
        sortOrder: 4,
      },
    ],
  },
];

export interface SeededSubcategory {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
}

export interface SeededMainCategory {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  subcategories: SeededSubcategory[];
}

export interface CategorySeedResult {
  mainCategoriesCount: number;
  subcategoriesCount: number;
  totalCategoriesSeeded: number;
  categories: SeededMainCategory[];
}

/**
 * Idempotently seeds Saffron Vastra main categories and subcategories into the database.
 * Preserves all existing database records and performs zero product modifications.
 */
export async function seedCategories(client: PrismaClient = prisma): Promise<CategorySeedResult> {
  console.log("===================================================================");
  console.log("   SEEDING SAFFRON VASTRA CATEGORIES & SUBCATEGORIES               ");
  console.log("===================================================================\n");

  const seededCategories: SeededMainCategory[] = [];
  let subcategoriesCount = 0;

  for (const mainCat of SAFFRON_VASTRA_CATEGORIES) {
    const parentRecord = await client.category.upsert({
      where: { slug: mainCat.slug },
      update: {
        name: mainCat.name,
        shortDescription: mainCat.shortDescription,
        detailedDescription: mainCat.detailedDescription,
        sortOrder: mainCat.sortOrder,
        status: mainCat.status || "Active",
        parentId: null,
        image: `/images/categories/${mainCat.slug}.jpg`,
      },
      create: {
        name: mainCat.name,
        slug: mainCat.slug,
        shortDescription: mainCat.shortDescription,
        detailedDescription: mainCat.detailedDescription,
        sortOrder: mainCat.sortOrder,
        status: mainCat.status || "Active",
        parentId: null,
        image: `/images/categories/${mainCat.slug}.jpg`,
      },
    });

    console.log(`✓ Main Category: ${parentRecord.name} [slug: ${parentRecord.slug}]`);

    const subRecords: SeededSubcategory[] = [];

    for (const subCat of mainCat.subcategories) {
      const subRecord = await client.category.upsert({
        where: { slug: subCat.slug },
        update: {
          name: subCat.name,
          parentId: parentRecord.id,
          shortDescription: subCat.shortDescription,
          detailedDescription: subCat.detailedDescription,
          sortOrder: subCat.sortOrder,
          status: subCat.status || "Active",
          image: `/images/categories/${subCat.slug}.jpg`,
        },
        create: {
          name: subCat.name,
          slug: subCat.slug,
          parentId: parentRecord.id,
          shortDescription: subCat.shortDescription,
          detailedDescription: subCat.detailedDescription,
          sortOrder: subCat.sortOrder,
          status: subCat.status || "Active",
          image: `/images/categories/${subCat.slug}.jpg`,
        },
      });

      console.log(`  └─ Subcategory: ${subRecord.name} [slug: ${subRecord.slug}] (parent: ${parentRecord.name})`);
      subRecords.push({
        id: subRecord.id,
        name: subRecord.name,
        slug: subRecord.slug,
        parentId: subRecord.parentId,
      });
      subcategoriesCount++;
    }

    seededCategories.push({
      id: parentRecord.id,
      name: parentRecord.name,
      slug: parentRecord.slug,
      parentId: parentRecord.parentId,
      subcategories: subRecords,
    });
  }

  console.log("\n-------------------------------------------------------------------");
  console.log("✓ Saffron Vastra Category Seeding Complete!");
  console.log(`  - Main Categories: ${seededCategories.length}`);
  console.log(`  - Subcategories:   ${subcategoriesCount}`);
  console.log(`  - Total Seeded:    ${seededCategories.length + subcategoriesCount}`);
  console.log("-------------------------------------------------------------------\n");

  return {
    mainCategoriesCount: seededCategories.length,
    subcategoriesCount,
    totalCategoriesSeeded: seededCategories.length + subcategoriesCount,
    categories: seededCategories,
  };
}

// Allow direct standalone execution via `npx tsx src/database/category.seeder.ts`
const isDirectExecution =
  Boolean(process.argv[1]) &&
  (process.argv[1].endsWith("category.seeder.ts") ||
    process.argv[1].endsWith("category.seeder.js") ||
    process.argv[1].includes("category.seeder"));

if (isDirectExecution) {
  seedCategories()
    .then(async () => {
      await prisma.$disconnect();
      process.exit(0);
    })
    .catch(async (e) => {
      console.error("Category seeding failed:", e);
      await prisma.$disconnect();
      process.exit(1);
    });
}

