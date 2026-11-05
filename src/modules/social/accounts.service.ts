import { prisma } from '../../database/prisma.js';
import { encrypt } from '../../common/secretbox.js';
import { env } from '../../config/env.js';
import type { PlatformKey } from './providers/types.js';

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
    const accessToken = env.INSTAGRAM_ACCESS_TOKEN;

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
      },
      update: {
        externalAccountId: accountId,
        ...(encryptedAccessToken !== undefined ? { encryptedAccessToken } : {}),
      },
    });
    return;
  }

  // Other platforms: no env-based tokens configured yet — no-op.
}
