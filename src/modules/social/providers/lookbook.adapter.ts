import { AppError } from '../../../common/errors.js';
import type { ProviderAdapter, PublishPayload, PublishResult } from './types.js';

export const lookbookAdapter: ProviderAdapter = {
  platform: 'lookbook',

  async publish(_payload: PublishPayload, _credentials: string): Promise<PublishResult> {
    throw new AppError(503, 'ADAPTER_NOT_AVAILABLE', 'Platform approval pending — cannot publish yet.');
  },

  async getStatus(_externalPostId: string, _credentials: string): Promise<'published' | 'pending' | 'failed'> {
    throw new AppError(503, 'ADAPTER_NOT_AVAILABLE', 'Platform approval pending — cannot publish yet.');
  },

  normalizeError(_err: unknown): { code: string; message: string; retryable: boolean } {
    return { code: 'NOT_AVAILABLE', message: 'Platform approval pending.', retryable: false };
  },
};
