import { getPlatformMeta } from './providers/registry.js';
import type { AccountStatus, ContentType, PlatformKey } from './providers/types.js';

export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
  code?: string;
}

export function checkEligibility(opts: {
  coverMimeType?: string;
  hasVideo: boolean;
  platform: PlatformKey;
  contentType: ContentType;
  accountStatus: AccountStatus;
}): EligibilityResult {
  const meta = getPlatformMeta(opts.platform);

  if (meta.manual) {
    return { eligible: false, code: 'MANUAL_ONLY', reason: `${meta.displayName} is posted manually` };
  }

  if (opts.accountStatus !== 'ready') {
    return { eligible: false, code: 'APPROVAL_PENDING', reason: `${meta.displayName} account is not approved yet` };
  }

  const isVideoType = meta.videoContentTypes.includes(opts.contentType);

  if (meta.jpegOnly && !isVideoType && opts.coverMimeType !== 'image/jpeg') {
    return { eligible: false, code: 'JPEG_REQUIRED', reason: `${meta.displayName} requires a JPEG cover image` };
  }

  if (isVideoType && !opts.hasVideo) {
    return { eligible: false, code: 'VIDEO_REQUIRED', reason: `${meta.displayName} ${opts.contentType} requires a video` };
  }

  return { eligible: true };
}
