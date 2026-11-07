import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { requireAdmin, type AuthenticatedRequest } from '../../common/auth.middleware.js';
import { env } from '../../config/env.js';
import { getRegistry } from './providers/registry.js';
import { querySocialProducts } from './products.query.js';
import { createCampaign } from './campaigns.service.js';
import { retryJob, releaseHeldJobs, recomputeCampaignStatus, countPublishableJobs } from './jobs.service.js';
import { suggestCaptionAndHashtags } from './suggest.service.js';
import { runJobBatch } from './jobs.runner.js';
import { listAccounts, upsertEnvAccount } from './accounts.service.js';
import { background } from '../../common/background.js';
import { prisma } from '../../database/prisma.js';
import {
  createCampaignSchema,
  listProductsSchema,
  listCampaignsSchema,
  patchVariantSchema,
} from './social.schemas.js';

// Sync env-based accounts into the DB once at startup.
if (env.SOCIAL_PUBLISHING_ENABLED) {
  upsertEnvAccount('instagram').catch(err =>
    console.error('[social] Instagram account sync error:', err)
  );
  upsertEnvAccount('facebook').catch(err =>
    console.error('[social] Facebook account sync error:', err)
  );
  upsertEnvAccount('pinterest').catch(err =>
    console.error('[social] Pinterest account sync error:', err)
  );
}

export const socialRouter = Router();

// Require admin on all routes.
socialRouter.use(requireAdmin as any);

// Feature-flag gate.
socialRouter.use((_req, res, next) => {
  if (!env.SOCIAL_PUBLISHING_ENABLED) {
    return res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: 'Not found' });
  }
  next();
});

// GET /products
socialRouter.get('/products', async (req, res) => {
  const parsed = listProductsSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: parsed.error.issues[0]?.message,
    });
  }
  try {
    const page = await querySocialProducts({
      ...parsed.data,
      ids: parsed.data.ids?.split(','),
    });
    return res.status(200).json({ status: 'success', ...page });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /platforms
socialRouter.get('/platforms', (_req, res) => {
  return res.status(200).json({ status: 'success', data: getRegistry() });
});

// GET /accounts
socialRouter.get('/accounts', async (_req, res) => {
  try {
    const accounts = await listAccounts();
    return res.status(200).json({ status: 'success', data: accounts });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /campaigns
socialRouter.post('/campaigns', async (req, res) => {
  const parsed = createCampaignSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: parsed.error.issues[0]?.message,
    });
  }
  try {
    const authReq = req as AuthenticatedRequest;
    const result = await createCampaign({
      ...parsed.data,
      createdByUserId: authReq.user!.id,
    });
    return res.status(201).json({ status: 'success', data: result });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /campaigns
socialRouter.get('/campaigns', async (req, res) => {
  const parsed = listCampaignsSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: parsed.error.issues[0]?.message,
    });
  }
  try {
    const { page, limit } = parsed.data;
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      prisma.socialCampaign.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { products: true } } },
      }),
      prisma.socialCampaign.count(),
    ]);
    return res.status(200).json({
      status: 'success',
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /campaigns/:id
socialRouter.get('/campaigns/:id', async (req, res) => {
  try {
    const campaign = await prisma.socialCampaign.findUnique({
      where: { id: req.params.id },
      include: {
        products: {
          include: {
            product: { select: { id: true, title: true } },
            variants: { include: { publishJob: true } },
          },
        },
      },
    });
    if (!campaign) {
      return res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: 'Campaign not found' });
    }
    return res.status(200).json({ status: 'success', data: campaign });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /campaigns/:id/publish
socialRouter.post('/campaigns/:id/publish', async (req, res) => {
  const campaign = await prisma.socialCampaign.findUnique({ where: { id: req.params.id } });
  if (!campaign) {
    return res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: 'Campaign not found' });
  }
  // Release any held jobs, then count everything ready to run (held→pending + already-pending retries).
  await releaseHeldJobs(req.params.id);
  const publishable = await countPublishableJobs(req.params.id);
  if (publishable === 0) {
    return res.status(409).json({
      status: 'error',
      code: 'NO_PUBLISHABLE_JOBS',
      message: 'No publishable jobs for this campaign. Check that the platform account is connected and approved, or wait for scheduled retries.',
    });
  }
  await prisma.socialCampaign.update({ where: { id: req.params.id }, data: { status: 'publishing' } });
  background(
    runJobBatch(10)
      .then(() => recomputeCampaignStatus(req.params.id))
      .catch(err => console.error('[social] publish batch error:', err))
  );
  return res.status(202).json({ status: 'success', message: 'Publish enqueued' });
});

// DELETE /campaigns/:id — permanently deletes the campaign and all its products/variants/jobs/logs
// (cascades per schema). Refuses while a publish is actively in-flight.
socialRouter.delete('/campaigns/:id', async (req, res) => {
  try {
    const campaign = await prisma.socialCampaign.findUnique({ where: { id: req.params.id } });
    if (!campaign) {
      return res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: 'Campaign not found' });
    }
    if (campaign.status === 'publishing') {
      return res.status(409).json({
        status: 'error',
        code: 'CAMPAIGN_PUBLISHING',
        message: 'Cannot delete a campaign while it is actively publishing. Wait for it to finish, then try again.',
      });
    }
    await prisma.socialCampaign.delete({ where: { id: req.params.id } });
    return res.status(200).json({ status: 'success', message: 'Campaign deleted' });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// PATCH /campaigns/:id/variants/:variantId — update caption/hashtags/settings
socialRouter.patch('/campaigns/:id/variants/:variantId', async (req, res) => {
  const parsed = patchVariantSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ status: 'error', code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message });
  }
  try {
    const variant = await prisma.socialPostVariant.findFirst({
      where: { id: req.params.variantId, campaignProduct: { campaignId: req.params.id } },
    });
    if (!variant) {
      return res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: 'Variant not found' });
    }
    const updated = await prisma.socialPostVariant.update({
      where: { id: req.params.variantId },
      data: {
        ...(parsed.data.caption !== undefined ? { caption: parsed.data.caption } : {}),
        ...(parsed.data.hashtags !== undefined ? { hashtags: parsed.data.hashtags } : {}),
        ...(parsed.data.settings !== undefined ? { settings: parsed.data.settings as Prisma.InputJsonValue } : {}),
      },
      select: { id: true, caption: true, hashtags: true, settings: true },
    });
    return res.status(200).json({ status: 'success', data: updated });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /campaigns/:id/variants/:variantId/suggest — AI-generated caption + hashtags
