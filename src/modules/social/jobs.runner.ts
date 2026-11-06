import crypto from 'node:crypto';
import { prisma } from '../../database/prisma.js';
import { claimJobs, completeJob, failJob } from './jobs.service.js';
import { decrypt } from '../../common/secretbox.js';
import type { PublishPayload, PlatformKey, ContentType } from './providers/types.js';
import type { ProviderAdapter } from './providers/types.js';
import { prepareMediaForPlatform } from './media.service.js';
import { fakeAdapter } from './providers/fake.adapter.js';
import { instagramAdapter } from './providers/instagram.adapter.js';
import { facebookAdapter } from './providers/facebook.adapter.js';
import { pinterestAdapter } from './providers/pinterest.adapter.js';

const ADAPTERS: Record<string, ProviderAdapter> = {};

// Only register fake adapter in non-production
if (process.env.NODE_ENV !== 'production') {
  ADAPTERS['fake'] = fakeAdapter;
}

ADAPTERS['instagram'] = instagramAdapter;
ADAPTERS['facebook'] = facebookAdapter;
ADAPTERS['pinterest'] = pinterestAdapter;

/**
 * Claims up to `batchSize` pending jobs, processes each via its registered adapter,
 * and returns the count of jobs processed (claimed — not just successful).
 */
export async function runJobBatch(batchSize: number): Promise<number> {
  const lockId = 'runner-' + crypto.randomUUID();
  const jobIds = await claimJobs(batchSize, lockId);

  if (jobIds.length === 0) return 0;

  await Promise.allSettled(
    jobIds.map(async (jobId) => {
      // Load the full job with related data
      const job = await prisma.socialPublishJob.findUnique({
        where: { id: jobId },
        include: { variant: true, socialAccount: true },
      });

      if (!job) {
        // Should not happen after claim, but guard anyway
        await failJob(jobId, { code: 'JOB_NOT_FOUND', message: 'Job not found after claim', retryable: false });
        return;
      }

      // Look up adapter
      const adapter = ADAPTERS[job.provider];
      if (!adapter) {
        await failJob(jobId, { code: 'NO_ADAPTER', message: 'No adapter registered', retryable: false });
        return;
      }

      // Decrypt access token (may throw if key missing or token is null)
      let accessToken = '';
      if (job.socialAccount.encryptedAccessToken != null) {
        try {
          accessToken = decrypt(job.socialAccount.encryptedAccessToken);
        } catch (err) {
          const isSecretboxError =
            err instanceof Error && err.message.includes('SECRETBOX_NOT_CONFIGURED');
          if (isSecretboxError) {
            await failJob(jobId, {
              code: 'SECRETBOX_NOT_CONFIGURED',
              message: 'SOCIAL_TOKEN_KEY is not configured',
              retryable: false,
            });
          } else {
            await failJob(jobId, adapter.normalizeError(err));
          }
          return;
        }
      }

      // Prepare media URL (convert/re-host if needed)
      const rawMediaUrl = (job.variant.mediaSnapshot as any)?.url ?? '';
      let mediaUrl = rawMediaUrl;
      if (rawMediaUrl) {
        try {
          const prepared = await prepareMediaForPlatform(
            rawMediaUrl,
            job.variant.platform as PlatformKey,
            job.variant.contentType as ContentType,
          );
          mediaUrl = prepared.url;
        } catch (err) {
          await failJob(jobId, { code: 'MEDIA_PREPARATION_FAILED', message: err instanceof Error ? err.message : String(err), retryable: false });
          return;
        }
      }

      // Build publish payload
      const payload: PublishPayload = {
        variantId: job.variant.id,
        platform: job.variant.platform as PublishPayload['platform'],
        contentType: job.variant.contentType as PublishPayload['contentType'],
        caption: job.variant.caption ?? undefined,
        hashtags: job.variant.hashtags,
        mediaUrl,
        settings: (job.variant.settings as Record<string, unknown>) ?? undefined,
      };

      // Publish via adapter
      try {
        const result = await adapter.publish(payload, accessToken);
        await completeJob(jobId, result);
      } catch (err) {
        await failJob(jobId, adapter.normalizeError(err));
      }
    }),
  );

  return jobIds.length;
}
