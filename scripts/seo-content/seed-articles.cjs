// Seeds the journal stories in docs/seo/content-drafts/articles.json (created or updated by slug).
//
//   node scripts/seo-content/seed-articles.cjs                       dry run (writes nothing)
//   node scripts/seo-content/seed-articles.cjs --apply               backup, then save every story as Draft
//   node scripts/seo-content/seed-articles.cjs --apply --publish     backup, then save and publish (visible on /journal)
//   node scripts/seo-content/seed-articles.cjs --restore FILE        put the backed-up stories back (new ones are removed)
//
// Publish only once the storefront that renders headings, lists and links (components/content/StoryBody) is deployed,
// otherwise "## " and "[link](...)" show as typed. Run from D:\saff\backend; the database in backend/.env is PRODUCTION.
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

const ROOT = path.resolve(__dirname, "../../..");
const FILE = path.join(ROOT, "docs/seo/content-drafts/articles.json");
const BACKUPS = path.join(ROOT, "backups");
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const publish = args.includes("--publish");
const restoreIdx = args.indexOf("--restore");
const restoreFile = restoreIdx >= 0 ? args[restoreIdx + 1] : null;
const FIELDS = ["title", "excerpt", "body", "coverImage", "category", "status", "publishedAt"];

async function main() {
  const prisma = new PrismaClient();
  try {
    if (restoreFile) {
      const backup = JSON.parse(fs.readFileSync(restoreFile, "utf8"));
      for (const a of backup.existing) {
        await prisma.article.update({ where: { slug: a.slug }, data: Object.fromEntries(FIELDS.map((f) => [f, a[f]])) });
      }
      if (backup.created.length) await prisma.article.deleteMany({ where: { slug: { in: backup.created } } });
      console.log(`Restored ${backup.existing.length} stories, removed ${backup.created.length} seeded ones.`);
      return;
    }

    const stories = JSON.parse(fs.readFileSync(FILE, "utf8")).sort((a, b) => (a.publishOrder || 0) - (b.publishOrder || 0));
    for (const s of stories) {
      if (!s.slug || !s.title || !s.body) throw new Error(`Story without slug/title/body: ${s.slug || s.title}`);
      if (s.body.length > 30000) throw new Error(`${s.slug}: body is longer than the 30000 characters the admin accepts`);
    }
    const existing = await prisma.article.findMany({ where: { slug: { in: stories.map((s) => s.slug) } } });
    const now = Date.now();
    const plan = stories.map((s, i) => {
      const cur = existing.find((e) => e.slug === s.slug);
      // one second apart, in publishOrder, so the journal lists them in the intended order (newest first)
      const publishedAt = publish ? cur?.publishedAt || new Date(now - (stories.length - i) * 1000) : cur?.publishedAt || null;
      const data = {
        title: s.title,
        excerpt: s.excerpt || null,
        body: s.body,
        coverImage: s.coverImage || null,
        category: s.category || null,
        status: publish ? "Published" : cur?.status || "Draft",
        publishedAt,
      };
      return { s, cur, data };
    });

    for (const { s, cur, data } of plan) {
      const words = s.body.split(/\s+/).filter(Boolean).length;
      console.log(`${cur ? "UPDATE" : "CREATE"} ${s.slug.padEnd(60)} ${data.status.padEnd(9)} ${words} words  "${s.title}"`);
    }
    if (!apply) {
      console.log(`\nDry run: nothing written. Add --apply${publish ? " --publish" : ""} to write (a backup is taken first).`);
      return;
    }

    fs.mkdirSync(BACKUPS, { recursive: true });
    const backupFile = path.join(BACKUPS, `journal-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(
      backupFile,
      JSON.stringify({ existing, created: plan.filter((x) => !x.cur).map((x) => x.s.slug) }, null, 2)
    );
    console.log(`Backup written: ${backupFile}`);

    for (const { s, cur, data } of plan) {
      if (cur) await prisma.article.update({ where: { slug: s.slug }, data });
      else await prisma.article.create({ data: { slug: s.slug, ...data } });
    }
    console.log(`Saved ${plan.length} stories (${publish ? "published" : "as draft or unchanged status"}). To undo: node scripts/seo-content/seed-articles.cjs --restore "${backupFile}"`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
