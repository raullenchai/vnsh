import { readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  generateRootSecret,
  deriveWorkspaceKeys,
  sealWorkspaceName,
  openWorkspaceName,
  sealBlobName,
  openBlobName,
  generateKey,
  generateIV,
  encrypt,
  parseVnshUrl,
  buildVnshUrl,
} from './crypto.js';
import { handleWorkspaceCreate, handleWorkspaceUpdate, handleShareFile, handleRead } from './index.js';

/**
 * An agent creating a workspace knows what the content is; nothing in the bytes
 * does. `vnsh_workspace_create` with `content` holding Python produced a
 * document that downloaded as `.txt`, because sniffing recovers a type only for
 * formats with magic bytes. The `name` argument is how an agent says so, and it
 * is sealed under the content key so saying so costs the guarantee nothing.
 */
describe('the MCP server seals names the same way every other client does', () => {
  it('round-trips through its own copy of the key schedule', () => {
    const key = deriveWorkspaceKeys(generateRootSecret()).key;
    expect(openWorkspaceName(sealWorkspaceName('migration.sql', key), key)).toBe('migration.sql');
  });

  /**
   * The MCP server and the CLI ship separate copies of crypto.ts. A name sealed
   * by one is opened by the other across the wire, so the two copies drifting
   * apart is a real interoperability failure that no single-package test would
   * see. Comparing the source is blunt and it is also exactly the property that
   * matters.
   */
  it('keeps its copy of the name helpers identical to the CLI', () => {
    const here = readFileSync(join(__dirname, 'crypto.ts'), 'utf-8');
    const cli = readFileSync(
      join(__dirname, '..', '..', 'cli', 'npm', 'src', 'crypto.ts'),
      'utf-8',
    );
    const extract = (source: string) => {
      const start = source.indexOf('export function sealWorkspaceName');
      const end = source.indexOf('/**\n * Workspace links come in two tiers');
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return source.slice(start, end).trim();
    };
    expect(extract(here)).toBe(extract(cli));
  });
});

/**
 * A public workspace's edit link is a `/w/...#w=` link like any other, so
 * nothing about the URL says the content is stored in the clear. Updating one
 * used to encrypt both the body and the name into it, leaving readers with
 * ciphertext served as a public document and a name that decoded to gibberish.
 */
describe('vnsh_workspace_update respects how the workspace stores content', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const EDIT_URL = 'https://vnsh.dev/w/aBcDeFgHiJkL#w=' +
    generateRootSecret().toString('base64url');

  function mockUpdate(isPublic: boolean) {
    const calls: RequestInit[] = [];
    global.fetch = ((_url: string, init: RequestInit) => {
      calls.push(init);
      if (init?.method === 'HEAD') {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(isPublic ? { 'X-Vnsh-Public': '1' } : {}),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ id: 'aBcDeFgHiJkL', version: 4 }),
        text: async () => '',
        headers: new Headers(),
      });
    }) as unknown as typeof fetch;
    return calls;
  }

  it('sends a public workspace its body and name in the clear', async () => {
    const calls = mockUpdate(true);
    await handleWorkspaceUpdate({
      url: EDIT_URL, content: 'plain text', base_version: 3, name: 'next.csv',
    });
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(Buffer.from(put.body as Uint8Array).toString('utf-8')).toBe('plain text');
    const sent = (put.headers as Record<string, string>)['X-Vnsh-Name'];
    expect(openWorkspaceName(sent, null)).toBe('next.csv');
  });

  it('still seals both for an encrypted workspace', async () => {
    const calls = mockUpdate(false);
    await handleWorkspaceUpdate({
      url: EDIT_URL, content: 'plain text', base_version: 3, name: 'next.csv',
    });
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(Buffer.from(put.body as Uint8Array).toString('utf-8')).not.toContain('plain text');
    const sent = (put.headers as Record<string, string>)['X-Vnsh-Name'];
    expect(openWorkspaceName(sent, null)).not.toBe('next.csv');
  });
});

describe('vnsh_workspace_create attaches the name it is given', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockCreate() {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 'aBcDeFgHiJkL', version: 1, expires: '2026-01-01T00:00:00.000Z' }),
      text: async () => '',
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  function headersOf(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
    return (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
  }

  it('sends a sealed name that reveals nothing to the server', async () => {
    const fetchMock = mockCreate();
    await handleWorkspaceCreate({ content: 'print("hi")', name: 'analysis.py' });
    const sent = headersOf(fetchMock)['X-Vnsh-Name'];
    expect(sent).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = Buffer.from(sent.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    expect(decoded.toString('latin1')).not.toContain('analysis');
  });

  it('sends no header when the agent names nothing', async () => {
    const fetchMock = mockCreate();
    await handleWorkspaceCreate({ content: 'print("hi")' });
    expect(headersOf(fetchMock)['X-Vnsh-Name']).toBeUndefined();
  });

  it('sends a public workspace name in the clear, matching its body', async () => {
    const fetchMock = mockCreate();
    await handleWorkspaceCreate({ content: 'notes', public: true, name: 'notes.md' });
    const sent = headersOf(fetchMock)['X-Vnsh-Name'];
    expect(openWorkspaceName(sent, null)).toBe('notes.md');
  });

  it('is the same length whatever the name, so the length leaks nothing', async () => {
    const key = deriveWorkspaceKeys(generateRootSecret()).key;
    const lengths = ['a.c', 'migration.sql', 'acquisition-targets.xlsx'].map(
      (name) => (sealWorkspaceName(name, key) as string).length,
    );
    expect(new Set(lengths).size).toBe(1);
  });

  it('rejects a name longer than the schema allows rather than truncating it', async () => {
    mockCreate();
    await expect(
      handleWorkspaceCreate({ content: 'x', name: 'a'.repeat(300) }),
    ).rejects.toThrow();
  });
});