socialRouter.post('/campaigns/:id/variants/:variantId/suggest', async (req, res) => {
  try {
    const variant = await prisma.socialPostVariant.findFirst({
      where: { id: req.params.variantId, campaignProduct: { campaignId: req.params.id } },
      include: {
        campaignProduct: {
          include: {
            product: {
              select: { title: true, description: true, focusKeywords: true, material: true, category: { select: { name: true } } },
            },
          },
        },
      },
    });
    if (!variant) {
      return res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: 'Variant not found' });
    }
    const product = variant.campaignProduct.product;
    const suggestion = await suggestCaptionAndHashtags({
      platform: variant.platform,
      contentType: variant.contentType,
      productTitle: product.title,
      productDescription: product.description,
      categoryName: product.category?.name ?? null,
      material: product.material ?? undefined,
      tags: Array.isArray(product.focusKeywords) ? (product.focusKeywords as string[]) : [],
    });
    return res.status(200).json({ status: 'success', data: suggestion });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /campaigns/:id/jobs/:jobId/retry
socialRouter.post('/campaigns/:id/jobs/:jobId/retry', async (req, res) => {
  try {
    await retryJob(req.params.jobId, req.params.id);
    await prisma.socialCampaign.update({ where: { id: req.params.id }, data: { status: 'publishing' } });
    background(
      runJobBatch(10)
        .then(() => recomputeCampaignStatus(req.params.id))
        .catch(err => console.error('[social] retry batch error:', err))
    );
    return res.status(202).json({ status: 'success', message: 'Retry enqueued' });
  } catch (err: any) {
    if (err?.code === 'JOB_NOT_FOUND') {
      return res.status(404).json({ status: 'error', code: err.code, message: err.message });
    }
    return res.status(500).json({ status: 'error', message: err.message });
  }
});
