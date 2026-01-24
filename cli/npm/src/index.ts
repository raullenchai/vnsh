/**
 * vnsh-cli - Programmatic API
 *
 * @example
 * ```typescript
 * import { share, read } from 'vnsh-cli';
 *
 * // Share content
 * const url = await share('Hello, World!');
 * console.log(url);
 *
 * // Read content
 * const content = await read(url);
 * console.log(content);
 * ```
 */

export {
  encrypt,
  decrypt,
  generateKey,
  generateIV,
  bufferToHex,
  hexToBuffer,
  parseVnshUrl,
  buildVnshUrl,
} from './crypto.js';

const DEFAULT_HOST = process.env.VNSH_HOST || 'https://vnsh.dev';

interface ShareOptions {
  host?: string;
  ttl?: number;
}

interface UploadResponse {
  id: string;
  expires: string;
}

/**
 * Share content via vnsh
 * @param content - String or Buffer to share
 * @param options - Optional configuration
 * @returns The shareable URL
 */
export async function share(
  content: string | Buffer,
  options: ShareOptions = {}
): Promise<string> {
  const { generateKey, generateIV, encrypt, buildVnshUrl } = await import('./crypto.js');

  const host = options.host || DEFAULT_HOST;
  const data = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;

  // Generate key and IV
  const key = generateKey();
  const iv = generateIV();

  // Encrypt
  const encrypted = encrypt(data, key, iv);

  // Build API URL
  let apiUrl = `${host}/api/drop`;
  if (options.ttl) {
    apiUrl += `?ttl=${options.ttl}`;
  }

  // Upload
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: encrypted,
  });

  if (!response.ok) {
    throw new Error(`Upload failed: HTTP ${response.status}`);
  }

  const result = await response.json() as UploadResponse;

  return buildVnshUrl(host, result.id, key, iv);
}

/**
 * Read content from a vnsh URL
 * @param url - The vnsh URL to read
 * @returns The decrypted content as a Buffer
 */
export async function read(url: string): Promise<Buffer> {
  const { parseVnshUrl, decrypt } = await import('./crypto.js');

  const { host, id, key, iv } = parseVnshUrl(url);

  const response = await fetch(`${host}/api/blob/${id}`);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('Blob not found. It may have expired or been deleted.');
    }
    if (response.status === 410) {
      throw new Error('Blob has expired and is no longer available.');
    }
    throw new Error(`Failed to fetch blob: HTTP ${response.status}`);
  }

  const encrypted = Buffer.from(await response.arrayBuffer());
  return decrypt(encrypted, key, iv);
}

/**
 * Read content as string
 * @param url - The vnsh URL to read
 * @returns The decrypted content as a string
 */
export async function readString(url: string): Promise<string> {
  const buffer = await read(url);
  return buffer.toString('utf-8');
}
