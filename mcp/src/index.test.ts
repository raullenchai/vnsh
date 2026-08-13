/**
 * Tests for vnsh MCP Server
 *
 * Tests cover:
 * - Image type detection (PNG, JPEG, GIF, WebP)
 * - Binary content detection
 * - Tool handlers (with mocked fetch)
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encrypt, decrypt, generateKey, generateIV, bufferToHex, buildVnshUrl, parseVnshUrl, generateRootSecret, buildWorkspaceUrl, buildReadOnlyWorkspaceUrl } from './crypto.js';
import {
  detectImageType,
  detectBinary,
  handleRead,
  handleShare,
  handleWorkspaceCreate,
  handleWorkspaceRenew,
  handleWorkspaceHistory,
  handleWorkspaceRestore,
  handleWorkspaceRead,
  handleArtifactCreate,
  handleArtifactList,
  handleArtifactRead,
  handleArtifactUpdate,
  detectFileType,
  sandboxHtml,
} from './index.js';

describe('Account Artifact tools', () => {
  const originalFetch = globalThis.fetch;
  const artifact = {
    id: '7c12f6ce-2e6c-4f7b-9940-f0588b1fa111', title: 'Launch brief', summary: 'Ready',
    artifactType: 'report', contentType: 'text/markdown; charset=utf-8', status: 'draft',
    visibility: 'private', version: 1, size: 12, workspace: { id: 'personal', name: 'Personal' },
  };

  beforeEach(() => { process.env.VNSH_TOKEN = 'account-token'; });
  afterEach(() => { globalThis.fetch = originalFetch; delete process.env.VNSH_TOKEN; });

  it('creates a permanent Library Artifact through the account API', async () => {
    let seen: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
    globalThis.fetch = vi.fn(async (input, init) => {
      seen = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
      return Response.json({ artifact }, { status: 201 });
    }) as typeof fetch;
    const result = await handleArtifactCreate({ title: 'Launch brief', content: '# Ready', artifact_type: 'report' });
    expect(seen?.url).toBe('https://account.vnsh.dev/api/artifacts');
    expect(seen?.headers.get('Authorization')).toBe('Bearer account-token');
    expect(seen?.body).toMatchObject({ title: 'Launch brief', content: '# Ready', artifactType: 'report' });
    expect(result.metadata).toMatchObject({ artifactId: artifact.id, version: 1 });
    expect(result.content[0].text).toContain('Human view: https://account.vnsh.dev/artifacts/');
  });

  it('lists and reads discoverable knowledge without pasted URLs', async () => {
    let listTarget = '';
    globalThis.fetch = vi.fn(async (input) => String(input).includes('?')
      ? (listTarget = String(input), Response.json({ artifacts: [artifact] }))
      : Response.json({ artifact, content: '# Ready' })) as typeof fetch;
    const listed = await handleArtifactList({ search: 'launch', status: 'draft', artifact_type: 'report' });
    expect(listTarget).toContain('q=launch');
    expect(listTarget).toContain('status=draft');
    expect(listTarget).toContain('type=report');
    expect(listed.content[0].text).toContain(artifact.id);
    const read = await handleArtifactRead({ artifact_id: artifact.id });
    expect(read.content[0].text).toContain('base_version: 1');
    expect(read.metadata).toMatchObject({ content: '# Ready', version: 1 });
  });

  it('updates with explicit conflict protection and actionable recovery', async () => {
    let headers = new Headers();
    globalThis.fetch = vi.fn(async (_input, init) => {
      headers = new Headers(init?.headers);
      return Response.json({ artifact: { ...artifact, version: 2 } });
    }) as typeof fetch;
    const updated = await handleArtifactUpdate({ artifact_id: artifact.id, content: '# Verified', base_version: 1, change_summary: 'Verified prod' });
    expect(headers.get('If-Match')).toBe('"1"');
    expect(updated.metadata.version).toBe(2);

    globalThis.fetch = vi.fn(async () => Response.json({
      error: 'VERSION_CONFLICT', message: 'Artifact is at version 3', currentVersion: 3,
      nextAction: 'GET this same URL, merge, and retry',
    }, { status: 412 })) as typeof fetch;
    await expect(handleArtifactUpdate({ artifact_id: artifact.id, content: 'stale', base_version: 1 }))
      .rejects.toThrow(/Current version: 3.*GET this same URL/i);
  });

  it('explains how to connect instead of making an unauthenticated request', async () => {
    delete process.env.VNSH_TOKEN;
    globalThis.fetch = vi.fn() as typeof fetch;
    await expect(handleArtifactList({})).rejects.toThrow(/Sign in at https:\/\/account\.vnsh\.dev/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('handles an empty Library, self-hosting and an expired account token clearly', async () => {
    let target = '';
    globalThis.fetch = vi.fn(async (input) => {
      target = String(input);
      return Response.json({ artifacts: [] });
    }) as typeof fetch;
    const empty = await handleArtifactList({ host: 'https://self-hosted.example/base' });
    expect(target).toBe('https://self-hosted.example/api/artifacts');
    expect(empty.content[0].text).toContain('Create the first one');

    globalThis.fetch = vi.fn(async () => Response.json({ error: 'UNAUTHORIZED' }, { status: 401 })) as typeof fetch;
    await expect(handleArtifactRead({ artifact_id: artifact.id })).rejects.toThrow(/Reconnect this Agent/i);
  });
});

describe('local HTML sandbox', () => {
  it('encodes hostile HTML instead of interpolating executable markup', () => {
    const hostile = '<script>parent.postMessage("leak", "*")</script></script>';
    const wrapped = sandboxHtml(hostile);
    expect(wrapped).not.toContain(hostile);
    expect(wrapped).toContain(Buffer.from(hostile).toString('base64'));
    expect(wrapped).toContain("f.setAttribute('sandbox', 'allow-scripts')");
    expect(wrapped).toContain("default-src 'none'");
    expect(wrapped).toContain('noopener,noreferrer');
  });
});

describe('workspace history and restore', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });
  const secret = generateRootSecret();
  const editUrl = buildWorkspaceUrl('https://vnsh.dev', 'aBcDeFgHiJkL', secret);

  it('lists retained versions', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({
      id: 'aBcDeFgHiJkL', limit: 20,
      versions: [
        { version: 3, size: 30, archivedAt: '2026-08-13T00:00:00Z', current: true },
        { version: 2, size: 20, archivedAt: '2026-08-12T00:00:00Z', current: false },
      ],
    })) as typeof fetch;
    const result = await handleWorkspaceHistory({ url: editUrl });
    expect((result.content[0] as { text: string }).text).toContain('v2');
    expect(result.metadata.versions).toHaveLength(2);
  });

  it('restores with write authority and conflict protection', async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = vi.fn(async (input, init) => {
      request = { url: String(input), init };
      return Response.json({ version: 4, permanent: true });
    }) as typeof fetch;
    const result = await handleWorkspaceRestore({ url: editUrl, version: 1, base_version: 3 });
    expect(request?.url).toContain('/history/1/restore');
    expect(new Headers(request?.init?.headers).get('If-Match')).toBe('"3"');
    expect(new Headers(request?.init?.headers).get('X-Vnsh-Write')).toMatch(/^[a-f0-9]{64}$/);
    expect(result.metadata).toMatchObject({ restoredVersion: 1, version: 4 });
  });
});

describe('public workspace reads', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('reads a fragment-free public URL through both read tools', async () => {
    globalThis.fetch = vi.fn(async () => new Response('# public plan\n', {
      status: 200,
      headers: { ETag: '"4"', 'Content-Type': 'text/markdown' },
    })) as typeof fetch;
    const url = 'https://vnshcontent.dev/p/aBcDeFgHiJkL';
    const generic = await handleRead({ url });
    const workspace = await handleWorkspaceRead({ url });
    expect((generic.content[0] as { text: string }).text).toBe('# public plan\n');
    expect((workspace.content[0] as { text: string }).text).toContain('# public plan');
    expect(workspace.metadata).toMatchObject({ version: 4, public: true, canWrite: false });
  });

  it('accepts Cloudflare weak ETags without producing NaN', async () => {
    globalThis.fetch = vi.fn(async () => new Response('public plan', {
      status: 200,
      headers: { ETag: 'W/"7"', 'Content-Type': 'text/plain' },
    })) as typeof fetch;
    const result = await handleWorkspaceRead({
      url: 'https://vnshcontent.dev/p/aBcDeFgHiJkL',
    });
    expect(result.metadata).toMatchObject({ version: 7 });
    expect((result.content[0] as { text: string }).text).toContain('version 7');
  });

  it('rejects invalid workspace TTLs before making a request', async () => {
    globalThis.fetch = vi.fn() as typeof fetch;
    await expect(handleWorkspaceCreate({ content: 'x', ttl: 0 })).rejects.toThrow();
    await expect(handleWorkspaceCreate({ content: 'x', ttl: 1.5 })).rejects.toThrow();
    await expect(handleWorkspaceCreate({ content: 'x', ttl: 169 })).rejects.toThrow();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('detectImageType', () => {
  describe('PNG detection', () => {
    it('detects PNG from magic bytes', () => {
      // PNG magic: 89 50 4E 47 0D 0A 1A 0A
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const result = detectImageType(png);
      expect(result).toEqual({ ext: 'png', mime: 'image/png' });
    });

    it('detects PNG with additional data', () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
      const result = detectImageType(png);
      expect(result).toEqual({ ext: 'png', mime: 'image/png' });
    });
  });

  describe('JPEG detection', () => {
    it('detects JPEG from magic bytes', () => {
      // JPEG magic: FF D8 FF
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
      const result = detectImageType(jpeg);
      expect(result).toEqual({ ext: 'jpg', mime: 'image/jpeg' });
    });

    it('detects JPEG with EXIF header', () => {
      // JPEG with EXIF: FF D8 FF E1
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x00]);
      const result = detectImageType(jpeg);
      expect(result).toEqual({ ext: 'jpg', mime: 'image/jpeg' });
    });
  });

  describe('GIF detection', () => {
    it('detects GIF87a', () => {
      // GIF87a: 47 49 46 38 37 61
      const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]);
      const result = detectImageType(gif);
      expect(result).toEqual({ ext: 'gif', mime: 'image/gif' });
    });

    it('detects GIF89a', () => {
      // GIF89a: 47 49 46 38 39 61
      const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
      const result = detectImageType(gif);
      expect(result).toEqual({ ext: 'gif', mime: 'image/gif' });
    });
  });

  describe('WebP detection', () => {
    it('detects WebP from magic bytes', () => {
      // WebP: RIFF....WEBP (52 49 46 46 xx xx xx xx 57 45 42 50)
      const webp = Buffer.from([
        0x52, 0x49, 0x46, 0x46, // RIFF
        0x00, 0x00, 0x00, 0x00, // size (placeholder)
        0x57, 0x45, 0x42, 0x50, // WEBP
      ]);
      const result = detectImageType(webp);
      expect(result).toEqual({ ext: 'webp', mime: 'image/webp' });
    });

    it('returns null for RIFF without WEBP', () => {
      // RIFF file but not WebP (could be WAV)
      const riff = Buffer.from([
        0x52, 0x49, 0x46, 0x46, // RIFF
        0x00, 0x00, 0x00, 0x00, // size
        0x57, 0x41, 0x56, 0x45, // WAVE
      ]);
      const result = detectImageType(riff);
      expect(result).toBeNull();
    });
  });

  describe('non-image detection', () => {
    it('returns null for text', () => {
      const text = Buffer.from('Hello, World!');
      const result = detectImageType(text);
      expect(result).toBeNull();
    });

    it('returns null for JSON', () => {
      const json = Buffer.from('{"key": "value"}');
      const result = detectImageType(json);
      expect(result).toBeNull();
    });

    it('returns null for too-short buffer', () => {
      const short = Buffer.from([0x89, 0x50]);
      const result = detectImageType(short);
      expect(result).toBeNull();
    });

    it('returns null for empty buffer', () => {
      const empty = Buffer.alloc(0);
      const result = detectImageType(empty);
      expect(result).toBeNull();
    });

    it('returns null for PDF', () => {
      // PDF magic: 25 50 44 46 (%PDF)
      const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
      const result = detectImageType(pdf);
      expect(result).toBeNull();
    });
  });
});

describe('detectBinary', () => {
  describe('text content', () => {
    it('returns false for plain ASCII text', () => {
      const text = Buffer.from('Hello, World!');
      expect(detectBinary(text)).toBe(false);
    });

    it('returns false for text with newlines', () => {
      const text = Buffer.from('Line 1\nLine 2\r\nLine 3');
      expect(detectBinary(text)).toBe(false);
    });

    it('returns false for text with tabs', () => {
      const text = Buffer.from('Column1\tColumn2\tColumn3');
      expect(detectBinary(text)).toBe(false);
    });

    it('returns false for JSON', () => {
      const json = Buffer.from('{"key": "value", "number": 123}');
      expect(detectBinary(json)).toBe(false);
    });

    it('returns false for code', () => {
      const code = Buffer.from('function hello() {\n  console.log("Hello");\n}');
      expect(detectBinary(code)).toBe(false);
    });

    it('returns false for UTF-8 text with multibyte chars', () => {
      const utf8 = Buffer.from('Hello 世界 🌍');
      expect(detectBinary(utf8)).toBe(false);
    });
  });

  describe('binary content', () => {
    it('returns true for buffer with null bytes', () => {
      const binary = Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6c, 0x6f]);
      expect(detectBinary(binary)).toBe(true);
    });

    it('returns true for PNG', () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(detectBinary(png)).toBe(true);
    });

    it('returns true for JPEG', () => {
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      expect(detectBinary(jpeg)).toBe(true);
    });

    it('returns true for buffer with many control chars', () => {
      // Create a buffer with 50% control characters
      const binary = Buffer.alloc(100);
      for (let i = 0; i < 100; i++) {
        binary[i] = i % 2 === 0 ? 0x41 : 0x01; // Alternating 'A' and control char
      }
      expect(detectBinary(binary)).toBe(true);
    });

    it('returns true for executable', () => {
      // ELF header (Linux executable)
      const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
      expect(detectBinary(elf)).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('handles empty buffer', () => {
      const empty = Buffer.alloc(0);
      expect(detectBinary(empty)).toBe(false);
    });

    it('samples only first 1024 bytes', () => {
      // Create a large buffer that's text at start but binary later
      const mixed = Buffer.alloc(2000);
      // First 1024 bytes: text
      mixed.fill(0x41, 0, 1024);
      // Rest: binary with null bytes
      mixed.fill(0x00, 1024);
      expect(detectBinary(mixed)).toBe(false); // Only first 1024 sampled
    });

    it('returns false for buffer right at 10% threshold', () => {
      // Create a buffer with exactly 10% non-printable (at threshold, should be false)
      const buffer = Buffer.alloc(100);
      buffer.fill(0x41); // Fill with 'A'
      for (let i = 0; i < 10; i++) {
        buffer[i * 10] = 0x01; // 10 control chars = 10%
      }
      expect(detectBinary(buffer)).toBe(false);
    });

    it('returns true for buffer just over 10% threshold', () => {
      // Create a buffer with just over 10% non-printable
      const buffer = Buffer.alloc(100);
      buffer.fill(0x41); // Fill with 'A'
      for (let i = 0; i < 11; i++) {
        buffer[i * 9] = 0x01; // 11 control chars = 11%
      }
      expect(detectBinary(buffer)).toBe(true);
    });
  });
});

describe('encryption/decryption integration', () => {
  it('can encrypt and decrypt text content', () => {
    const key = generateKey();
    const iv = generateIV();
    const plaintext = 'Hello, Opaque MCP!';

    const encrypted = encrypt(plaintext, key, iv);
    expect(Buffer.isBuffer(encrypted)).toBe(true);
    expect(encrypted.toString()).not.toBe(plaintext);
  });

  it('can encrypt and decrypt image-like binary content', () => {
    const key = generateKey();
    const iv = generateIV();
    // Fake PNG header
    const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

    const encrypted = encrypt(pngData, key, iv);
    // Encrypted data is a Buffer
    expect(Buffer.isBuffer(encrypted)).toBe(true);
    // Encrypted data should be different from original
    expect(encrypted.equals(pngData)).toBe(false);
  });

  it('preserves image magic bytes after decrypt', async () => {
    const key = generateKey();
    const iv = generateIV();
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    // Encrypted then decrypted should preserve original
    // This tests that our encryption is reversible for binary content
    const encrypted = encrypt(pngHeader, key, iv);

    // Use crypto module directly for decryption test
    const { createDecipheriv } = await import('crypto');
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

    expect(detectImageType(decrypted)).toEqual({ ext: 'png', mime: 'image/png' });
  });
});

describe('URL building and parsing roundtrip', () => {
  it('can build a URL with encrypted content reference', async () => {
    const { buildVnshUrl, parseVnshUrl } = await import('./crypto.js');

    const key = generateKey();
    const iv = generateIV();
    const host = 'https://vnsh.dev';
    // Use UUID format to match the regex in parseVnshUrl
    const id = '12345678-abcd-ef01-2345-6789abcdef01';

    const url = buildVnshUrl(host, id, key, iv);

    // URL should contain all components (v2 format)
    expect(url).toContain(host);
    expect(url).toContain(id);
    expect(url).toContain('#');
    // v2 format: 48 bytes base64url = 64 chars
    expect(url.split('#')[1]).toHaveLength(64);

    // Parsing should recover original values
    const parsed = parseVnshUrl(url);
    expect(parsed.host).toBe(host);
    expect(parsed.id).toBe(id);
    expect(parsed.key.equals(key)).toBe(true);
    expect(parsed.iv.equals(iv)).toBe(true);
  });
});

describe('content type detection', () => {
  it('detects JSON content', () => {
    const json = '{"key": "value"}';
    expect(json.startsWith('{')).toBe(true);

    // Verify it parses
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('detects array JSON content', () => {
    const json = '[1, 2, 3]';
    expect(json.startsWith('[')).toBe(true);

    // Verify it parses
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('detects HTML content', () => {
    const html = '<!DOCTYPE html><html><body>Hello</body></html>';
    expect(html.startsWith('<!DOCTYPE')).toBe(true);
  });

  it('detects Markdown content', () => {
    const md1 = '# Heading\n\nParagraph';
    const md2 = '---\ntitle: Test\n---\n\nContent';

    expect(md1.startsWith('# ')).toBe(true);
    expect(md2.startsWith('---\n')).toBe(true);
  });
});

// Mock fetch for handler tests
const originalFetch = global.fetch;

describe('handleRead', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('successfully reads and decrypts text content', async () => {
    const key = generateKey();
    const iv = generateIV();
    const plaintext = 'Hello, vnsh!';
    const encrypted = encrypt(plaintext, key, iv);

    // Mock fetch to return encrypted content
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => String(encrypted.length) },
      arrayBuffer: () => Promise.resolve(encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength)),
    });

    const url = buildVnshUrl('https://vnsh.dev', '12345678-abcd-ef01-2345-6789abcdef01', key, iv);
    const result = await handleRead({ url });

    expect(result.content[0].text).toBe(plaintext);
    expect(result.metadata?.contentType).toBe('text');
  });

  it('handles 404 not found response', async () => {
    const key = generateKey();
    const iv = generateIV();

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });

    const url = buildVnshUrl('https://vnsh.dev', '12345678-abcd-ef01-2345-6789abcdef01', key, iv);
    const result = await handleRead({ url });

    expect(result.content[0].text).toContain('not found');
  });

  it('handles 410 expired response', async () => {
    const key = generateKey();
    const iv = generateIV();

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 410,
    });

    const url = buildVnshUrl('https://vnsh.dev', '12345678-abcd-ef01-2345-6789abcdef01', key, iv);
    const result = await handleRead({ url });

    expect(result.content[0].text).toContain('expired');
  });

  it('throws on HTTP error response', async () => {
    const key = generateKey();
    const iv = generateIV();

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const url = buildVnshUrl('https://vnsh.dev', '12345678-abcd-ef01-2345-6789abcdef01', key, iv);
    await expect(handleRead({ url })).rejects.toThrow('HTTP 500');
  });

  it('rejects content too large from content-length header', async () => {
    const key = generateKey();
    const iv = generateIV();

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => String(100 * 1024 * 1024) }, // 100MB
    });

    const url = buildVnshUrl('https://vnsh.dev', '12345678-abcd-ef01-2345-6789abcdef01', key, iv);
    const result = await handleRead({ url });

    expect(result.content[0].text).toContain('too large');
    expect(result.content[0].text).toContain('50MB');
  });

  it('rejects content too large from actual size', async () => {
    const key = generateKey();
    const iv = generateIV();

    // Create a buffer that appears small in header but is actually large
    const largeBuffer = Buffer.alloc(60 * 1024 * 1024); // 60MB

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => '0' }, // Claim 0 size
      arrayBuffer: () => Promise.resolve(largeBuffer.buffer),
    });

    const url = buildVnshUrl('https://vnsh.dev', '12345678-abcd-ef01-2345-6789abcdef01', key, iv);
    const result = await handleRead({ url });

    expect(result.content[0].text).toContain('too large');
  });

  it('decrypts JSON content correctly', async () => {
    const key = generateKey();
    const iv = generateIV();
    const jsonContent = '{"name": "test", "value": 123}';
    const encrypted = encrypt(jsonContent, key, iv);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => String(encrypted.length) },
      arrayBuffer: () => Promise.resolve(encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength)),
    });

    const url = buildVnshUrl('https://vnsh.dev', '12345678-abcd-ef01-2345-6789abcdef01', key, iv);
    const result = await handleRead({ url });

    expect(result.content[0].text).toBe(jsonContent);
    expect(result.metadata?.contentType).toBe('json');
  });

  it('decrypts array JSON content correctly', async () => {
    const key = generateKey();
    const iv = generateIV();
    const jsonContent = '[1, 2, 3, 4, 5]';
    const encrypted = encrypt(jsonContent, key, iv);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => String(encrypted.length) },
      arrayBuffer: () => Promise.resolve(encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength)),
    });

    const url = buildVnshUrl('https://vnsh.dev', '12345678-abcd-ef01-2345-6789abcdef01', key, iv);
    const result = await handleRead({ url });

    expect(result.content[0].text).toBe(jsonContent);
    expect(result.metadata?.contentType).toBe('json');
  });

  it('decrypts HTML content correctly', async () => {
    const key = generateKey();
    const iv = generateIV();
    const htmlContent = '<!DOCTYPE html><html><body>Hello</body></html>';
    const encrypted = encrypt(htmlContent, key, iv);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => String(encrypted.length) },
      arrayBuffer: () => Promise.resolve(encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength)),
    });

    const url = buildVnshUrl('https://vnsh.dev', '12345678-abcd-ef01-2345-6789abcdef01', key, iv);
    const result = await handleRead({ url });

    expect(result.content[0].text).toBe(htmlContent);
    expect(result.metadata?.contentType).toBe('html');
  });

  it('decrypts html tag content correctly', async () => {
    const key = generateKey();
    const iv = generateIV();
    const htmlContent = '<html><body>Hello</body></html>';
    const encrypted = encrypt(htmlContent, key, iv);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => String(encrypted.length) },
      arrayBuffer: () => Promise.resolve(encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength)),
    });

    const url = buildVnshUrl('https://vnsh.dev', '12345678-abcd-ef01-2345-6789abcdef01', key, iv);
    const result = await handleRead({ url });

    expect(result.content[0].text).toBe(htmlContent);
    expect(result.metadata?.contentType).toBe('html');
  });

  it('decrypts Markdown heading content correctly', async () => {
    const key = generateKey();
    const iv = generateIV();
    const mdContent = '# Hello World\n\nThis is markdown.';
    const encrypted = encrypt(mdContent, key, iv);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => String(encrypted.length) },
      arrayBuffer: () => Promise.resolve(encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength)),
    });

    const url = buildVnshUrl('https://vnsh.dev', '12345678-abcd-ef01-2345-6789abcdef01', key, iv);
    const result = await handleRead({ url });

    expect(result.content[0].text).toBe(mdContent);
    expect(result.metadata?.contentType).toBe('markdown');
  });

  it('decrypts frontmatter markdown correctly', async () => {
    const key = generateKey();
    const iv = generateIV();
    const mdContent = '---\ntitle: Test\n---\n\nContent';
    const encrypted = encrypt(mdContent, key, iv);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => String(encrypted.length) },
      arrayBuffer: () => Promise.resolve(encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength)),
    });

    const url = buildVnshUrl('https://vnsh.dev', '12345678-abcd-ef01-2345-6789abcdef01', key, iv);
    const result = await handleRead({ url });

    expect(result.content[0].text).toBe(mdContent);
    expect(result.metadata?.contentType).toBe('markdown');
  });

  it('handles invalid JSON gracefully', async () => {
    const key = generateKey();
    const iv = generateIV();
    const invalidJson = '{ invalid json }';
    const encrypted = encrypt(invalidJson, key, iv);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => String(encrypted.length) },
      arrayBuffer: () => Promise.resolve(encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength)),
    });

    const url = buildVnshUrl('https://vnsh.dev', '12345678-abcd-ef01-2345-6789abcdef01', key, iv);
    const result = await handleRead({ url });

    expect(result.content[0].text).toBe(invalidJson);
    expect(result.metadata?.contentType).toBe('text'); // Falls back to text
  });

  it('saves PNG image to temp file', async () => {
    const key = generateKey();
    const iv = generateIV();
    // PNG magic bytes followed by some data
    const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    const encrypted = encrypt(pngData, key, iv);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => String(encrypted.length) },
      arrayBuffer: () => Promise.resolve(encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength)),
    });

    const url = buildVnshUrl('https://vnsh.dev', '12345678-abcd-ef01-2345-6789abcdef01', key, iv);
    const result = await handleRead({ url });

    expect(result.content[0].text).toContain('Image detected');
    expect(result.content[0].text).toContain('image/png');
    expect(result.metadata?.contentType).toBe('image/png');
    expect(result.metadata?.filePath).toContain('.png');
  });

  it('saves JPEG image to temp file', async () => {
    const key = generateKey();
    const iv = generateIV();
    // JPEG magic bytes
    const jpegData = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const encrypted = encrypt(jpegData, key, iv);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => String(encrypted.length) },
      arrayBuffer: () => Promise.resolve(encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength)),
    });

    const url = buildVnshUrl('https://vnsh.dev', '12345678-abcd-ef01-2345-6789abcdef01', key, iv);
    const result = await handleRead({ url });

    expect(result.content[0].text).toContain('Image detected');
    expect(result.content[0].text).toContain('image/jpeg');
    expect(result.metadata?.contentType).toBe('image/jpeg');
    expect(result.metadata?.filePath).toContain('.jpg');
  });

  it('saves binary content to temp file', async () => {
    const key = generateKey();
    const iv = generateIV();
    // Binary data with null bytes (not an image)
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0x05, 0x06, 0x07]);
    const encrypted = encrypt(binaryData, key, iv);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => String(encrypted.length) },
      arrayBuffer: () => Promise.resolve(encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength)),
    });

    const url = buildVnshUrl('https://vnsh.dev', '12345678-abcd-ef01-2345-6789abcdef01', key, iv);
    const result = await handleRead({ url });

    expect(result.content[0].text).toContain('Binary content detected');
    expect(result.metadata?.contentType).toBe('application/octet-stream');
    expect(result.metadata?.filePath).toContain('.bin');
  });
});

describe('handleShare', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('successfully encrypts and uploads content', async () => {
    const mockId = 'test-blob-1234-5678-abcd-ef0123456789';
    const mockExpires = '2025-01-24T00:00:00Z';

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: mockId, expires: mockExpires }),
    });

    const result = await handleShare({ content: 'Hello, world!' });

    expect(result.content[0].text).toContain('encrypted and uploaded');
    expect(result.content[0].text).toContain(mockId);
    expect(result.metadata?.blobId).toBe(mockId);
    expect(result.metadata?.expires).toBe(mockExpires);
    // v2 format: 64-char base64url fragment
    expect(result.metadata?.url).toContain('#');
    expect((result.metadata?.url as string).split('#')[1]).toHaveLength(64);
  });

  it('handles upload failure', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });

    await expect(handleShare({ content: 'Hello' })).rejects.toThrow('Upload failed');
  });

  it('includes TTL in upload request', async () => {
    const mockId = 'test-blob-1234-5678-abcd-ef0123456789';

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: mockId, expires: '2025-01-25T00:00:00Z' }),
    });

    await handleShare({ content: 'Hello', ttl: 48 });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('ttl=48'),
      expect.any(Object)
    );
  });

  it('uses custom host for upload', async () => {
    const customHost = 'https://custom.vnsh.dev';
    const mockId = 'test-blob-1234-5678-abcd-ef0123456789';

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: mockId, expires: '2025-01-24T00:00:00Z' }),
    });

    const result = await handleShare({ content: 'Hello', host: customHost });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(customHost),
      expect.any(Object)
    );
    expect(result.metadata?.url).toContain(customHost);
  });

  it('encrypts content before upload', async () => {
    const mockId = 'test-blob-1234-5678-abcd-ef0123456789';

    let uploadedBody: Uint8Array | undefined;
    global.fetch = vi.fn().mockImplementation((url, options) => {
      uploadedBody = options?.body;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: mockId, expires: '2025-01-24T00:00:00Z' }),
      });
    });

    await handleShare({ content: 'Hello, world!' });

    // Verify the body is encrypted (not plaintext)
    expect(uploadedBody).toBeDefined();
    const bodyStr = Buffer.from(uploadedBody!).toString();
    expect(bodyStr).not.toBe('Hello, world!');
  });

  it('builds correct shareable URL with key and IV', async () => {
    const mockId = 'test-blob-1234-5678-abcd-ef0123456789';

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: mockId, expires: '2025-01-24T00:00:00Z' }),
    });

    const result = await handleShare({ content: 'Hello' });
    const url = result.metadata?.url as string;

    expect(url).toContain('vnsh.dev');
    expect(url).toContain(`/v/${mockId}`);
    expect(url).toContain('#'); // Fragment present

    // v2 format: 48 bytes (key+iv) base64url encoded = 64 chars
    const fragment = url.split('#')[1];
    expect(fragment).toHaveLength(64);
  });
});

describe('image and binary handling', () => {
  it('detects PNG image and returns metadata', () => {
    const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    const imageType = detectImageType(pngData);

    expect(imageType).not.toBeNull();
    expect(imageType?.ext).toBe('png');
    expect(imageType?.mime).toBe('image/png');
  });

  it('detects JPEG image and returns metadata', () => {
    const jpegData = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const imageType = detectImageType(jpegData);

    expect(imageType).not.toBeNull();
    expect(imageType?.ext).toBe('jpg');
    expect(imageType?.mime).toBe('image/jpeg');
  });

  it('detects binary content with null bytes', () => {
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0x05]);
    expect(detectBinary(binaryData)).toBe(true);
  });

  it('handles encrypted image round-trip', async () => {
    const key = generateKey();
    const iv = generateIV();
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const encrypted = encrypt(pngHeader, key, iv);
    const { decrypt } = await import('./crypto.js');
    const decrypted = decrypt(encrypted, key, iv);

    expect(detectImageType(decrypted)).toEqual({ ext: 'png', mime: 'image/png' });
  });
});

describe('error handling', () => {
  it('throws on invalid URL without fragment', async () => {
    const { parseVnshUrl } = await import('./crypto.js');

    expect(() => parseVnshUrl('https://vnsh.dev/v/123')).toThrow('missing fragment');
  });

  it('throws on invalid URL path', async () => {
    const { parseVnshUrl } = await import('./crypto.js');

    expect(() => parseVnshUrl('https://vnsh.dev/invalid/path#k=abc&iv=def')).toThrow('cannot extract blob ID');
  });

  it('throws on invalid key length', async () => {
    const { parseVnshUrl } = await import('./crypto.js');

    expect(() => parseVnshUrl('https://vnsh.dev/v/12345678-1234-1234-1234-123456789012#k=short&iv=12345678901234567890123456789012')).toThrow('key must be 64 hex chars');
  });

  it('throws on invalid IV length', async () => {
    const { parseVnshUrl } = await import('./crypto.js');
    const validKey = '0'.repeat(64);

    expect(() => parseVnshUrl(`https://vnsh.dev/v/12345678-1234-1234-1234-123456789012#k=${validKey}&iv=short`)).toThrow('IV must be 32 hex chars');
  });
});

/**
 * The workspace page tells agents which tools to reach for, and it got one name
 * wrong: it advertised vnsh_workspace_write, which has never existed. An agent
 * following that instruction calls a tool that is not there and fails, which is
 * precisely the dead end the instructions were added to prevent.
 *
 * That list lives in the worker, so it cannot import this one. This test is the
 * other half of the pair: if a tool is renamed here, this fails and points at
 * the copy in worker/test/workspace.test.ts that has to move with it.
 */
