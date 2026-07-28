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

// ---------------------------------------------------------------------------
// Workspace crypto (v2) — AES-256-GCM with a random per-write nonce.
//
// A single root secret S lives only in the URL fragment. Everything else is
// derived from it, so the server can verify writes without ever being able to
// decrypt:
//
//   K = HKDF(S, "vnsh/enc/v2")     content key
//   W = HKDF(S, "vnsh/write/v2")   write token, sent as 64 hex chars
//   H = SHA-256(W)                 the only derived value the server stores
//
// GCM is used rather than CBC because workspace content is mutable: without an
// authentication tag, anyone able to rewrite storage (including the host) could
// flip ciphertext bits undetectably.
//
// The nonce is random per write and prepended to the ciphertext rather than
// derived from a version number. Reusing a nonce under GCM leaks the
// authentication key, not just plaintext — and a fresh random 96-bit nonce per
// write makes reuse impossible without any version bookkeeping on the client.
// ---------------------------------------------------------------------------

import { createHash, hkdfSync } from 'crypto';

const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;

export function generateRootSecret(): Buffer {
  return randomBytes(32);
}

function derive(secret: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), Buffer.from(info, 'utf-8'), 32));
}

export interface WorkspaceKeys {
  /** AES-256-GCM content key. */
  key: Buffer;
  /** Write token, as the 64 hex chars sent in X-Vnsh-Write. */
  writeToken: string;
  /** SHA-256 of the write token — what the server stores and compares. */
  writeHash: string;
}

export function deriveWorkspaceKeys(secret: Buffer): WorkspaceKeys {
  const key = derive(secret, 'vnsh/enc/v2');
  const writeToken = derive(secret, 'vnsh/write/v2').toString('hex');
  // Must hash the hex *string*, matching the worker's
  // sha256Hex(header) which encodes the header text as UTF-8.
  const writeHash = createHash('sha256').update(writeToken, 'utf-8').digest('hex');
  return { key, writeToken, writeHash };
}

/** Encrypt to `nonce ‖ ciphertext ‖ tag`. */
export function encryptWorkspace(plaintext: string | Buffer, key: Buffer): Buffer {
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const input = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf-8') : plaintext;
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
}

/** Decrypt `nonce ‖ ciphertext ‖ tag`. Throws if the tag does not verify. */
export function decryptWorkspace(payload: Buffer, key: Buffer): Buffer {
  if (payload.length < GCM_NONCE_BYTES + GCM_TAG_BYTES) {
    throw new Error('Workspace payload is too short to be valid');
  }
  const nonce = payload.subarray(0, GCM_NONCE_BYTES);
  const tag = payload.subarray(payload.length - GCM_TAG_BYTES);
  const ciphertext = payload.subarray(GCM_NONCE_BYTES, payload.length - GCM_TAG_BYTES);

  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Workspace links come in two tiers, distinguished by their fragment prefix:
 *
 *   #w=<S>   root secret   — read and write
 *   #r=<K>   content key   — read only
 *
 * K is HKDF(S, "enc"), a one-way derivation, so handing out K lets someone
 * decrypt every version while making it impossible to recover S and therefore
 * impossible to forge a write. The read-only tier needs no server-side state and
 * no extra crypto: it is just a different part of the same key schedule.
 */
export interface WorkspaceLink {
  host: string;
  id: string;
  /** Content key. Always present — both tiers can decrypt. */
  key: Buffer;
  /** Root secret. Null for read-only links. */
  secret: Buffer | null;
  /** Write token. Null for read-only links. */
  writeToken: string | null;
  canWrite: boolean;
}

/** Read + write link. */
export function buildWorkspaceUrl(host: string, id: string, secret: Buffer): string {
  return `${host}/w/${id}#w=${bufferToBase64url(secret)}`;
}

/** Read-only link: carries K instead of S, so the holder cannot derive W. */
export function buildReadOnlyWorkspaceUrl(host: string, id: string, secret: Buffer): string {
  return `${host}/w/${id}#r=${bufferToBase64url(deriveWorkspaceKeys(secret).key)}`;
}

export function parseWorkspaceUrl(url: string): WorkspaceLink {
  const [urlPart, fragment] = url.split('#');
  if (!fragment) {
    throw new Error('Invalid workspace URL: missing #w= or #r= fragment');
  }

  const urlObj = new URL(urlPart);
  const pathMatch = urlObj.pathname.match(/^\/w\/([0-9A-Za-z]{12})$/);
  if (!pathMatch) {
    throw new Error('Invalid workspace URL: expected a /w/{id} path');
  }
  const host = urlObj.origin;
  const id = pathMatch[1];

  const readOnly = fragment.startsWith('r=');
  const encoded = readOnly || fragment.startsWith('w=') ? fragment.slice(2) : fragment;

  const material = base64urlToBuffer(encoded);
  if (material.length !== 32) {
    throw new Error(`Invalid workspace URL: key must be 32 bytes (got ${material.length})`);
  }

  if (readOnly) {
    return { host, id, key: material, secret: null, writeToken: null, canWrite: false };
  }

  const derived = deriveWorkspaceKeys(material);
  return {
    host,
    id,
    key: derived.key,
    secret: material,
    writeToken: derived.writeToken,
    canWrite: true,
  };
}
