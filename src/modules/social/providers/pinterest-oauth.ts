import { env } from '../../../config/env.js';
import { AppError } from '../../../common/errors.js';
import { sanitizeToken } from './meta.util.js';

// Pinterest auth has two supported shapes:
//  1. A direct, long-lived access token (PINTEREST_ACCESS_TOKEN) — used as-is, no network call.
//  2. A refresh-token flow — app credentials (PINTEREST_APP_ID/SECRET) are reused across all calls;
//     a one-time user refresh token is exchanged for a short-lived access token, cached in memory.
// The credential stored on the SocialAccount (and passed in as `credentials`) is whichever of the
// two the account was synced with — see accounts.service.ts upsertEnvAccount('pinterest').
interface TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  message?: string;
  error?: string;
  error_description?: string;
}

/** Marks a stored credential as a direct access token rather than a refresh token. */
export const DIRECT_TOKEN_PREFIX = 'direct:';

let cached: { accessToken: string; expiresAt: number; refreshToken: string } | null = null;

function oauthUrl(): string {
  const host = (env.PINTEREST_API_BASE?.trim() || 'https://api.pinterest.com').replace(/\/+$/, '');
  return `${host}/v5/oauth/token`;
}

/** Clears the in-memory token cache (for tests). */
export function clearPinterestTokenCache(): void {
  cached = null;
}

/**
 * Resolves a Pinterest access token from whatever credential the account was synced with.
 * If `credentials` carries the direct-token marker, it is returned as-is (no network call).
 * Otherwise it is treated as a refresh token and exchanged for a short-lived access token via
 * PINTEREST_APP_ID + PINTEREST_APP_SECRET, cached in memory. Never logs or returns either
 * token value in an error.
 */
export async function getPinterestAccessToken(credentials: string): Promise<string> {
  if (credentials.startsWith(DIRECT_TOKEN_PREFIX)) {
    const token = sanitizeToken(credentials.slice(DIRECT_TOKEN_PREFIX.length));
    if (!token) {
      throw new AppError(500, 'PINTEREST_NOT_CONFIGURED', 'PINTEREST_ACCESS_TOKEN is empty');
    }
    return token;
  }

  const appId = env.PINTEREST_APP_ID?.trim();
  const appSecret = env.PINTEREST_APP_SECRET?.trim();
  const refreshToken = sanitizeToken(credentials);

  if (!appId || !appSecret) {
    throw new AppError(500, 'PINTEREST_NOT_CONFIGURED', 'PINTEREST_APP_ID and PINTEREST_APP_SECRET are required for the refresh-token flow');
  }
  if (!refreshToken) {
    throw new AppError(500, 'PINTEREST_NOT_CONFIGURED', 'PINTEREST_REFRESH_TOKEN is required');
  }

  const now = Date.now();
  // Reuse a cached token until a minute before it expires.
  if (cached && cached.refreshToken === refreshToken && cached.expiresAt > now + 60_000) {
    return cached.accessToken;
  }

  const basic = Buffer.from(`${appId}:${appSecret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });

  console.log('[pinterest] → POST oauth/token (refresh grant)');
  let res: Response;
  try {
    res = await fetch(oauthUrl(), {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    throw new AppError(502, 'PINTEREST_NETWORK_ERROR', `Pinterest OAuth network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const rawText = await res.text();
  let parsed: TokenResponse | undefined;
  try { parsed = rawText ? (JSON.parse(rawText) as TokenResponse) : undefined; } catch { parsed = undefined; }

  if (!res.ok) {
    const detail = parsed?.message ?? parsed?.error_description ?? parsed?.error ?? rawText.slice(0, 300) ?? `HTTP ${res.status}`;
    console.error(`[pinterest] ✗ oauth/token failed: HTTP ${res.status} — ${detail}`);
    throw new AppError(res.status, 'PINTEREST_OAUTH_ERROR', `Pinterest token refresh failed: ${detail}`);
  }

  const accessToken = parsed?.access_token;
  if (!accessToken) {
    throw new AppError(502, 'PINTEREST_OAUTH_ERROR', 'Pinterest token refresh returned no access_token');
  }

  const expiresIn = parsed?.expires_in ?? 3600;
  cached = { accessToken, refreshToken, expiresAt: now + expiresIn * 1000 };
  console.log(`[pinterest] ✓ oauth/token: minted access token (expires_in=${expiresIn}s)`);
  return accessToken;
}