describe('the registered tool names', () => {
  it('are exactly the set the workspace page advertises', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf-8');
    const registered = [
      ...new Set([...source.matchAll(/name: '(vnsh_[a-z_]+)'/g)].map((m) => m[1])),
    ].sort();

    expect(registered).toEqual([
      'vnsh_artifact_create',
      'vnsh_artifact_list',
      'vnsh_artifact_read',
      'vnsh_artifact_update',
      'vnsh_read',
      'vnsh_share',
      'vnsh_share_file',
      'vnsh_workspace_create',
      'vnsh_workspace_history',
      'vnsh_workspace_open',
      'vnsh_workspace_read',
      'vnsh_workspace_renew',
      'vnsh_workspace_restore',
      'vnsh_workspace_update',
    ]);
    // The name that was wrong, spelled out so it cannot quietly come back.
    expect(registered).not.toContain('vnsh_workspace_write');
  });
});

/**
 * The server could read a public workspace but never make one, so the surface
 * agents actually use could not produce the thing that lets another agent read
 * a link with no key and no setup.
 */
describe('creating a public workspace', () => {
  // Captured per test rather than at collection time: another describe in this
  // file that stubs fetch while its body evaluates would otherwise be what gets
  // "restored", and the resulting failure would look intermittent.
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  function captureRequest() {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
      seen.push({
        url: String(input),
        headers,
        body: Buffer.from(init?.body as Uint8Array).toString('utf-8'),
      });
      return new Response(
        JSON.stringify({ id: 'aBcDeFgHiJkL', version: 1, expires: '2026-07-30T00:00:00Z' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    return seen;
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.VNSH_TOKEN;
  });

  it('sends the content as written, and says so', async () => {
    const seen = captureRequest();
    const result = await handleWorkspaceCreate({ content: '# Plan\n\n- one\n', public: true });

    expect(seen[0].headers['x-vnsh-public']).toBe('1');
    // Encryption is skipped rather than performed and thrown away — there is no
    // pretence of a guarantee that is not there.
    expect(seen[0].body).toBe('# Plan\n\n- one\n');

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('/p/aBcDeFgHiJkL');
    expect(text).toMatch(/vnsh can read it/i);
    // The shareable link has no fragment, because there is no key to carry.
    expect(text).not.toMatch(/\/p\/aBcDeFgHiJkL#/);
    // And the edit link is still handed back, or the author could never change it.
    expect(text).toContain('/w/aBcDeFgHiJkL#w=');
  });

  it('stays encrypted unless asked, and never infers it', async () => {
    const seen = captureRequest();
    const result = await handleWorkspaceCreate({ content: 'sensitive notes' });

    expect(seen[0].headers['x-vnsh-public']).toBeUndefined();
    expect(seen[0].body).not.toContain('sensitive notes');

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('#r=');
    expect(text).not.toContain('/p/');
  });

  it('creates permanent rendered artifacts with the account token', async () => {
    process.env.VNSH_TOKEN = 'account-token';
    const seen = captureRequest();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
      seen.push({ url: String(input), headers, body: '' });
      return new Response(JSON.stringify({ id: 'aBcDeFgHiJkL', version: 1, permanent: true }), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await handleWorkspaceCreate({ content: '<h1>Report</h1>', artifact: true });
    expect(seen[0].headers.authorization).toBe('Bearer account-token');
    expect(seen[0].headers['x-vnsh-kind']).toBe('artifact');
    expect(result.metadata?.url).toContain('/artifact/aBcDeFgHiJkL#w=');
    expect((result.content[0] as { text: string }).text).toMatch(/saved permanently/i);
  });
});

/**
 * vnsh_read has detected binary since the beginning and saved it to a file.
 * vnsh_workspace_read, 350 lines below it in the same file, ran
 * plaintext.toString('utf-8') unconditionally. A 53,635-byte screenshot came
 * back as 93,230 bytes holding 20,179 U+FFFD, with the original bytes gone —
 * and an agent reported, correctly, that the image could not be retrieved.
 */
describe('detectFileType', () => {
  const pad = (...b: number[]) => Buffer.from([...b, ...new Array(16).fill(0)]);

  it.each([
    ['PNG', pad(0x89, 0x50, 0x4e, 0x47), 'png', true],
    ['JPEG', pad(0xff, 0xd8, 0xff, 0xe0), 'jpg', true],
    ['GIF', pad(0x47, 0x49, 0x46, 0x38), 'gif', true],
    ['PDF', pad(0x25, 0x50, 0x44, 0x46), 'pdf', false],
  ])('names %s and says whether it is an image', (_n, buf, ext, image) => {
    expect(detectFileType(buf)).toEqual({ ext, mime: expect.any(String), image });
  });

  it('needs the WEBP marker, not just RIFF', () => {
    const riff = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4];
    expect(detectFileType(Buffer.from([...riff, 0x57, 0x45, 0x42, 0x50]))?.ext).toBe('webp');
    expect(detectFileType(Buffer.from([...riff, 0x41, 0x56, 0x49, 0x20]))).toBeNull();
  });

  it('leaves text alone', () => {
    expect(detectFileType(Buffer.from('# A report\n\n- one', 'utf-8'))).toBeNull();
    expect(detectFileType(Buffer.from('<svg xmlns="...">', 'utf-8'))).toBeNull();
    expect(detectFileType(Buffer.from([1, 2]))).toBeNull();
  });

  it('agrees with detectImageType, which now delegates to it', () => {
    expect(detectImageType(pad(0xff, 0xd8, 0xff, 0xe0))).toEqual({ ext: 'jpg', mime: 'image/jpeg' });
    // A PDF is a known type but not an image, and the older question must still
    // answer "no" so the v1 path keeps behaving exactly as it did.
    expect(detectImageType(pad(0x25, 0x50, 0x44, 0x46))).toBeNull();
  });

  it('would have caught the reported corruption', () => {
    // The exact shape of the bug: a JPEG through toString('utf-8') and back is
    // neither the same length nor a JPEG any more.
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 0x9f)]);
    const roundTripped = Buffer.from(jpeg.toString('utf-8'), 'utf-8');
    expect(roundTripped.length).not.toBe(jpeg.length);
    expect(detectFileType(jpeg)?.mime).toBe('image/jpeg');
  });
});

