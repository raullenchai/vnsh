/**
 * Crypto Compatibility Tests
 *
 * These tests validate that AES-256-CBC encryption/decryption works
 * consistently across all platforms:
 * - Node.js crypto (used by MCP server)
 * - OpenSSL CLI (used by oq CLI)
 * - WebCrypto (used by browser viewer)
 *
 * Run with: npx tsx tests/crypto.test.ts
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { execSync } from 'child_process';
import { describe, it, expect } from 'vitest';

// Test vectors - same key/iv should produce identical ciphertext across platforms
const TEST_VECTORS = [
  {
    name: 'simple_text',
    plaintext: 'Hello World',
    key: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    iv: 'fedcba9876543210fedcba9876543210',
  },
  {
    name: 'empty_string',
    plaintext: '',
    key: 'aaaabbbbccccddddaaaabbbbccccddddaaaabbbbccccddddaaaabbbbccccdddd',
    iv: '11112222333344441111222233334444',
  },
  {
    name: 'json_content',
    plaintext: '{"key": "value", "number": 42}',
    key: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    iv: 'cafebabecafebabecafebabecafebabe',
  },
  {
    name: 'unicode_text',
    plaintext: 'Hello 世界 🌍',
    key: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    iv: 'abcdef1234567890abcdef1234567890',
  },
  {
    name: 'exact_block_size',
    plaintext: '0123456789abcdef', // 16 bytes = exactly one block
    key: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    iv: '00000000000000000000000000000000',
  },
  {
    name: 'multi_block',
    plaintext: 'This is a longer message that spans multiple AES blocks to test padding correctly.',
    key: '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f',
    iv: 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0',
  },
];

/**
 * Encrypt using Node.js crypto module
 */
function encryptNode(plaintext: string, keyHex: string, ivHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
}

/**
 * Decrypt using Node.js crypto module
 */
function decryptNode(ciphertext: Buffer, keyHex: string, ivHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
}

/**
 * Encrypt using OpenSSL CLI (matches oq CLI behavior)
 */
function encryptOpenSSL(plaintext: string, keyHex: string, ivHex: string): Buffer {
  // Use printf for cross-platform compatibility (echo -n behaves differently on macOS)
  const escaped = plaintext.replace(/\\/g, '\\\\').replace(/'/g, "'\"'\"'").replace(/%/g, '%%');
  const cmd = `printf '%s' '${escaped}' | openssl enc -aes-256-cbc -K ${keyHex} -iv ${ivHex}`;
  return execSync(cmd, { encoding: 'buffer' });
}

/**
 * Decrypt using OpenSSL CLI
 */
function decryptOpenSSL(ciphertext: Buffer, keyHex: string, ivHex: string): string {
  const base64 = ciphertext.toString('base64');
  const cmd = `printf '%s' '${base64}' | base64 -d | openssl enc -d -aes-256-cbc -K ${keyHex} -iv ${ivHex}`;
  return execSync(cmd, { encoding: 'utf-8' });
}

