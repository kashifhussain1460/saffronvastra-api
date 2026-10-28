// Step 1: download every listing image into  product-images/<slug>/NN-<slug>.jpg  (read-only on the database).
//   node scripts/etsy-import/download-images.cjs [csv path] [output folder]
const fs = require("fs");
const path = require("path");
const { loadListings } = require("./etsy-lib.cjs");

const CSV = process.argv[2] || "D:/saff/EtsyListingsDownload (1).csv";
const OUT = process.argv[3] || "D:/saff/product-images";

async function fetchImage(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (listing migration)" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get("content-type") || "";
      const buf = Buffer.from(await res.arrayBuffer());
      const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
      const isPng = buf[0] === 0x89 && buf[1] === 0x50;
      if (!type.startsWith("image/") || !(isJpeg || isPng) || buf.length < 5000) throw new Error(`not an image (${type}, ${buf.length} bytes)`);
      return { buf, ext: isPng ? "png" : "jpg" };
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastError;
}

(async () => {
  const listings = loadListings(CSV);
  const jobs = [];
  for (const l of listings) l.images.forEach((url, i) => jobs.push({ l, url, n: i + 1 }));
  fs.mkdirSync(OUT, { recursive: true });
  const manifest = [];
  let done = 0, skipped = 0;
  const failed = [];
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next++];
      const dir = path.join(OUT, job.l.slug);
      fs.mkdirSync(dir, { recursive: true });
      const existing = fs.readdirSync(dir).find((f) => f.startsWith(String(job.n).padStart(2, "0") + "-"));
      let file = existing;
      try {
        if (existing && fs.statSync(path.join(dir, existing)).size > 5000) skipped++;
        else {
          const { buf, ext } = await fetchImage(job.url);
          file = `${String(job.n).padStart(2, "0")}-${job.l.slug}.${ext}`;
          fs.writeFileSync(path.join(dir, file), buf);
          done++;
        }
        manifest.push({ slug: job.l.slug, position: job.n, file: `${job.l.slug}/${file}`, source: job.url });
      } catch (e) {
        failed.push({ slug: job.l.slug, position: job.n, url: job.url, error: String(e.message) });
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  manifest.sort((a, b) => a.slug.localeCompare(b.slug) || a.position - b.position);
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify({ products: listings.length, images: manifest, failed }, null, 2));
  const index = ["#,Product title,Folder,Images", ...listings.map((l) => `${l.index},"${l.title.replace(/"/g, '""')}",${l.slug},${manifest.filter((m) => m.slug === l.slug).length}`)];
  fs.writeFileSync(path.join(OUT, "INDEX.csv"), index.join("\n"));
  console.log({ products: listings.length, wanted: jobs.length, downloaded: done, alreadyThere: skipped, failed: failed.length });
  if (failed.length) console.log(failed);
})();
