export type PlatformKey = 'instagram' | 'facebook' | 'pinterest' | 'tiktok' | 'reddit' | 'lookbook';
export type ContentType = 'Post' | 'Story' | 'Reel' | 'Pin' | 'VideoPost' | 'ManualHandoff';
export type AccountStatus = 'ready' | 'approval_pending' | 'manual_required';

export interface PlatformMeta {
  key: PlatformKey;
  displayName: string;
  color: string;              // hex for UI
  contentTypes: ContentType[];
  jpegOnly: boolean;
  videoContentTypes: ContentType[]; // types that require video
  manual: boolean;
  status: AccountStatus;
}

export interface PublishPayload {
  variantId: string;
  platform: PlatformKey;
  contentType: ContentType;
  caption?: string;
  hashtags: string[];
  mediaUrl: string;           // absolute HTTPS, JPEG, publicly reachable
  settings?: Record<string, unknown>;
}

export interface PublishResult {
  externalPostId: string;
  externalPostUrl?: string;
  providerContainerId?: string;
}

export interface ProviderAdapter {
  platform: PlatformKey;
  publish(payload: PublishPayload, credentials: string): Promise<PublishResult>;
  getStatus(externalPostId: string, credentials: string): Promise<'published' | 'pending' | 'failed'>;
  normalizeError(err: unknown): { code: string; message: string; retryable: boolean };
}