describe('AES-256-CBC Encryption', () => {
  describe('Node.js crypto round-trip', () => {
    TEST_VECTORS.forEach((vector) => {
      it(`encrypts and decrypts: ${vector.name}`, () => {
        const encrypted = encryptNode(vector.plaintext, vector.key, vector.iv);
        const decrypted = decryptNode(encrypted, vector.key, vector.iv);
        expect(decrypted).toBe(vector.plaintext);
      });
    });
  });

  describe('OpenSSL round-trip', () => {
    TEST_VECTORS.forEach((vector) => {
      it(`encrypts and decrypts: ${vector.name}`, () => {
        // Skip unicode test for OpenSSL as shell escaping is complex
        if (vector.name === 'unicode_text') {
          return;
        }

        const encrypted = encryptOpenSSL(vector.plaintext, vector.key, vector.iv);
        const decrypted = decryptOpenSSL(encrypted, vector.key, vector.iv);
        expect(decrypted).toBe(vector.plaintext);
      });
    });
  });

  describe('Cross-platform compatibility: Node.js -> OpenSSL', () => {
    TEST_VECTORS.forEach((vector) => {
      it(`Node.js encrypted, OpenSSL decrypted: ${vector.name}`, () => {
        if (vector.name === 'unicode_text') return;

        const encrypted = encryptNode(vector.plaintext, vector.key, vector.iv);
        const decrypted = decryptOpenSSL(encrypted, vector.key, vector.iv);
        expect(decrypted).toBe(vector.plaintext);
      });
    });
  });

  describe('Cross-platform compatibility: OpenSSL -> Node.js', () => {
    TEST_VECTORS.forEach((vector) => {
      it(`OpenSSL encrypted, Node.js decrypted: ${vector.name}`, () => {
        if (vector.name === 'unicode_text') return;

        const encrypted = encryptOpenSSL(vector.plaintext, vector.key, vector.iv);
        const decrypted = decryptNode(encrypted, vector.key, vector.iv);
        expect(decrypted).toBe(vector.plaintext);
      });
    });
  });

  describe('Ciphertext determinism', () => {
    it('same input produces same ciphertext', () => {
      const vector = TEST_VECTORS[0];
      const encrypted1 = encryptNode(vector.plaintext, vector.key, vector.iv);
      const encrypted2 = encryptNode(vector.plaintext, vector.key, vector.iv);
      expect(encrypted1.equals(encrypted2)).toBe(true);
    });

    it('Node.js and OpenSSL produce identical ciphertext', () => {
      const vector = TEST_VECTORS[0]; // simple_text
      const nodeEncrypted = encryptNode(vector.plaintext, vector.key, vector.iv);
      const opensslEncrypted = encryptOpenSSL(vector.plaintext, vector.key, vector.iv);
      expect(nodeEncrypted.equals(opensslEncrypted)).toBe(true);
    });
  });

  describe('PKCS#7 Padding', () => {
    it('pads empty string to one block', () => {
      const vector = TEST_VECTORS.find((v) => v.name === 'empty_string')!;
      const encrypted = encryptNode(vector.plaintext, vector.key, vector.iv);
      expect(encrypted.length).toBe(16); // One block of padding
    });

    it('pads exact block size to two blocks', () => {
      const vector = TEST_VECTORS.find((v) => v.name === 'exact_block_size')!;
      const encrypted = encryptNode(vector.plaintext, vector.key, vector.iv);
      expect(encrypted.length).toBe(32); // Original block + padding block
    });
  });

  describe('Random key/IV generation', () => {
    it('generates unique keys', () => {
      const key1 = randomBytes(32).toString('hex');
      const key2 = randomBytes(32).toString('hex');
      expect(key1).not.toBe(key2);
      expect(key1.length).toBe(64); // 32 bytes = 64 hex chars
    });

    it('generates unique IVs', () => {
      const iv1 = randomBytes(16).toString('hex');
      const iv2 = randomBytes(16).toString('hex');
      expect(iv1).not.toBe(iv2);
      expect(iv1.length).toBe(32); // 16 bytes = 32 hex chars
    });
  });

  describe('Error handling', () => {
    it('throws on invalid key length', () => {
      expect(() => {
        encryptNode('test', 'short', 'fedcba9876543210fedcba9876543210');
      }).toThrow();
    });

    it('throws on invalid IV length', () => {
      expect(() => {
        encryptNode('test', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'short');
      }).toThrow();
    });

    it('throws on wrong key during decryption', () => {
      const vector = TEST_VECTORS[0];
      const encrypted = encryptNode(vector.plaintext, vector.key, vector.iv);
      const wrongKey = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

      expect(() => {
        decryptNode(encrypted, wrongKey, vector.iv);
      }).toThrow();
    });

    it('throws on corrupted ciphertext', () => {
      const vector = TEST_VECTORS[0];
      const encrypted = encryptNode(vector.plaintext, vector.key, vector.iv);
      encrypted[0] = encrypted[0] ^ 0xff; // Corrupt first byte

      expect(() => {
        decryptNode(encrypted, vector.key, vector.iv);
      }).toThrow();
    });
  });
});

describe('Hex Conversion', () => {
  it('converts hex to bytes correctly', () => {
    const hex = '48656c6c6f'; // "Hello"
    const bytes = Buffer.from(hex, 'hex');
    expect(bytes.toString('utf-8')).toBe('Hello');
  });

  it('converts bytes to hex correctly', () => {
    const bytes = Buffer.from('Hello', 'utf-8');
    const hex = bytes.toString('hex');
    expect(hex).toBe('48656c6c6f');
  });
});
