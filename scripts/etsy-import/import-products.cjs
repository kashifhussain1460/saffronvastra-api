// Step 2: create the products (as Draft) with SEO text, tags and images from the downloaded folders.
//   node scripts/etsy-import/import-products.cjs            -> dry run, prints what would be created
//   node scripts/etsy-import/import-products.cjs apply      -> writes to the database
// Run from D:\saff\backend. Safe to run again: products whose slug already exists are skipped.
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const { loadListings, guessColour, seoTitle, seoDescription, cutAtWord } = require("./etsy-lib.cjs");

const CSV = "D:/saff/EtsyListingsDownload (1).csv";
const IMAGES = "D:/saff/product-images";
const UPLOADS = path.resolve(process.cwd(), "public/uploads");
const prisma = new PrismaClient();

function imageSize(buf) {
  if (buf[0] === 0x89) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return { width: null, height: null };
}

// "Care Instructions" bullet list from the description, when there is one.
function careFrom(description) {
  const m = description.match(/care instructions?\s*\n+([\s\S]*?)(?:\n\s*\n[A-Z][^\n]{2,40}\n|$)/i);
  return m ? m[1].split("\n").map((l) => l.replace(/^[-•\s]+/, "").trim()).filter(Boolean).join("\n") || null : null;
}

(async () => {
  const apply = process.argv[2] === "apply";
  const listings = loadListings(CSV);
  let category = await prisma.category.findFirst({ where: { slug: "jackets" } });
  if (!category && apply) {
    category = await prisma.category.create({
      data: {
        name: "Jackets", slug: "jackets", status: "Active", sortOrder: 0,
        shortDescription: "Hand-embroidered velvet and cotton jackets from Jaipur.",
        detailedDescription: "Statement jackets with folk-art floral embroidery, made by hand by artisans in Jaipur.",
      },
    });
  }
  if (!category) category = { name: "Jackets (will be created)" };
  const manifest = JSON.parse(fs.readFileSync(path.join(IMAGES, "manifest.json"), "utf8"));
  const plan = [];
  for (const l of listings) {
    const files = manifest.images.filter((m) => m.slug === l.slug).sort((a, b) => a.position - b.position);
    const colour = guessColour(l.title);
    const lead = l.title.split(/\s+[-|–]\s+/)[0].trim();
    plan.push({
      l, files, colour, lead,
      seoTitle: seoTitle(l.title),
      seoDescription: seoDescription(l.description, l.title),
      shortDescription: cutAtWord(seoDescription(l.description, l.title), 200),
      care: careFrom(l.description),
    });
  }
  if (!apply) {
    console.log("category:", category.name, "| products:", plan.length, "| images:", plan.reduce((n, p) => n + p.files.length, 0));
    console.log("guessed colours:", plan.filter((p) => p.colour.guessed).length);
    plan.forEach((p) => console.log(`\n#${p.l.index} ${p.l.slug}\n  title:  ${p.l.title}\n  meta:   ${p.seoTitle} (${p.seoTitle.length})\n  desc:   ${p.seoDescription} (${p.seoDescription.length})\n  colour: ${p.colour.name} ${p.colour.hex}${p.colour.guessed ? " (not in title)" : ""} | sizes ${p.l.sizes.join("/")} | ₹${p.l.price} | images ${p.files.length} | tags ${p.l.tags.length}`));
    return;
  }

  let created = 0, skipped = 0, assets = 0;
  for (const p of plan) {
    if (await prisma.product.findUnique({ where: { slug: p.l.slug } })) { skipped++; continue; }
    const imageRows = [];
    for (const f of p.files) {
      const src = path.join(IMAGES, f.file);
      const buf = fs.readFileSync(src);
      const ext = path.extname(f.file).slice(1);
      const n = String(f.position).padStart(2, "0");
      const stored = `${p.l.slug}-${n}.${ext}`;
      fs.copyFileSync(src, path.join(UPLOADS, stored));
      const { width, height } = imageSize(buf);
      const asset = await prisma.mediaAsset.upsert({
        where: { storageKey: `uploads/${stored}` },
        update: {},
        create: {
          storageKey: `uploads/${stored}`, name: stored, url: `/uploads/${stored}`, mimeType: ext === "png" ? "image/png" : "image/jpeg",
          bytes: buf.length, width, height, altText: `${p.lead} - photo ${f.position}`, folder: "Product Images",
        },
      });
      assets++;
      imageRows.push({ mediaAssetId: asset.id, url: asset.url, altText: asset.altText, sortOrder: f.position - 1, isCover: f.position === 1 });
    }
    await prisma.product.create({
      data: {
        categoryId: category.id, slug: p.l.slug, title: p.l.title, description: p.l.description,
        shortDescription: p.shortDescription, material: p.l.materials.join(", ") || null,
        basePriceMinor: Math.round(p.l.price * 100), currency: p.l.currency, status: process.env.IMPORT_STATUS || "Active",
        productType: "Jacket", brand: "Saffron Threads", careInstructions: p.care,
        seoTitle: p.seoTitle, seoDescription: p.seoDescription, focusKeywords: p.l.tags,
        variants: { create: p.l.sizes.map((size) => ({ sku: `SJ-${String(p.l.index).padStart(3, "0")}-${size.toUpperCase()}`, size, colourName: p.colour.name, colourHex: p.colour.hex })) },
        images: { create: imageRows },
      },
    });
    created++;
  }
  console.log({ created, skipped, mediaAssets: assets });
})().catch((e) => { console.error(String(e.message).split("\n").slice(-6).join("\n")); process.exit(1); }).finally(() => prisma.$disconnect());
