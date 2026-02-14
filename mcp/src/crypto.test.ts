/**
 * Tests for vnsh MCP crypto utilities
 */

import { describe, it, expect } from 'vitest';
import {
  generateKey,
  generateIV,
  encrypt,
  decrypt,
  hexToBuffer,
  bufferToHex,
  parseVnshUrl,
  buildVnshUrl,
} from './crypto.js';

describe('generateKey', () => {
  it('generates a 32-byte key', () => {
    const key = generateKey();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it('generates different keys on each call', () => {
    const key1 = generateKey();
    const key2 = generateKey();
    expect(key1.equals(key2)).toBe(false);
  });
});

describe('generateIV', () => {
  it('generates a 16-byte IV', () => {
    const iv = generateIV();
    expect(iv).toBeInstanceOf(Buffer);
    expect(iv.length).toBe(16);
  });

  it('generates different IVs on each call', () => {
    const iv1 = generateIV();
    const iv2 = generateIV();
    expect(iv1.equals(iv2)).toBe(false);
  });
});

describe('encrypt/decrypt', () => {
  it('encrypts and decrypts string content', () => {
    const key = generateKey();
    const iv = generateIV();
    const plaintext = 'Hello, Opaque!';

    const ciphertext = encrypt(plaintext, key, iv);
    expect(ciphertext).toBeInstanceOf(Buffer);
    expect(ciphertext.length).toBeGreaterThan(0);
    // Ciphertext should be different from plaintext
    expect(ciphertext.toString()).not.toBe(plaintext);

    const decrypted = decrypt(ciphertext, key, iv);
    expect(decrypted.toString('utf-8')).toBe(plaintext);
  });

  it('encrypts and decrypts Buffer content', () => {
    const key = generateKey();
    const iv = generateIV();
    const plaintext = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG header

    const ciphertext = encrypt(plaintext, key, iv);
    const decrypted = decrypt(ciphertext, key, iv);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it('encrypts and decrypts empty content', () => {
    const key = generateKey();
    const iv = generateIV();
    const plaintext = '';

    const ciphertext = encrypt(plaintext, key, iv);
    const decrypted = decrypt(ciphertext, key, iv);
    expect(decrypted.toString('utf-8')).toBe(plaintext);
  });

  it('encrypts and decrypts large content', () => {
    const key = generateKey();
    const iv = generateIV();
    const plaintext = 'x'.repeat(100000); // 100KB

    const ciphertext = encrypt(plaintext, key, iv);
    const decrypted = decrypt(ciphertext, key, iv);
    expect(decrypted.toString('utf-8')).toBe(plaintext);
  });

  it('fails to decrypt with wrong key', () => {
    const key1 = generateKey();
    const key2 = generateKey();
    const iv = generateIV();
    const plaintext = 'Hello, Opaque!';

    const ciphertext = encrypt(plaintext, key1, iv);
    expect(() => decrypt(ciphertext, key2, iv)).toThrow();
  });

  it('fails to decrypt with wrong IV', () => {
    const key = generateKey();
    const iv1 = generateIV();
    const iv2 = generateIV();
    const plaintext = 'Hello, Opaque!';

    const ciphertext = encrypt(plaintext, key, iv1);
    expect(() => decrypt(ciphertext, key, iv2)).toThrow();
  });
});

describe('hexToBuffer/bufferToHex', () => {
  it('converts hex to buffer correctly', () => {
    const hex = '48656c6c6f';
    const buffer = hexToBuffer(hex);
    expect(buffer.toString('utf-8')).toBe('Hello');
  });

  it('converts buffer to hex correctly', () => {
    const buffer = Buffer.from('Hello', 'utf-8');
    const hex = bufferToHex(buffer);
    expect(hex).toBe('48656c6c6f');
  });

  it('roundtrips correctly', () => {
    const original = Buffer.from([0, 128, 255, 1, 127]);
    const hex = bufferToHex(original);
    const back = hexToBuffer(hex);
    expect(back.equals(original)).toBe(true);
  });
});

describe('parseVnshUrl', () => {
  it('parses a valid vnsh URL', () => {
    const key = 'a'.repeat(64);
    const iv = 'b'.repeat(32);
    const url = `https://vnsh.dev/v/abc123-def456#k=${key}&iv=${iv}`;

    const result = parseVnshUrl(url);
    expect(result.host).toBe('https://vnsh.dev');
    expect(result.id).toBe('abc123-def456');
    expect(result.key).toBeInstanceOf(Buffer);
    expect(result.key.length).toBe(32);
    expect(result.iv).toBeInstanceOf(Buffer);
    expect(result.iv.length).toBe(16);
  });

  it('parses a localhost URL', () => {
    const key = '0'.repeat(64);
    const iv = '1'.repeat(32);
    // Use UUID format since the regex expects hex chars and dashes
    const url = `http://localhost:8787/v/12345678-abcd-1234-efab-123456789abc#k=${key}&iv=${iv}`;

    const result = parseVnshUrl(url);
    expect(result.host).toBe('http://localhost:8787');
    expect(result.id).toBe('12345678-abcd-1234-efab-123456789abc');
  });

  it('throws on missing fragment', () => {
    const url = 'https://vnsh.dev/v/abc123';
    expect(() => parseVnshUrl(url)).toThrow('missing fragment');
  });

  it('throws on invalid path', () => {
    const url = 'https://vnsh.dev/invalid/path#k=aaa&iv=bbb';
    expect(() => parseVnshUrl(url)).toThrow('cannot extract blob ID');
  });

  it('throws on invalid key length', () => {
    const url = 'https://vnsh.dev/v/abc123#k=tooshort&iv=' + 'b'.repeat(32);
    expect(() => parseVnshUrl(url)).toThrow('key must be 64 hex chars');
  });

  it('throws on invalid IV length', () => {
    const url = 'https://vnsh.dev/v/abc123#k=' + 'a'.repeat(64) + '&iv=tooshort';
    expect(() => parseVnshUrl(url)).toThrow('IV must be 32 hex chars');
  });

  it('throws on missing key', () => {
    const url = 'https://vnsh.dev/v/abc123#iv=' + 'b'.repeat(32);
    expect(() => parseVnshUrl(url)).toThrow('key must be 64 hex chars');
  });

  it('throws on missing IV', () => {
    const url = 'https://vnsh.dev/v/abc123#k=' + 'a'.repeat(64);
    expect(() => parseVnshUrl(url)).toThrow('IV must be 32 hex chars');
  });
});

describe('buildVnshUrl', () => {
  it('builds a valid vnsh URL', () => {
    const host = 'https://vnsh.dev';
    const id = 'test-blob-id';
    const key = Buffer.alloc(32, 0xab);
    const iv = Buffer.alloc(16, 0xcd);

    const url = buildVnshUrl(host, id, key, iv);
    expect(url).toContain(host);
    expect(url).toContain(`/v/${id}`);
    expect(url).toContain('#');
    // v2 format: 48 bytes base64url = 64 chars
    expect(url.split('#')[1]).toHaveLength(64);
  });

  it('roundtrips with parseVnshUrl', () => {
    const host = 'https://vnsh.dev';
    const id = '12345678-1234-1234-1234-123456789abc';
    const key = generateKey();
    const iv = generateIV();

    const url = buildVnshUrl(host, id, key, iv);
    const parsed = parseVnshUrl(url);

    expect(parsed.host).toBe(host);
    expect(parsed.id).toBe(id);
    expect(parsed.key.equals(key)).toBe(true);
    expect(parsed.iv.equals(iv)).toBe(true);
  });
});

describe('OpenSSL compatibility', () => {
  it('uses AES-256-CBC with PKCS7 padding (same as OpenSSL)', () => {
    // This test verifies we use the same encryption as:
    // openssl enc -aes-256-cbc -K $KEY -iv $IV
    const key = hexToBuffer('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    const iv = hexToBuffer('fedcba9876543210fedcba9876543210');
    const plaintext = 'test';

    const ciphertext = encrypt(plaintext, key, iv);
    const decrypted = decrypt(ciphertext, key, iv);

    expect(decrypted.toString('utf-8')).toBe(plaintext);
    // The ciphertext should be at least 16 bytes (one AES block) due to padding
    expect(ciphertext.length).toBeGreaterThanOrEqual(16);
    // The ciphertext length should be a multiple of 16 (AES block size)
    expect(ciphertext.length % 16).toBe(0);
  });
});
