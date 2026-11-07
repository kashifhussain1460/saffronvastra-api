import { prisma } from '../../database/prisma.js';
import { AppError } from '../../common/errors.js';

const MAX_ATTEMPTS = 5;
const STALE_LOCK_MS = 10 * 60 * 1000;

/**
 * Claim up to `batchSize` pending/retryable jobs atomically.
 * Uses FOR UPDATE SKIP LOCKED so concurrent workers never claim the same job.
 * Column identifiers are camelCase (matching the Prisma-generated migration).
 */
export async function claimJobs(batchSize: number, lockId: string): Promise<string[]> {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new AppError(400, 'INVALID_BATCH_SIZE', 'batchSize must be a positive integer');
  }

  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "social_publish_jobs"
    SET "status" = 'processing', "lockedAt" = now(), "lockedBy" = ${lockId}, "updatedAt" = now()
    WHERE "id" IN (
      SELECT "id" FROM "social_publish_jobs"
      WHERE "status" = 'pending'
        AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= now())
      ORDER BY "enqueuedAt"
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    )
    RETURNING "id"
  `;
  return rows.map(r => r.id);
}

/** Mark a job done (provider confirmed the post). */
export async function completeJob(
  jobId: string,
  result: { externalPostId: string; externalPostUrl?: string },
): Promise<void> {
  await prisma.$transaction([
    prisma.socialPublishJob.update({
      where: { id: jobId },
      data: {
        status: 'published',
        externalPostId: result.externalPostId,
        externalPostUrl: result.externalPostUrl ?? null,
        completedAt: new Date(),
        lockedAt: null,
        lockedBy: null,
      },
    }),
    prisma.socialPublishLog.create({
      data: { jobId, eventType: 'attempt_success' },
    }),
  ]);
}

/**
 * Classify a failure and either schedule a retry or dead-letter the job.
 * attemptCount is incremented inside a transaction; the backoff uses the new count.
 */
export async function failJob(
  jobId: string,
  err: { code: string; message: string; retryable: boolean },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const job = await tx.socialPublishJob.findUnique({
      where: { id: jobId },
      select: { attemptCount: true },
    });
    if (!job) {
      throw new AppError(404, 'JOB_NOT_FOUND', 'Publish job not found');
    }

    const attemptCount = job.attemptCount + 1;
    const shouldRetry = err.retryable && attemptCount < MAX_ATTEMPTS;

    if (shouldRetry) {
      const delayMs = (2 ** attemptCount) * 60_000 + Math.random() * 30_000;
      await tx.socialPublishJob.update({
        where: { id: jobId },
        data: {
          status: 'pending',
          attemptCount,
          nextRetryAt: new Date(Date.now() + delayMs),
          lastErrorCode: err.code,
          lastErrorMessage: err.message,
          lockedAt: null,
          lockedBy: null,
        },
      });
    } else {
      await tx.socialPublishJob.update({
        where: { id: jobId },
        data: {
          status: 'dead',
          attemptCount,
          nextRetryAt: null,
          lastErrorCode: err.code,
          lastErrorMessage: err.message,
          lockedAt: null,
          lockedBy: null,
        },
      });
    }

    await tx.socialPublishLog.create({
      data: {
        jobId,
        eventType: 'attempt_failure',
        errorCode: err.code,
        errorMessage: err.message,
      },
    });

    if (!shouldRetry) {
      await tx.socialPublishLog.create({
        data: {
          jobId,
          eventType: 'dead_lettered',
          errorCode: err.code,
          errorMessage: err.message,
        },
      });
    }
  });
}

/** Admin retry: reset a dead or failed job for the given campaign so it can be claimed again. */
export async function retryJob(jobId: string, campaignId: string): Promise<void> {
  const result = await prisma.socialPublishJob.updateMany({
    where: {
      id: jobId,
      status: { in: ['dead', 'failed'] },
      variant: { campaignProduct: { campaignId } },
    },
    data: {
      status: 'pending',
      attemptCount: 0,
      nextRetryAt: null,
      lockedAt: null,
      lockedBy: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });
  if (result.count === 0) {
    throw new AppError(404, 'JOB_NOT_FOUND', 'Job not found, not retryable, or does not belong to this campaign');
  }
}

/**
 * Recompute and persist a campaign's status from its jobs' statuses.
 *  - any job still pending/processing/held → 'publishing'
 *  - at least one published, none in flight  → 'published' (partial successes count)
 *  - all terminal and none published         → 'failed'
 *  - no jobs at all                          → left unchanged
 */
export async function recomputeCampaignStatus(campaignId: string): Promise<void> {
  const jobs = await prisma.socialPublishJob.findMany({
    where: { variant: { campaignProduct: { campaignId } } },
    select: { status: true },
  });

  if (jobs.length === 0) return;

  const inFlight = jobs.some(j => ['pending', 'processing', 'held'].includes(j.status));
  const anyPublished = jobs.some(j => j.status === 'published');

  let status: string;
  if (inFlight) status = 'publishing';
  else if (anyPublished) status = 'published';
  else status = 'failed';

  await prisma.socialCampaign.update({ where: { id: campaignId }, data: { status } });
}

/** Resolve the campaign id a job belongs to (for post-run status recompute). */
export async function campaignIdForJob(jobId: string): Promise<string | null> {
  const row = await prisma.socialPublishJob.findUnique({
    where: { id: jobId },
    select: { variant: { select: { campaignProduct: { select: { campaignId: true } } } } },
  });
  return row?.variant.campaignProduct.campaignId ?? null;
}

/** Count jobs ready to be processed (pending and due) for a campaign. */
export async function countPublishableJobs(campaignId: string): Promise<number> {
  return prisma.socialPublishJob.count({
    where: {
      status: 'pending',
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }],
      variant: { campaignProduct: { campaignId } },
    },
  });
}

/** Release all held jobs for a campaign so claimJobs can pick them up. */
export async function releaseHeldJobs(campaignId: string): Promise<number> {
  const result = await prisma.socialPublishJob.updateMany({
    where: {
      status: 'held',
      variant: {
        campaignProduct: {
          campaignId,
        },
      },
    },
    data: { status: 'pending' },
  });
  return result.count;
}

/** Sweeper: return jobs stuck in 'processing' beyond the stale-lock window to 'pending'. */
export async function recoverStaleLocks(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_LOCK_MS);
  const result = await prisma.socialPublishJob.updateMany({
    where: {
      status: 'processing',
      lockedAt: { lt: cutoff },
    },
    data: {
      status: 'pending',
      lockedAt: null,
      lockedBy: null,
    },
  });
  return result.count;
}