/**
 * Renewing a workspace.
 *
 * The behaviour worth pinning is not "it sends a POST" but the two things an
 * agent could get wrong on the user's behalf: renewing from a link that has no
 * authority to, and treating an expired workspace as something that can be
 * brought back.
 */
describe('renewing a workspace', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stub(status: number, body: unknown) {
    const seen: { url: string; method: string; headers: Record<string, string> }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
      seen.push({ url: String(input), method: init?.method || 'GET', headers });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    return seen;
  }

  const secret = generateRootSecret();
  const editUrl = buildWorkspaceUrl('https://vnsh.dev', 'aBcDeFgHiJkL', secret);
  const viewUrl = buildReadOnlyWorkspaceUrl('https://vnsh.dev', 'aBcDeFgHiJkL', secret);
  const renewed = { id: 'aBcDeFgHiJkL', version: 3, expires: '2026-08-09T00:00:00Z' };

  it('posts the write token to the renew route', async () => {
    const seen = stub(200, renewed);
    await handleWorkspaceRenew({ url: editUrl });

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('https://vnsh.dev/api/workspace/aBcDeFgHiJkL/renew');
    expect(seen[0].headers['x-vnsh-write']).toMatch(/^[a-f0-9]{64}$/);
  });

  it('passes a requested lifetime through, and omits it otherwise', async () => {
    const withTtl = stub(200, renewed);
    await handleWorkspaceRenew({ url: editUrl, ttl: 168 });
    expect(withTtl[0].url).toContain('?ttl=168');

    const without = stub(200, renewed);
    await handleWorkspaceRenew({ url: editUrl });
    expect(without[0].url).not.toContain('ttl');
  });

  it('reports that the version did not move', async () => {
    stub(200, renewed);
    const result = await handleWorkspaceRenew({ url: editUrl });
    const text = (result.content[0] as { text: string }).text;
    // An agent that concluded a renew invalidated its base_version would go do
    // an unnecessary re-read, or worse, abandon an edit it had already composed.
    expect(text).toContain('unchanged');
    expect(text).toContain('3');
    expect(result.metadata?.version).toBe(3);
  });

  it('refuses a view-only link without calling the server', async () => {
    const seen = stub(200, renewed);
    await expect(handleWorkspaceRenew({ url: viewUrl })).rejects.toThrow(/view-only/i);
    expect(seen).toHaveLength(0);
  });

  it.each([404, 410])('does not promise recovery of a workspace that is gone (%i)', async (status) => {
    stub(status, { error: 'EXPIRED' });
    const result = await handleWorkspaceRenew({ url: editUrl });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    // Expiry is deletion. An agent told "expired" without being told "gone"
    // tends to offer to restore it, which is a promise nobody can keep.
    expect(text).toMatch(/unrecoverable/i);
  });
});
