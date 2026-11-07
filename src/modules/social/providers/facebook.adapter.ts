import { env } from '../../../config/env.js';
import { AppError } from '../../../common/errors.js';
import type { ProviderAdapter, PublishPayload, PublishResult } from './types.js';
import { graphVersion, sanitizeToken } from './meta.util.js';

const HOST = 'https://graph.facebook.com';

interface GraphApiError {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_msg?: string;
    fbtrace_id?: string;
  };
}

function redactUrl(url: string): string {
  return url.replace(/(access_token=)[^&]+/gi, '$1***');
}

function getPageId(): string {
  if (!env.FACEBOOK_PAGE_ID) {
    throw new AppError(500, 'FACEBOOK_NOT_CONFIGURED', 'FACEBOOK_PAGE_ID is not configured');
  }
  return env.FACEBOOK_PAGE_ID;
}

async function apiFetch(url: string, options: RequestInit = {}, label = 'request'): Promise<unknown> {
  const method = options.method ?? 'GET';
  console.log(`[facebook] → ${method} ${label}: ${redactUrl(url)}`);

  let res: Response;
  try {
    res = await fetch(url, options);
  } catch (err) {
    console.error(`[facebook] ✗ ${label} network error:`, err);
    throw new AppError(502, 'FACEBOOK_NETWORK_ERROR', `Facebook network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const rawText = await res.text();
  let parsed: unknown = undefined;
  try { parsed = rawText ? JSON.parse(rawText) : undefined; } catch { parsed = undefined; }

  if (!res.ok) {
    const e = (parsed as GraphApiError | undefined)?.error;
    const detail = e
      ? `${e.message ?? 'unknown'}` +
        (e.code != null ? ` (code ${e.code}` : '') +
        (e.error_subcode != null ? `/${e.error_subcode}` : '') +
        (e.code != null ? ')' : '') +
        (e.error_user_msg ? ` — ${e.error_user_msg}` : '') +
        (e.fbtrace_id ? ` [fbtrace ${e.fbtrace_id}]` : '')
      : rawText.slice(0, 500);
    console.error(`[facebook] ✗ ${label} failed: HTTP ${res.status} — ${detail}`);
    throw new AppError(res.status, 'FACEBOOK_API_ERROR', `Facebook API error (${label}): ${detail}`);
  }

  console.log(`[facebook] ✓ ${label}: HTTP ${res.status}`);
  return parsed;
}

function buildMessage(payload: PublishPayload): string {
  const caption = payload.caption?.trim() ?? '';
  const tags = (payload.hashtags ?? []).map(h => (h.startsWith('#') ? h : `#${h}`)).join(' ');
  return [caption, tags].filter(Boolean).join('\n\n');
}

export const facebookAdapter: ProviderAdapter = {
  platform: 'facebook',

  async publish(payload: PublishPayload, credentials: string): Promise<PublishResult> {
    const pageId = getPageId();
    const token = sanitizeToken(credentials);
    const BASE = `${HOST}/${graphVersion()}`;
    console.log(`[facebook] publishing to page ${pageId} base=${BASE}`);

    // Single-step: publish a photo with a caption to the Page feed.
    const url = `${BASE}/${pageId}/photos`;
    const res = await apiFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: payload.mediaUrl,
        caption: buildMessage(payload),
      }),
    }, 'create-photo-post') as { id?: string; post_id?: string };

    const externalPostId = res.post_id ?? res.id ?? '';
    console.log(`[facebook] published post: ${externalPostId}`);
    return { externalPostId };
  },

  async getStatus(externalPostId: string, credentials: string): Promise<'published' | 'pending' | 'failed'> {
    try {
      await apiFetch(
        `${HOST}/${graphVersion()}/${externalPostId}?fields=id`,
        { headers: { Authorization: `Bearer ${sanitizeToken(credentials)}` } },
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
        // Auth (401/190) and bad-request (400) are not retryable; transient/network/rate are.
        retryable: err.statusCode === 429 || err.statusCode === 502 || err.statusCode === 503,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { code: 'FACEBOOK_ERROR', message: msg, retryable: true };
  },
};
