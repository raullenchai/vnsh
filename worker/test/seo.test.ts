import { describe, it, expect } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';

type Env = { VNSH_STORE: R2Bucket };

async function get(path: string): Promise<{ status: number; body: string }> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request('http://localhost' + path), env as Env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: await response.text() };
}

function jsonLd(html: string): Record<string, unknown>[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) =>
    JSON.parse(m[1]),
  );
}

const BLOG_SLUGS = [
  'host-blind-sharing-for-ai-coding',
  'debug-ci-failures-with-claude-code',
  'host-blind-encryption-in-chrome-extension',
  'ai-debug-bundles-packaging-browser-context',
  'url-fragments-encryption-keys',
];

describe('structured data', () => {
  // The machine-readable summary drifted a whole product generation behind the
  // page it describes — it still called vnsh a file-sharing CLI and a pastebin
  // alternative. Nothing on the page surfaces that, so only a test catches it.
  it('describes the current product, not the v1 one', async () => {
    const { body } = await get('/');
    const [app] = jsonLd(body);
    expect(app['@type']).toBe('SoftwareApplication');

    const description = String(app.description);
    expect(description).toContain('workspace');
    expect(description).not.toMatch(/pastebin/i);
    expect(description).not.toMatch(/file sharing/i);

    // Read and write is the structural claim; without it this is a pastebin.
    expect(JSON.stringify(app.featureList)).toMatch(/read and write/i);
  });

  it('parses as valid JSON on every page that emits it', async () => {
    for (const path of ['/', ...BLOG_SLUGS.map((s) => '/blog/' + s)]) {
      const { body } = await get(path);
      expect(() => jsonLd(body), path).not.toThrow();
      expect(jsonLd(body).length, path).toBeGreaterThan(0);
    }
  });

  it('marks blog posts as BlogPosting with a machine-readable date', async () => {
    for (const slug of BLOG_SLUGS) {
      const { body } = await get('/blog/' + slug);
      const [post] = jsonLd(body);
      expect(post['@type'], slug).toBe('BlogPosting');
      expect(post.url, slug).toBe('https://vnsh.dev/blog/' + slug);
      expect(String(post.datePublished), slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(post.headline, slug).toBeTruthy();
    }
  });
});

describe('social cards', () => {
  // A summary_large_image card with no image unfurls blank in Slack, X and
  // iMessage — exactly where these links get shared.
  it('never declares a large-image card without an image', async () => {
    for (const path of ['/', '/blog', ...BLOG_SLUGS.map((s) => '/blog/' + s)]) {
      const { body } = await get(path);
      if (body.includes('summary_large_image')) {
        expect(body, path).toMatch(/name="twitter:image"/);
        expect(body, path).toMatch(/property="og:image"/);
      }
    }
  });

  it('serves the OG image as a real PNG', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request('http://localhost/og-image.png'),
      env as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    // Social platforms do not render SVG previews, so an SVG behind a .png name
    // means every shared link has silently had no preview at all.
    expect(response.headers.get('Content-Type')).toBe('image/png');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

describe('crawlability', () => {
  it('gives every indexable page a self-referencing canonical', async () => {
    const expected: [string, string][] = [
      ['/', 'https://vnsh.dev'],
      ...BLOG_SLUGS.map((s) => ['/blog/' + s, 'https://vnsh.dev/blog/' + s] as [string, string]),
    ];
    for (const [path, canonical] of expected) {
      const { body } = await get(path);
      expect(body, path).toContain(`<link rel="canonical" href="${canonical}">`);
    }
  });

  it('leaves no blog post orphaned from the homepage', async () => {
    // Reachable only through the sitemap is reachable barely at all: the
    // highest-authority page on the site passed them nothing.
    const { body } = await get('/');
    expect(body).toContain('href="/blog"');
  });

  it('lists every sitemap URL with a lastmod, and only real routes', async () => {
    const { body } = await get('/sitemap.xml');
    const entries = [...body.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      const loc = /<loc>([^<]+)<\/loc>/.exec(entry)?.[1] ?? '';
      expect(entry, loc).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);

      const path = loc.replace('https://vnsh.dev', '') || '/';
      const { status } = await get(path);
      expect(status, 'sitemap advertises a dead URL: ' + loc).toBe(200);
    }
  });

  it('points crawlers and agents at the right manifests', async () => {
    const { body } = await get('/robots.txt');
    expect(body).toContain('Sitemap: https://vnsh.dev/sitemap.xml');
    expect(body).toContain('https://vnsh.dev/llms.txt');
  });
});

describe('titles', () => {
  it('gives the homepage a title inside what search results display', async () => {
    const { body } = await get('/');
    const raw = /<title>([^<]+)<\/title>/.exec(body)?.[1] ?? '';
    // Measure what a reader sees, not the source: `&amp;` is one character on
    // screen and five in the markup.
    const title = raw.replace(/&amp;/g, '&').replace(/&mdash;/g, '\u2014').replace(/&middot;/g, '\u00b7');
    expect(title.length).toBeGreaterThan(20);
    // Past roughly 60 characters the tail is truncated in results.
    expect(title.length).toBeLessThanOrEqual(60);
  });

  it('gives every blog post a distinct title and description', async () => {
    const titles = new Set<string>();
    const descriptions = new Set<string>();
    for (const slug of BLOG_SLUGS) {
      const { body } = await get('/blog/' + slug);
      titles.add(/<title>([^<]+)<\/title>/.exec(body)?.[1] ?? '');
      descriptions.add(/<meta name="description" content="([^"]+)"/.exec(body)?.[1] ?? '');
    }
    expect(titles.size).toBe(BLOG_SLUGS.length);
    expect(descriptions.size).toBe(BLOG_SLUGS.length);
  });
});

/**
 * The homepage used to pull a font stylesheet and six Prism scripts from a
 * CDN. The font URL 404'd — so it had never once applied — and the scripts
 * forced the CSP to trust a third-party script origin on a site whose entire
 * claim is that it does not. Both are gone; this keeps them gone, because the
 * cost of a reintroduced <link> is invisible until someone reads a console.
 */
describe('the app serves no third-party assets', () => {
  it('references no external origin in the served page', async () => {
    const { body: html } = await get('/');
    expect(html).not.toContain('cdn.jsdelivr.net');
    expect(html).not.toContain('unpkg.com');
    // Every <script src> and <link href> must be same-origin or a data: URI.
    const external = [...html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="(https?:\/\/[^"]+)"/g)]
      .map((m) => m[1])
      .filter((u) => !u.startsWith('https://vnsh.dev'));
    expect(external).toEqual([]);
  });

  it('grants its CSP no third-party script or style origin', async () => {
    const { body: html } = await get('/');
    const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
    expect(csp).toContain("script-src 'self' 'unsafe-inline';");
    expect(csp).not.toContain('jsdelivr');
  });
});
