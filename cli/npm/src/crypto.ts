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
 * Parse a vnsh URL to extract components
 */
export function parseVnshUrl(url: string): {
  host: string;
  id: string;
  key: Buffer;
  iv: Buffer;
} {
  // URL format: https://vnsh.dev/v/{id}#k={key}&iv={iv}
  const hashIndex = url.indexOf('#');
  if (hashIndex === -1) {
    throw new Error('Invalid URL: missing fragment (#k=...&iv=...)');
  }

  const pathPart = url.substring(0, hashIndex);
  const fragment = url.substring(hashIndex + 1);

  // Extract host
  const hostMatch = pathPart.match(/^(https?:\/\/[^/]+)/);
  if (!hostMatch) {
    throw new Error('Invalid URL: cannot extract host');
  }
  const host = hostMatch[1];

  // Extract blob ID
  const idMatch = pathPart.match(/\/v\/([a-f0-9-]+)/);
  if (!idMatch) {
    throw new Error('Invalid URL: cannot extract blob ID');
  }
  const id = idMatch[1];

  // Parse fragment parameters
  const params = new URLSearchParams(fragment);
  const keyHex = params.get('k');
  const ivHex = params.get('iv');

  if (!keyHex || keyHex.length !== 64) {
    throw new Error(`Invalid URL: missing or malformed key (expected 64 hex chars)`);
  }
  if (!ivHex || ivHex.length !== 32) {
    throw new Error(`Invalid URL: missing or malformed IV (expected 32 hex chars)`);
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
