import { AppError } from '../../../common/errors.js';
import type { ContentType, PlatformKey, PlatformMeta } from './types.js';

const REGISTRY: Readonly<Record<PlatformKey, PlatformMeta>> = Object.freeze({
  instagram: Object.freeze({
    key: 'instagram',
    displayName: 'Instagram',
    color: '#E1306C',
    contentTypes: Object.freeze(['Post', 'Story', 'Reel']) as PlatformMeta['contentTypes'],
    jpegOnly: true,
    videoContentTypes: Object.freeze(['Reel']) as PlatformMeta['videoContentTypes'],
    manual: false,
    status: 'ready',
  }),
  facebook: Object.freeze({
    key: 'facebook',
    displayName: 'Facebook',
    color: '#1877F2',
    contentTypes: Object.freeze(['Post', 'Story']) as PlatformMeta['contentTypes'],
    jpegOnly: false,
    videoContentTypes: Object.freeze([] as ContentType[]) as PlatformMeta['videoContentTypes'],
    manual: false,
    status: 'ready',
  }),
  pinterest: Object.freeze({
    key: 'pinterest',
    displayName: 'Pinterest',
    color: '#E60023',
    contentTypes: Object.freeze(['Pin']) as PlatformMeta['contentTypes'],
    jpegOnly: false,
    videoContentTypes: Object.freeze([] as ContentType[]) as PlatformMeta['videoContentTypes'],
    manual: false,
    status: 'ready',
  }),
});

export function getRegistry(): Readonly<Record<PlatformKey, PlatformMeta>> {
  return REGISTRY;
}

export function getPlatformMeta(key: PlatformKey): PlatformMeta {
  if (!Object.prototype.hasOwnProperty.call(REGISTRY, key)) {
    throw new AppError(400, 'UNKNOWN_PLATFORM', 'Unknown platform: ' + key);
  }
  return REGISTRY[key];
}
