import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from './errors.js';

const KEY_VERSION = '1';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

// Reads the key directly from process.env: importing env.ts here would create a circular dependency risk.
function getKey(): Buffer {
  const raw = process.env.SOCIAL_TOKEN_KEY;
  if (!raw) {
    throw new AppError(500, 'SECRETBOX_NOT_CONFIGURED', 'SOCIAL_TOKEN_KEY is not configured');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new AppError(500, 'SECRETBOX_NOT_CONFIGURED', 'SOCIAL_TOKEN_KEY must be base64-encoded 32 bytes');
  }
  return key;
}

/** Encrypts with AES-256-GCM. Output: "1:{iv_hex}:{ciphertext_hex}:{tag_hex}". */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [KEY_VERSION, iv.toString('hex'), ct.toString('hex'), tag.toString('hex')].join(':');
}

/** Decrypts a value produced by encrypt(). Throws if the format is wrong or the auth tag does not verify. */
export function decrypt(ciphertext: string): string {
  const key = getKey();
  const parts = ciphertext.split(':');
  if (parts.length !== 4 || parts[0] !== KEY_VERSION) {
    throw new Error('Failed to decrypt: malformed ciphertext');
  }
  try {
    const iv = Buffer.from(parts[1], 'hex');
    const ct = Buffer.from(parts[2], 'hex');
    const tag = Buffer.from(parts[3], 'hex');
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Failed to decrypt: authentication failed');
  }
}
