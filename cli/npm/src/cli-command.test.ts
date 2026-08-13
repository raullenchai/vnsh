import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { program } from './cli.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.VNSH_TOKEN;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('CLI commands', () => {
  it('runs vn init through the real Commander command graph', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vnsh-cli-command-'));
    roots.push(root);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await program.parseAsync(['node', 'vn', 'init', root]);

    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('vnsh:init:start');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('created:'));
    expect(log).toHaveBeenCalledWith('Agents in this project can now create and open vnsh handoffs.');
  });

  it('runs account status through the real command graph', async () => {
    process.env.VNSH_TOKEN = 'test-token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      user: { email: 'owner@example.com', tier: 'free' },
      usage: { documents: 2, documentLimit: 100, totalBytes: 1024, storageLimit: 1073741824 },
    })));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await program.parseAsync(['node', 'vn', 'whoami']);

    expect(log).toHaveBeenCalledWith('owner@example.com');
    expect(log).toHaveBeenCalledWith('documents: 2/100');
    expect(log).toHaveBeenCalledWith('storage: 1.0KB/1024.00MB');
  });

  it('creates a public workspace from a file through the real command graph', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vnsh-cli-upload-'));
    roots.push(root);
    const file = join(root, 'handoff.txt');
    writeFileSync(file, 'agent handoff');
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      id: 'AbCdEf123456', version: 1, expires: '2026-08-14T00:00:00.000Z',
      public: true, url: 'https://vnshcontent.dev/p/AbCdEf123456',
    }, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await program.parseAsync(['node', 'vn', '--public', file]);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://vnsh.dev/api/workspace',
      expect.objectContaining({ method: 'POST', body: Buffer.from('agent handoff') }),
    );
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['X-Vnsh-Public']).toBe('1');
    expect(headers['X-Vnsh-Write-Hash']).toMatch(/^[a-f0-9]{64}$/);
  });
});
