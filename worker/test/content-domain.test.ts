import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';

/**
 * Public documents are served from their own registrable domain. The isolation
 * that buys is not about sandboxing — an opaque origin already handles what a
 * page can *reach* — it is about whose name is on the page when a reporter or a
 * scanner decides what to list. So what these tests pin down is the boundary
 * itself: that the content domain answers for published documents and for
 * nothing else, and that a route added to the worker later is off it by default.
 */

const CONTENT_HOST = 'vnshcontent.dev';
const WRITE_TOKEN = 'c'.repeat(64);

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

type TestEnv = Record<string, unknown>;

async function call(request: Request, overrides: TestEnv = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    request,
    { ...(env as TestEnv), CONTENT_HOST, ...overrides } as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function createPublic(body = '<!DOCTYPE html><h1>published</h1>') {
  const response = await call(
    new Request('https://vnsh.dev/api/workspace', {
      method: 'POST',
      headers: { 'X-Vnsh-Write-Hash': await sha256Hex(WRITE_TOKEN), 'X-Vnsh-Public': '1' },
      body,
    }),
  );
  expect(response.status).toBe(201);
  return response.json<{ id: string; public: boolean; url?: string }>();
}

describe('the content domain serves published documents and nothing else', () => {
  it('serves a public document', async () => {
    const body = '<!DOCTYPE html><h1>published</h1>';
    const { id } = await createPublic(body);

    const response = await call(new Request(`https://${CONTENT_HOST}/p/${id}`));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
  });

  // The whole point of the second domain is that an escape or a listing here
  // reaches nothing that matters. If the API were reachable, it would.
  it.each([
    ['the API', 'GET', '/api/workspace/aaaaaaaaaaaa'],
    ['workspace creation', 'POST', '/api/workspace'],
    ['the blob API', 'GET', '/api/blob/aaaaaaaaaaaa'],
    ['the encrypted viewer', 'GET', '/w/aaaaaaaaaaaa'],
    ['the blob viewer', 'GET', '/v/aaaaaaaaaaaa'],
    ['the protocol document', 'GET', '/llms.txt'],
    ['the install script', 'GET', '/i'],
    ['the sitemap', 'GET', '/sitemap.xml'],
    ['the event beacon', 'POST', '/api/event'],
  ])('does not serve %s', async (_label, method, path) => {
    const response = await call(new Request(`https://${CONTENT_HOST}${path}`, { method }));
    expect(response.status).toBe(404);
    await response.text();
  });

  // Both report routes are asserted with an explicit override rather than
  // whatever wrangler.toml happens to say, so configuring a mailbox cannot
  // quietly turn this into a test of the other branch.
  it('explains itself at the root, so a scanner does not land on a bare 404', async () => {
    const response = await call(new Request(`https://${CONTENT_HOST}/`), {
      ABUSE_CONTACT: undefined,
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    // Names a disposal route and disclaims authorship — the two questions a
    // gateway asks before listing a host.
    expect(html).toContain('security/advisories/new');
    expect(html).toContain('not reviewed or endorsed');
  });

  it('names the abuse mailbox at the root once one is configured', async () => {
    const response = await call(new Request(`https://${CONTENT_HOST}/`), {
      ABUSE_CONTACT: 'mailto:abuse@vnsh.dev',
    });
    const html = await response.text();
    expect(html).toContain('href="mailto:abuse@vnsh.dev"');
    expect(html).toContain('not reviewed or endorsed');
  });

  it('tells crawlers to stay out entirely', async () => {
    const response = await call(new Request(`https://${CONTENT_HOST}/robots.txt`));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('User-agent: *\nDisallow: /\n');
  });

  it('publishes a security.txt that has not lapsed', async () => {
    const response = await call(new Request(`https://${CONTENT_HOST}/.well-known/security.txt`));
    expect(response.status).toBe(200);
    const text = await response.text();
    const expires = text.match(/^Expires: (.+)$/m)?.[1];
    expect(expires).toBeTruthy();
    expect(Date.parse(expires as string)).toBeGreaterThan(Date.now());
    // A contact that works today. See ABUSE_CONTACT for why no mailto is listed
    // until the mailbox exists.
    expect(text).toContain('Contact: https://github.com/raullenchai/vnsh/security/advisories/new');
  });

  it('lists an abuse mailbox only once one is configured', async () => {
    const without = await call(
      new Request(`https://${CONTENT_HOST}/.well-known/security.txt`),
      { ABUSE_CONTACT: undefined },
    );
    expect(await without.text()).not.toContain('mailto:');

    const withMailbox = await call(
      new Request(`https://${CONTENT_HOST}/.well-known/security.txt`),
      { ABUSE_CONTACT: 'mailto:abuse@vnsh.dev' },
    );
    expect(await withMailbox.text()).toContain('Contact: mailto:abuse@vnsh.dev');
  });
});

describe('public documents stay out of search and out of an origin', () => {
  it('sends noindex, so staying unindexed is enforced rather than hoped for', async () => {
    const { id } = await createPublic();
    const response = await call(new Request(`https://${CONTENT_HOST}/p/${id}`));
    expect(response.headers.get('X-Robots-Tag')).toContain('noindex');
    await response.text();
  });

  // Regression guard. Losing this line would hand every published document a
  // real origin on a shared domain, which is the failure the domain split is
  // explicitly *not* a substitute for.
  it('still lands the document in an opaque origin', async () => {
    const { id } = await createPublic();
    const response = await call(new Request(`https://${CONTENT_HOST}/p/${id}`));
    const csp = response.headers.get('Content-Security-Policy') || '';
    expect(csp).toMatch(/(^|;)\s*sandbox\b/);
    expect(csp).not.toContain('allow-same-origin');
    await response.text();
  });
});

describe('the quiet window on the primary host', () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();

  it('keeps serving links handed out before the move', async () => {
    const body = '<!DOCTYPE html><h1>older link</h1>';
    const { id } = await createPublic(body);
    const response = await call(new Request(`https://vnsh.dev/p/${id}`), {
      LEGACY_PUBLIC_UNTIL: future,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
  });

  it('is gone for good once the window closes, and does not redirect', async () => {
    const { id } = await createPublic();
    const response = await call(new Request(`https://vnsh.dev/p/${id}`), {
      LEGACY_PUBLIC_UNTIL: past,
    });
    // 410, not 301: a scanner can tag the source of a redirect that leads to
    // bad content, which is the exact liability the content domain removes.
    expect(response.status).toBe(410);
    expect(response.headers.get('Location')).toBeNull();
    await response.text();
  });

  it('stays open when no cutover has been configured', async () => {
    const { id } = await createPublic();
    const response = await call(new Request(`https://vnsh.dev/p/${id}`), {
      LEGACY_PUBLIC_UNTIL: undefined,
    });
    expect(response.status).toBe(200);
    await response.text();
  });
});

describe('clients are told the public URL rather than guessing it', () => {
  it('returns it on create, on the content domain', async () => {
    const { id, url } = await createPublic();
    expect(url).toBe(`https://${CONTENT_HOST}/p/${id}`);
  });

  it('omits it for an encrypted workspace, which has no public URL', async () => {
    const response = await call(
      new Request('https://vnsh.dev/api/workspace', {
        method: 'POST',
        headers: { 'X-Vnsh-Write-Hash': await sha256Hex(WRITE_TOKEN) },
        body: 'ciphertext',
      }),
    );
    const data = await response.json<{ url?: string; public: boolean }>();
    expect(data.public).toBe(false);
    expect(data.url).toBeUndefined();
  });

  it('returns it again after a write, so an echoed link is still right', async () => {
    const { id } = await createPublic();
    const response = await call(
      new Request(`https://vnsh.dev/api/workspace/${id}`, {
        method: 'PUT',
        headers: { 'X-Vnsh-Write': WRITE_TOKEN, 'If-Match': '"1"' },
        body: '<!DOCTYPE html><h1>v2</h1>',
      }),
    );
    expect(response.status).toBe(200);
    const data = await response.json<{ url?: string }>();
    expect(data.url).toBe(`https://${CONTENT_HOST}/p/${id}`);
  });

  it('falls back to the requesting origin when there is no content domain', async () => {
    const response = await call(
      new Request('https://example.test/api/workspace', {
        method: 'POST',
        headers: { 'X-Vnsh-Write-Hash': await sha256Hex(WRITE_TOKEN), 'X-Vnsh-Public': '1' },
        body: 'note',
      }),
      { CONTENT_HOST: undefined },
    );
    const data = await response.json<{ id: string; url: string }>();
    expect(data.url).toBe(`https://example.test/p/${data.id}`);
  });
});

describe('what the primary host publishes about the split', () => {
  it('points agents at the content domain for public links', async () => {
    const response = await call(new Request('https://vnsh.dev/llms.txt'));
    const text = await response.text();
    expect(text).not.toContain('https://vnsh.dev/p/');
    expect(text).toContain(`https://${CONTENT_HOST}/p/{id}`);
    // An agent that is not told the two domains belong together will read the
    // second one as a redirect to somewhere untrusted and refuse it.
    expect(text).toContain('different domain, on purpose');
  });

  /**
   * A public workspace is addressed two ways and only one of them can be handed
   * out. /p/{id} carries no fragment, so it cannot carry the write token either
   * — an implementation that surfaces only the public link has permanently given
   * up the ability to update its own document, and nothing in the 201 response
   * says so. Raised in #35 and closed on the claim that it was already covered;
   * it was not. This is the assertion that would have caught that.
   */
  it('says the public link is not the whole address, and names the way back', async () => {
    const text = await (await call(new Request('https://vnsh.dev/llms.txt'))).text();

    const claim = text.indexOf('only way to write again');
    expect(claim).toBeGreaterThan(-1);

    // Both shapes have to sit together, or "addressed two ways" is a statement
    // with no example next to it. The readable one is on the content host; the
    // writable one is not, and that asymmetry is the whole point.
    const nearby = text.slice(claim - 400, claim);
    expect(nearby).toContain(`https://${CONTENT_HOST}/p/{id}`);
    expect(nearby).toContain('https://vnsh.dev/w/{id}#w=');
  });

  it('keeps advertising its own paths when there is no second domain', async () => {
    const response = await call(new Request('https://vnsh.dev/llms.txt'), {
      CONTENT_HOST: undefined,
    });
    expect(await response.text()).toContain('https://vnsh.dev/p/{id}');
  });

  it('asks crawlers not to index the legacy public path', async () => {
    const response = await call(new Request('https://vnsh.dev/robots.txt'));
    expect(await response.text()).toContain('Disallow: /p/');
  });

  it('serves a security.txt on the primary host too', async () => {
    const response = await call(new Request('https://vnsh.dev/.well-known/security.txt'));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Canonical: https://vnsh.dev/.well-known/security.txt');
  });
});

/**
 * Without a visibility dimension the two tiers are indistinguishable in the
 * numbers, so there is no way to answer "does anyone use the public tier" —
 * the tier that cost a second registrable domain. Analytics Engine is unbound
 * in tests, which means trackEvent() no-ops and any assertion about what got
 * recorded would pass while recording nothing; the binding is stubbed so the
 * slot layout is genuinely exercised.
 */
describe('the two tiers are distinguishable in the numbers', () => {
  type Point = { blobs?: string[] };
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

  const visibilityOf = (event: string) =>
    written.filter((p) => p.blobs?.[0] === event).map((p) => p.blobs?.[5]);

  it('labels a public create public', async () => {
    await createPublic();
    expect(visibilityOf('workspace_create')).toEqual(['public']);
  });

  it('labels an encrypted create encrypted', async () => {
    const response = await call(
      new Request('https://vnsh.dev/api/workspace', {
        method: 'POST',
        headers: { 'X-Vnsh-Write-Hash': await sha256Hex(WRITE_TOKEN) },
        body: 'ciphertext',
      }),
    );
    await response.json();
    expect(visibilityOf('workspace_create')).toEqual(['encrypted']);
  });

  it('labels a read of the public document public', async () => {
    const { id } = await createPublic();
    written = [];
    const response = await call(new Request(`https://${CONTENT_HOST}/p/${id}`));
    await response.text();
    expect(visibilityOf('workspace_read')).toEqual(['public']);
  });

  // Appended, never renumbered: rows already written cannot be migrated, so
  // moving an existing slot would silently reinterpret all of them.
  it('puts visibility in slot 6 and leaves the earlier slots alone', async () => {
    await createPublic();
    const point = written.find((p) => p.blobs?.[0] === 'workspace_create');
    expect(point?.blobs?.length).toBe(6);
    expect(point?.blobs?.[1]).toBe('unknown');
    expect(point?.blobs?.[5]).toBe('public');
  });
});
