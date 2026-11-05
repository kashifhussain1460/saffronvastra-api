import { Router } from 'express';
import { requireAdmin, type AuthenticatedRequest } from '../../common/auth.middleware.js';
import { env } from '../../config/env.js';
import { getRegistry } from './providers/registry.js';
import { querySocialProducts } from './products.query.js';
import { createCampaign } from './campaigns.service.js';
import { retryJob, releaseHeldJobs } from './jobs.service.js';
import { runJobBatch } from './jobs.runner.js';
import { listAccounts, upsertEnvAccount } from './accounts.service.js';
import { background } from '../../common/background.js';
import { prisma } from '../../database/prisma.js';
import {
  createCampaignSchema,
  listProductsSchema,
  listCampaignsSchema,
} from './social.schemas.js';

// Sync env-based accounts into the DB once at startup.
if (env.SOCIAL_PUBLISHING_ENABLED) {
  upsertEnvAccount('instagram').catch(err =>
    console.error('[social] Instagram account sync error:', err)
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
  await releaseHeldJobs(req.params.id);
  background(runJobBatch(10));
  return res.status(202).json({ status: 'success', message: 'Publish enqueued' });
});

// POST /campaigns/:id/jobs/:jobId/retry
socialRouter.post('/campaigns/:id/jobs/:jobId/retry', async (req, res) => {
  try {
    await retryJob(req.params.jobId, req.params.id);
    return res.status(200).json({ status: 'success' });
  } catch (err: any) {
    if (err?.code === 'JOB_NOT_FOUND') {
      return res.status(404).json({ status: 'error', code: err.code, message: err.message });
    }
    return res.status(500).json({ status: 'error', message: err.message });
  }
});
