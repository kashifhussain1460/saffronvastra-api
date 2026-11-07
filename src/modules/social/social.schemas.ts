import { z } from 'zod';

export const createCampaignSchema = z.object({
  name: z.string().min(1).max(200),
  productIds: z.array(z.string().uuid()).min(1).max(200),
  platforms: z.array(z.object({
    platform: z.enum(['instagram', 'facebook', 'pinterest']),
    contentType: z.enum(['Post', 'Story', 'Reel', 'Pin', 'VideoPost', 'ManualHandoff']),
  })).min(1),
  content: z.record(z.object({
    caption: z.string().max(2200).optional(),
    hashtags: z.array(z.string()).max(30).optional(),
    title: z.string().max(500).optional(),
    destinationUrl: z.string().url().optional(),
    settings: z.record(z.unknown()).optional(),
  })),
});

export const listProductsSchema = z.object({
  search: z.string().optional(),
  categorySlug: z.string().optional(),
  uncategorised: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  ids: z.string().optional(), // comma-separated UUIDs
});

export const patchVariantSchema = z.object({
  caption: z.string().max(2200).nullable().optional(),
  hashtags: z.array(z.string().max(100)).max(30).optional(),
  settings: z.record(z.unknown()).optional(),
});

export const listCampaignsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
