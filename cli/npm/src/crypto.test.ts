import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as cli from './crypto.js';
import * as mcp from '../../../mcp/src/crypto.js';

const vectors = JSON.parse(readFileSync(new URL('../../../test-vectors/vnsh-compat.json', import.meta.url), 'utf8')) as {
  workspaceV2: Record<string, string>;
};

// A fixed secret so the vectors below are stable across runs and across
// packages. Never use a hard-coded secret for anything real.
const SECRET = Buffer.from('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex');
const HOST = 'https://vnsh.dev';
const ID = 'aBcDeFgHiJkL';

it('matches the repository-wide legacy v1 compatibility contract', () => {
  const vector = (vectors as { legacyV1: Record<string, string> }).legacyV1;
  const ciphertext = cli.encrypt(Buffer.from(vector.plaintext), Buffer.from(vector.keyHex, 'hex'), Buffer.from(vector.ivHex, 'hex'));
  expect(ciphertext.toString('base64')).toBe(vector.ciphertextBase64);
});

describe('workspace key schedule', () => {
  it('matches the repository-wide compatibility contract', () => {
    const vector = vectors.workspaceV2;
    const secret = Buffer.from(vector.secretHex, 'hex');
    const derived = cli.deriveWorkspaceKeys(secret);
    expect(derived.key.toString('hex')).toBe(vector.keyHex);
    expect(derived.writeToken).toBe(vector.writeToken);
    expect(derived.writeHash).toBe(vector.writeHash);
    expect(cli.buildWorkspaceUrl(vector.host, vector.id, secret)).toBe(vector.editUrl);
    expect(cli.buildReadOnlyWorkspaceUrl(vector.host, vector.id, secret)).toBe(vector.readUrl);
    expect(cli.decryptWorkspace(Buffer.from(vector.payloadBase64, 'base64'), derived.key).toString('utf8')).toBe(vector.plaintext);
  });
  it('derives the same keys from the same secret every time', () => {
    const a = cli.deriveWorkspaceKeys(SECRET);
    const b = cli.deriveWorkspaceKeys(SECRET);
    expect(a.key.toString('hex')).toBe(b.key.toString('hex'));
    expect(a.writeToken).toBe(b.writeToken);
    expect(a.writeHash).toBe(b.writeHash);
  });

  it('makes the write token unrecoverable from the content key', () => {
    // This is the entire basis of the view-only tier: a holder of K cannot get
    // back to S, so cannot derive W, so can never write.
    const { key, writeToken } = cli.deriveWorkspaceKeys(SECRET);
    expect(key.toString('hex')).not.toBe(writeToken);
    expect(cli.deriveWorkspaceKeys(key).writeToken).not.toBe(writeToken);
  });

  it('sends the server a hash of the token, never the token', () => {
    const { writeToken, writeHash } = cli.deriveWorkspaceKeys(SECRET);
    expect(writeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(writeHash).not.toBe(writeToken);
  });
});

describe('workspace encryption', () => {
  it('round-trips through nonce, ciphertext and tag', () => {
    const { key } = cli.deriveWorkspaceKeys(SECRET);
    const payload = cli.encryptWorkspace('hello workspace', key);
    expect(cli.decryptWorkspace(payload, key).toString('utf-8')).toBe('hello workspace');
  });

  it('uses a fresh nonce per write, so identical input differs on the wire', () => {
    // Reusing a nonce under GCM leaks the authentication key, not just the
    // plaintext. Identical ciphertext for identical input would mean reuse.
    const { key } = cli.deriveWorkspaceKeys(SECRET);
    const a = cli.encryptWorkspace('same', key);
    const b = cli.encryptWorkspace('same', key);
    expect(a.toString('hex')).not.toBe(b.toString('hex'));
    expect(a.subarray(0, 12).toString('hex')).not.toBe(b.subarray(0, 12).toString('hex'));
  });

  it('refuses content whose authentication tag does not verify', () => {
    const { key } = cli.deriveWorkspaceKeys(SECRET);
    const payload = cli.encryptWorkspace('tamper me', key);
    payload[payload.length - 1] ^= 0xff;
    expect(() => cli.decryptWorkspace(payload, key)).toThrow();
  });

  it('rejects a payload too short to hold a nonce and a tag', () => {
    const { key } = cli.deriveWorkspaceKeys(SECRET);
    expect(() => cli.decryptWorkspace(Buffer.alloc(8), key)).toThrow(/too short/i);
  });
});

describe('workspace links', () => {
  it('parses an edit link as writable and a view-only link as not', () => {
    const edit = cli.parseWorkspaceUrl(cli.buildWorkspaceUrl(HOST, ID, SECRET));
    expect(edit.canWrite).toBe(true);
    expect(edit.writeToken).toMatch(/^[0-9a-f]{64}$/);

    const view = cli.parseWorkspaceUrl(cli.buildReadOnlyWorkspaceUrl(HOST, ID, SECRET));
    expect(view.canWrite).toBe(false);
    expect(view.writeToken).toBeNull();
    expect(view.secret).toBeNull();
  });

  it('gives both tiers the same content key, so both can read', () => {
    const edit = cli.parseWorkspaceUrl(cli.buildWorkspaceUrl(HOST, ID, SECRET));
    const view = cli.parseWorkspaceUrl(cli.buildReadOnlyWorkspaceUrl(HOST, ID, SECRET));
    expect(view.key.toString('hex')).toBe(edit.key.toString('hex'));

    const payload = cli.encryptWorkspace('shared', edit.key);
    expect(cli.decryptWorkspace(payload, view.key).toString('utf-8')).toBe('shared');
  });

  it('routes /w/ and /v/ links to the right reader', () => {
    expect(cli.isWorkspaceUrl(`${HOST}/w/${ID}#w=abc`)).toBe(true);
    expect(cli.isWorkspaceUrl(`${HOST}/v/${ID}#k=aa&iv=bb`)).toBe(false);
    expect(cli.isWorkspaceUrl(`${HOST}/v/12345678-1234-1234-1234-123456789abc#k=a`)).toBe(false);
    expect(cli.isWorkspaceUrl('not a url at all')).toBe(false);
  });

  it('refuses a fragment that is not 32 bytes of key material', () => {
    expect(() => cli.parseWorkspaceUrl(`${HOST}/w/${ID}#w=tooshort`)).toThrow(/32 bytes/);
    expect(() => cli.parseWorkspaceUrl(`${HOST}/w/${ID}`)).toThrow(/fragment/);
  });
});

// The CLI and the MCP server carry their own copies of this code because they
// ship as separate packages. That is only safe while something forces them to
// stay identical — otherwise a link made by one silently stops opening in the
// other, and the failure looks like corruption rather than a version skew.
describe('compatibility with the MCP implementation', () => {
  it('derives byte-identical keys from the same secret', () => {
    const a = cli.deriveWorkspaceKeys(SECRET);
    const b = mcp.deriveWorkspaceKeys(SECRET);
    expect(a.key.toString('hex')).toBe(b.key.toString('hex'));
    expect(a.writeToken).toBe(b.writeToken);
    expect(a.writeHash).toBe(b.writeHash);
  });

  it('pins the key schedule to fixed vectors, so neither side can drift alone', () => {
    const { key, writeToken, writeHash } = cli.deriveWorkspaceKeys(SECRET);
    // HKDF-SHA256(SECRET, info="vnsh/enc/v2") and info="vnsh/write/v2".
    // Changing an info string or the salt breaks every link already issued.
    expect(key.toString('hex')).toMatchInlineSnapshot(`"dd532139b5f51705c86b30be89d66e6d701cf22867d58eefe753a1abc5841345"`);
    expect(writeToken).toMatchInlineSnapshot(`"e48c25fb8e0ab2b77e9a1abd9dbff8efce50a916fe3a9176cf99a8e159d34511"`);
    expect(writeHash).toMatchInlineSnapshot(`"57e4916cd70c4ade1d9f765a233128c516dc37fa37b4446b63307283451f1d28"`);
  });

  it('decrypts what the other one encrypted, in both directions', () => {
    const { key } = cli.deriveWorkspaceKeys(SECRET);
    expect(mcp.decryptWorkspace(cli.encryptWorkspace('from the cli', key), key).toString('utf-8')).toBe(
      'from the cli',
    );
    expect(cli.decryptWorkspace(mcp.encryptWorkspace('from the mcp', key), key).toString('utf-8')).toBe(
      'from the mcp',
    );
  });

  it('builds and parses each other’s links', () => {
    const fromCli = cli.buildWorkspaceUrl(HOST, ID, SECRET);
    const fromMcp = mcp.buildWorkspaceUrl(HOST, ID, SECRET);
    expect(fromCli).toBe(fromMcp);

    expect(mcp.parseWorkspaceUrl(fromCli).writeToken).toBe(cli.parseWorkspaceUrl(fromMcp).writeToken);
    expect(cli.buildReadOnlyWorkspaceUrl(HOST, ID, SECRET)).toBe(
      mcp.buildReadOnlyWorkspaceUrl(HOST, ID, SECRET),
    );
  });
});

describe('v1 blobs still work', () => {
  it('round-trips CBC, so links issued before workspaces keep opening', () => {
    const key = cli.generateKey();
    const iv = cli.generateIV();
    const encrypted = cli.encrypt(Buffer.from('legacy blob'), key, iv);
    expect(cli.decrypt(encrypted, key, iv).toString('utf-8')).toBe('legacy blob');
  });
});
