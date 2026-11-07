import { env } from '../../../config/env.js';
import { AppError } from '../../../common/errors.js';
import type { ProviderAdapter, PublishPayload, PublishResult } from './types.js';
import { getPinterestAccessToken } from './pinterest-oauth.js';

const DEFAULT_HOST = 'https://api.pinterest.com';

// Pinterest API v5 errors are flat: { code, message } (not nested under "error" like Meta).
interface PinterestApiError {
  code?: number;
  message?: string;
}

function apiBase(): string {
  const host = (env.PINTEREST_API_BASE?.trim() || DEFAULT_HOST).replace(/\/+$/, '');
  return `${host}/v5`;
}

function getBoardId(): string {
  const boardId = env.PINTEREST_BOARD_ID?.trim();
  if (!boardId) {
    throw new AppError(500, 'PINTEREST_NOT_CONFIGURED', 'PINTEREST_BOARD_ID is not configured');
  }
  return boardId;
}

function redactUrl(url: string): string {
  // Pinterest uses Bearer auth (token in the header, not the URL), but redact any stray query token just in case.
  return url.replace(/(access_token=)[^&]+/gi, '$1***');
}

async function apiFetch(url: string, options: RequestInit = {}, label = 'request'): Promise<unknown> {
  const method = options.method ?? 'GET';
  console.log(`[pinterest] → ${method} ${label}: ${redactUrl(url)}`);

  let res: Response;
  try {
    res = await fetch(url, options);
  } catch (err) {
    console.error(`[pinterest] ✗ ${label} network error:`, err);
    throw new AppError(502, 'PINTEREST_NETWORK_ERROR', `Pinterest network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const rawText = await res.text();
  let parsed: unknown = undefined;
  try { parsed = rawText ? JSON.parse(rawText) : undefined; } catch { parsed = undefined; }

  if (!res.ok) {
    const e = parsed as PinterestApiError | undefined;
    const detail = e?.message
      ? `${e.message}${e.code != null ? ` (code ${e.code})` : ''}`
      : rawText.slice(0, 500) || `HTTP ${res.status}`;
    console.error(`[pinterest] ✗ ${label} failed: HTTP ${res.status} — ${detail}`);
    throw new AppError(res.status, 'PINTEREST_API_ERROR', `Pinterest API error (${label}): ${detail}`);
  }

  console.log(`[pinterest] ✓ ${label}: HTTP ${res.status}`);
  return parsed;
}

// Pinterest: title max 100 chars, description max 800 chars.
function buildTitle(payload: PublishPayload): string | undefined {
  const fromSettings = (payload.settings?.title as string | undefined)?.trim();
  const base = fromSettings || payload.caption?.trim();
  if (!base) return undefined;
  const firstLine = base.split('\n')[0]!.trim();
  return firstLine.slice(0, 100);
}

function buildDescription(payload: PublishPayload): string {
  const caption = payload.caption?.trim() ?? '';
  const tags = (payload.hashtags ?? []).map(h => (h.startsWith('#') ? h : `#${h}`)).join(' ');
  return [caption, tags].filter(Boolean).join('\n\n').slice(0, 800);
}

export const pinterestAdapter: ProviderAdapter = {
  platform: 'pinterest',

  async publish(payload: PublishPayload, credentials: string): Promise<PublishResult> {
    const boardId = getBoardId();
    // `credentials` is the refresh token stored on the account; mint a short-lived access token.
    const token = await getPinterestAccessToken(credentials);
    const BASE = apiBase();
    console.log(`[pinterest] publishing pin to board ${boardId} base=${BASE}`);

    const link = (payload.settings?.destinationUrl as string | undefined)?.trim();
    const body: Record<string, unknown> = {
      board_id: boardId,
      description: buildDescription(payload),
      media_source: { source_type: 'image_url', url: payload.mediaUrl },
    };
    const title = buildTitle(payload);
    if (title) body.title = title;
    if (link) body.link = link;

    const res = (await apiFetch(`${BASE}/pins`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 'create-pin')) as { id?: string };

    const externalPostId = res.id ?? '';
    const externalPostUrl = externalPostId ? `https://www.pinterest.com/pin/${externalPostId}/` : undefined;
    console.log(`[pinterest] published pin: ${externalPostId}`);
    return { externalPostId, externalPostUrl };
  },

  async getStatus(externalPostId: string, credentials: string): Promise<'published' | 'pending' | 'failed'> {
    try {
      const token = await getPinterestAccessToken(credentials);
      await apiFetch(
        `${apiBase()}/pins/${externalPostId}`,
        { headers: { Authorization: `Bearer ${token}` } },
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
        // Transient only: rate limit / upstream. Auth (401) and bad-request (400) are not retryable.
        retryable: err.statusCode === 429 || err.statusCode === 502 || err.statusCode === 503,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { code: 'PINTEREST_ERROR', message: msg, retryable: true };
  },
};
