/**
 * Workspace crypto (v2) for the extension.
 *
 * Mirrors mcp/src/crypto.ts and cli/npm/src/crypto.ts, expressed in WebCrypto
 * because this runs in a browser. The duplication is deliberate — these ship as
 * separate artifacts — and is only safe because workspace.test.ts pins the key
 * schedule to the same vectors the other clients use. A link made by one client
 * that will not open in another looks like corruption, not a version skew, so
 * the vectors are the thing keeping that from happening quietly.
 *
 * GCM rather than the CBC used by v1 blobs: workspace content is mutable, and
 * without an authentication tag anyone able to rewrite storage — the host
 * included — could flip ciphertext bits undetectably. The nonce is random per
 * write and prepended; reusing one under GCM leaks the authentication key.
 */

const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;

export interface WorkspaceKeys {
  /** AES-256-GCM content key. */
  key: Uint8Array;
  /** Write token, as the 64 hex chars sent in X-Vnsh-Write. */
  writeToken: string;
  /** SHA-256 of the write token — the only derived value the server stores. */
  writeHash: string;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function base64urlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  let binary: string;
  try {
    binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  } catch {
    // atob reports "Invalid character" for a truncated link, which tells the
    // reader nothing. Anything undecodable is simply not key material.
    throw new Error('Workspace key is not valid base64url');
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function derive(secret: Uint8Array, info: string): Promise<Uint8Array> {
  const ikm = await crypto.subtle.importKey('raw', secret as BufferSource, 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(info),
    },
    ikm,
    256,
  );
  return new Uint8Array(bits);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}

export function generateRootSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export async function deriveWorkspaceKeys(secret: Uint8Array): Promise<WorkspaceKeys> {
  const key = await derive(secret, 'vnsh/enc/v2');
  const writeToken = toHex(await derive(secret, 'vnsh/write/v2'));
  // Hash the hex *string*: the worker hashes the header text as UTF-8.
  return { key, writeToken, writeHash: await sha256Hex(writeToken) };
}

/** Encrypt to `nonce ‖ ciphertext ‖ tag`. */
export async function encryptWorkspace(
  plaintext: Uint8Array,
  key: Uint8Array,
): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_BYTES));
  const aes = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, [
    'encrypt',
  ]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, plaintext as BufferSource),
  );
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return out;
}

/** Bytes reserved for a name inside the sealed slot, before the 2-byte length. */
export const NAME_SLOT_BYTES = 200;

/** Windows refuses these as file names, with or without an extension. */
const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Reduce anything to a bare file name that is safe on every platform.
 *
 * The result reaches a browser `download` attribute, so it has to be a name and
 * nothing else. Beyond separators, three things matter and are easy to miss:
 * a bidirectional override makes `.exe` render as `.pdf` in any file list that
 * honours it; `:` addresses an NTFS alternate data stream; and Windows strips
 * trailing dots and spaces, so `report.txt.` and `report.txt` are one file.
 *
 * The cap is in UTF-8 bytes, not code units, so it matches what the wire format
 * can actually carry.
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
    .replace(/[. ]+$/, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  const safe = RESERVED_DEVICE_NAMES.test(cleaned) ? `_${cleaned}` : cleaned;
  let cut = safe;
  while (new TextEncoder().encode(cut).length > NAME_SLOT_BYTES && cut.length > 0) {
    cut = Array.from(cut).slice(0, -1).join('');
  }
  return cut || null;
}

/**
 * Wrap a file name so vnsh can store it without reading it.
 *
 * A name is content: `screenshot.png` is nothing, `severance-agreement.pdf` is
 * a great deal. So it travels the way the body travels - AES-256-GCM under the
 * content key, base64url on the wire - and the service keeps an opaque string
 * it hands back untouched.
 *
 * The plaintext is padded to a constant width first. Encryption hides the bytes
 * but not their count, and an unpadded value would publish the exact length of
 * every private name. Pass a null key for a public workspace, which has no key
 * and nothing left to withhold.
 */
