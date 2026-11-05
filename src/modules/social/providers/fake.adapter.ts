import { AppError } from '../../../common/errors.js';
import type { ProviderAdapter, PublishPayload, PublishResult } from './types.js';

export const fakeAdapter: ProviderAdapter = {
  platform: 'instagram', // used as stand-in; fake adapter accepts any platform in tests

  async publish(payload: PublishPayload, _credentials: string): Promise<PublishResult> {
    if (process.env.NODE_ENV === 'production') {
      throw new AppError(500, 'FAKE_ADAPTER_NOT_ALLOWED', 'Fake adapter cannot be used in production');
    }
    // Simulate async work
    await new Promise(r => setTimeout(r, 100));
    return {
      externalPostId: `fake-${Date.now()}`,
      externalPostUrl: `https://example.com/fake/${Date.now()}`,
    };
  },

  async getStatus(_externalPostId: string, _credentials: string): Promise<'published' | 'pending' | 'failed'> {
    return 'published';
  },

  normalizeError(err: unknown): { code: string; message: string; retryable: boolean } {
    const msg = err instanceof Error ? err.message : String(err);
    return { code: 'FAKE_ERROR', message: msg, retryable: false };
  },
};
