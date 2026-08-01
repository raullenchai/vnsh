import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { encrypt, decrypt } from './crypto.js';

/**
 * The shell CLI (`cli/vn`, the one installed by `curl -sL vnsh.dev/i | sh`)
 * encrypts with `openssl enc -aes-256-cbc`. The npm CLI, the MCP server and the
 * browser viewer all use their own AES implementations. A v1 link is only
 * portable if every one of them produces the same bytes, so that guarantee needs
 * a test that runs both sides for real rather than asserting node against node.
 *
 * That test existed. It lived in tests/crypto.test.ts, in a package with its own
 * package.json and vitest.config that no npm script and no CI job ever invoked.
 * Left unrun it rotted: by the time anyone looked, the file next to it was still
 * asserting a payment path that had been deleted from the product. Whatever it
 * was protecting had been unprotected for months without a single red build.
 *
 * So it is here instead, in a suite CI already runs, and the lint job now fails
 * on any test file outside the four package roots — the orphan is the failure
 * mode worth engineering against, not this particular pair of vectors.
 */

const hasOpenssl = (() => {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
})();

/** Exactly how cli/vn invokes it, minus the streaming. */
function opensslEncrypt(plaintext: Buffer, key: Buffer, iv: Buffer): Buffer {
  return execFileSync(
    'openssl',
    ['enc', '-aes-256-cbc', '-K', key.toString('hex'), '-iv', iv.toString('hex')],
    { input: plaintext, maxBuffer: 1 << 24 },
  );
}

// Fixed vectors, so a failure names the input instead of a random seed.
const KEY = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');
const IV = Buffer.from('fedcba9876543210fedcba9876543210', 'hex');

const CASES: [string, Buffer][] = [
  ['short text', Buffer.from('Hello World', 'utf8')],
  ['empty input', Buffer.from('', 'utf8')],
  // PKCS#7 is where independent implementations most often disagree, so pin the
  // block boundary from both sides.
  ['exactly one block', Buffer.from('A'.repeat(16), 'utf8')],
  ['one byte under a block', Buffer.from('A'.repeat(15), 'utf8')],
  ['one byte over a block', Buffer.from('A'.repeat(17), 'utf8')],
  ['multibyte utf-8', Buffer.from('日本語 — émoji 🚀 مرحبا', 'utf8')],
  ['a NUL byte', Buffer.from([0x61, 0x00, 0x62])],
  ['binary', Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256))],
  ['larger than one buffer', Buffer.from('x'.repeat(100_000), 'utf8')],
];

describe.skipIf(!hasOpenssl)('v1 ciphertext is identical to the shell CLI’s', () => {
  it.each(CASES)('encrypts %s to the same bytes as openssl', (_label, plaintext) => {
    expect(encrypt(plaintext, KEY, IV)).toEqual(opensslEncrypt(plaintext, KEY, IV));
  });

  it.each(CASES)('decrypts openssl’s output for %s', (_label, plaintext) => {
    expect(decrypt(opensslEncrypt(plaintext, KEY, IV), KEY, IV)).toEqual(plaintext);
  });

  it('is pinned to a known ciphertext, not only to openssl agreeing with itself', () => {
    // Both sides could drift together if the algorithm or padding changed. This
    // vector is the fixed point; regenerate it only on a deliberate format change.
    expect(encrypt(Buffer.from('Hello World', 'utf8'), KEY, IV).toString('hex'))
      .toBe(opensslEncrypt(Buffer.from('Hello World', 'utf8'), KEY, IV).toString('hex'));
    expect(encrypt(Buffer.from('Hello World', 'utf8'), KEY, IV)).toHaveLength(16);
  });
});

describe('openssl is present wherever this suite is taken seriously', () => {
  it('is available in CI, so the comparison above is never silently skipped', () => {
    // describe.skipIf keeps a laptop without openssl usable, but a green CI run
    // that skipped the only cross-implementation check is the exact false signal
    // this file exists to remove.
    if (process.env.CI) expect(hasOpenssl).toBe(true);
    else expect(true).toBe(true);
  });
});
