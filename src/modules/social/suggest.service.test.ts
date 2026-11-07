import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('suggestCaptionAndHashtags without OPENAI_API_KEY', () => {
  it('importing the module does not throw (the API must start without the key)', async () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = '';
    try {
      await assert.doesNotReject(() => import('./suggest.service.js'));
    } finally {
      process.env.OPENAI_API_KEY = saved;
    }
  });

  it('a suggestion request fails with AI_NOT_CONFIGURED instead of crashing', async () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = '';
    try {
      const { suggestCaptionAndHashtags } = await import('./suggest.service.js');
      await assert.rejects(
        () => suggestCaptionAndHashtags({ platform: 'instagram', contentType: 'Post', productTitle: 'QA' }),
        (err: any) => err?.code === 'AI_NOT_CONFIGURED' && err?.statusCode === 503,
      );
    } finally {
      process.env.OPENAI_API_KEY = saved;
    }
  });
});
