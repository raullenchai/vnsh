import { describe, it, expect } from 'vitest';
import {
  deriveWorkspaceKeys,
  encryptWorkspace,
  decryptWorkspace,
  buildWorkspaceUrl,
  buildReadOnlyWorkspaceUrl,
  buildPublicUrl,
  parseWorkspaceUrl,
  workspaceKind,
  base64urlToBytes,
  bytesToBase64url,
} from '../src/lib/workspace';

const SECRET = base64urlToBytes('ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8');
const HOST = 'https://vnsh.dev';
const ID = 'aBcDeFgHiJkL';

const hex = (b: Uint8Array) =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');

describe('key schedule', () => {
  /**
   * These are the same vectors the CLI pins, derived from the same secret. This
   * is now the fourth implementation of this key schedule, and the only thing
   * stopping them drifting apart is that each one is nailed to these numbers. A
   * link made in one client that will not open in another reads as corruption,
   * not as a version mismatch, so the drift would be silent and expensive.
   */
  it('matches the vectors every other client is pinned to', async () => {
    const { key, writeToken, writeHash } = await deriveWorkspaceKeys(SECRET);
    expect(hex(key)).toBe('dd532139b5f51705c86b30be89d66e6d701cf22867d58eefe753a1abc5841345');
    expect(writeToken).toBe(
      'e48c25fb8e0ab2b77e9a1abd9dbff8efce50a916fe3a9176cf99a8e159d34511',
    );
    expect(writeHash).toBe(
      '57e4916cd70c4ade1d9f765a233128c516dc37fa37b4446b63307283451f1d28',
    );
  });

  it('cannot recover the write token from the content key', async () => {
    const { key, writeToken } = await deriveWorkspaceKeys(SECRET);
    const fromKey = await deriveWorkspaceKeys(key);
    expect(fromKey.writeToken).not.toBe(writeToken);
  });
});

describe('encryption', () => {
  it('round-trips', async () => {
    const { key } = await deriveWorkspaceKeys(SECRET);
    const payload = await encryptWorkspace(new TextEncoder().encode('hello'), key);
    expect(new TextDecoder().decode(await decryptWorkspace(payload, key))).toBe('hello');
  });

  it('uses a fresh nonce per write', async () => {
    const { key } = await deriveWorkspaceKeys(SECRET);
    const a = await encryptWorkspace(new TextEncoder().encode('same'), key);
    const b = await encryptWorkspace(new TextEncoder().encode('same'), key);
    expect(hex(a.slice(0, 12))).not.toBe(hex(b.slice(0, 12)));
  });

  it('rejects content whose tag does not verify', async () => {
    const { key } = await deriveWorkspaceKeys(SECRET);
    const payload = await encryptWorkspace(new TextEncoder().encode('tamper'), key);
    payload[payload.length - 1] ^= 0xff;
    await expect(decryptWorkspace(payload, key)).rejects.toThrow();
  });

  it('rejects a payload too short to hold a nonce and a tag', async () => {
    const { key } = await deriveWorkspaceKeys(SECRET);
    await expect(decryptWorkspace(new Uint8Array(8), key)).rejects.toThrow(/too short/i);
  });
});

describe('link shapes', () => {
  it('classifies the three kinds and rejects everything else', () => {
    expect(workspaceKind(`${HOST}/w/${ID}#w=x`)).toBe('encrypted');
    expect(workspaceKind(`${HOST}/p/${ID}`)).toBe('public');
    expect(workspaceKind(`${HOST}/v/${ID}#k=a&iv=b`)).toBeNull();
    expect(workspaceKind('https://example.com/w/aBcDeFgHiJkL')).toBe('encrypted');
    expect(workspaceKind('nonsense')).toBeNull();
  });

  it('gives an edit link write access and a view-only link none', async () => {
    const edit = await parseWorkspaceUrl(buildWorkspaceUrl(HOST, ID, SECRET));
    expect(edit.canWrite).toBe(true);

    const view = await parseWorkspaceUrl(await buildReadOnlyWorkspaceUrl(HOST, ID, SECRET));
    expect(view.canWrite).toBe(false);
    expect(view.secret).toBeNull();
    // Both tiers decrypt, so the content key has to match.
    expect(hex(view.key as Uint8Array)).toBe(hex(edit.key as Uint8Array));
  });

  // A public link has no fragment because there is no key to carry — that is
  // how the two guarantees stay distinguishable at a glance.
  it('treats a public link as keyless rather than as a malformed one', async () => {
    const link = await parseWorkspaceUrl(buildPublicUrl(HOST, ID));
    expect(link.kind).toBe('public');
    expect(link.key).toBeNull();
    expect(link.canWrite).toBe(false);
  });

  it('refuses an encrypted link with no fragment or the wrong key size', async () => {
    await expect(parseWorkspaceUrl(`${HOST}/w/${ID}`)).rejects.toThrow(/fragment/);
    await expect(parseWorkspaceUrl(`${HOST}/w/${ID}#w=short`)).rejects.toThrow(/32 bytes/);
  });

  it('round-trips base64url without padding', () => {
    const bytes = new Uint8Array([251, 255, 190, 0, 1]);
    expect(bytesToBase64url(bytes)).not.toContain('=');
    expect(hex(base64urlToBytes(bytesToBase64url(bytes)))).toBe(hex(bytes));
  });
});

/**
 * What the content script actually matches on a page. This is the bug the
 * extension shipped with: it scanned only for /v/ links, so every workspace
 * link shared in GitHub, Slack or Discord — the entire v2 product — was
 * invisible to the hover preview, silently and with no error anywhere.
 */
describe('link detection on a page', () => {
  // Kept in step with the regex in src/content/detector.ts.
  const LINK_RE =
    /vnsh\.dev\/(?:v\/[a-zA-Z0-9-]+#\S+|w\/[a-zA-Z0-9]{12}#\S+|p\/[a-zA-Z0-9]{12})/;

  it('finds all three link shapes', () => {
    expect(LINK_RE.test('https://vnsh.dev/v/aBcDeFgHiJkL#k=aa&iv=bb')).toBe(true);
    expect(LINK_RE.test('https://vnsh.dev/w/aBcDeFgHiJkL#w=secret')).toBe(true);
    expect(LINK_RE.test('https://vnsh.dev/w/aBcDeFgHiJkL#r=key')).toBe(true);
    // No fragment, because a public workspace has no key to put in one.
    expect(LINK_RE.test('https://vnsh.dev/p/aBcDeFgHiJkL')).toBe(true);
  });

  it('leaves the rest of the site alone', () => {
    // Requiring a fragment for /p/ would have been the easy mistake; not
    // requiring one for /w/ is the other.
    expect(LINK_RE.test('https://vnsh.dev/w/aBcDeFgHiJkL')).toBe(false);
    expect(LINK_RE.test('https://vnsh.dev/')).toBe(false);
    expect(LINK_RE.test('https://vnsh.dev/llms.txt')).toBe(false);
    expect(LINK_RE.test('https://vnsh.dev/blog/url-fragments-encryption-keys')).toBe(false);
    expect(LINK_RE.test('https://vnsh.dev/privacy')).toBe(false);
  });
});
