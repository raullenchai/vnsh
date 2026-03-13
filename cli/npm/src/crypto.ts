/**
 * Crypto utilities for vnsh CLI
 * Compatible with OpenSSL AES-256-CBC encryption
 */

import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits

/**
 * Generate a random encryption key
 */
export function generateKey(): Buffer {
  return crypto.randomBytes(KEY_LENGTH);
}

/**
 * Generate a random IV
 */
export function generateIV(): Buffer {
  return crypto.randomBytes(IV_LENGTH);
}

/**
 * Encrypt data using AES-256-CBC
 */
export function encrypt(data: Buffer, key: Buffer, iv: Buffer): Buffer {
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/**
 * Decrypt data using AES-256-CBC
 */
export function decrypt(data: Buffer, key: Buffer, iv: Buffer): Buffer {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/**
 * Convert buffer to hex string
 */
export function bufferToHex(buffer: Buffer): string {
  return buffer.toString('hex');
}

/**
 * Convert hex string to buffer
 */
export function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

/**
 * Convert base64url string to Buffer
 */
export function base64urlToBuffer(str: string): Buffer {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
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
  const [urlPart, fragment] = url.split('#');

  if (!fragment) {
    throw new Error('Invalid URL: missing fragment');
  }

  // Extract host
  const hostMatch = urlPart.match(/^(https?:\/\/[^/]+)/);
  if (!hostMatch) {
    throw new Error('Invalid URL: cannot extract host');
  }
  const host = hostMatch[1];

  // Extract blob ID (supports UUID with dashes and base62 short IDs)
  const idMatch = urlPart.match(/\/v\/([a-zA-Z0-9-]+)/);
  if (!idMatch) {
    throw new Error('Invalid URL: cannot extract blob ID');
  }
  const id = idMatch[1];

  // Detect format: v2 if fragment is exactly 64 chars base64url
  if (fragment.length === 64 && !fragment.includes('k=')) {
    try {
      const secretBuffer = base64urlToBuffer(fragment);
      if (secretBuffer.length === 48) {
        return {
          host,
          id,
          key: secretBuffer.subarray(0, 32),
          iv: secretBuffer.subarray(32, 48),
        };
      }
    } catch {
      // Fall through to v1 parsing
    }
  }

  // v1 format: k=...&iv=... parameters
  const params = new URLSearchParams(fragment);
  const keyHex = params.get('k');
  const ivHex = params.get('iv');

  if (!keyHex || keyHex.length !== 64) {
    throw new Error(`Invalid URL: key must be 64 hex chars (got ${keyHex?.length || 0})`);
  }
  if (!ivHex || ivHex.length !== 32) {
    throw new Error(`Invalid URL: IV must be 32 hex chars (got ${ivHex?.length || 0})`);
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
 */
export function buildVnshUrl(host: string, id: string, key: Buffer, iv: Buffer): string {
  const secret = Buffer.concat([key, iv]);
  return `${host}/v/${id}#${bufferToBase64url(secret)}`;
}
