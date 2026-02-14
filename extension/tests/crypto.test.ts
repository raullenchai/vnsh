import { describe, it, expect } from 'vitest';
import {
  generateKey,
  generateIV,
  encrypt,
  decrypt,
  encryptText,
  decryptToText,
  hexToBytes,
  bytesToHex,
  base64urlToBytes,
  bytesToBase64url,
} from '../src/lib/crypto';

describe('crypto encoding helpers', () => {
  it('hexToBytes / bytesToHex roundtrip', () => {
    const hex = '0123456789abcdef';
    const bytes = hexToBytes(hex);
    expect(bytes.length).toBe(8);
    expect(bytesToHex(bytes)).toBe(hex);
  });

  it('base64url roundtrip', () => {
    const original = new Uint8Array([0, 1, 2, 255, 254, 253, 128, 64]);
    const encoded = bytesToBase64url(original);
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
    const decoded = base64urlToBytes(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it('base64url encodes 48 bytes to 64 chars (v2 URL secret)', () => {
    const secret = new Uint8Array(48); // 32 key + 16 iv
    crypto.getRandomValues(secret);
    const encoded = bytesToBase64url(secret);
    expect(encoded.length).toBe(64);
    const decoded = base64urlToBytes(encoded);
    expect(decoded.length).toBe(48);
    expect(Array.from(decoded)).toEqual(Array.from(secret));
  });
});

describe('crypto encrypt/decrypt', () => {
  it('generates key of 32 bytes', () => {
    const key = generateKey();
    expect(key.length).toBe(32);
  });

  it('generates IV of 16 bytes', () => {
    const iv = generateIV();
    expect(iv.length).toBe(16);
  });

  it('encrypts and decrypts text roundtrip', async () => {
    const key = generateKey();
    const iv = generateIV();
    const plaintext = 'Hello, vnsh!';

    const ciphertext = await encryptText(plaintext, key, iv);
    expect(ciphertext.byteLength).toBeGreaterThan(0);

    const decrypted = await decryptToText(ciphertext, key, iv);
    expect(decrypted).toBe(plaintext);
  });

  it('encrypts and decrypts binary data', async () => {
    const key = generateKey();
    const iv = generateIV();
    const data = new Uint8Array([0, 1, 2, 3, 255, 254, 253, 252]);

    const ciphertext = await encrypt(data, key, iv);
    const decrypted = await decrypt(ciphertext, key, iv);
    expect(Array.from(new Uint8Array(decrypted))).toEqual(Array.from(data));
  });

  it('encrypts empty string (PKCS#7 full padding block)', async () => {
    const key = generateKey();
    const iv = generateIV();

    const ciphertext = await encryptText('', key, iv);
    // Empty plaintext → 16 bytes (one full padding block)
    expect(ciphertext.byteLength).toBe(16);

    const decrypted = await decryptToText(ciphertext, key, iv);
    expect(decrypted).toBe('');
  });

  it('encrypts exactly one block (16 bytes → 32 bytes with padding)', async () => {
    const key = generateKey();
    const iv = generateIV();
    const data = new Uint8Array(16).fill(0x41); // 'AAAAAAAAAAAAAAAA'

    const ciphertext = await encrypt(data, key, iv);
    // 16 bytes plaintext → 32 bytes (original + full padding block)
    expect(ciphertext.byteLength).toBe(32);

    const decrypted = await decrypt(ciphertext, key, iv);
    expect(Array.from(new Uint8Array(decrypted))).toEqual(Array.from(data));
  });

  it('matches known test vector: simple_text', async () => {
    const key = hexToBytes(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );
    const iv = hexToBytes('fedcba9876543210fedcba9876543210');
    const plaintext = new TextEncoder().encode('Hello World');

    const ciphertext = await encrypt(plaintext, key, iv);
    const ciphertextB64 = btoa(
      String.fromCharCode(...new Uint8Array(ciphertext)),
    );
    // Verified with: echo -n 'Hello World' | openssl enc -aes-256-cbc -K <key> -iv <iv> | base64
    expect(ciphertextB64).toBe('H3GCiWU7aSviQLVlPaR2Rw==');
  });

  it('decrypts known test vector: simple_text', async () => {
    const key = hexToBytes(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );
    const iv = hexToBytes('fedcba9876543210fedcba9876543210');
    const ciphertextB64 = 'H3GCiWU7aSviQLVlPaR2Rw==';
    const binary = atob(ciphertextB64);
    const ciphertext = new Uint8Array(
      [...binary].map((c) => c.charCodeAt(0)),
    ).buffer;

    const decrypted = await decrypt(ciphertext, key, iv);
    const text = new TextDecoder().decode(decrypted);
    expect(text).toBe('Hello World');
  });

  it('handles unicode text', async () => {
    const key = generateKey();
    const iv = generateIV();
    const plaintext = 'Hello 世界 🌍';

    const ciphertext = await encryptText(plaintext, key, iv);
    const decrypted = await decryptToText(ciphertext, key, iv);
    expect(decrypted).toBe(plaintext);
  });

  it('wrong key fails decryption', async () => {
    const key = generateKey();
    const iv = generateIV();
    const wrongKey = generateKey();

    const ciphertext = await encryptText('secret', key, iv);
    await expect(
      decryptToText(ciphertext, wrongKey, iv),
    ).rejects.toThrow();
  });
});
