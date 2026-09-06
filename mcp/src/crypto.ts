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

/** Bytes reserved for a name inside the sealed slot, before the 2-byte length. */
const NAME_SLOT_BYTES = 200;

/**
 * A file name, wrapped so the service can store it without reading it.
 *
 * The name is content - `analysis.py` is harmless, `Q3-layoff-list.xlsx` is not
 * - so it gets the same treatment the body gets: AES-256-GCM under the content
 * key, base64url on the wire. vnsh keeps the string in R2 custom metadata and
 * hands it back untouched, which is what lets a download arrive as
 * `analysis.py` instead of a guess made from its first four bytes.
 *
 * The plaintext is padded to a fixed width first. Encryption hides the bytes
 * but not their count, and an unpadded value would publish the exact length of
 * every private file name - enough to tell `ok.txt` from
 * `acquisition-targets.xlsx`, and enough to rule candidates in or out. Every
 * sealed name is therefore the same size on the wire. What stays visible is
 * only whether a name was attached at all.
 *
 * Public workspaces are the exception, and deliberately so: they have no key,
 * and their name is base64url of plain UTF-8. Weakening the name below what the
 * body already promises is the one thing this must never do.
 */
export function sealWorkspaceName(name: string, key: Buffer | null): string | null {
  const clean = sanitizeFileName(name);
  if (!clean) return null;
  const bytes = Buffer.from(clean, 'utf-8');
  if (!key) return bufferToBase64url(bytes);
  // 2-byte big-endian length, then the name, then zeros out to a constant width.
  const slot = Buffer.alloc(2 + NAME_SLOT_BYTES);
  slot.writeUInt16BE(bytes.length, 0);
  bytes.copy(slot, 2);
  return bufferToBase64url(encryptWorkspace(slot, key));
}

/**
 * Recover a name sealed by `sealWorkspaceName`, or null if anything is off.
 *
 * Null is a real answer, not an error: the caller falls back to a generated
 * name. A wrong name costs nothing, and a name that came from somewhere other
 * than the key holder must never reach a filesystem path.
 */
export function openWorkspaceName(header: string | null, key: Buffer | null): string | null {
  if (!header || header.length > 512 || !/^[A-Za-z0-9_-]+$/.test(header)) return null;
  try {
    const bytes = base64urlToBuffer(header);
    if (!key) return sanitizeFileName(bytes.toString('utf-8'));
    const slot = decryptWorkspace(bytes, key);
    if (slot.length !== 2 + NAME_SLOT_BYTES) return null;
    const length = slot.readUInt16BE(0);
    if (length > NAME_SLOT_BYTES) return null;
    return sanitizeFileName(slot.subarray(2, 2 + length).toString('utf-8'));
  } catch {
    return null;
  }
}

/**
 * Seal a name for a legacy `/v/` blob.
 *
 * A blob is AES-256-CBC, and its name has to travel the same way for one
 * practical reason: the shell client encrypts with `openssl enc`, which has no
 * GCM mode. So the name is CBC under the blob's own key with its own random IV,
 * NUL-padded to a fixed slot first — a filename cannot contain NUL, so the pad
 * is unambiguous, and every sealed name is the same length whatever it says.
 *
 * The seal is unauthenticated, exactly like the blob body it names. Someone who
 * can rewrite stored bytes can garble the name; `sanitizeFileName` on the way
 * out is what keeps that from becoming more than a wrong name.
 */
export function sealBlobName(name: string, key: Buffer): string | null {
  const clean = sanitizeFileName(name);
  if (!clean) return null;
  const slot = Buffer.alloc(NAME_SLOT_BYTES);
  Buffer.from(clean, 'utf-8').copy(slot);
  const iv = generateIV();
  return bufferToBase64url(Buffer.concat([iv, encrypt(slot, key, iv)]));
}

/** 16 bytes of IV plus the 200-byte slot padded by PKCS#7 to 208. */
const SEALED_BLOB_NAME_BYTES = 16 + 208;

/** Recover a name sealed by `sealBlobName`, or null if anything is off. */
export function openBlobName(header: string | null, key: Buffer): string | null {
  if (!header || !/^[A-Za-z0-9_-]+$/.test(header)) return null;
  try {
    const bytes = base64urlToBuffer(header);
    if (bytes.length !== SEALED_BLOB_NAME_BYTES) return null;
    const slot = decrypt(bytes.subarray(16), key, bytes.subarray(0, 16));
    if (slot.length !== NAME_SLOT_BYTES) return null;
    const end = slot.indexOf(0);
    return sanitizeFileName(slot.subarray(0, end === -1 ? slot.length : end).toString('utf-8'));
  } catch {
    return null;
  }
}

/** Windows refuses these as file names, with or without an extension. */
const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Reduce anything to a bare file name that is safe on every platform.
 *
 * This value ends up in a path the CLI writes to and in a browser `download`
 * attribute, so it has to be a name and nothing else. Beyond separators, three
 * things matter and are easy to miss:
 *
 * - Bidirectional overrides. A name carrying U+202E renders in reverse from
 *   that point on, so `.exe` can be displayed as `.pdf` in every file list that
 *   honours them, which is the entire reason to put one in a name.
 * - `:` addresses an NTFS alternate data stream, so `notes.txt:payload.exe`
 *   writes somewhere other than where it appears to. `< > " | ? *` are simply
 *   invalid there, and a name Linux accepts must not make a Windows reader throw.
 * - Trailing dots and spaces are stripped by Windows, so `report.txt.` and
 *   `report.txt` are one file - a way to collide with a name on purpose.
 *
 * The cap is in UTF-8 bytes rather than code units so that it matches the limit
 * the wire format actually imposes; a 200-character CJK name is 600 bytes and
 * would otherwise be accepted here and silently dropped by the server.
 */
export function sanitizeFileName(raw: string): string | null {
  if (!raw) return null;
  const segment = raw.split(/[/\\]/).pop() || '';
  const cleaned = segment
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    // Zero-width and bidirectional formatting characters.
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, '')
    .replace(/[<>:"|?*]/g, '')
    .trim()
    // Windows drops these, so keeping them invites two names for one file.
    .replace(/[. ]+$/, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  const safe = RESERVED_DEVICE_NAMES.test(cleaned) ? `_${cleaned}` : cleaned;
  return truncateUtf8(safe, NAME_SLOT_BYTES);
}

/** Cut to a byte budget without splitting a character in half. */
function truncateUtf8(value: string, maxBytes: number): string | null {
  let cut = value;
  while (Buffer.byteLength(cut, 'utf-8') > maxBytes && cut.length > 0) {
    cut = cut.slice(0, -1);
  }
  return cut || null;
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
  const pathMatch = urlObj.pathname.match(/^\/(?:w|artifact)\/([0-9A-Za-z]{12})$/);
  if (!pathMatch) {
    throw new Error('Invalid workspace URL: expected a /w/{id} or /artifact/{id} path');
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
