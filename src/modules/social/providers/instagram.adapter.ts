import { env } from '../../../config/env.js';
import { AppError } from '../../../common/errors.js';
import type { ProviderAdapter, PublishPayload, PublishResult } from './types.js';

const BASE = 'https://graph.instagram.com/v26.0';

function getAccountId(): string {
  if (!env.INSTAGRAM_ACCOUNT_ID) {
    throw new AppError(500, 'INSTAGRAM_NOT_CONFIGURED', 'INSTAGRAM_ACCOUNT_ID is not configured');
  }
  return env.INSTAGRAM_ACCOUNT_ID;
}

async function apiFetch(url: string, options: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, options);
  if (!res.ok) {
    throw new AppError(res.status, 'INSTAGRAM_API_ERROR', `Instagram API error: ${res.status}`);
  }
  const body = await res.json() as unknown;
  return body;
}

export const instagramAdapter: ProviderAdapter = {
  platform: 'instagram',

  async publish(payload: PublishPayload, credentials: string): Promise<PublishResult> {
    const accountId = getAccountId();
    const token = credentials;

    // --- Rate limit check ---
    const limitUrl =
      `${BASE}/${accountId}/content_publishing_limit?fields=config,quota_usage`;
    const limitData = await apiFetch(limitUrl, {
      headers: { Authorization: `Bearer ${token}` },
    }) as { data: Array<{ config: { quota_total: number; quota_duration: number }; quota_usage: number }> };

    const limitEntry = limitData.data?.[0];
    if (limitEntry && limitEntry.quota_usage >= limitEntry.config.quota_total) {
      throw new AppError(429, 'INSTAGRAM_RATE_LIMIT', 'Instagram publishing rate limit reached');
    }

    // --- Step 1: Create container ---
    const createUrl = `${BASE}/${accountId}/media`;
    const createBody: Record<string, string> = {
      image_url: payload.mediaUrl,
      caption: payload.caption ?? '',
      media_type: 'IMAGE',
    };

    const createRes = await apiFetch(createUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(createBody),
    }) as { id: string };

    const containerId = createRes.id;

    // --- Step 2: Poll container status ---
    let finished = false;
    for (let i = 0; i < 5; i++) {
      if (i > 0) await new Promise<void>((r) => setTimeout(r, 60_000));

      const statusRes = await apiFetch(
        `${BASE}/${containerId}?fields=status_code`,
        { headers: { Authorization: `Bearer ${token}` } },
      ) as { status_code: string; id: string };

      if (statusRes.status_code === 'FINISHED') {
        finished = true;
        break;
      }
      if (statusRes.status_code === 'ERROR') {
        throw new AppError(422, 'INSTAGRAM_CONTAINER_ERROR', `Container ${containerId} reported an error`);
      }
    }

    if (!finished) {
      throw new AppError(408, 'INSTAGRAM_CONTAINER_TIMEOUT', `Container ${containerId} did not finish within the polling window`);
    }

    // --- Step 3: Publish ---
    const publishUrl = `${BASE}/${accountId}/media_publish`;
    const publishRes = await apiFetch(publishUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ creation_id: containerId }),
    }) as { id: string };

    const publishedId = publishRes.id;

    return { externalPostId: publishedId, providerContainerId: containerId };
  },

  async getStatus(externalPostId: string, credentials: string): Promise<'published' | 'pending' | 'failed'> {
    try {
      await apiFetch(
        `${BASE}/${externalPostId}?fields=media_type,timestamp`,
        { headers: { Authorization: `Bearer ${credentials}` } },
      );
      return 'published';
    } catch {
      return 'failed';
    }
  },

  normalizeError(err: unknown): { code: string; message: string; retryable: boolean } {
    if (err instanceof AppError) {
      return {
        code: err.code,
        message: err.message,
        retryable: err.statusCode === 429 || err.statusCode === 408,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { code: 'INSTAGRAM_ERROR', message: msg, retryable: true };
  },
};
