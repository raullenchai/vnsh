import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';

type Env = { VNSH_STORE: R2Bucket };

// Analytics Engine is unbound in tests, so trackEvent() no-ops and every
// assertion about "what got recorded" would silently pass. Stub the binding so
// the whitelist and the blob layout are actually exercised.
type Point = { blobs?: string[]; doubles?: number[]; indexes?: string[] };
let written: Point[] = [];

beforeEach(() => {
  written = [];
  (env as Record<string, unknown>).VNSH_ANALYTICS = {
    writeDataPoint: (p: Point) => void written.push(p),
  };
});

afterEach(() => {
  delete (env as Record<string, unknown>).VNSH_ANALYTICS;
});

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const eventsNamed = (name: string) => written.filter((p) => p.blobs?.[0] === name);

function beacon(body: unknown, headers: Record<string, string> = {}) {
  return call(
    new Request('http://localhost/api/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

describe('POST /api/event', () => {
  it('records a whitelisted event with its referrer in blob5', async () => {
    const response = await beacon({ event: 'prompt_copy', ref: 'w' }, { 'X-Vnsh-Client': 'web' });
    expect(response.status).toBe(204);

    const [point] = eventsNamed('prompt_copy');
    expect(point).toBeDefined();
    // Slot layout is load-bearing: existing queries read blob3/blob4.
    expect(point.blobs).toEqual(['prompt_copy', 'web', '', '', 'w']);
    expect(point.indexes).toEqual(['prompt_copy']);
  });

  it('records a page view', async () => {
    await beacon({ event: 'page_view', ref: 'home' });
    expect(eventsNamed('page_view')).toHaveLength(1);
  });

  // The beacon is unauthenticated, so it must not be able to manufacture the
  // events the funnel is actually judged on. Those are only ever written from a
  // real request that did the work.
  it('refuses to record a forged workspace or upload event', async () => {
    for (const event of ['workspace_create', 'workspace_update', 'workspace_read', 'upload', 'read']) {
      const response = await beacon({ event, ref: 'w' });
      expect(response.status).toBe(204);
      expect(eventsNamed(event)).toHaveLength(0);
    }
    expect(written).toHaveLength(0);
  });

  it('answers 204 on malformed input rather than surfacing an error', async () => {
    expect((await beacon('not json at all')).status).toBe(204);
    expect((await beacon({})).status).toBe(204);
    expect((await beacon({ event: null })).status).toBe(204);
    expect(written).toHaveLength(0);
  });

  it('buckets an unrecognised referrer as direct instead of storing it', async () => {
    await beacon({ event: 'page_view', ref: '../../etc/passwd' });
    expect(eventsNamed('page_view')[0].blobs?.[4]).toBe('direct');
  });

  it('sets CORS headers so the beacon works from the workspace page', async () => {
    const response = await beacon({ event: 'page_view' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('rejects methods other than POST', async () => {
    const response = await call(new Request('http://localhost/api/event'));
    expect(response.status).toBe(405);
  });

  it('allows X-Vnsh-Ref through preflight', async () => {
    const response = await call(
      new Request('http://localhost/api/event', { method: 'OPTIONS' }),
    );
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('X-Vnsh-Ref');
  });
});

describe('workspace create attribution', () => {
  async function create(headers: Record<string, string>) {
    return call(
      new Request('http://localhost/api/workspace', {
        method: 'POST',
        headers: { 'X-Vnsh-Write-Hash': 'a'.repeat(64), ...headers },
        body: 'ciphertext',
      }),
    );
  }

  // This is the whole point of the change: a create that came from reading
  // someone else's workspace has to be distinguishable from a cold create,
  // otherwise the reader -> creator loop cannot be measured at all.
  it('separates a create from a reader from a cold create', async () => {
    expect((await create({ 'X-Vnsh-Ref': 'w', 'X-Vnsh-Client': 'web' })).status).toBe(201);
    expect((await create({ 'X-Vnsh-Client': 'web' })).status).toBe(201);

    const refs = eventsNamed('workspace_create').map((p) => p.blobs?.[4]);
    expect(refs).toEqual(['w', 'direct']);
  });

  it('still records the workspace id and agent in their existing slots', async () => {
    await create({ 'X-Vnsh-Client': 'mcp', 'X-Vnsh-Agent': 'Cursor', 'X-Vnsh-Ref': 'w' });
    const [point] = eventsNamed('workspace_create');
    expect(point.blobs?.[1]).toBe('mcp');
    expect(point.blobs?.[2]).toMatch(/^[0-9A-Za-z]{12}$/);
    expect(point.blobs?.[3]).toBe('cursor');
  });
});
