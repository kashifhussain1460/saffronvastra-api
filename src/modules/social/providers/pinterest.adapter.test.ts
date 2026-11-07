import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../../../config/env.js';
import { AppError } from '../../../common/errors.js';
import { pinterestAdapter } from './pinterest.adapter.js';
import { clearPinterestTokenCache, DIRECT_TOKEN_PREFIX } from './pinterest-oauth.js';
import type { PublishPayload } from './types.js';

function makePayload(overrides: Partial<PublishPayload> = {}): PublishPayload {
  return {
    variantId: 'v1',
    platform: 'pinterest',
    contentType: 'Pin',
    caption: 'Green velvet jacket',
    hashtags: ['boho', 'handmade'],
    mediaUrl: 'https://example.com/img.jpg',
    ...overrides,
  };
}

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

// Routes the OAuth refresh call to a minted access token; everything else goes to `onApi`.
function mockFetch(onApi: (url: string, opts: any) => Response) {
  globalThis.fetch = (async (url: string, opts: any) => {
    if (String(url).includes('/oauth/token')) {
      return fakeResponse(200, { access_token: 'minted-access-token', token_type: 'bearer', expires_in: 3600 });
    }
    return onApi(String(url), opts);
  }) as typeof fetch;
}

describe('pinterestAdapter', () => {
  const originalFetch = globalThis.fetch;
  const originalBoard = env.PINTEREST_BOARD_ID;
  const originalAppId = env.PINTEREST_APP_ID;
  const originalAppSecret = env.PINTEREST_APP_SECRET;

  beforeEach(() => {
    env.PINTEREST_BOARD_ID = 'board-123';
    env.PINTEREST_APP_ID = 'app-id';
    env.PINTEREST_APP_SECRET = 'app-secret';
    clearPinterestTokenCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    env.PINTEREST_BOARD_ID = originalBoard;
    env.PINTEREST_APP_ID = originalAppId;
    env.PINTEREST_APP_SECRET = originalAppSecret;
    clearPinterestTokenCache();
  });

  it('throws PINTEREST_NOT_CONFIGURED when no board is set', async () => {
    env.PINTEREST_BOARD_ID = undefined;
    await assert.rejects(
      () => pinterestAdapter.publish(makePayload(), 'refresh-token'),
      (err: unknown) => err instanceof AppError && err.code === 'PINTEREST_NOT_CONFIGURED',
    );
  });

  it('throws PINTEREST_NOT_CONFIGURED when app credentials are missing', async () => {
    env.PINTEREST_APP_ID = undefined;
    await assert.rejects(
      () => pinterestAdapter.publish(makePayload(), 'refresh-token'),
      (err: unknown) => err instanceof AppError && err.code === 'PINTEREST_NOT_CONFIGURED',
    );
  });

  it('mints an access token then posts a pin and returns the pin id and URL', async () => {
    let captured: { url: string; body: any; auth?: string } | undefined;
    mockFetch((url, opts) => {
      captured = { url, body: JSON.parse(opts.body), auth: opts.headers?.Authorization };
      return fakeResponse(201, { id: 'pin-999' });
    });

    const result = await pinterestAdapter.publish(makePayload(), 'refresh-token');

    assert.strictEqual(result.externalPostId, 'pin-999');
    assert.strictEqual(result.externalPostUrl, 'https://www.pinterest.com/pin/pin-999/');
    assert.ok(captured);
    assert.match(captured!.url, /\/v5\/pins$/);
    // Uses the minted access token, not the refresh token, as the Bearer credential.
    assert.strictEqual(captured!.auth, 'Bearer minted-access-token');
    assert.strictEqual(captured!.body.board_id, 'board-123');
    assert.strictEqual(captured!.body.media_source.source_type, 'image_url');
    assert.strictEqual(captured!.body.media_source.url, 'https://example.com/img.jpg');
    // description = caption + hashtags
    assert.match(captured!.body.description, /Green velvet jacket/);
    assert.match(captured!.body.description, /#boho #handmade/);
  });

  it('surfaces the Pinterest API error message (flat code/message shape)', async () => {
    mockFetch(() => fakeResponse(401, { code: 2, message: 'Authentication failed' }));

    await assert.rejects(
      () => pinterestAdapter.publish(makePayload(), 'refresh-token'),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'PINTEREST_API_ERROR' &&
        /Authentication failed/.test(err.message) &&
        /code 2/.test(err.message),
    );
  });

  it('direct access token (marker-prefixed) skips the OAuth refresh call entirely', async () => {
    let oauthCalled = false;
    let captured: { url: string; auth?: string } | undefined;
    globalThis.fetch = (async (url: string, opts: any) => {
      if (String(url).includes('/oauth/token')) {
        oauthCalled = true;
        return fakeResponse(200, { access_token: 'should-not-be-used' });
      }
      captured = { url: String(url), auth: opts.headers?.Authorization };
      return fakeResponse(201, { id: 'pin-001' });
    }) as typeof fetch;

    const result = await pinterestAdapter.publish(makePayload(), `${DIRECT_TOKEN_PREFIX}my-direct-token`);

    assert.strictEqual(result.externalPostId, 'pin-001');
    assert.strictEqual(oauthCalled, false, 'should not call the OAuth refresh endpoint for a direct token');
    assert.strictEqual(captured?.auth, 'Bearer my-direct-token');
  });

  it('surfaces an OAuth refresh failure as PINTEREST_OAUTH_ERROR', async () => {
    globalThis.fetch = (async () =>
      fakeResponse(401, { message: 'Refresh token is invalid' })) as typeof fetch;

    await assert.rejects(
      () => pinterestAdapter.publish(makePayload(), 'bad-refresh'),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'PINTEREST_OAUTH_ERROR' &&
        /Refresh token is invalid/.test(err.message),
    );
  });

  it('normalizeError: 401 is not retryable, 429 is retryable', () => {
    const auth = pinterestAdapter.normalizeError(new AppError(401, 'PINTEREST_API_ERROR', 'nope'));
    assert.strictEqual(auth.retryable, false);

    const rate = pinterestAdapter.normalizeError(new AppError(429, 'PINTEREST_API_ERROR', 'slow down'));
    assert.strictEqual(rate.retryable, true);
  });
});
