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
      // The landing page provides an immediate create path, then demonstrates
      // the handoff and concrete use cases.
      expect(html).toContain('One link. Any Agent. No lost context.');
      expect(html).toContain('id="hero-creator"');
      expect(html).toContain('One link · the same context · every tool');
      expect(html).toContain('Browser research → coding Agent');
      expect(html).toContain('Research → implementation');
      expect(html).toContain('Agent proposal → your decision');
      expect(html).toContain('Drop a file or paste text');
      expect(html).toContain('claude mcp add vnsh -- npx -y vnsh-mcp@1.8.2');
    });
  });

  describe('Human documentation', () => {
    it('GET /docs explains the product and links to the agent protocol', async () => {
      const request = new Request('http://localhost/docs');
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/html');
      const html = await response.text();
      expect(html).toContain('Give every Agent the context it needs.');
      expect(html).toContain('Your first shared Workspace');
      expect(html).toContain('Two modes, two different promises');
      expect(html).toContain('Connect through MCP');
      expect(html).toContain('Know where the trust boundary is');
      expect(html).toContain('href="/llms.txt"');
    });

    it('HEAD /docs returns headers without a body', async () => {
      const request = new Request('http://localhost/docs', { method: 'HEAD' });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/html');
      expect(await response.text()).toBe('');
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
      // New short ID format: 12 chars base62
      expect(body.id).toMatch(/^[0-9A-Za-z]{12}$/);
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

    /**
     * `?price=` used to mark a blob paid, and reads of it were gated behind a
     * 402 that accepted any non-empty `?paymentProof=`. Reported from outside
     * as a bypass (#6). The paywall is gone rather than fixed, so the parameter
     * has to be inert both ways: still accepted, since published CLIs send it,
     * and carrying no consequence on the read.
     */
    it('accepts a stale ?price= without gating the read behind it', async () => {
      const request = new Request('http://localhost/api/drop?price=0.01', {
        method: 'POST',
        body: 'no-longer-paid-content',
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(201);
      const { id } = await response.json() as { id: string };

      // No proof of anything, and no 402.
      const readCtx = createExecutionContext();
      const read = await worker.fetch(new Request(`http://localhost/api/blob/${id}`), env as Env, readCtx);
      await waitOnExecutionContext(readCtx);

      expect(read.status).toBe(200);
      expect(read.headers.get('X-Payment-Methods')).toBeNull();
      expect(await read.text()).toBe('no-longer-paid-content');
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
      // Updated regex supports both UUID and short base62 IDs
      expect(html).toContain('/^\\/v\\/([a-zA-Z0-9-]+)$/');
    });

    it('contains AI instructions for agents without MCP', async () => {
      // AI agents using WebFetch see the HTML as text - they need instructions
      const request = new Request('http://localhost/v/12345678-1234-1234-1234-123456789abc');
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      const html = await response.text();
      // Verify AI instructions banner is present for agents
      expect(html).toContain('ai-instructions');
      expect(html).toContain('AI Agent');
      expect(html).toContain('curl -sL vnsh.dev/claude | sh');
      // The banner points at the zero-install path so an agent with only a shell
      // can act on it; it no longer names the MCP tool, which requires setup first.
      expect(html).toContain('npx vnsh read');
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

  describe('OpenClaw Skill', () => {
    it('GET /skill.md returns SKILL.md as text/markdown', async () => {
      const request = new Request('http://localhost/skill.md');
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/markdown');

      const skill = await response.text();
      // Check YAML frontmatter
      expect(skill).toContain('---');
      expect(skill).toContain('name: vnsh');
      expect(skill).toContain('openclaw:');
      // Check content
      expect(skill).toContain('vnsh - Encrypted Agent-to-Agent File Sharing');
      expect(skill).toContain('vnsh.dev');
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

  // Regression: list() without include:['customMetadata'] returns an empty
  // customMetadata object, so expiresAt read as undefined and every object fell
  // through to the 8-day legacy branch — blobs lived ~8 days instead of 24h.
  describe('cleanup cron', () => {
    it('sees customMetadata when listing, so expired objects are collected', async () => {
      const key = 'cccccccccccc';
      await env.VNSH_STORE.put(key, 'expired-bytes', {
        customMetadata: { expiresAt: new Date(Date.now() - 1000).toISOString() },
      });

      const listed = await env.VNSH_STORE.list({
        limit: 1000,
        include: ['customMetadata'],
      } as R2ListOptions & { include: ('customMetadata' | 'httpMetadata')[] });

      const found = listed.objects.find((o) => o.key === key);
      expect(found?.customMetadata?.expiresAt).toBeDefined();

      const ctx = createExecutionContext();
      await worker.scheduled!({} as ScheduledEvent, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      expect(await env.VNSH_STORE.head(key)).toBeNull();
    });
  });
});

/**
 * "Host-blind" is easy to over-read. The server holding no key is verifiable
 * from outside, but whatever does the encrypting holds the plaintext first —
 * and the recommended install refetches that code on every start. A document
 * that invites people to reimplement the protocol owes them both facts.
 */
describe('llms.txt states the trust boundary', () => {
  async function llms(): Promise<string> {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request('http://localhost/llms.txt'), env as Env, ctx);
    await waitOnExecutionContext(ctx);
    return response.text();
  }

  it('answers HEAD discovery probes', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request('http://localhost/llms.txt', { method: 'HEAD' }), env as Env, ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it('documents self-describing Account Artifact capability links', async () => {
    const text = await llms();
    expect(text).toContain('## Account Artifact capability links');
    expect(text).toContain('https://account.vnsh.dev/c/{bearer-token}');
    expect(text).toContain('X-Vnsh-Capability');
    expect(text).toContain('If-Match: "<current ETag version>"');
    expect(text).toContain('412 VERSION_CONFLICT');
    expect(text).toMatch(/not host-blind encryption/i);
  });

  it('distinguishes what is verifiable from what is merely true today', async () => {
    const text = await llms();
    expect(text).toMatch(/the boundary is the client, not the transport/i);
    expect(text).toMatch(/vnsh cannot read your content/i);
    // The claim it must not let a reader infer.
    expect(text).toMatch(/not what is claimed/i);
  });

  it('says that the default install refetches code on every start', async () => {
    const text = await llms();
    expect(text).toMatch(/refetches the latest published version/i);
  });

  it('gives a way to pin, for someone who reviews what they run', async () => {
    const text = await llms();
    expect(text).toContain('npx -y vnsh-mcp@');
    expect(text).toMatch(/npm i -g vnsh-mcp@/);
    expect(text).toMatch(/git clone/);
  });

  it('documents creating a workspace, not only reading one', async () => {
    // The document's whole premise is that the clients are optional. It omitted
    // the create endpoint entirely, which someone found by getting a 400.
    const text = await llms();
    expect(text).toContain('POST https://vnsh.dev/api/workspace');
    expect(text).toContain('X-Vnsh-Write-Hash');
    expect(text).toMatch(/X-Vnsh-Public/);
  });
});
