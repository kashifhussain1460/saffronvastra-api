import { env } from '../../../config/env.js';

/** Default Graph API version if none is set in the environment. */
const DEFAULT_GRAPH_VERSION = 'v23.0';

export type MetaFlow = 'instagram_login' | 'facebook_login' | 'unknown';

/**
 * Trim a token read from the environment and strip stray wrapping quotes/newlines
 * that commonly leak in from copy-paste or shell quoting. Returns '' for a missing token.
 */
export function sanitizeToken(raw: string | undefined | null): string {
  if (!raw) return '';
  let t = raw.trim();
  // Strip a single pair of wrapping quotes.
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  // Remove any embedded whitespace/newlines (tokens never contain them).
  t = t.replace(/\s+/g, '');
  return t;
}

/** Report whitespace/quote problems in the raw env value without revealing the token. */
export function describeTokenHygiene(raw: string | undefined | null): string[] {
  const issues: string[] = [];
  if (!raw) {
    issues.push('token is missing/empty');
    return issues;
  }
  if (raw !== raw.trim()) issues.push('leading/trailing whitespace');
  if (/\s/.test(raw.trim())) issues.push('embedded whitespace or newline');
  if (/^["']|["']$/.test(raw.trim())) issues.push('wrapping quote characters');
  return issues;
}

/**
 * Infer the Meta auth flow from the token prefix.
 *  - Instagram Login (Unified Login) user tokens start with "IGAA".
 *  - Facebook user/page tokens start with "EAA".
 */
export function detectFlow(token: string): MetaFlow {
  if (token.startsWith('IGAA')) return 'instagram_login';
  if (token.startsWith('EAA')) return 'facebook_login';
  return 'unknown';
}

export function graphVersion(): string {
  return sanitizeToken(env.META_GRAPH_API_VERSION) || DEFAULT_GRAPH_VERSION;
}

/**
 * Pick the correct Graph API host for the given token's flow.
 *  - instagram_login  → graph.instagram.com
 *  - facebook_login   → graph.facebook.com
 *  - unknown          → graph.facebook.com (most permissive for IG Business publishing)
 */
export function graphHostForToken(token: string): string {
  const flow = detectFlow(token);
  if (flow === 'instagram_login') return 'https://graph.instagram.com';
  return 'https://graph.facebook.com';
}

export function graphBaseForToken(token: string): string {
  return `${graphHostForToken(token)}/${graphVersion()}`;
}
