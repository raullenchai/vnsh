import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  generateRootSecret,
  deriveWorkspaceKeys,
  sealWorkspaceName,
  openWorkspaceName,
} from './crypto.js';
import { handleWorkspaceCreate, handleWorkspaceUpdate } from './index.js';

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
