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
 * Convert base64url string to Buffer
 */
export function base64urlToBuffer(str: string): Buffer {
  // Replace URL-safe chars with standard base64 chars
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  // Add padding if needed
  const padded = base64 + '=='.slice(0, (4 - base64.length % 4) % 4);
  return Buffer.from(padded, 'base64');
}

/**
 * Convert Buffer to base64url string (no padding)
 */
export function bufferToBase64url(buffer: Buffer): string {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Parse a vnsh URL to extract components
 *
 * Supports two URL formats:
 * - v2 (new): https://host/v/{shortId}#{base64url_secret}
 *   - shortId: 12 chars base62
 *   - secret: 64 chars base64url encoding key(32B) + iv(16B)
 * - v1 (old): https://host/v/{uuid}#k={key}&iv={iv}
 *   - uuid: 36 chars with dashes
 *   - key: 64 hex chars, iv: 32 hex chars
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
    throw new Error('Invalid vnsh URL: missing fragment');
  }

  // Parse URL to get host and ID
  const urlObj = new URL(urlPart);
  // Match both UUID (with dashes) and short base62 IDs
  const pathMatch = urlObj.pathname.match(/^\/v\/([a-zA-Z0-9-]+)$/);

  if (!pathMatch) {
    throw new Error('Invalid vnsh URL: cannot extract blob ID from path');
  }

  const id = pathMatch[1];
  const host = urlObj.origin;

  // Detect format: v2 if fragment is exactly 64 chars base64url (no = sign except padding)
  // v1 if fragment contains k= and iv= parameters
  if (fragment.length === 64 && !fragment.includes('k=')) {
    // v2 format: base64url encoded key+iv (48 bytes -> 64 chars)
    try {
      const secretBuffer = base64urlToBuffer(fragment);
      if (secretBuffer.length === 48) {
        return {
          host,
          id,
          key: secretBuffer.slice(0, 32),
          iv: secretBuffer.slice(32, 48),
        };
      }
    } catch (e) {
      // Fall through to v1 parsing
    }
  }

  // v1 format: k=...&iv=... parameters
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
 * Build a vnsh URL from components (v2 format)
 * Uses compact base64url encoding for key+iv
 */
export function buildVnshUrl(host: string, id: string, key: Buffer, iv: Buffer): string {
  const secret = Buffer.concat([key, iv]);
  const secretBase64url = bufferToBase64url(secret);
  return `${host}/v/${id}#${secretBase64url}`;
}