/**
 * The one-shot share is a legacy `/v/` blob, and it used to arrive nameless:
 * vnsh_read saved every binary as `opaque-<id>.bin`.
 */
describe('vnsh_share_file and vnsh_read keep a legacy blob\'s name', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('share_file seals the file name under the blob key', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnsh-share-'));
    const filePath = path.join(dir, 'model-weights.bin');
    fs.writeFileSync(filePath, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 201,
      json: async () => ({ id: 'aBcDeFgHiJkL', expires: '2026-01-01T00:00:00.000Z' }),
      text: async () => '',
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await handleShareFile({ file_path: filePath });
    const sent = ((fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>)['X-Vnsh-Name'];
    expect(sent).toMatch(/^[A-Za-z0-9_-]{299}$/);
    expect(sent).not.toContain('model-weights');
    const { key } = parseVnshUrl((result.metadata as { url: string }).url);
    expect(openBlobName(sent, key)).toBe('model-weights.bin');
  });

  it('read saves a binary blob under the name it was shared with', async () => {
    const key = generateKey();
    const iv = generateIV();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
    const encrypted = encrypt(png, key, iv);
    const name = `chart-${Date.now()}.png`;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ 'content-length': String(encrypted.length), 'X-Vnsh-Name': sealBlobName(name, key)! }),
      arrayBuffer: async () => encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength),
    }) as unknown as typeof fetch;

    const result = await handleRead({ url: buildVnshUrl('https://vnsh.dev', 'aBcDeFgHiJkL', key, iv) });
    const saved = (result.metadata as { filePath: string }).filePath;
    expect(path.basename(saved)).toBe(name);
    expect(fs.readFileSync(saved)).toEqual(png);
    fs.unlinkSync(saved);
  });

  it('read never overwrites a file already at that name', async () => {
    const key = generateKey();
    const iv = generateIV();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);
    const encrypted = encrypt(png, key, iv);
    const name = `taken-${Date.now()}.png`;
    const taken = path.join(os.tmpdir(), name);
    fs.writeFileSync(taken, 'do not clobber');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ 'content-length': String(encrypted.length), 'X-Vnsh-Name': sealBlobName(name, key)! }),
      arrayBuffer: async () => encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength),
    }) as unknown as typeof fetch;

    const result = await handleRead({ url: buildVnshUrl('https://vnsh.dev', 'aBcDeFgHiJkL', key, iv) });
    const saved = (result.metadata as { filePath: string }).filePath;
    expect(saved).not.toBe(taken);
    expect(fs.readFileSync(taken, 'utf-8')).toBe('do not clobber');
    fs.unlinkSync(saved);
    fs.unlinkSync(taken);
  });
});

/**
 * Two review findings on the update path: a probe that fails must not be read
 * as "private" (the PUT would replace a public document with ciphertext), and
 * the schema agents actually see has to advertise the parameter.
 */
describe('vnsh_workspace_update is honest about what it does not know', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('refuses to write when the visibility probe fails', async () => {
    const calls: RequestInit[] = [];
    global.fetch = ((_url: string, init: RequestInit) => {
      calls.push(init);
      return Promise.resolve({ ok: false, status: 500, headers: new Headers(), text: async () => 'boom' });
    }) as unknown as typeof fetch;
    const url = 'https://vnsh.dev/w/aBcDeFgHiJkL#w=' + generateRootSecret().toString('base64url');
    await expect(handleWorkspaceUpdate({ url, content: 'x', base_version: 3 })).rejects.toThrow(/public or encrypted/);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('advertises `name` on create and update in tools/list', () => {
    const source = readFileSync(join(__dirname, 'index.ts'), 'utf-8');
    for (const tool of ['vnsh_workspace_create', 'vnsh_workspace_update']) {
      const start = source.indexOf(`name: '${tool}'`);
      const end = source.indexOf('required: [', start);
      expect(start).toBeGreaterThan(-1);
      expect(source.slice(start, end)).toMatch(/\n\s+name: \{\n\s+type: 'string'/);
    }
  });
});
