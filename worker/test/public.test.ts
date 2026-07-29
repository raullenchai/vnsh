import { describe, it, expect } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';

type Env = { VNSH_STORE: R2Bucket };

const WRITE_TOKEN = 'b'.repeat(64);

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

async function create(body: string, headers: Record<string, string> = {}) {
  const response = await call(
    new Request('http://localhost/api/workspace', {
      method: 'POST',
      headers: { 'X-Vnsh-Write-Hash': await sha256Hex(WRITE_TOKEN), ...headers },
      body,
    }),
  );
  expect(response.status).toBe(201);
  return response.json<{ id: string; public: boolean }>();
}

const HTML = '<!DOCTYPE html><html><body><h1>a public report</h1></body></html>';

describe('public workspaces', () => {
  // A human opening a link has a browser doing the decryption for them; an
  // agent's fetch does not execute JavaScript, so the two experiences were
  // never symmetric. A public workspace closes that gap by giving up the thing
  // that caused it — and the link shape says so, since there is no key to carry.
  it('serves plaintext to anything that speaks HTTP', async () => {
    const { id, public: isPublic } = await create(HTML, { 'X-Vnsh-Public': '1' });
    expect(isPublic).toBe(true);

    const response = await call(new Request(`http://localhost/p/${id}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(await response.text()).toBe(HTML);
  });

  it('sends text as text rather than letting a browser sniff it', async () => {
    const { id } = await create('just some notes', { 'X-Vnsh-Public': '1' });
    const response = await call(new Request(`http://localhost/p/${id}`));
    expect(response.headers.get('Content-Type')).toContain('text/plain');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    await response.text();
  });

  it('renders a document that opens with a banner comment', async () => {
    const { id } = await create('<!-- generated -->\n<html><body>hi</body></html>', {
      'X-Vnsh-Public': '1',
    });
    const response = await call(new Request(`http://localhost/p/${id}`));
    expect(response.headers.get('Content-Type')).toContain('text/html');
    await response.text();
  });

  // Public content is served from vnsh.dev, so it must not run *as* vnsh.dev.
  it('runs public content in an opaque origin with no network', async () => {
    const { id } = await create(HTML, { 'X-Vnsh-Public': '1' });
    const response = await call(new Request(`http://localhost/p/${id}`));
    const csp = response.headers.get('Content-Security-Policy') || '';
    await response.text();

    // sandbox without allow-same-origin is what denies it same-origin reads of
    // /api and the ability to impersonate the real UI.
    expect(csp).toMatch(/(^|;)\s*sandbox\b/);
    expect(csp).not.toContain('allow-same-origin');
    // And the content cannot call home with what it was given.
    expect(csp).toContain("default-src 'none'");
  });
});

describe('the two guarantees stay separate', () => {
  it('will not serve an encrypted workspace from the public path', async () => {
    const { id } = await create('ciphertext-bytes');
    const response = await call(new Request(`http://localhost/p/${id}`));
    expect(response.status).toBe(404);
    await response.text();
  });

  it('answers the same for encrypted, missing and expired ids', async () => {
    // Distinguishing them would confirm whether a given id exists.
    const { id } = await create('ciphertext-bytes');
    const encrypted = await call(new Request(`http://localhost/p/${id}`));
    const missing = await call(new Request('http://localhost/p/zzzzzzzzzzzz'));
    expect(encrypted.status).toBe(missing.status);
    expect(await encrypted.text()).toBe(await missing.text());
  });

  it('tells API clients not to try decrypting plaintext', async () => {
    const { id } = await create(HTML, { 'X-Vnsh-Public': '1' });
    const response = await call(new Request(`http://localhost/api/workspace/${id}`));
    expect(response.headers.get('X-Vnsh-Public')).toBe('1');
    await response.arrayBuffer();

    const { id: encryptedId } = await create('ciphertext-bytes');
    const encrypted = await call(new Request(`http://localhost/api/workspace/${encryptedId}`));
    expect(encrypted.headers.get('X-Vnsh-Public')).toBeNull();
    await encrypted.arrayBuffer();
  });

  it('defaults to encrypted when nothing asks for public', async () => {
    const { id, public: isPublic } = await create('ciphertext-bytes');
    expect(isPublic).toBe(false);
    expect((await call(new Request(`http://localhost/p/${id}`))).status).toBe(404);
  });
});

describe('visibility is fixed at creation', () => {
  async function put(id: string, body: string, headers: Record<string, string> = {}) {
    return call(
      new Request(`http://localhost/api/workspace/${id}`, {
        method: 'PUT',
        headers: { 'X-Vnsh-Write': WRITE_TOKEN, 'If-Match': '1', ...headers },
        body,
      }),
    );
  }

  // Whoever holds the edit link must not be able to change the guarantee the
  // author advertised when they handed that link out.
  it('cannot be turned public by a later write', async () => {
    const { id } = await create('ciphertext-bytes');
    const written = await put(id, 'still ciphertext', { 'X-Vnsh-Public': '1' });
    expect(written.status).toBe(200);
    await written.text();

    expect((await call(new Request(`http://localhost/p/${id}`))).status).toBe(404);
  });

  it('is not silently lost when a public workspace is updated', async () => {
    const { id } = await create(HTML, { 'X-Vnsh-Public': '1' });
    const updated = '<!DOCTYPE html><html><body><h1>revised</h1></body></html>';
    const written = await put(id, updated);
    expect(written.status).toBe(200);
    await written.text();

    const response = await call(new Request(`http://localhost/p/${id}`));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(updated);
  });

  it('still requires the write token to change public content', async () => {
    const { id } = await create(HTML, { 'X-Vnsh-Public': '1' });
    const response = await put(id, 'defaced', { 'X-Vnsh-Write': 'c'.repeat(64) });
    expect(response.status).toBe(403);
    await response.text();
  });
});

/**
 * The homepage had to gain this without becoming a menu again. An earlier
 * version of the page asked people to choose between a "workspace" and a
 * "one-shot job" before they knew what either was, and that was removed for
 * being confusing. Publishing is an opt-out from the product's own promise, so
 * it belongs as one quiet line under the dropzone, not a second front door.
 */
describe('the homepage offers publishing without becoming a menu', () => {
  async function home(): Promise<string> {
    return (await call(new Request('http://localhost/'))).text();
  }

  it('offers it as a single opt-in, off by default', async () => {
    const html = await home();
    expect(html).toContain('id="opt-public"');
    // An unchecked checkbox: no `checked` attribute anywhere on it.
    expect(html).toMatch(/<input type="checkbox" id="opt-public">/);
    // And not a second mode selector.
    expect(html).not.toContain('data-mode=');
  });

  it('states the cost in the same breath as the benefit', async () => {
    const html = await home();
    const label = html.slice(html.indexOf('for="opt-public"'), html.indexOf('</label>'));
    expect(label).toMatch(/agents can just fetch it/i);
    expect(label).toMatch(/vnsh\s*\n?\s*can read it/i);
  });

  it('sends the header only when asked, and skips encryption then', async () => {
    const html = await home();
    expect(html).toContain("...(wantsPublic() ? { 'X-Vnsh-Public': '1' } : {})");
    // The encryption step is skipped rather than performed and discarded.
    expect(html).toMatch(/if \(wantsPublic\(\)\) \{[\s\S]{0,200}Uploading in the clear/);
  });

  it('hands back a link with no fragment, and calls it what it is', async () => {
    const html = await home();
    // A public link cannot carry a key, so it must not pretend to.
    expect(html).toMatch(/data\.public\s*\n?\s*\?\s*location\.origin \+ '\/p\/' \+ data\.id/);
    // Calling it "view-only" would misdescribe who can read it.
    expect(html).toContain("nameEl.textContent = 'Public link'");
    expect(html).toContain("roleEl.textContent = 'anyone can read it, no key needed'");
  });
});
