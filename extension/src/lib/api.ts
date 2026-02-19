/**
 * API client for vnsh server.
 * Thin wrappers around POST /api/drop and GET /api/blob/:id.
 */

import { VNSH_HOST } from './constants';

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
