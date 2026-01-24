/**
 * End-to-End Tests for vnsh
 *
 * These tests validate the complete flow:
 * - CLI upload → API storage → Download → Decryption
 * - Payment flows (x402)
 * - Expiry handling
 *
 * Prerequisites:
 * - Worker running locally: cd worker && npm run dev
 * - CLI available: vn (install via: curl -sL vnsh.dev/i | sh)
 *
 * Run with: VNSH_HOST=http://localhost:8787 npx vitest run tests/e2e.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync, exec } from 'child_process';
import { createDecipheriv } from 'crypto';
import { promisify } from 'util';

const execAsync = promisify(exec);

const HOST = process.env.VNSH_HOST || 'http://localhost:8787';
const CLI_PATH = process.env.VN_PATH || 'vn';

// Helper to run CLI commands
function runCLI(args: string, input?: string): string {
  const env = { ...process.env, VNSH_HOST: HOST };
  if (input) {
    return execSync(`echo -n '${input}' | ${CLI_PATH} ${args}`, { env, encoding: 'utf-8' });
  }
  return execSync(`${CLI_PATH} ${args}`, { env, encoding: 'utf-8' });
}

// Helper to make HTTP requests
async function httpRequest(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${HOST}${path}`, options);
}

// Parse URL fragment to extract key and IV
function parseFragment(url: string): { id: string; key: string; iv: string } {
  const urlObj = new URL(url);
  const id = urlObj.pathname.split('/').pop()!;
  const params = new URLSearchParams(urlObj.hash.slice(1));
  return {
    id,
    key: params.get('k')!,
    iv: params.get('iv')!,
  };
}

// Decrypt content using Node.js crypto (simulates MCP server)
function decryptContent(ciphertext: Buffer, keyHex: string, ivHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
}

describe('E2E: Basic Upload/Download Flow', () => {
  it('uploads content via CLI and downloads via API', async () => {
    const testContent = `e2e-test-${Date.now()}`;

    // Upload via CLI
    const output = runCLI('', testContent);
    expect(output).toContain(HOST);
    expect(output).toContain('#k=');
    expect(output).toContain('&iv=');

    // Extract URL from output
    const urlMatch = output.match(new RegExp(`${HOST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/v/[a-f0-9-]+#k=[a-f0-9]+&iv=[a-f0-9]+`));
    expect(urlMatch).toBeTruthy();
    const url = urlMatch![0];

    // Parse fragment
    const { id, key, iv } = parseFragment(url);
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    expect(key.length).toBe(64);
    expect(iv.length).toBe(32);

    // Download encrypted blob
    const response = await httpRequest(`/api/blob/${id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');

    // Decrypt and verify
    const encrypted = Buffer.from(await response.arrayBuffer());
    const decrypted = decryptContent(encrypted, key, iv);
    expect(decrypted).toBe(testContent);
  });

  it('uploads file via CLI', async () => {
    // Create temp file
    const tempFile = `/tmp/vnsh-test-${Date.now()}.txt`;
    const fileContent = `file-content-${Date.now()}`;
    execSync(`echo -n '${fileContent}' > ${tempFile}`);

    try {
      const output = runCLI(tempFile);
      expect(output).toContain(HOST);
      expect(output).toContain('#k=');

      // Clean up and verify
      const urlMatch = output.match(new RegExp(`${HOST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/v/[a-f0-9-]+#k=[a-f0-9]+&iv=[a-f0-9]+`));
      const { id, key, iv } = parseFragment(urlMatch![0]);

      const response = await httpRequest(`/api/blob/${id}`);
      const encrypted = Buffer.from(await response.arrayBuffer());
      const decrypted = decryptContent(encrypted, key, iv);
      expect(decrypted).toBe(fileContent);
    } finally {
      execSync(`rm -f ${tempFile}`);
    }
  });

  it('CLI --local mode outputs encrypted blob without upload', () => {
    const testContent = 'local-mode-test';
    const output = runCLI('--local', testContent);

    expect(output).toContain('Encrypted blob (base64):');
    expect(output).toContain('Decryption key:');
    expect(output).toContain('IV:');
    expect(output).not.toContain(HOST);

    // Extract and verify we can decrypt
    const base64Match = output.match(/Encrypted blob \(base64\):\n(.+)/);
    const keyMatch = output.match(/Decryption key: ([a-f0-9]+)/);
    const ivMatch = output.match(/IV: ([a-f0-9]+)/);

    expect(base64Match).toBeTruthy();
    expect(keyMatch).toBeTruthy();
    expect(ivMatch).toBeTruthy();

    const encrypted = Buffer.from(base64Match![1].trim(), 'base64');
    const decrypted = decryptContent(encrypted, keyMatch![1], ivMatch![1]);
    expect(decrypted).toBe(testContent);
  });
});

describe('E2E: TTL and Expiry', () => {
  it('accepts TTL parameter via CLI', async () => {
    const output = runCLI('--ttl 1', 'ttl-test');
    expect(output).toContain('Expires:');
  });

  it('respects TTL on API upload', async () => {
    const response = await httpRequest('/api/drop?ttl=1', {
      method: 'POST',
      body: 'api-ttl-test',
      headers: { 'Content-Type': 'application/octet-stream' },
    });

    expect(response.status).toBe(201);
    const body = await response.json() as { expires: string };

    // Verify expiry is ~1 hour from now
    const expiresAt = new Date(body.expires).getTime();
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    expect(expiresAt - now).toBeLessThan(oneHour + 10000);
    expect(expiresAt - now).toBeGreaterThan(oneHour - 10000);
  });
});

describe('E2E: x402 Payment Flow', () => {
  it('uploads paid content via CLI', async () => {
    const output = runCLI('--price 0.05', 'premium-content');
    expect(output).toContain('Price:');
    expect(output).toContain('$0.05');
  });

  it('returns 402 for paid content without payment proof', async () => {
    // Upload with price
    const uploadResponse = await httpRequest('/api/drop?price=0.01', {
      method: 'POST',
      body: 'paid-api-test',
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    const { id } = await uploadResponse.json() as { id: string };

    // Try to download without payment
    const downloadResponse = await httpRequest(`/api/blob/${id}`);
    expect(downloadResponse.status).toBe(402);

    // Check payment headers
    expect(downloadResponse.headers.get('X-Payment-Price')).toBe('0.01');
    expect(downloadResponse.headers.get('X-Payment-Currency')).toBe('USD');
    expect(downloadResponse.headers.get('X-Payment-Methods')).toContain('lightning');
    expect(downloadResponse.headers.get('X-Payment-Methods')).toContain('stripe');

    // Check body
    const body = await downloadResponse.json() as { error: string; payment: { price: number; methods: string[] } };
    expect(body.error).toBe('PAYMENT_REQUIRED');
    expect(body.payment.price).toBe(0.01);
    expect(body.payment.methods).toContain('lightning');
  });

  it('allows download with payment proof (mock)', async () => {
    // Upload with price
    const uploadResponse = await httpRequest('/api/drop?price=0.01', {
      method: 'POST',
      body: 'paid-with-proof',
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    const { id } = await uploadResponse.json() as { id: string };

    // Download with mock payment proof
    // Note: In production this would be a valid JWT
    const downloadResponse = await httpRequest(`/api/blob/${id}?paymentProof=mock-token`);

    // Current implementation accepts any non-empty proof for testing
    expect(downloadResponse.status).toBe(200);
    const content = await downloadResponse.text();
    expect(content).toBe('paid-with-proof');
  });
});

describe('E2E: Error Handling', () => {
  it('returns 404 for non-existent blob', async () => {
    const response = await httpRequest('/api/blob/00000000-0000-0000-0000-000000000000');
    expect(response.status).toBe(404);

    const body = await response.json() as { error: string; message: string };
    expect(body.error).toBe('NOT_FOUND');
  });

  it('returns 400 for empty upload', async () => {
    const response = await httpRequest('/api/drop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    expect(response.status).toBe(400);

    const body = await response.json() as { error: string };
    expect(body.error).toBe('EMPTY_BODY');
  });

  it('returns 404 for unknown routes', async () => {
    const response = await httpRequest('/unknown/route');
    expect(response.status).toBe(404);
  });
});

describe('E2E: CORS', () => {
  it('includes CORS headers on all responses', async () => {
    // Test health endpoint
    const healthResponse = await httpRequest('/');
    expect(healthResponse.headers.get('Access-Control-Allow-Origin')).toBe('*');

    // Test upload
    const uploadResponse = await httpRequest('/api/drop', {
      method: 'POST',
      body: 'cors-test',
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    expect(uploadResponse.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('handles OPTIONS preflight correctly', async () => {
    const response = await httpRequest('/api/drop', { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
  });
});

describe('E2E: Viewer', () => {
  it('serves HTML viewer for /v/:id routes', async () => {
    const response = await httpRequest('/v/12345678-1234-1234-1234-123456789abc');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');

    const html = await response.text();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('vnsh');
    expect(html).toContain('crypto.subtle'); // WebCrypto API usage
  });
});

describe('E2E: Binary Content', () => {
  it('handles binary content correctly', async () => {
    // Create binary content (some random bytes)
    const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd, 0x00, 0x00]);

    const uploadResponse = await httpRequest('/api/drop', {
      method: 'POST',
      body: binaryContent,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    expect(uploadResponse.status).toBe(201);
    const { id } = await uploadResponse.json() as { id: string };

    // Download and verify bytes match exactly
    const downloadResponse = await httpRequest(`/api/blob/${id}`);
    const downloaded = Buffer.from(await downloadResponse.arrayBuffer());
    expect(downloaded.equals(binaryContent)).toBe(true);
  });
});
