import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkEligibility } from './eligibility.service.js';

describe('checkEligibility', () => {
  it('manual platform is never eligible', () => {
    const r = checkEligibility({ platform: 'reddit', contentType: 'ManualHandoff', accountStatus: 'manual_required', hasVideo: false });
    assert.strictEqual(r.eligible, false);
    assert.strictEqual(r.code, 'MANUAL_ONLY');
  });

  it('PNG on Instagram Post is ineligible', () => {
    const r = checkEligibility({ platform: 'instagram', contentType: 'Post', accountStatus: 'ready', coverMimeType: 'image/png', hasVideo: false });
    assert.strictEqual(r.eligible, false);
    assert.strictEqual(r.code, 'JPEG_REQUIRED');
  });

  it('JPEG on Instagram Post is eligible', () => {
    const r = checkEligibility({ platform: 'instagram', contentType: 'Post', accountStatus: 'ready', coverMimeType: 'image/jpeg', hasVideo: false });
    assert.strictEqual(r.eligible, true);
  });

  it('Reel without video is ineligible', () => {
    const r = checkEligibility({ platform: 'instagram', contentType: 'Reel', accountStatus: 'ready', coverMimeType: 'image/jpeg', hasVideo: false });
    assert.strictEqual(r.eligible, false);
    assert.strictEqual(r.code, 'VIDEO_REQUIRED');
  });

  it('approval_pending is ineligible', () => {
    const r = checkEligibility({ platform: 'facebook', contentType: 'Post', accountStatus: 'approval_pending', hasVideo: false });
    assert.strictEqual(r.eligible, false);
    assert.strictEqual(r.code, 'APPROVAL_PENDING');
  });
});
