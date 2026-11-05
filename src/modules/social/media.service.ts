import sharp from 'sharp';
import { put } from '@vercel/blob';
import { env } from '../../config/env.js';
import { AppError } from '../../common/errors.js';
import { getPlatformMeta } from './providers/registry.js';
import type { ContentType, PlatformKey } from './providers/types.js';

export interface MediaSnapshot {
  url: string;      // absolute HTTPS URL, publicly reachable
  mimeType: string; // 'image/jpeg' after conversion, original otherwise
  width?: number;
  height?: number;
}

/** Video content types that do NOT need JPEG conversion */
const VIDEO_CONTENT_TYPES: ContentType[] = ['Reel', 'VideoPost'];

/**
 * Prepare a media URL for publishing to a given platform.
 * - Resolves relative URLs against APP_URL.
 * - For jpegOnly platforms (Instagram) with non-video content:
 *   - Converts non-JPEG images to JPEG via sharp and re-hosts on Vercel Blob.
 *   - Re-hosts Etsy-CDN JPEGs on Vercel Blob for reliability.
 * - For other platforms: verifies reachability (best-effort HEAD) and returns as-is.
 */
export async function prepareMediaForPlatform(
  rawUrl: string,
  platform: PlatformKey,
  contentType: ContentType,
): Promise<MediaSnapshot> {
  try {
    // 1. Resolve relative URLs
    let url = rawUrl;
    if (url.startsWith('/')) {
      const base = env.APP_URL.replace(/\/$/, '');
      url = base + url;
    }

    // 2. Check jpegOnly from registry
    const meta = getPlatformMeta(platform);
    const jpegOnly = meta.jpegOnly;

    // 3. jpegOnly + non-video content type
    if (jpegOnly && !VIDEO_CONTENT_TYPES.includes(contentType)) {
      // Detect mimeType via HEAD
      let mimeType = 'image/jpeg';
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const headRes = await fetch(url, { method: 'HEAD', signal: controller.signal });
        clearTimeout(timer);
        mimeType = headRes.headers.get('content-type')?.split(';')[0].trim() ?? 'image/jpeg';
      } catch {
        // assume image/jpeg, proceed without conversion
        mimeType = 'image/jpeg';
      }

      if (mimeType !== 'image/jpeg') {
        // Convert to JPEG
        const imgRes = await fetch(url);
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        const { width, height } = await sharp(buffer).metadata();
        const jpegBuffer = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();

        if (!env.BLOB_READ_WRITE_TOKEN) {
          throw new AppError(422, 'BLOB_NOT_CONFIGURED', 'BLOB_READ_WRITE_TOKEN is required for media re-hosting');
        }
        const { url: blobUrl } = await put(`social/${Date.now()}-converted.jpg`, jpegBuffer, { access: 'public' });
        return { url: blobUrl, mimeType: 'image/jpeg', width, height };
      }

      // mimeType is already image/jpeg
      const hostname = new URL(url).hostname;
      const isEtsy = hostname.includes('etsy.com') || hostname.includes('etsystatic.com');
      if (isEtsy) {
        // Re-host Etsy CDN JPEG for reliability
        const imgRes = await fetch(url);
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        const { width, height } = await sharp(buffer).metadata();

        if (!env.BLOB_READ_WRITE_TOKEN) {
          throw new AppError(422, 'BLOB_NOT_CONFIGURED', 'BLOB_READ_WRITE_TOKEN is required for media re-hosting');
        }
        const { url: blobUrl } = await put(`social/${Date.now()}-converted.jpg`, buffer, { access: 'public' });
        return { url: blobUrl, mimeType: 'image/jpeg', width, height };
      }

      return { url, mimeType: 'image/jpeg' };
    }

    // 4. Not jpegOnly — verify reachable (best-effort) and return as-is
    let detectedMime = 'image/jpeg';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const headRes = await fetch(url, { method: 'HEAD', signal: controller.signal });
      clearTimeout(timer);
      detectedMime = headRes.headers.get('content-type')?.split(';')[0].trim() ?? 'image/jpeg';
    } catch {
      // swallow errors
    }

    return { url, mimeType: detectedMime };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      422,
      'MEDIA_PREPARATION_FAILED',
      `Media preparation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
