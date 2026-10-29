// Needs the local database (docker compose up). Run with: npm run test:db
// Uses a fake Blob store; the real Vercel Blob is not touched. Creates QA rows and removes them again.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../../database/prisma.js";
import { importFromBlob, type BlobEntry, type BlobSource } from "./blobImport.service.js";

const tag = `qa-blob-${Date.now().toString(36)}`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PNG2 = Buffer.concat([PNG, Buffer.from("x")]); // different bytes, still starts as a PNG

function fakeStore(files: Record<string, Buffer>, pageSize = 100): BlobSource & { downloads: string[] } {
  const entries: BlobEntry[] = Object.entries(files).map(([pathname, buf]) => ({ pathname, size: buf.length, url: `https://fake.public.blob.vercel-storage.com/${pathname}` }));
  const downloads: string[] = [];
  return {
    downloads,
    async list(_prefix, cursor, limit) {
      const start = cursor ? Number(cursor) : 0;
      const take = Math.min(limit, pageSize);
      const blobs = entries.slice(start, start + take);
      const next = start + take;
      return { blobs, cursor: next < entries.length ? String(next) : undefined, hasMore: next < entries.length };
    },
    async fetchBytes(url) {
      downloads.push(url);
      const hit = entries.find((e) => e.url === url);
      if (!hit) throw new Error("not found");
      return files[hit.pathname];
    },
  };
}

async function runAll(source: BlobSource) {
  let cursor: string | null = null;
  const total = { created: 0, linked: 0, unmatched: [] as string[], invalid: [] as string[], calls: 0 };
  for (let i = 0; i < 50; i++) {
    const r = await importFromBlob({ cursor, batchSize: 2 }, source);
    total.calls++;
    total.created += r.created;
    total.linked += r.linked.length;
    total.unmatched.push(...r.unmatched.map((u) => u.path));
    total.invalid.push(...r.invalid.map((u) => u.path));
    if (r.done) return total;
    cursor = r.nextCursor;
  }
  throw new Error("did not finish");
}

after(async () => {
  await prisma.productImage.deleteMany({ where: { product: { slug: { startsWith: tag } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: tag } } });
  await prisma.collection.deleteMany({ where: { slug: { startsWith: tag } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: tag } } });
  await prisma.mediaAsset.deleteMany({ where: { storageKey: { startsWith: `uploads/` }, url: { startsWith: "https://fake.public.blob" } } });
  await prisma.$disconnect();
});

test("images in the Blob folders are added to the library and linked to the right product, category and collection", async () => {
  const category = await prisma.category.create({ data: { name: "QA Blob", slug: `${tag}-cat` } });
  const product = await prisma.product.create({ data: { categoryId: category.id, slug: `${tag}-jacket`, title: "QA Blob Jacket", description: "x", basePriceMinor: 100000 } });
  const collection = await prisma.collection.create({ data: { slug: `${tag}-col`, title: "QA Blob Collection" } });

  const source = fakeStore({
    [`uploads/products/${tag}-jacket/02.png`]: PNG2,
    [`uploads/products/${tag}-jacket/01.png`]: PNG,
    [`uploads/products/${tag}-nobody/01.png`]: PNG, // no such product
    [`uploads/categories/${tag}-cat.png`]: PNG2,
    [`uploads/collections/${tag}-col.png`]: PNG,
    [`uploads/banners/${tag}-banner.png`]: PNG2,
    [`uploads/products/${tag}-jacket/notes.png`]: Buffer.from("this is not an image"), // fails the real-type check
    [`uploads/1792-someone-else.png`]: PNG, // outside the convention: ignored
  });

  const first = await runAll(source);
  assert.ok(first.calls > 1, "several calls were needed with a batch of 2");
  assert.deepEqual(first.invalid, [`uploads/products/${tag}-jacket/notes.png`]);
  assert.deepEqual(first.unmatched, [`uploads/products/${tag}-nobody/01.png`]);

  const images = await prisma.productImage.findMany({ where: { productId: product.id }, orderBy: { sortOrder: "asc" }, include: { mediaAsset: true } });
  assert.equal(images.length, 2);
  assert.ok(images[0].url.endsWith("01.png") && images[0].isCover, "01 is the cover and comes first");
  assert.ok(images[1].url.endsWith("02.png") && !images[1].isCover);
  assert.equal(images[0].mediaAsset?.folder, "Product Images");
  assert.equal(images[0].mediaAsset?.mimeType, "image/png");
  assert.equal(images[0].mediaAsset?.width, 1);

  const cat = await prisma.category.findUnique({ where: { id: category.id } });
  assert.ok(cat?.image?.endsWith(`${tag}-cat.png`));
  const col = await prisma.collection.findUnique({ where: { id: collection.id } });
  assert.ok(col?.bannerImage?.endsWith(`${tag}-col.png`) && col.heroMediaId);
  assert.equal((await prisma.mediaAsset.findFirst({ where: { storageKey: `uploads/banners/${tag}-banner.png` } }))?.folder, "Banner Images");
  assert.equal(await prisma.mediaAsset.count({ where: { storageKey: "uploads/1792-someone-else.png" } }), 0, "files outside the folders are left alone");

  // running it again changes nothing and downloads nothing it already has
  const before = await prisma.mediaAsset.count({ where: { url: { startsWith: "https://fake.public.blob" } } });
  source.downloads.length = 0;
  const second = await runAll(source);
  assert.equal(second.created, 0);
  assert.equal(second.linked, 0);
  assert.equal(await prisma.productImage.count({ where: { productId: product.id } }), 2);
  assert.equal(await prisma.mediaAsset.count({ where: { url: { startsWith: "https://fake.public.blob" } } }), before);
  assert.ok(!source.downloads.some((u) => !u.includes("notes.png") && !u.includes("-nobody")), "only the files that failed or had no match are looked at again");
});

test("a product created after its images were uploaded gets them on the next import", async () => {
  const category = await prisma.category.findFirstOrThrow({ where: { slug: `${tag}-cat` } });
  const source = fakeStore({ [`uploads/products/${tag}-late/01.png`]: PNG });
  const r1 = await runAll(source);
  assert.deepEqual(r1.unmatched, [`uploads/products/${tag}-late/01.png`]);
  const product = await prisma.product.create({ data: { categoryId: category.id, slug: `${tag}-late`, title: "QA Late", description: "x", basePriceMinor: 100000 } });
  const r2 = await runAll(source);
  assert.equal(r2.created, 0, "the file was already in the library");
  assert.equal(r2.linked, 1);
  assert.equal(await prisma.productImage.count({ where: { productId: product.id } }), 1);
});

test("a category that already has an image is left unchanged", async () => {
  const cat = await prisma.category.create({ data: { name: "QA Has Image", slug: `${tag}-has`, image: "/uploads/keep-me.png" } });
  const source = fakeStore({ [`uploads/categories/${tag}-has.png`]: PNG2 });
  const r = await runAll(source);
  assert.equal(r.unmatched.length, 1);
  assert.equal((await prisma.category.findUnique({ where: { id: cat.id } }))?.image, "/uploads/keep-me.png");
});

test("many files that cannot be imported do not stop the import from finishing", async () => {
  const files: Record<string, Buffer> = {};
  for (let n = 1; n <= 6; n++) files[`uploads/banners/${tag}-bad-${n}.png`] = Buffer.from(`not an image ${n}`);
  const r = await runAll(fakeStore(files, 4)); // two store pages, batches of two
  assert.equal(r.invalid.length, 6);
  assert.equal(r.created, 0);
});
