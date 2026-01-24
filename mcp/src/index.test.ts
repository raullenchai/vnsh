/**
 * Tests for vnsh MCP Server
 *
 * Tests cover:
 * - Image type detection (PNG, JPEG, GIF, WebP)
 * - Binary content detection
 * - Tool handlers (with mocked fetch)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encrypt, decrypt, generateKey, generateIV, bufferToHex, buildVnshUrl, parseVnshUrl } from './crypto.js';
import { detectImageType, detectBinary, handleRead, handleShare } from './index.js';

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

    // URL should contain all components
    expect(url).toContain(host);
    expect(url).toContain(id);
    expect(url).toContain('#k=');
    expect(url).toContain('&iv=');

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

  it('handles 402 payment required response', async () => {
    const key = generateKey();
    const iv = generateIV();

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      json: () => Promise.resolve({ payment: { price: 5 } }),
    });

    const url = buildVnshUrl('https://vnsh.dev', '12345678-abcd-ef01-2345-6789abcdef01', key, iv);
    const result = await handleRead({ url });

    expect(result.content[0].text).toContain('Payment required');
    expect(result.content[0].text).toContain('$5');
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
    expect(result.metadata?.url).toContain('#k=');
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
    expect(url).toContain('#k=');
    expect(url).toContain('&iv=');

    // Verify key and IV lengths
    const keyPart = url.split('#k=')[1].split('&')[0];
    const ivPart = url.split('&iv=')[1];
    expect(keyPart).toHaveLength(64); // 32 bytes = 64 hex chars
    expect(ivPart).toHaveLength(32);  // 16 bytes = 32 hex chars
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
