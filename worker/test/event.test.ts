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
    // Slot layout is load-bearing: queries read positions, and rows already
    // written cannot be migrated, so slots may only ever be appended.
    // blob6 is visibility, which a beacon event has no notion of.
    // blob7 is the client version, appended after blob6. A beacon from the page
    // sends 'web' with no version, so it is empty here — the slot existing at
    // all is what makes a client rollout observable.
    expect(point.blobs).toEqual(['prompt_copy', 'web', '', '', 'w', '', '']);
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

/**
 * prompt_copy sat at zero across every page view the site has ever had. That
 * number has two incompatible readings — nobody scrolled to the CTA, or
 * everybody saw it and declined — and they call for opposite fixes. prompt_seen
 * is what separates them, so it has to be a beacon event the page may report.
 */
describe('the setup funnel can distinguish unseen from declined', () => {
  it('accepts prompt_seen from the page', async () => {
    const response = await beacon({ event: 'prompt_seen', ref: 'home' }, { 'X-Vnsh-Client': 'web' });
    expect(response.status).toBe(204);
    const [point] = eventsNamed('prompt_seen');
    expect(point).toBeDefined();
    expect(point.blobs?.[4]).toBe('home');
  });

  it('still refuses an event that is not on the whitelist', async () => {
    const response = await beacon({ event: 'workspace_create' }, { 'X-Vnsh-Client': 'web' });
    expect(response.status).toBe(204);
    // Inferred events must not be forgeable through the beacon, or the funnel
    // could be inflated by anyone with curl.
    expect(eventsNamed('workspace_create')).toHaveLength(0);
  });
});

/**
 * Keeping only the client name made a rollout unobservable: "mcp called 400
 * times" reads identically before and after a fix ships. When the MCP server's
 * image corruption was finally fixed, the question "did anyone pick it up" had
 * no answer, because the version half of X-Vnsh-Client was split off and thrown
 * away — and both clients had hardcoded it stale anyway.
 */
describe('the client version reaches the analytics row', () => {
  it('records the version alongside the source', async () => {
    written.length = 0;
    await call(new Request('http://localhost/api/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vnsh-Client': 'mcp/1.4.4' },
      body: JSON.stringify({ event: 'page_view' }),
    }));
    const point = written.find((p) => p.blobs?.[0] === 'page_view');
    expect(point?.blobs?.[1]).toBe('mcp');
    expect(point?.blobs?.[6]).toBe('1.4.4');
  });

  it('does not let a client write arbitrary bytes into the row', async () => {
    written.length = 0;
    await call(new Request('http://localhost/api/event', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // A newline is rejected by the platform before this code sees it, so the
        // interesting case is junk that is a legal header value.
        'X-Vnsh-Client': 'cli-npm/2.3.4<script>alert(1)</script>' + 'x'.repeat(200),
      },
      body: JSON.stringify({ event: 'page_view' }),
    }));
    const point = written.find((p) => p.blobs?.[0] === 'page_view');
    // Assert the property, not the exact mangling: the version is whatever
    // survives, but it can never carry markup, be unbounded, or contain a
    // separator. (`</script>` holds a '/', so the split already stops there —
    // which is why pinning the mangled string would be testing an accident.)
    const version = point?.blobs?.[6] as string;
    expect(version).toMatch(/^[0-9A-Za-z.\-]*$/);
    expect(version.length).toBeLessThanOrEqual(24);
    expect(version.startsWith('2.3.4')).toBe(true);
  });

  it('leaves the slot empty when a client sends no version', async () => {
    written.length = 0;
    await call(new Request('http://localhost/api/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vnsh-Client': 'web' },
      body: JSON.stringify({ event: 'page_view' }),
    }));
    expect(written.find((p) => p.blobs?.[0] === 'page_view')?.blobs?.[6]).toBe('');
  });
});
