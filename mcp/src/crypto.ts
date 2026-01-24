/**
 * Crypto utilities for vnsh MCP Server
 *
 * Implements AES-256-CBC encryption/decryption compatible with:
 * - OpenSSL CLI (used by vn)
 * - WebCrypto (used by browser viewer)
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Generate a random encryption key (32 bytes = 256 bits)
 */
export function generateKey(): Buffer {
  return randomBytes(32);
}

/**
 * Generate a random IV (16 bytes = 128 bits)
 */
export function generateIV(): Buffer {
  return randomBytes(16);
}

/**
 * Encrypt content using AES-256-CBC
 *
 * @param plaintext - The content to encrypt (string or Buffer)
 * @param key - 32-byte encryption key
 * @param iv - 16-byte initialization vector
 * @returns Encrypted ciphertext as Buffer
 */
export function encrypt(plaintext: string | Buffer, key: Buffer, iv: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const input = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf-8') : plaintext;
  return Buffer.concat([cipher.update(input), cipher.final()]);
}

/**
 * Decrypt content using AES-256-CBC
 *
 * @param ciphertext - The encrypted content
 * @param key - 32-byte encryption key
 * @param iv - 16-byte initialization vector
 * @returns Decrypted plaintext as Buffer
 */
export function decrypt(ciphertext: Buffer, key: Buffer, iv: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Convert hex string to Buffer
 */
export function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

/**
 * Convert Buffer to hex string
 */
export function bufferToHex(buffer: Buffer): string {
  return buffer.toString('hex');
}

/**
 * Parse a vnsh URL to extract components
 *
 * URL format: https://host/v/{id}#k={key}&iv={iv}
 */
export function parseVnshUrl(url: string): {
  host: string;
  id: string;
  key: Buffer;
  iv: Buffer;
} {
  // Split URL and fragment
  const [urlPart, fragment] = url.split('#');

  if (!fragment) {
    throw new Error('Invalid vnsh URL: missing fragment (#k=...&iv=...)');
  }

  // Parse URL to get host and ID
  const urlObj = new URL(urlPart);
  const pathMatch = urlObj.pathname.match(/^\/v\/([a-f0-9-]+)$/);

  if (!pathMatch) {
    throw new Error('Invalid vnsh URL: cannot extract blob ID from path');
  }

  const id = pathMatch[1];
  const host = urlObj.origin;

  // Parse fragment for key and IV
  const params = new URLSearchParams(fragment);
  const keyHex = params.get('k');
  const ivHex = params.get('iv');

  if (!keyHex || keyHex.length !== 64) {
    throw new Error(`Invalid vnsh URL: key must be 64 hex chars (got ${keyHex?.length || 0})`);
  }

  if (!ivHex || ivHex.length !== 32) {
    throw new Error(`Invalid vnsh URL: IV must be 32 hex chars (got ${ivHex?.length || 0})`);
  }

  return {
    host,
    id,
    key: hexToBuffer(keyHex),
    iv: hexToBuffer(ivHex),
  };
}

/**
 * Build a vnsh URL from components
 */
export function buildVnshUrl(host: string, id: string, key: Buffer, iv: Buffer): string {
  const keyHex = bufferToHex(key);
  const ivHex = bufferToHex(iv);
  return `${host}/v/${id}#k=${keyHex}&iv=${ivHex}`;
}
