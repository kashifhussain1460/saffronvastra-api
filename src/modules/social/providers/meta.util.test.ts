import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeToken,
  describeTokenHygiene,
  detectFlow,
  graphHostForToken,
} from './meta.util.js';

describe('sanitizeToken', () => {
  it('returns empty string for missing token', () => {
    assert.strictEqual(sanitizeToken(undefined), '');
    assert.strictEqual(sanitizeToken(null), '');
    assert.strictEqual(sanitizeToken(''), '');
  });

  it('trims surrounding whitespace and newlines', () => {
    assert.strictEqual(sanitizeToken('  IGAAabc\n'), 'IGAAabc');
  });

  it('strips a single pair of wrapping quotes', () => {
    assert.strictEqual(sanitizeToken('"EAAxyz"'), 'EAAxyz');
    assert.strictEqual(sanitizeToken("'EAAxyz'"), 'EAAxyz');
  });

  it('removes embedded whitespace', () => {
    assert.strictEqual(sanitizeToken('EAA xyz'), 'EAAxyz');
  });
});

describe('describeTokenHygiene', () => {
  it('flags a missing token', () => {
    assert.deepStrictEqual(describeTokenHygiene(undefined), ['token is missing/empty']);
  });

  it('flags wrapping quotes and whitespace', () => {
    const issues = describeTokenHygiene('  "EAAxyz"  ');
    assert.ok(issues.includes('leading/trailing whitespace'));
    assert.ok(issues.includes('wrapping quote characters'));
  });

  it('returns no issues for a clean token', () => {
    assert.deepStrictEqual(describeTokenHygiene('EAAxyz'), []);
  });
});

describe('detectFlow', () => {
  it('detects Instagram Login tokens (IGAA)', () => {
    assert.strictEqual(detectFlow('IGAAabc123'), 'instagram_login');
  });

  it('detects Facebook Login tokens (EAA)', () => {
    assert.strictEqual(detectFlow('EAAabc123'), 'facebook_login');
  });

  it('returns unknown for other prefixes', () => {
    assert.strictEqual(detectFlow('xyz'), 'unknown');
  });
});

describe('graphHostForToken', () => {
  it('routes IGAA tokens to graph.instagram.com', () => {
    assert.strictEqual(graphHostForToken('IGAAabc'), 'https://graph.instagram.com');
  });

  it('routes EAA tokens to graph.facebook.com', () => {
    assert.strictEqual(graphHostForToken('EAAabc'), 'https://graph.facebook.com');
  });

  it('defaults unknown tokens to graph.facebook.com', () => {
    assert.strictEqual(graphHostForToken('weirdtoken'), 'https://graph.facebook.com');
  });
});
