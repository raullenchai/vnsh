/**
 * Integration Tests for vnsh
 *
 * Tests end-to-end flows including:
 * - Full encryption/decryption roundtrips
 * - CLI script validation
 * - MCP tool workflow simulation
 * - Error handling across components
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  encrypt,
  decrypt,
  generateKey,
  generateIV,
  buildVnshUrl,
  parseVnshUrl,
  bufferToHex,
  hexToBuffer,
} from './crypto.js';
import { handleRead, handleShare, detectImageType, detectBinary } from './index.js';

// Mock fetch for integration tests
const originalFetch = global.fetch;

describe('End-to-End Encryption Flow', () => {
  it('full text content roundtrip: encrypt → upload → download → decrypt', async () => {
    const key = generateKey();
    const iv = generateIV();
    const originalContent = 'This is sensitive content that needs encryption.';

    // Step 1: Encrypt on client side
    const encrypted = encrypt(originalContent, key, iv);
    expect(encrypted.toString()).not.toBe(originalContent);

    // Step 2: Simulate upload (mock server returning ID)
    const mockId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

    // Step 3: Build shareable URL (v2 format: base64url encoded key+iv in fragment)
    const url = buildVnshUrl('https://vnsh.dev', mockId, key, iv);
    expect(url).toContain('#'); // Fragment present
    expect(url.split('#')[1].length).toBe(64); // 48 bytes base64url = 64 chars
    expect(url).not.toContain(originalContent);

    // Step 4: Parse URL (simulating recipient)
    const parsed = parseVnshUrl(url);
    expect(parsed.id).toBe(mockId);

    // Step 5: Decrypt (simulating client-side decryption)
    const decrypted = decrypt(encrypted, parsed.key, parsed.iv);
    expect(decrypted.toString('utf-8')).toBe(originalContent);
  });

  it('full binary content roundtrip: encrypt → upload → download → decrypt', async () => {
    const key = generateKey();
    const iv = generateIV();
    // Simulate a PNG image
    const pngData = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG header
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
      0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10, // 16x16 dimensions
    ]);

    // Step 1: Encrypt binary content
    const encrypted = encrypt(pngData, key, iv);

    // Step 2 & 3: Build URL
    const url = buildVnshUrl('https://vnsh.dev', 'a1b2c3d4-e5f6-7890-abcd-ef1234567891', key, iv);

    // Step 4: Parse URL
    const parsed = parseVnshUrl(url);

    // Step 5: Decrypt
    const decrypted = decrypt(encrypted, parsed.key, parsed.iv);

    // Step 6: Verify image type is preserved
    const imageType = detectImageType(decrypted);
    expect(imageType).toEqual({ ext: 'png', mime: 'image/png' });
    expect(decrypted.equals(pngData)).toBe(true);
  });

  it('encryption produces different output for same content with different keys', () => {
    const content = 'Same content, different keys';
    const iv = generateIV();

    const key1 = generateKey();
    const key2 = generateKey();

    const encrypted1 = encrypt(content, key1, iv);
    const encrypted2 = encrypt(content, key2, iv);

    expect(encrypted1.equals(encrypted2)).toBe(false);
  });

  it('encryption produces different output for same content with different IVs', () => {
    const content = 'Same content, different IVs';
    const key = generateKey();

    const iv1 = generateIV();
    const iv2 = generateIV();

    const encrypted1 = encrypt(content, key, iv1);
    const encrypted2 = encrypt(content, key, iv2);

    expect(encrypted1.equals(encrypted2)).toBe(false);
  });

  it('decryption with wrong key fails', () => {
    const key1 = generateKey();
    const key2 = generateKey();
    const iv = generateIV();
    const content = 'Secret message';

    const encrypted = encrypt(content, key1, iv);

    expect(() => {
      decrypt(encrypted, key2, iv);
    }).toThrow();
  });

  it('decryption with wrong IV fails', () => {
    const key = generateKey();
    const iv1 = generateIV();
    const iv2 = generateIV();
    const content = 'Secret message';

    const encrypted = encrypt(content, key, iv1);

    expect(() => {
      decrypt(encrypted, key, iv2);
    }).toThrow();
  });
});

describe('URL Security', () => {
  it('key is only in fragment, never sent to server', () => {
    const key = generateKey();
    const iv = generateIV();
    const testId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567892';
    const url = buildVnshUrl('https://vnsh.dev', testId, key, iv);

    // Split at hash
    const [serverPart, fragment] = url.split('#');

    // Server only sees the path, not the key
    expect(serverPart).toBe(`https://vnsh.dev/v/${testId}`);
    expect(serverPart).not.toContain(bufferToHex(key));

    // Fragment contains base64url encoded key+iv (v2 format)
    // The secret is 48 bytes (key+iv) base64url encoded = 64 chars
    expect(fragment.length).toBe(64);
    // Verify round-trip works: parse the URL and check key matches
    const parsed = parseVnshUrl(url);
    expect(parsed.key.equals(key)).toBe(true);
    expect(parsed.iv.equals(iv)).toBe(true);
  });

  it('URL parsing preserves exact key and IV', () => {
    const key = generateKey();
    const iv = generateIV();
    const url = buildVnshUrl('https://vnsh.dev', 'abc12345-6789-0abc-def0-123456789abc', key, iv);

    const parsed = parseVnshUrl(url);

    expect(parsed.key.equals(key)).toBe(true);
    expect(parsed.iv.equals(iv)).toBe(true);
  });

  it('URLs with different hosts are parsed correctly', () => {
    const key = generateKey();
    const iv = generateIV();

    const hosts = ['https://vnsh.dev', 'https://staging.vnsh.dev', 'http://localhost:8787'];
    const id = 'a1b2c3d4-5678-90ab-cdef-fedcba987654';

    for (const host of hosts) {
      const url = buildVnshUrl(host, id, key, iv);
      const parsed = parseVnshUrl(url);

      expect(parsed.host).toBe(host);
      expect(parsed.id).toBe(id);
    }
  });
});

describe('MCP Tool Workflow', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('handleShare → handleRead roundtrip', async () => {
    const originalContent = 'Content shared via MCP tools';
    const mockId = 'a1b2c3d4-1234-5678-abcd-ef0123456789';

    let capturedBody: Uint8Array | undefined;

    // Mock upload
    global.fetch = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.includes('/api/drop')) {
        capturedBody = options?.body as Uint8Array;
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ id: mockId, expires: '2025-01-25T00:00:00Z' }),
        };
      }
      return { ok: false, status: 404 };
    });

    // Step 1: Share content
    const shareResult = await handleShare({ content: originalContent });
    const shareUrl = shareResult.metadata?.url as string;

    // Extract key and IV from the URL
    const parsed = parseVnshUrl(shareUrl);

    expect(shareUrl).toContain(mockId);
    expect(capturedBody).toBeDefined();

    // Step 2: Mock download returning the captured encrypted body
    global.fetch = vi.fn().mockImplementation(async () => {
      return {
        ok: true,
        status: 200,
        headers: { get: () => String(capturedBody!.length) },
        arrayBuffer: () => Promise.resolve(capturedBody!.buffer),
      };
    });

    // Step 3: Read content back
    const readResult = await handleRead({ url: shareUrl });

    expect(readResult.content[0].text).toBe(originalContent);
  });

  it('handleShare with large content', async () => {
    const largeContent = 'x'.repeat(10000); // 10KB of content
    const mockId = 'a1b2c3d4-1234-5678-abcd-ef0123456780';

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: mockId, expires: '2025-01-25T00:00:00Z' }),
    });

    const result = await handleShare({ content: largeContent });

    expect(result.metadata?.size).toBeGreaterThan(10000);
    expect(result.content[0].text).toContain('encrypted and uploaded');
  });

  it('handleShare with special characters', async () => {
    const specialContent = '日本語テスト 🚀 <script>alert("xss")</script> \n\t\r';
    const mockId = 'a1b2c3d4-1234-5678-abcd-ef0123456781';

    let capturedBody: Uint8Array | undefined;

    global.fetch = vi.fn().mockImplementation(async (_url: string, options?: RequestInit) => {
      capturedBody = options?.body as Uint8Array;
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: mockId, expires: '2025-01-25T00:00:00Z' }),
      };
    });

    const shareResult = await handleShare({ content: specialContent });

    // Mock read with captured body
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => String(capturedBody!.length) },
      arrayBuffer: () => Promise.resolve(capturedBody!.buffer),
    });

    const readResult = await handleRead({ url: shareResult.metadata?.url as string });

    expect(readResult.content[0].text).toBe(specialContent);
  });
});

describe('Content Type Detection Integration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const testCases = [
    { content: '{"key": "value"}', expectedType: 'json', name: 'JSON object' },
    { content: '[1, 2, 3]', expectedType: 'json', name: 'JSON array' },
    { content: '<!DOCTYPE html><html></html>', expectedType: 'html', name: 'HTML doctype' },
    { content: '<html><body>Hello</body></html>', expectedType: 'html', name: 'HTML tag' },
    { content: '# Heading\n\nContent', expectedType: 'markdown', name: 'Markdown heading' },
    { content: '---\ntitle: Test\n---', expectedType: 'markdown', name: 'Markdown frontmatter' },
    { content: 'Plain text content', expectedType: 'text', name: 'Plain text' },
    { content: 'function foo() {}', expectedType: 'text', name: 'Code' },
  ];

  for (const { content, expectedType, name } of testCases) {
    it(`detects ${name} as ${expectedType}`, async () => {
      const key = generateKey();
      const iv = generateIV();
      const encrypted = encrypt(content, key, iv);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => String(encrypted.length) },
        arrayBuffer: () => Promise.resolve(encrypted.buffer.slice(
          encrypted.byteOffset,
          encrypted.byteOffset + encrypted.byteLength
        )),
      });

      const url = buildVnshUrl('https://vnsh.dev', 'a1b2c3d4-e5f6-7890-abcd-ef1234567893', key, iv);
      const result = await handleRead({ url });

      expect(result.metadata?.contentType).toBe(expectedType);
    });
  }
});

describe('Binary Detection Integration', () => {
  const binaryTestCases = [
    // PNG has 0x1a (control char) which triggers binary detection
    { data: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], expected: true, name: 'PNG header' },
    // JPEG header alone doesn't have enough control chars - add more realistic JPEG data with null bytes
    { data: [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00], expected: true, name: 'JPEG with null' },
    // GIF header alone doesn't trigger binary - test with typical GIF data including control chars
    { data: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00], expected: true, name: 'GIF89a with data' },
    { data: [0x00, 0x01, 0x02, 0x03], expected: true, name: 'Null bytes' },
    { data: Array.from('Hello, World!').map(c => c.charCodeAt(0)), expected: false, name: 'ASCII text' },
    // ELF binary header (Linux executable)
    { data: [0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00], expected: true, name: 'ELF header' },
  ];

  for (const { data, expected, name } of binaryTestCases) {
    it(`correctly identifies ${name} as ${expected ? 'binary' : 'text'}`, () => {
      const buffer = Buffer.from(data);
      expect(detectBinary(buffer)).toBe(expected);
    });
  }
});

describe('Image Type Detection Integration', () => {
  const imageTestCases = [
    { data: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], expected: { ext: 'png', mime: 'image/png' }, name: 'PNG' },
    { data: [0xff, 0xd8, 0xff, 0xe0], expected: { ext: 'jpg', mime: 'image/jpeg' }, name: 'JPEG' },
    { data: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], expected: { ext: 'gif', mime: 'image/gif' }, name: 'GIF87a' },
    { data: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], expected: { ext: 'gif', mime: 'image/gif' }, name: 'GIF89a' },
    {
      data: [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50],
      expected: { ext: 'webp', mime: 'image/webp' },
      name: 'WebP'
    },
  ];

  for (const { data, expected, name } of imageTestCases) {
    it(`correctly identifies ${name} image`, () => {
      const buffer = Buffer.from(data);
      expect(detectImageType(buffer)).toEqual(expected);
    });
  }
});

describe('Error Handling Integration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('handles network timeout gracefully', async () => {
    const key = generateKey();
    const iv = generateIV();
    const url = buildVnshUrl('https://vnsh.dev', 'a1b2c3d4-e5f6-7890-abcd-ef1234567894', key, iv);

    global.fetch = vi.fn().mockRejectedValue(new Error('Network timeout'));

    await expect(handleRead({ url })).rejects.toThrow('Network timeout');
  });

  it('handles corrupted encrypted data', async () => {
    const key = generateKey();
    const iv = generateIV();
    const url = buildVnshUrl('https://vnsh.dev', 'a1b2c3d4-e5f6-7890-abcd-ef1234567895', key, iv);

    // Return random data that won't decrypt properly
    const corruptData = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => String(corruptData.length) },
      arrayBuffer: () => Promise.resolve(corruptData.buffer),
    });

    await expect(handleRead({ url })).rejects.toThrow();
  });

  it('handles empty response body', async () => {
    const key = generateKey();
    const iv = generateIV();
    const url = buildVnshUrl('https://vnsh.dev', 'a1b2c3d4-e5f6-7890-abcd-ef1234567896', key, iv);

    const emptyData = Buffer.alloc(0);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => '0' },
      arrayBuffer: () => Promise.resolve(emptyData.buffer),
    });

    await expect(handleRead({ url })).rejects.toThrow();
  });
});

describe('Hex Encoding Integration', () => {
  it('hex encoding/decoding preserves all byte values', () => {
    // Test all possible byte values
    const allBytes = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) {
      allBytes[i] = i;
    }

    const hex = bufferToHex(allBytes);
    const decoded = hexToBuffer(hex);

    expect(decoded.equals(allBytes)).toBe(true);
  });

  it('key and IV maintain exact 32/16 byte sizes through encoding', () => {
    const key = generateKey();
    const iv = generateIV();

    expect(key.length).toBe(32);
    expect(iv.length).toBe(16);

    const keyHex = bufferToHex(key);
    const ivHex = bufferToHex(iv);

    expect(keyHex.length).toBe(64);
    expect(ivHex.length).toBe(32);

    const keyDecoded = hexToBuffer(keyHex);
    const ivDecoded = hexToBuffer(ivHex);

    expect(keyDecoded.length).toBe(32);
    expect(ivDecoded.length).toBe(16);
  });
});
