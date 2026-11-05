import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../database/prisma.js';
import { createCampaign } from './campaigns.service.js';

describe('createCampaign', () => {
  let productId: string;
  let accountId: string;

  before(async () => {
    // seed a product and an Instagram account
    const product = await prisma.product.findFirst({ where: { status: 'Active', deletedAt: null } });
    assert.ok(product, 'need at least one active product');
    productId = product.id;

    accountId = (await prisma.socialAccount.upsert({
      where: { platform: 'instagram' },
      create: { platform: 'instagram', accountName: 'test', integrationMode: 'direct_api', credentialSource: 'env', connectionStatus: 'connected', appReviewStatus: 'approved' },
      update: { connectionStatus: 'connected', appReviewStatus: 'approved' },
    })).id;
  });

  it('creates campaign with one product × instagram', async () => {
    const result = await createCampaign({
      name: 'Test Campaign',
      createdByUserId: 'system',
      productIds: [productId],
      platforms: [{ platform: 'instagram', contentType: 'Post' }],
      content: { instagram: { caption: 'Hello', hashtags: ['#test'] } },
    });
    assert.ok(result.campaignId);
    assert.strictEqual(result.variantCount, 1);
  });

  it('deduplicates productIds', async () => {
    const result = await createCampaign({
      name: 'Dupe Test',
      createdByUserId: 'system',
      productIds: [productId, productId],
      platforms: [{ platform: 'instagram', contentType: 'Post' }],
      content: { instagram: { caption: 'x' } },
    });
    assert.strictEqual(result.variantCount, 1); // deduped
  });

  after(() => prisma.$disconnect());
});
