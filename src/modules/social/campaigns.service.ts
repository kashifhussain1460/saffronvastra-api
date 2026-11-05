import crypto, { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../database/prisma.js';
import { AppError } from '../../common/errors.js';
import type { PlatformKey, ContentType, AccountStatus } from './providers/types.js';
import { getPlatformMeta } from './providers/registry.js';
import { checkEligibility } from './eligibility.service.js';

export interface CreateCampaignInput {
  name: string;
  createdByUserId: string;
  productIds: string[];                                   // deduplicated, max 200
  platforms: { platform: PlatformKey; contentType: ContentType }[];
  content: Record<string, {
    caption?: string;
    hashtags?: string[];
    title?: string;
    destinationUrl?: string;
    settings?: Record<string, unknown>;
  }>;
}

export interface CreateCampaignResult {
  campaignId: string;
  variantCount: number;
  jobCount: number;       // variants that have eligible accounts
  manualCount: number;    // variants needing manual handoff
  skippedCount: number;   // ineligible variants
}

export async function createCampaign(input: CreateCampaignInput): Promise<CreateCampaignResult> {
  const { name, createdByUserId, platforms, content } = input;

  // 1. Validate
  if (!name || name.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Campaign name is required');
  }
  if (!platforms || platforms.length === 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'At least one platform is required');
  }
  if (!input.productIds || input.productIds.length === 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'At least one product is required');
  }
  if (input.productIds.length > 200) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Maximum 200 products allowed');
  }

  // 2. Dedup productIds
  const uniqueProductIds = [...new Set(input.productIds)];

  // 3. Load cover images (one query); mimeType lives on MediaAsset, not ProductImage
  const coverImages = await prisma.productImage.findMany({
    where: { productId: { in: uniqueProductIds } },
    orderBy: [{ isCover: 'desc' }, { sortOrder: 'asc' }],
    include: { mediaAsset: { select: { mimeType: true } } },
  });

  const coverByProduct = new Map<string, { url: string; mimeType: string }>();
  for (const img of coverImages) {
    if (!coverByProduct.has(img.productId)) {
      coverByProduct.set(img.productId, {
        url: img.url,
        mimeType: img.mediaAsset?.mimeType ?? 'image/jpeg',
      });
    }
  }

  // 4. Load SocialAccount rows for each requested platform (one query)
  const platformKeys = platforms.map(p => p.platform);
  const accounts = await prisma.socialAccount.findMany({
    where: { platform: { in: platformKeys } },
  });

  const accountByPlatform = new Map<string, typeof accounts[number]>();
  for (const acc of accounts) {
    accountByPlatform.set(acc.platform, acc);
  }

  // AccountStatus mapping from SocialAccount DB row
  function getAccountStatus(platform: PlatformKey): AccountStatus {
    const meta = getPlatformMeta(platform);
    if (meta.manual) return 'manual_required';

    const acc = accountByPlatform.get(platform);
    if (!acc) return 'approval_pending';

    if (acc.connectionStatus === 'connected' && acc.appReviewStatus === 'approved') {
      return 'ready';
    }
    return 'approval_pending';
  }

  // R-2: Pre-generate all IDs before transaction (createMany doesn't return IDs)
  const campaignProductIds = new Map<string, string>(); // productId -> campaignProductId
  for (const pid of uniqueProductIds) {
    campaignProductIds.set(pid, crypto.randomUUID());
  }

  const variantIds = new Map<string, string>(); // `${productId}:${platform}` -> variantId
  for (const pid of uniqueProductIds) {
    for (const p of platforms) {
      variantIds.set(`${pid}:${p.platform}`, crypto.randomUUID());
    }
  }

  // Compute eligibility per variant (before transaction — no provider calls inside)
  type VariantDecision =
    | { type: 'job'; accountId: string; provider: string }
    | { type: 'manual' }
    | { type: 'skip' };

  const variantDecisions = new Map<string, VariantDecision>();
  let jobCount = 0;
  let manualCount = 0;
  let skippedCount = 0;

  for (const pid of uniqueProductIds) {
    const cover = coverByProduct.get(pid);
    for (const p of platforms) {
      const key = `${pid}:${p.platform}`;
      const accountStatus = getAccountStatus(p.platform);
      const result = checkEligibility({
        coverMimeType: cover?.mimeType,
        hasVideo: false,
        platform: p.platform,
        contentType: p.contentType,
        accountStatus,
      });

      if (result.eligible) {
        const acc = accountByPlatform.get(p.platform)!;
        variantDecisions.set(key, { type: 'job', accountId: acc.id, provider: p.platform });
        jobCount++;
      } else if (result.code === 'MANUAL_ONLY') {
        variantDecisions.set(key, { type: 'manual' });
        manualCount++;
      } else {
        variantDecisions.set(key, { type: 'skip' });
        skippedCount++;
      }
    }
  }

  const variantCount = uniqueProductIds.length * platforms.length;

  // 5. Run one prisma.$transaction
  let campaignId!: string;

  await prisma.$transaction(async (tx) => {
    // Create SocialCampaign
    const campaign = await tx.socialCampaign.create({
      data: { name, createdByUserId, status: 'draft' },
    });
    campaignId = campaign.id;

    // createMany SocialCampaignProduct
    const campaignProductRows = uniqueProductIds.map(pid => ({
      id: campaignProductIds.get(pid)!,
      campaignId: campaign.id,
      productId: pid,
    }));
    await tx.socialCampaignProduct.createMany({ data: campaignProductRows });

    // createMany SocialPostVariant (using pre-generated IDs — R-2)
    const variantRows = [];
    for (const pid of uniqueProductIds) {
      const cpId = campaignProductIds.get(pid)!;
      const cover = coverByProduct.get(pid);
      for (const p of platforms) {
        const key = `${pid}:${p.platform}`;
        const c = content[p.platform] ?? {};
        variantRows.push({
          id: variantIds.get(key)!,
          campaignProductId: cpId,
          platform: p.platform,
          contentType: p.contentType,
          caption: c.caption ?? null,
          title: c.title ?? null,
          hashtags: c.hashtags ?? [],
          destinationUrl: c.destinationUrl ?? null,
          settings: (c.settings ?? Prisma.DbNull) as Prisma.InputJsonValue,
          // R-4: raw URL + mimeType; no JPEG conversion here
          mediaSnapshot: cover ? { url: cover.url, mimeType: cover.mimeType } as Prisma.InputJsonValue : Prisma.DbNull,
        });
      }
    }
    await tx.socialPostVariant.createMany({ data: variantRows });

    // createMany SocialPublishJob (only for eligible variants)
    const jobRows = [];
    for (const pid of uniqueProductIds) {
      for (const p of platforms) {
        const key = `${pid}:${p.platform}`;
        const decision = variantDecisions.get(key)!;
        if (decision.type === 'job') {
          const variantId = variantIds.get(key)!;
          const idempotencyKey = createHash('sha256').update(variantId).digest('hex');
          jobRows.push({
            variantId,
            socialAccountId: decision.accountId,
            provider: decision.provider,
            idempotencyKey,
            status: 'held',
          });
        }
      }
    }
    if (jobRows.length > 0) {
      await tx.socialPublishJob.createMany({ data: jobRows });
    }
  });

  return { campaignId, variantCount, jobCount, manualCount, skippedCount };
}
