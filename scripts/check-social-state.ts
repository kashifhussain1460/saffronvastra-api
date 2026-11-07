// Read-only: shows social accounts and the latest campaign's jobs so we can see why publish is blocked.
//   npx tsx scripts/check-social-state.ts
import { prisma } from "../src/database/prisma.js";

async function main() {
  const accounts = await prisma.socialAccount.findMany({
    select: { platform: true, externalAccountId: true, connectionStatus: true, appReviewStatus: true, credentialSource: true },
    orderBy: { platform: "asc" },
  });
  console.log("=== Social accounts ===");
  console.log(JSON.stringify(accounts, null, 2));

  const campaign = await prisma.socialCampaign.findFirst({
    orderBy: { createdAt: "desc" },
    include: {
      products: {
        include: {
          variants: { include: { publishJob: { select: { id: true, provider: true, status: true, nextRetryAt: true, lastErrorCode: true } } } },
        },
      },
    },
  });

  if (!campaign) { console.log("\nNo campaigns found."); process.exit(0); }

  console.log(`\n=== Latest campaign ${campaign.id.slice(0, 8)} (status=${campaign.status}) ===`);
  for (const p of campaign.products) {
    for (const v of p.variants) {
      console.log(JSON.stringify({
        platform: v.platform,
        contentType: v.contentType,
        hasMedia: Boolean((v.mediaSnapshot as any)?.url),
        mediaMime: (v.mediaSnapshot as any)?.mimeType ?? null,
        job: v.publishJob
          ? { provider: v.publishJob.provider, status: v.publishJob.status, nextRetryAt: v.publishJob.nextRetryAt, lastErrorCode: v.publishJob.lastErrorCode }
          : "NO JOB (eligibility skipped — account not ready or media ineligible)",
      }));
    }
  }
  process.exit(0);
}

void main();
