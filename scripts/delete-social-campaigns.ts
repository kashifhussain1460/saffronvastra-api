// Deletes social campaigns (and, by cascade, their products/variants/publish jobs/logs).
// Dry run by default — shows what would be deleted without touching the database.
//
//   npx tsx scripts/delete-social-campaigns.ts                  # dry run, ALL campaigns
//   npx tsx scripts/delete-social-campaigns.ts --apply          # actually delete ALL campaigns
//   npx tsx scripts/delete-social-campaigns.ts --id=<id>        # dry run, one campaign
//   npx tsx scripts/delete-social-campaigns.ts --id=<id> --apply
//   npx tsx scripts/delete-social-campaigns.ts --status=draft --apply   # only campaigns in this status
//
// Refuses to delete a campaign whose status is "publishing" (an active publish may be in flight)
// unless --force is also passed.
import { prisma } from "../src/database/prisma.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const force = args.includes("--force");
  const idArg = args.find(a => a.startsWith("--id="));
  const statusArg = args.find(a => a.startsWith("--status="));
  return {
    apply,
    force,
    id: idArg ? idArg.slice("--id=".length) : undefined,
    status: statusArg ? statusArg.slice("--status=".length) : undefined,
  };
}

async function main() {
  const { apply, force, id, status } = parseArgs();

  const where: Record<string, unknown> = {};
  if (id) where.id = id;
  if (status) where.status = status;

  const campaigns = await prisma.socialCampaign.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { products: true } },
      products: { include: { variants: { include: { publishJob: { select: { status: true } } } } } },
    },
  });

  if (campaigns.length === 0) {
    console.log("No campaigns match the given filter. Nothing to do.");
    process.exit(0);
  }

  console.log(`=== ${apply ? "DELETING" : "DRY RUN — would delete"} ${campaigns.length} campaign(s) ===`);

  const blocked: string[] = [];
  for (const c of campaigns) {
    const jobCounts: Record<string, number> = {};
    for (const p of c.products) {
      for (const v of p.variants) {
        if (v.publishJob) jobCounts[v.publishJob.status] = (jobCounts[v.publishJob.status] ?? 0) + 1;
      }
    }
    const isPublishing = c.status === "publishing" || jobCounts.processing || jobCounts.pending;
    if (isPublishing && !force) blocked.push(c.id);

    console.log(JSON.stringify({
      id: c.id,
      name: c.name,
      status: c.status,
      createdAt: c.createdAt,
      productCount: c._count.products,
      jobsByStatus: jobCounts,
      willSkip: isPublishing && !force ? "BLOCKED (in-flight publish — pass --force to override)" : undefined,
    }));
  }

  const toDelete = campaigns.filter(c => !blocked.includes(c.id));

  if (!apply) {
    console.log(`\nDry run complete. ${toDelete.length} would be deleted, ${blocked.length} blocked (in-flight).`);
    console.log("Re-run with --apply to actually delete.");
    process.exit(0);
  }

  if (toDelete.length === 0) {
    console.log("\nNothing eligible to delete (all blocked by an in-flight publish).");
    process.exit(0);
  }

  console.log(`\nDeleting ${toDelete.length} campaign(s)...`);
  const result = await prisma.socialCampaign.deleteMany({ where: { id: { in: toDelete.map(c => c.id) } } });
  console.log(`✓ Deleted ${result.count} campaign(s) (cascaded to their products/variants/jobs/logs).`);
  if (blocked.length > 0) {
    console.log(`Skipped ${blocked.length} in-flight campaign(s): ${blocked.join(", ")}`);
  }
  process.exit(0);
}

void main();