export async function sealWorkspaceName(
  name: string,
  key: Uint8Array | null,
): Promise<string | null> {
  const clean = sanitizeFileName(name);
  if (!clean) return null;
  const bytes = new TextEncoder().encode(clean);
  if (!key) return bytesToBase64url(bytes);
  const slot = new Uint8Array(2 + NAME_SLOT_BYTES);
  slot[0] = (bytes.length >> 8) & 0xff;
  slot[1] = bytes.length & 0xff;
  slot.set(bytes, 2);
  return bytesToBase64url(await encryptWorkspace(slot, key));
}

/** Decrypt `nonce ‖ ciphertext ‖ tag`. Throws if the tag does not verify. */
export async function decryptWorkspace(
  payload: Uint8Array,
  key: Uint8Array,
): Promise<Uint8Array> {
  if (payload.length < GCM_NONCE_BYTES + GCM_TAG_BYTES) {
    throw new Error('Workspace payload is too short to be valid');
  }
  const aes = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, [
    'decrypt',
  ]);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: payload.slice(0, GCM_NONCE_BYTES) },
    aes,
    payload.slice(GCM_NONCE_BYTES) as BufferSource,
  );
  return new Uint8Array(plain);
}

/**
 * The three link shapes, and what each one can do:
 *
 *   /w/{id}#w=<S>   encrypted, read + write
 *   /w/{id}#r=<K>   encrypted, read only
 *   /p/{id}         public, readable by anything — no key, so no fragment
 *
 * K is HKDF(S, "enc"), a one-way derivation, so a #r= holder can decrypt every
 * version while being unable to recover S and therefore unable to forge a write.
 */
export type WorkspaceKind = 'encrypted' | 'public';

export interface WorkspaceLink {
  kind: WorkspaceKind;
  host: string;
  id: string;
  /** Content key. Null for a public workspace, which has none. */
  key: Uint8Array | null;
  secret: Uint8Array | null;
  canWrite: boolean;
}

export function buildWorkspaceUrl(host: string, id: string, secret: Uint8Array): string {
  return `${host}/w/${id}#w=${bytesToBase64url(secret)}`;
}

export async function buildReadOnlyWorkspaceUrl(
  host: string,
  id: string,
  secret: Uint8Array,
): Promise<string> {
  const { key } = await deriveWorkspaceKeys(secret);
  return `${host}/w/${id}#r=${bytesToBase64url(key)}`;
}

export function buildPublicUrl(host: string, id: string): string {
  return `${host}/p/${id}`;
}

/** Cheap shape test used before doing any work on a candidate link. */
export function workspaceKind(url: string): WorkspaceKind | null {
  try {
    const path = new URL(url.split('#')[0]).pathname;
    if (/^\/w\/[0-9A-Za-z]{12}$/.test(path)) return 'encrypted';
    if (/^\/p\/[0-9A-Za-z]{12}$/.test(path)) return 'public';
    return null;
  } catch {
    return null;
  }
}

export async function parseWorkspaceUrl(url: string): Promise<WorkspaceLink> {
  const [urlPart, fragment] = url.split('#');
  const target = new URL(urlPart);
  const kind = workspaceKind(url);
  if (!kind) throw new Error('Not a workspace URL');

  const id = target.pathname.split('/').pop() as string;

  if (kind === 'public') {
    return { kind, host: target.origin, id, key: null, secret: null, canWrite: false };
  }

  if (!fragment) throw new Error('Workspace URL is missing its #w= or #r= fragment');
  const readOnly = fragment.startsWith('r=');
  const encoded = readOnly || fragment.startsWith('w=') ? fragment.slice(2) : fragment;
  // A truncated link is the common case here — someone copied past the # or a
  // chat client ate the tail — so both failures report the same thing.
  let material: Uint8Array;
  try {
    material = base64urlToBytes(encoded);
  } catch {
    throw new Error('Workspace key must be 32 bytes; this link looks truncated');
  }
  if (material.length !== 32) {
    throw new Error(`Workspace key must be 32 bytes (got ${material.length})`);
  }

  if (readOnly) {
    return { kind, host: target.origin, id, key: material, secret: null, canWrite: false };
  }
  const { key } = await deriveWorkspaceKeys(material);
  return { kind, host: target.origin, id, key, secret: material, canWrite: true };
}
