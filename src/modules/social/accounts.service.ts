import { prisma } from '../../database/prisma.js';
import { encrypt } from '../../common/secretbox.js';
import { env } from '../../config/env.js';
import type { PlatformKey } from './providers/types.js';
import { sanitizeToken } from './providers/meta.util.js';
import { DIRECT_TOKEN_PREFIX } from './providers/pinterest-oauth.js';

export type SocialAccountPublic = {
  id: string;
  platform: string;
  externalAccountId: string | null;
  accountName: string;
  accountType: string;
  integrationMode: string;
  credentialSource: string;
  tokenExpiresAt: Date | null;
  grantedScopes: string[];
  appReviewStatus: string;
  connectionStatus: string;
  capabilities: unknown;
  apiVersion: string | null;
  lastVerifiedAt: Date | null;
  lastHealthCheckAt: Date | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** List all accounts, stripping encrypted credential fields before returning. */
export async function listAccounts(): Promise<SocialAccountPublic[]> {
  const rows = await prisma.socialAccount.findMany({ orderBy: { platform: 'asc' } });
  return rows.map(({ encryptedAccessToken: _a, encryptedRefreshToken: _r, ...rest }) => rest);
}

/**
 * Sync an env-based account into the DB.
 * Currently only implemented for 'instagram'.
 */
export async function upsertEnvAccount(platform: PlatformKey): Promise<void> {
  if (platform === 'instagram') {
    const accountId = env.INSTAGRAM_ACCOUNT_ID;
    const accessToken = sanitizeToken(env.INSTAGRAM_ACCESS_TOKEN) || undefined;

    if (!accountId) return; // nothing to sync

    const encryptedAccessToken =
      accessToken ? encrypt(accessToken) : undefined;

    await prisma.socialAccount.upsert({
      where: { platform: 'instagram' },
      create: {
        platform: 'instagram',
        externalAccountId: accountId,
        accountName: accountId,
        integrationMode: 'direct_api',
        credentialSource: 'env',
        encryptedAccessToken: encryptedAccessToken ?? null,
        connectionStatus: accessToken ? 'connected' : 'disconnected',
        appReviewStatus: accessToken ? 'approved' : 'pending',
      },
      update: {
        externalAccountId: accountId,
        ...(encryptedAccessToken !== undefined ? { encryptedAccessToken } : {}),
        connectionStatus: accessToken ? 'connected' : 'disconnected',
        appReviewStatus: accessToken ? 'approved' : 'pending',
      },
    });
    return;
  }

  if (platform === 'facebook') {
    const pageId = env.FACEBOOK_PAGE_ID;
    const accessToken = sanitizeToken(env.FACEBOOK_PAGE_ACCESS_TOKEN) || undefined;

    if (!pageId) return; // nothing to sync

    const encryptedAccessToken = accessToken ? encrypt(accessToken) : undefined;

    await prisma.socialAccount.upsert({
      where: { platform: 'facebook' },
      create: {
        platform: 'facebook',
        externalAccountId: pageId,
        accountName: pageId,
        integrationMode: 'direct_api',
        credentialSource: 'env',
        encryptedAccessToken: encryptedAccessToken ?? null,
        connectionStatus: accessToken ? 'connected' : 'disconnected',
        appReviewStatus: accessToken ? 'approved' : 'pending',
      },
      update: {
        externalAccountId: pageId,
        ...(encryptedAccessToken !== undefined ? { encryptedAccessToken } : {}),
        connectionStatus: accessToken ? 'connected' : 'disconnected',
        appReviewStatus: accessToken ? 'approved' : 'pending',
      },
    });
    return;
  }

  if (platform === 'pinterest') {
    const boardId = env.PINTEREST_BOARD_ID;

    // Two supported credential shapes, direct access token takes priority when both are set:
    //  - PINTEREST_ACCESS_TOKEN: used as-is (stored with a marker prefix so the adapter knows not
    //    to run it through the OAuth refresh grant).
    //  - PINTEREST_REFRESH_TOKEN (+ PINTEREST_APP_ID/SECRET): exchanged for a short-lived access
    //    token at publish time via pinterest-oauth.ts.
    const directToken = sanitizeToken(env.PINTEREST_ACCESS_TOKEN) || undefined;
    const refreshToken = sanitizeToken(env.PINTEREST_REFRESH_TOKEN) || undefined;
    const hasAppCreds = Boolean(env.PINTEREST_APP_ID?.trim() && env.PINTEREST_APP_SECRET?.trim());

    if (!boardId) return; // nothing to sync — cannot pin without a board

    const credential = directToken ? `${DIRECT_TOKEN_PREFIX}${directToken}` : refreshToken;
    // Ready when a direct token is present, or the full refresh-token chain (app creds + refresh token).
    const ready = Boolean(directToken || (refreshToken && hasAppCreds));
    const encryptedAccessToken = credential ? encrypt(credential) : undefined;

    await prisma.socialAccount.upsert({
      where: { platform: 'pinterest' },
      create: {
        platform: 'pinterest',
        externalAccountId: boardId,
        accountName: boardId,
        integrationMode: 'direct_api',
        credentialSource: 'env',
        encryptedAccessToken: encryptedAccessToken ?? null,
        connectionStatus: ready ? 'connected' : 'disconnected',
        appReviewStatus: ready ? 'approved' : 'pending',
      },
      update: {
        externalAccountId: boardId,
        ...(encryptedAccessToken !== undefined ? { encryptedAccessToken } : {}),
        connectionStatus: ready ? 'connected' : 'disconnected',
        appReviewStatus: ready ? 'approved' : 'pending',
      },
    });
    return;
  }

  // Other platforms: no env-based tokens configured yet — no-op.
}
