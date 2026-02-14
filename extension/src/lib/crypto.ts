/**
 * AES-256-CBC encrypt/decrypt using WebCrypto API.
 *
 * Must produce byte-identical output to:
 * - OpenSSL CLI: openssl enc -aes-256-cbc -K $KEY -iv $IV
 * - Node.js crypto: createCipheriv('aes-256-cbc', key, iv)
 * - Worker WebCrypto: crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, plaintext)
 */

/** Generate a random 32-byte encryption key */
export function generateKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** Generate a random 16-byte IV */
export function generateIV(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

/** Encrypt plaintext using AES-256-CBC (PKCS#7 padding is implicit in WebCrypto) */
export async function encrypt(
  plaintext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key.buffer as ArrayBuffer,
    { name: 'AES-CBC' },
    false,
    ['encrypt'],
  );
  return crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: iv.buffer as ArrayBuffer },
    cryptoKey,
    plaintext.buffer as ArrayBuffer,
  );
}

/** Decrypt ciphertext using AES-256-CBC */
export async function decrypt(
  ciphertext: ArrayBuffer,
  key: Uint8Array,
  iv: Uint8Array,
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key.buffer as ArrayBuffer,
    { name: 'AES-CBC' },
    false,
    ['decrypt'],
  );
  return crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: iv.buffer as ArrayBuffer },
    cryptoKey,
    ciphertext,
  );
}

/** Encrypt a UTF-8 string */
export async function encryptText(
  text: string,
  key: Uint8Array,
  iv: Uint8Array,
): Promise<ArrayBuffer> {
  return encrypt(new TextEncoder().encode(text), key, iv);
}

/** Decrypt to a UTF-8 string */
export async function decryptToText(
  ciphertext: ArrayBuffer,
  key: Uint8Array,
  iv: Uint8Array,
): Promise<string> {
  const decrypted = await decrypt(ciphertext, key, iv);
  return new TextDecoder().decode(decrypted);
}

// ── Encoding helpers ───────────────────────────────────────────────

/** Hex string → Uint8Array */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

/** Uint8Array → hex string */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Base64url string → Uint8Array */
export function base64urlToBytes(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '=='.slice(0, (4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return new Uint8Array([...binary].map((c) => c.charCodeAt(0)));
}

/** Uint8Array → base64url string (no padding) */
export function bytesToBase64url(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes);
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
