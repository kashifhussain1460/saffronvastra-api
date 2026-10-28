// One-off: computes sha256 for media assets uploaded before duplicate detection existed.
//   node scripts/backfill-media-hash.cjs
// Safe to repeat: only rows without a hash are touched, and nothing else about an asset changes.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const UPLOADS = path.resolve(process.cwd(), "public/uploads");

(async () => {
  const assets = await prisma.mediaAsset.findMany({ where: { sha256: null }, select: { id: true, url: true } });
  let done = 0, missing = 0;
  for (const a of assets) {
    if (!a.url.startsWith("/uploads/")) continue;
    const file = path.join(UPLOADS, path.basename(a.url));
    if (!fs.existsSync(file)) { missing++; continue; }
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    await prisma.mediaAsset.update({ where: { id: a.id }, data: { sha256 } });
    done++;
  }
  console.log({ withoutHash: assets.length, hashed: done, fileMissing: missing });
})().finally(() => prisma.$disconnect());
