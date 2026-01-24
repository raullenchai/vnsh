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
    it('GET /v/:id redirects to hash-based route', async () => {
      const request = new Request('http://localhost/v/12345678-1234-1234-1234-123456789abc');
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('/#v/12345678-1234-1234-1234-123456789abc');
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
      expect(script).toContain('#!/bin/bash');
      expect(script).toContain('vn()');
      expect(script).toContain('vnsh.dev');
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
