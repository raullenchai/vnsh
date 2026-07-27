import { describe, it, expect } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';

type Env = { VNSH_STORE: R2Bucket };

// The write token is any 64 hex chars; the server only ever stores its SHA-256.
const WRITE_TOKEN = 'a'.repeat(64);

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function createWorkspace(body = 'ciphertext-v1', token = WRITE_TOKEN) {
  const response = await call(
    new Request('http://localhost/api/workspace', {
      method: 'POST',
      headers: { 'X-Vnsh-Write-Hash': await sha256Hex(token) },
      body,
    }),
  );
  const json = (await response.json()) as { id: string; version: number; expires: string };
  return { response, ...json };
}

function put(id: string, body: string, ifMatch: string, token = WRITE_TOKEN) {
  return call(
    new Request(`http://localhost/api/workspace/${id}`, {
      method: 'PUT',
      headers: { 'X-Vnsh-Write': token, 'If-Match': ifMatch },
      body,
    }),
  );
}

describe('Workspaces', () => {
  describe('POST /api/workspace', () => {
    it('creates a workspace at version 1', async () => {
      const { response, id, version, expires } = await createWorkspace();

      expect(response.status).toBe(201);
      expect(id).toMatch(/^[0-9A-Za-z]{12}$/);
      expect(version).toBe(1);
      expect(new Date(expires).getTime()).toBeGreaterThan(Date.now());
    });

    it('rejects a missing write hash', async () => {
      const response = await call(
        new Request('http://localhost/api/workspace', { method: 'POST', body: 'x' }),
      );
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toBe('INVALID_WRITE_HASH');
    });

    it('rejects a malformed write hash', async () => {
      const response = await call(
        new Request('http://localhost/api/workspace', {
          method: 'POST',
          headers: { 'X-Vnsh-Write-Hash': 'not-a-hash' },
          body: 'x',
        }),
      );
      expect(response.status).toBe(400);
      await response.arrayBuffer();
    });

    it('rejects GET', async () => {
      const response = await call(new Request('http://localhost/api/workspace'));
      expect(response.status).toBe(405);
      await response.arrayBuffer();
    });
  });

  describe('GET /api/workspace/:id', () => {
    it('returns the ciphertext with the version as ETag', async () => {
      const { id } = await createWorkspace('secret-bytes');

      const response = await call(new Request(`http://localhost/api/workspace/${id}`));
      expect(response.status).toBe(200);
      expect(response.headers.get('ETag')).toBe('"1"');
      expect(await response.text()).toBe('secret-bytes');
    });

    it('exposes ETag to cross-origin callers', async () => {
      const { id } = await createWorkspace();
      const response = await call(new Request(`http://localhost/api/workspace/${id}`));
      expect(response.headers.get('Access-Control-Expose-Headers')).toContain('ETag');
      await response.arrayBuffer(); // drain: an unconsumed R2 body leaks the storage handle
    });

    it('returns 404 for an unknown workspace', async () => {
      const response = await call(new Request('http://localhost/api/workspace/aaaaaaaaaaaa'));
      expect(response.status).toBe(404);
      await response.arrayBuffer();
    });
  });

  describe('PUT /api/workspace/:id', () => {
    it('bumps the version and returns the new content on read', async () => {
      const { id } = await createWorkspace('v1-bytes');

      const response = await put(id, 'v2-bytes', '"1"');
      expect(response.status).toBe(200);
      expect((await response.json() as { version: number }).version).toBe(2);

      const read = await call(new Request(`http://localhost/api/workspace/${id}`));
      expect(read.headers.get('ETag')).toBe('"2"');
      expect(await read.text()).toBe('v2-bytes');
    });

    it('accepts an unquoted If-Match', async () => {
      const { id } = await createWorkspace();
      const response = await put(id, 'next', '1');
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    });

    it('rejects a wrong write token with 403', async () => {
      const { id } = await createWorkspace();
      const response = await put(id, 'evil', '"1"', 'b'.repeat(64));
      expect(response.status).toBe(403);
      await response.arrayBuffer();

      // Content must be untouched.
      const read = await call(new Request(`http://localhost/api/workspace/${id}`));
      expect(await read.text()).toBe('ciphertext-v1');
    });

    it('rejects a missing write token with 401', async () => {
      const { id } = await createWorkspace();
      const response = await call(
        new Request(`http://localhost/api/workspace/${id}`, {
          method: 'PUT',
          headers: { 'If-Match': '"1"' },
          body: 'x',
        }),
      );
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    });

    it('refuses an unconditional write with 428', async () => {
      const { id } = await createWorkspace();
      const response = await call(
        new Request(`http://localhost/api/workspace/${id}`, {
          method: 'PUT',
          headers: { 'X-Vnsh-Write': WRITE_TOKEN },
          body: 'x',
        }),
      );
      expect(response.status).toBe(428);
      await response.arrayBuffer();
    });

    it('rejects a stale If-Match with 412 and names the current version', async () => {
      const { id } = await createWorkspace();
      await put(id, 'v2', '"1"');

      const response = await put(id, 'v3-from-stale-reader', '"1"');
      expect(response.status).toBe(412);
      expect((await response.json() as { message: string }).message).toContain('version 2');

      // The stale write must not have landed.
      const read = await call(new Request(`http://localhost/api/workspace/${id}`));
      expect(await read.text()).toBe('v2');
    });

    it('returns 404 when the workspace does not exist', async () => {
      const response = await put('bbbbbbbbbbbb', 'x', '"1"');
      expect(response.status).toBe(404);
      await response.arrayBuffer();
    });

    it('renews the TTL on every write', async () => {
      const { id, expires } = await createWorkspace();
      const first = new Date(expires).getTime();

      const response = await put(id, 'v2', '"1"');
      const renewed = new Date((await response.json() as { expires: string }).expires).getTime();

      expect(renewed).toBeGreaterThanOrEqual(first);
    });
  });

  describe('expiry', () => {
    it('returns 410 and deletes once past expiresAt', async () => {
      const { id } = await createWorkspace();

      // Backdate the expiry in place.
      const key = `w/${id}`;
      const existing = await env.VNSH_STORE.get(key);
      const body = await existing!.arrayBuffer();
      await env.VNSH_STORE.put(key, body, {
        customMetadata: {
          ...existing!.customMetadata,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        },
      });

      const response = await call(new Request(`http://localhost/api/workspace/${id}`));
      expect(response.status).toBe(410);
      await response.arrayBuffer();
      expect(await env.VNSH_STORE.head(key)).toBeNull();
    });
  });
});

describe('GET /w/:id landing page', () => {
  it('serves a page instead of 404 so the URL is not a dead end', async () => {
    const response = await call(new Request('http://localhost/w/aBcDeFgHiJkL'));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('vnsh workspace');
    // Phase 0 must not render workspace content on the vnsh origin — user HTML
    // there could read the key out of location.hash.
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain('<script');
  });
});
