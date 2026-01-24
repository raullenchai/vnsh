import { describe, it, expect, beforeEach } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';

// Type for our worker's env
type Env = {
  VNSH_STORE: R2Bucket;
  VNSH_META: KVNamespace;
};

describe('vnsh API', () => {
  describe('Health Check', () => {
    it('GET /health returns status ok', async () => {
      const request = new Request('http://localhost/health');
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ status: 'ok', service: 'vnsh' });
    });
  });

  describe('Upload Page', () => {
    it('GET / returns upload HTML', async () => {
      const request = new Request('http://localhost/');
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/html');

      const html = await response.text();
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('vnsh');
      expect(html).toContain('Ephemeral Dropbox for AI');
    });
  });

  describe('POST /api/drop', () => {
    it('uploads blob and returns ID', async () => {
      const testContent = 'test-content-' + Date.now();
      const request = new Request('http://localhost/api/drop', {
        method: 'POST',
        body: testContent,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(201);
      const body = await response.json() as { id: string; expires: string };
      expect(body.id).toMatch(/^[a-f0-9-]{36}$/);
      expect(body.expires).toBeDefined();
    });

    it('accepts TTL parameter', async () => {
      const request = new Request('http://localhost/api/drop?ttl=1', {
        method: 'POST',
        body: 'ttl-test',
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(201);
      const body = await response.json() as { id: string; expires: string };

      // Verify expiry is approximately 1 hour from now
      const expiresAt = new Date(body.expires).getTime();
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;
      expect(expiresAt - now).toBeLessThan(oneHour + 5000);
      expect(expiresAt - now).toBeGreaterThan(oneHour - 5000);
    });

    it('accepts price parameter for x402', async () => {
      const request = new Request('http://localhost/api/drop?price=0.01', {
        method: 'POST',
        body: 'paid-content',
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(201);
    });

    it('rejects empty body', async () => {
      const request = new Request('http://localhost/api/drop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(400);
      const body = await response.json() as { error: string };
      expect(body.error).toBe('EMPTY_BODY');
    });

    it('includes CORS headers', async () => {
      const request = new Request('http://localhost/api/drop', {
        method: 'POST',
        body: 'cors-test',
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });

  describe('GET /api/blob/:id', () => {
    it('downloads previously uploaded blob', async () => {
      // First upload
      const testContent = 'download-test-' + Date.now();
      const uploadRequest = new Request('http://localhost/api/drop', {
        method: 'POST',
        body: testContent,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      const uploadCtx = createExecutionContext();
      const uploadResponse = await worker.fetch(uploadRequest, env as Env, uploadCtx);
      await waitOnExecutionContext(uploadCtx);
      const { id } = await uploadResponse.json() as { id: string };

      // Then download
      const downloadRequest = new Request(`http://localhost/api/blob/${id}`);
      const downloadCtx = createExecutionContext();
      const downloadResponse = await worker.fetch(downloadRequest, env as Env, downloadCtx);
      await waitOnExecutionContext(downloadCtx);

      expect(downloadResponse.status).toBe(200);
      expect(downloadResponse.headers.get('Content-Type')).toBe('application/octet-stream');
      expect(downloadResponse.headers.get('Cache-Control')).toBe('private, no-store, no-cache');

      const body = await downloadResponse.text();
      expect(body).toBe(testContent);
    });

    it('returns 404 for non-existent blob', async () => {
      const request = new Request('http://localhost/api/blob/00000000-0000-0000-0000-000000000000');
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(404);
      const body = await response.json() as { error: string };
      expect(body.error).toBe('NOT_FOUND');
    });

    it('returns 402 for paid blob without payment proof', async () => {
      // Upload with price
      const uploadRequest = new Request('http://localhost/api/drop?price=0.01', {
        method: 'POST',
        body: 'paid-content',
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      const uploadCtx = createExecutionContext();
      const uploadResponse = await worker.fetch(uploadRequest, env as Env, uploadCtx);
      await waitOnExecutionContext(uploadCtx);
      const { id } = await uploadResponse.json() as { id: string };

      // Try to download without payment
      const downloadRequest = new Request(`http://localhost/api/blob/${id}`);
      const downloadCtx = createExecutionContext();
      const downloadResponse = await worker.fetch(downloadRequest, env as Env, downloadCtx);
      await waitOnExecutionContext(downloadCtx);

      expect(downloadResponse.status).toBe(402);
      expect(downloadResponse.headers.get('X-Payment-Price')).toBe('0.01');
      expect(downloadResponse.headers.get('X-Payment-Currency')).toBe('USD');

      const body = await downloadResponse.json() as { error: string; payment: { price: number } };
      expect(body.error).toBe('PAYMENT_REQUIRED');
      expect(body.payment.price).toBe(0.01);
    });

    it('includes CORS headers', async () => {
      const request = new Request('http://localhost/api/blob/any-id');
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });

  describe('CORS Preflight', () => {
    it('OPTIONS /api/drop returns correct headers', async () => {
      const request = new Request('http://localhost/api/drop', {
        method: 'OPTIONS',
      });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    });

    it('OPTIONS /api/blob/:id returns correct headers', async () => {
      const request = new Request('http://localhost/api/blob/test-id', {
        method: 'OPTIONS',
      });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    });
  });

  describe('Viewer Route', () => {
    it('GET /v/:id serves app HTML directly (preserves hash fragment with keys)', async () => {
      const request = new Request('http://localhost/v/12345678-1234-1234-1234-123456789abc');
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      // Serves HTML directly instead of redirect to preserve #k=...&iv=... fragment
      // Bug fix: redirect to /#v/:id broke hash fragments - browser replaces hash, doesn't merge
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/html');
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
      const html = await response.text();
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('vnsh');
    });

    it('HTML contains JavaScript to handle /v/:id path format', async () => {
      // Bug fix: JavaScript must detect /v/:id in pathname and extract keys from hash
      const request = new Request('http://localhost/v/12345678-1234-1234-1234-123456789abc');
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      const html = await response.text();
      // Verify JS handles both /v/:id path format AND legacy #v/:id hash format
      expect(html).toContain('location.pathname');
      expect(html).toContain('pathMatch');
      expect(html).toContain('/^\\/v\\/([a-f0-9-]+)$/');
    });

    it('does not redirect (would break hash fragment)', async () => {
      const request = new Request('http://localhost/v/12345678-1234-1234-1234-123456789abc');
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      // Must NOT be a redirect - redirects break hash fragments
      expect(response.status).not.toBe(301);
      expect(response.status).not.toBe(302);
      expect(response.headers.get('Location')).toBeNull();
    });
  });

  describe('Install Script', () => {
    it('GET /i returns install script as text/plain', async () => {
      const request = new Request('http://localhost/i');
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/plain');

      const script = await response.text();
      expect(script).toContain('#!/bin/sh');
      expect(script).toContain('vn()');
      expect(script).toContain('vnsh.dev');
    });

    it('uses valid shell commands for JSON parsing', async () => {
      // Bug fix: complex shell quoting with grep/cut broke on macOS
      // Now uses sed which has simpler quoting requirements
      const request = new Request('http://localhost/i');
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      const script = await response.text();

      // Should use sed for ID extraction (not grep | cut with complex quoting)
      expect(script).toContain('sed -n');
      expect(script).toMatch(/\\?"id\\?"/); // Matches "id" or \"id\"

      // Should NOT use echo -e for output (not portable to macOS /bin/sh)
      // Check that echo -e is not used for actual output (followed by quote or variable)
      expect(script).not.toMatch(/echo -e ["'$]/);

      // Should use printf for colors (POSIX portable)
      expect(script).toContain('printf "%b"');

      // Should detect OS for platform-specific handling
      expect(script).toContain('detect_os');
      expect(script).toContain('uname');

      // Should check for required dependencies
      expect(script).toContain('command -v openssl');
      expect(script).toContain('command -v curl');

      // Should use POSIX-compatible base64 (tr to remove newlines works on both BSD and GNU)
      expect(script).toContain('tr -d');

      // Should use shebang #!/bin/sh (not bash) for portability
      expect(script.startsWith('#!/bin/sh')).toBe(true);
    });
  });

  describe('404 Handling', () => {
    it('returns 404 for unknown routes', async () => {
      const request = new Request('http://localhost/unknown/route');
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(404);
      const body = await response.json() as { error: string };
      expect(body.error).toBe('NOT_FOUND');
    });
  });
});
