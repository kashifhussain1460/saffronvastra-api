import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { encrypt, decrypt } from './secretbox.js';

// key is read lazily inside secretbox, so setting it here (after import) is sufficient
process.env.SOCIAL_TOKEN_KEY = Buffer.from('a'.repeat(32)).toString('base64');

describe('secretbox', () => {
  it('roundtrips a string', () => {
    const plain = 'IGQVJz-some-token-value';
    assert.strictEqual(decrypt(encrypt(plain)), plain);
  });

  it('produces different ciphertexts for the same input (random IV)', () => {
    const a = encrypt('hello');
    const b = encrypt('hello');
    assert.notStrictEqual(a, b);
  });

  it('ciphertext format is "1:{iv}:{ct}:{tag}"', () => {
    const parts = encrypt('x').split(':');
    assert.strictEqual(parts.length, 4);
    assert.strictEqual(parts[0], '1');
  });

  it('throws on tampered ciphertext', () => {
    const enc = encrypt('secret');
    const tampered = enc.slice(0, -4) + '0000';
    assert.throws(() => decrypt(tampered), /decrypt/i);
  });
});
