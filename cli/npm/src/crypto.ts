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

// ---------------------------------------------------------------------------
// Workspaces (v2)
//
// This mirrors mcp/src/crypto.ts byte for byte. The duplication is deliberate
// for now — the packages ship independently — but it is only safe because
// test/compat.test.ts pins both implementations to the same vectors. Change one
// without the other and that test fails.
//
// GCM rather than the CBC used by v1 blobs: workspace content is mutable, and
// without an authentication tag anyone able to rewrite storage — the host
// included — could flip ciphertext bits undetectably, which hollows out the
// whole host-blind claim. The nonce is random per write and prepended, never
// derived from a version number: reusing a nonce under GCM leaks the
// authentication key, not just the plaintext.
// ---------------------------------------------------------------------------

const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;

export function generateRootSecret(): Buffer {
  return crypto.randomBytes(32);
}

function derive(secret: Buffer, info: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync('sha256', secret, Buffer.alloc(0), Buffer.from(info, 'utf-8'), 32),
  );
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
  // Hash the hex *string*, matching the worker's sha256Hex(header), which
  // encodes the header text as UTF-8.
  const writeHash = crypto.createHash('sha256').update(writeToken, 'utf-8').digest('hex');
  return { key, writeToken, writeHash };
}

/** Encrypt to `nonce ‖ ciphertext ‖ tag`. */
export function encryptWorkspace(plaintext: string | Buffer, key: Buffer): Buffer {
  const nonce = crypto.randomBytes(GCM_NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
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

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
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
 * impossible to forge a write. The read-only tier needs no server-side state
 * and no extra crypto: it is a different part of the same key schedule.
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

/** True for a /w/ link, so callers can route without try/catch. */
export function isWorkspaceUrl(url: string): boolean {
  try {
    return /^\/w\/[0-9A-Za-z]{12}$/.test(new URL(url.split('#')[0]).pathname);
  } catch {
    return false;
  }
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
