/**
 * API client for vnsh server.
 * Thin wrappers around POST /api/drop and GET /api/blob/:id.
 */

import { VNSH_HOST } from './constants';
import {
  generateRootSecret,
  deriveWorkspaceKeys,
  encryptWorkspace,
  buildWorkspaceUrl,
  buildReadOnlyWorkspaceUrl,
  buildPublicUrl,
} from './workspace';

const CLIENT_HEADER = { 'X-Vnsh-Client': 'extension/1.0.0' };

export interface DropResponse {
  id: string;
  expires: string;
}

/**
 * Upload an encrypted blob.
 * @param ciphertext - The encrypted data
 * @param ttl - Time-to-live in hours (1-168, default server-side: 24)
 * @param host - API host override
 * @returns The blob ID and expiry timestamp
 */
export async function uploadBlob(
  ciphertext: ArrayBuffer,
  ttl?: number,
  host: string = VNSH_HOST,
): Promise<DropResponse> {
  const params = ttl ? `?ttl=${ttl}` : '';
  const response = await fetch(`${host}/api/drop${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...CLIENT_HEADER },
    body: ciphertext,
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<DropResponse>;
}

/**
 * Download an encrypted blob.
 * @param id - The blob ID
 * @param host - API host override
 * @returns The encrypted data as ArrayBuffer
 */
export async function downloadBlob(
  id: string,
  host: string = VNSH_HOST,
): Promise<{ data: ArrayBuffer; expires?: string }> {
  const response = await fetch(`${host}/api/blob/${id}`, {
    headers: { Accept: 'application/octet-stream', ...CLIENT_HEADER },
  });

  if (response.status === 404) {
    throw new Error('Blob not found');
  }
  if (response.status === 410) {
    throw new Error('Blob has expired');
  }
  if (response.status === 402) {
    throw new Error('Payment required');
  }
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }

  const expires = response.headers.get('X-Opaque-Expires') ?? undefined;
  const data = await response.arrayBuffer();
  return { data, expires };
}

/**
 * Create a workspace.
 *
 * The extension used to hand out v1 one-shot blobs, which meant everything it
 * shared was dead on arrival: no stable address, nothing to write back to, and
 * a link shape the rest of the product had moved past. Sharing now produces the
 * same thing the website and the CLI produce.
 *
 * Public workspaces are stored as plaintext, which is what lets an agent's
 * fetch read them with no key and no runtime. It is never the default and never
 * inferred — the caller has to ask.
 */
export async function createWorkspace(
  plaintext: Uint8Array,
  options: { public?: boolean; host?: string } = {},
): Promise<{ id: string; editUrl: string; viewUrl: string; expires: string }> {
  const host = options.host || VNSH_HOST;
  const secret = generateRootSecret();
  const { key, writeHash } = await deriveWorkspaceKeys(secret);

  const body = options.public ? plaintext : await encryptWorkspace(plaintext, key);

  const response = await fetch(`${host}/api/workspace`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      ...CLIENT_HEADER,
      'X-Vnsh-Write-Hash': writeHash,
      ...(options.public ? { 'X-Vnsh-Public': '1' } : {}),
    },
    body: body as BodyInit,
  });

  if (!response.ok) {
    throw new Error(`Create failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { id: string; expires: string; public?: boolean };
  return {
    id: data.id,
    editUrl: buildWorkspaceUrl(host, data.id, secret),
    // A public link carries no fragment, because there is no key to carry.
    viewUrl: data.public
      ? buildPublicUrl(host, data.id)
      : await buildReadOnlyWorkspaceUrl(host, data.id, secret),
    expires: data.expires,
  };
}
