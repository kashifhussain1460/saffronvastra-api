import { env } from '../../../config/env.js';
import { AppError } from '../../../common/errors.js';
import type { ProviderAdapter, PublishPayload, PublishResult } from './types.js';
import { graphBaseForToken, detectFlow, sanitizeToken } from './meta.util.js';

function getAccountId(): string {
  if (!env.INSTAGRAM_ACCOUNT_ID) {
    throw new AppError(500, 'INSTAGRAM_NOT_CONFIGURED', 'INSTAGRAM_ACCOUNT_ID is not configured');
  }
  return env.INSTAGRAM_ACCOUNT_ID;
}

interface GraphApiError {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_title?: string;
    error_user_msg?: string;
    fbtrace_id?: string;
  };
}

/** Strip the access_token query param from a URL before logging. */
function redactUrl(url: string): string {
  return url.replace(/(access_token=)[^&]+/gi, '$1***');
}

async function apiFetch(url: string, options: RequestInit = {}, label = 'request'): Promise<unknown> {
  const method = options.method ?? 'GET';
  console.log(`[instagram] → ${method} ${label}: ${redactUrl(url)}`);

  let res: Response;
  try {
    res = await fetch(url, options);
  } catch (err) {
    // Network-level failure (DNS, TLS, connection reset)
    console.error(`[instagram] ✗ ${label} network error:`, err);
    throw new AppError(502, 'INSTAGRAM_NETWORK_ERROR', `Instagram network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const rawText = await res.text();
  let parsed: unknown = undefined;
  try {
    parsed = rawText ? JSON.parse(rawText) : undefined;
  } catch {
    parsed = undefined;
  }

  if (!res.ok) {
    const graphErr = (parsed as GraphApiError | undefined)?.error;
    const detail = graphErr
      ? `${graphErr.message ?? 'unknown'}` +
        (graphErr.code != null ? ` (code ${graphErr.code}` : '') +
        (graphErr.error_subcode != null ? `/${graphErr.error_subcode}` : '') +
        (graphErr.code != null ? ')' : '') +
        (graphErr.error_user_msg ? ` — ${graphErr.error_user_msg}` : '') +
        (graphErr.fbtrace_id ? ` [fbtrace ${graphErr.fbtrace_id}]` : '')
      : rawText.slice(0, 500);

    console.error(`[instagram] ✗ ${label} failed: HTTP ${res.status} — ${detail}`);
    throw new AppError(res.status, 'INSTAGRAM_API_ERROR', `Instagram API error (${label}): ${detail}`);
  }

  console.log(`[instagram] ✓ ${label}: HTTP ${res.status}`);
  return parsed;
}

export const instagramAdapter: ProviderAdapter = {
  platform: 'instagram',

  async publish(payload: PublishPayload, credentials: string): Promise<PublishResult> {
    const accountId = getAccountId();
    const token = sanitizeToken(credentials);
    // Host is chosen from the token type: IGAA → graph.instagram.com, EAA → graph.facebook.com.
    const BASE = graphBaseForToken(token);
    console.log(`[instagram] flow=${detectFlow(token)} base=${BASE} account=${accountId}`);

    // --- Rate limit check (best-effort; genuine auth errors still abort) ---
    const limitUrl =
      `${BASE}/${accountId}/content_publishing_limit?fields=config,quota_usage`;
    try {
      const limitData = await apiFetch(limitUrl, {
        headers: { Authorization: `Bearer ${token}` },
      }, 'rate-limit-check') as { data: Array<{ config: { quota_total: number; quota_duration: number }; quota_usage: number }> };

      const limitEntry = limitData.data?.[0];
      if (limitEntry && limitEntry.quota_usage >= limitEntry.config.quota_total) {
        throw new AppError(429, 'INSTAGRAM_RATE_LIMIT', 'Instagram publishing rate limit reached');
      }
    } catch (err) {
      // Re-throw genuine auth/permission/rate-limit failures; tolerate only "endpoint unsupported".
      if (err instanceof AppError && (err.statusCode === 401 || err.statusCode === 403 || err.statusCode === 429)) {
        throw err;
      }
      console.warn(`[instagram] rate-limit-check skipped (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
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
    }, 'create-container') as { id: string };

    const containerId = createRes.id;
    console.log(`[instagram] container created: ${containerId} (media: ${redactUrl(payload.mediaUrl)})`);

    // --- Step 2: Poll container status ---
    let finished = false;
    for (let i = 0; i < 5; i++) {
      if (i > 0) await new Promise<void>((r) => setTimeout(r, 60_000));

      const statusRes = await apiFetch(
        `${BASE}/${containerId}?fields=status_code`,
        { headers: { Authorization: `Bearer ${token}` } },
        `poll-status[${i + 1}/5]`,
      ) as { status_code: string; id: string };
      console.log(`[instagram] container ${containerId} status: ${statusRes.status_code}`);

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
    }, 'media-publish') as { id: string };

    const publishedId = publishRes.id;
    console.log(`[instagram] published post: ${publishedId}`);

    return { externalPostId: publishedId, providerContainerId: containerId };
  },

  async getStatus(externalPostId: string, credentials: string): Promise<'published' | 'pending' | 'failed'> {
    try {
      await apiFetch(
        `${graphBaseForToken(credentials)}/${externalPostId}?fields=media_type,timestamp`,
        { headers: { Authorization: `Bearer ${credentials}` } },
        'get-status',
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
