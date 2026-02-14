/**
 * vnsh URL parsing and construction.
 *
 * Supports two URL formats:
 * - v2 (new): https://vnsh.dev/v/{base62_12char}#{base64url_64chars}
 *   fragment = base64url(key:32 + iv:16) = 64 chars
 * - v1 (old): https://vnsh.dev/v/{uuid}#k={64hex}&iv={32hex}
 */

import { base64urlToBytes, bytesToBase64url, hexToBytes } from './crypto';

export interface VnshUrlComponents {
  host: string;
  id: string;
  key: Uint8Array;
  iv: Uint8Array;
}

/**
 * Parse a vnsh URL to extract host, blob ID, key, and IV.
 * Auto-detects v1 vs v2 format from the fragment.
 */
export function parseVnshUrl(url: string): VnshUrlComponents {
  const hashIndex = url.indexOf('#');
  if (hashIndex === -1) {
    throw new Error('Invalid vnsh URL: missing fragment');
  }

  const urlPart = url.slice(0, hashIndex);
  const fragment = url.slice(hashIndex + 1);

  const urlObj = new URL(urlPart);
  const pathMatch = urlObj.pathname.match(/^\/v\/([a-zA-Z0-9-]+)$/);
  if (!pathMatch) {
    throw new Error('Invalid vnsh URL: cannot extract blob ID from path');
  }

  const id = pathMatch[1];
  const host = urlObj.origin;

  // v2 format: fragment is exactly 64 chars base64url (48 bytes = 32 key + 16 iv)
  if (fragment.length === 64 && !fragment.includes('k=')) {
    try {
      const secretBytes = base64urlToBytes(fragment);
      if (secretBytes.length === 48) {
        return {
          host,
          id,
          key: secretBytes.slice(0, 32),
          iv: secretBytes.slice(32, 48),
        };
      }
    } catch {
      // Fall through to v1 parsing
    }
  }

  // v1 format: k=<64hex>&iv=<32hex>
  const params = new URLSearchParams(fragment);
  const keyHex = params.get('k');
  const ivHex = params.get('iv');

  if (!keyHex || keyHex.length !== 64) {
    throw new Error(
      `Invalid vnsh URL: key must be 64 hex chars (got ${keyHex?.length || 0})`,
    );
  }
  if (!ivHex || ivHex.length !== 32) {
    throw new Error(
      `Invalid vnsh URL: IV must be 32 hex chars (got ${ivHex?.length || 0})`,
    );
  }

  return {
    host,
    id,
    key: hexToBytes(keyHex),
    iv: hexToBytes(ivHex),
  };
}

/**
 * Build a vnsh URL in v2 format.
 */
export function buildVnshUrl(
  host: string,
  id: string,
  key: Uint8Array,
  iv: Uint8Array,
): string {
  const secret = new Uint8Array([...key, ...iv]);
  const secretBase64url = bytesToBase64url(secret);
  return `${host}/v/${id}#${secretBase64url}`;
}

/**
 * Check if a string looks like a vnsh URL.
 */
export function isVnshUrl(text: string): boolean {
  return /vnsh\.dev\/v\/[a-zA-Z0-9-]+#\S+/.test(text);
}
