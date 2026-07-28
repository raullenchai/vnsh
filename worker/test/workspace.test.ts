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

describe('GET /w/:id viewer', () => {
  it('serves the viewer page', async () => {
    const response = await call(new Request('http://localhost/w/aBcDeFgHiJkL'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('Shared workspace');
    // A shared link is opened by people who do not know vnsh yet, so the tab and
    // the social preview are brand surfaces, not afterthoughts.
    expect(html).toContain('og:image');
    expect(html).toContain('rel="icon"');
  });

  it('renders workspace content only inside a sandboxed frame', async () => {
    const html = await (await call(new Request('http://localhost/w/aBcDeFgHiJkL'))).text();

    // allow-same-origin alongside allow-scripts would defeat the sandbox entirely:
    // the frame could then read parent.location.hash, which is the key.
    expect(html).toContain("setAttribute('sandbox', 'allow-scripts')");
    expect(html).not.toContain('allow-same-origin allow-scripts');
    expect(html).not.toContain('allow-scripts allow-same-origin');

    // Decrypted content must never be written into this document.
    expect(html).not.toMatch(/innerHTML\s*=\s*plaintext/);
  });

  it('injects a network-blocking CSP into the framed content', async () => {
    const html = await (await call(new Request('http://localhost/w/aBcDeFgHiJkL'))).text();
    // Without default-src 'none' the content could fetch the plaintext back out
    // to an attacker, which would break the host-blind guarantee from the inside.
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("form-action 'none'");
  });

  it('places the CSP by parsing the document, not by pattern-matching it', async () => {
    const html = await (await call(new Request('http://localhost/w/aBcDeFgHiJkL'))).text();

    // The first version injected the policy after the first /<head[^>]*>/ match,
    // so content containing an HTML comment holding a fake head tag swallowed the
    // <meta> into that comment and silently disabled the whole policy. Verified
    // exploitable in Chromium before this fix.
    expect(html).toContain('DOMParser');
    expect(html).toContain('doc.head.insertBefore');
    expect(html).not.toContain('html.match(/<head');
  });

  it('surfaces sharing and vnsh itself instead of a bare warning', async () => {
    const html = await (await call(new Request('http://localhost/w/aBcDeFgHiJkL'))).text();

    // "untrusted content" read as an alarm to someone opening their own report,
    // while the real anti-phishing controls (form-action 'none', no network) do
    // the actual work. State the guarantee instead.
    expect(html).not.toContain('untrusted content');
    expect(html).toContain('vnsh cannot read this page');

    // Every shared workspace is seen by someone who may not know vnsh.
    expect(html).toContain('Share your own work like this');

    // What each tier grants has to be stated at the point of sharing, not left
    // for the sender to discover after the fact.
    expect(html).toContain('They can read it. They cannot change it.');
    expect(html).toContain('They can read and change it.');
  });

  it('offers both share tiers and can never hand out more than it holds', async () => {
    const html = await (await call(new Request('http://localhost/w/aBcDeFgHiJkL'))).text();

    expect(html).toContain('Copy view-only link');
    expect(html).toContain('Copy edit link');

    // #r= carries K, which is HKDF(S,"enc") — a one-way derivation. A page opened
    // with a view-only link therefore has no way to rebuild the edit link, and the
    // edit option must stay hidden rather than merely disabled.
    expect(html).toContain("var viewOnly = frag.indexOf('r=') === 0");
    expect(html).toContain("document.getElementById('share-edit').hidden = !canWrite");
    expect(html).toContain("rootSecret = viewOnly ? null : material");
  });

  it('routes links out of the sandbox instead of letting content open windows', async () => {
    const html = await (await call(new Request('http://localhost/w/aBcDeFgHiJkL'))).text();

    // A link inside the frame would otherwise navigate the frame itself, and the
    // target would inherit the sandbox — so every link in every document looked
    // broken. The click is forwarded to this page rather than granting
    // allow-popups-to-escape-sandbox, which would also let content open windows
    // with no user gesture and smuggle data out in the URL.
    expect(html).toContain('vnshOpen');
    // Assert the attribute itself: the words allow-popups / allow-same-origin also
    // appear in comments explaining why they are not granted.
    expect(html).toContain("setAttribute('sandbox', 'allow-scripts')");
    expect(html).not.toMatch(/'sandbox',\s*'[^']*allow-popups/);
    expect(html).not.toMatch(/'sandbox',\s*'[^']*allow-same-origin/);

    // The frame is opaque-origin, so event.origin is the string "null" and cannot
    // identify anyone. Trust has to come from the source window.
    expect(html).toContain('e.source !== contentFrame.contentWindow');
    // Only real web URLs; javascript: and data: must not be handed to window.open.
    expect(html).toContain("u.protocol !== 'http:' && u.protocol !== 'https:'");
  });

  it('does not advertise commands that do not exist', async () => {
    const html = await (await call(new Request('http://localhost/w/aBcDeFgHiJkL'))).text();
    // An earlier draft told recipients to run `npx vnsh workspace read`, which the
    // npm CLI has never implemented.
    expect(html).not.toContain('vnsh workspace read');
  });
});

describe('body size limits', () => {
  // Content-Length is caller-supplied. Enforcing only on the header let a client
  // omit or understate it and stream past the 25MB ceiling straight into R2.
  function chunked(bytes: number): ReadableStream<Uint8Array> {
    let sent = 0;
    return new ReadableStream({
      pull(controller) {
        if (sent >= bytes) return controller.close();
        const size = Math.min(1024 * 1024, bytes - sent);
        controller.enqueue(new Uint8Array(size));
        sent += size;
      },
    });
  }

  it('rejects an oversized body that declares no Content-Length', async () => {
    const response = await call(
      new Request('http://localhost/api/workspace', {
        method: 'POST',
        headers: { 'X-Vnsh-Write-Hash': await sha256Hex(WRITE_TOKEN) },
        body: chunked(26 * 1024 * 1024),
      } as RequestInit),
    );
    expect(response.status).toBe(413);
    await response.arrayBuffer();
  });

  it('rejects an oversized update and leaves the workspace untouched', async () => {
    const { id } = await createWorkspace('original');

    const response = await call(
      new Request(`http://localhost/api/workspace/${id}`, {
        method: 'PUT',
        headers: { 'X-Vnsh-Write': WRITE_TOKEN, 'If-Match': '"1"' },
        body: chunked(26 * 1024 * 1024),
      } as RequestInit),
    );
    expect(response.status).toBe(413);
    await response.arrayBuffer();

    const read = await call(new Request(`http://localhost/api/workspace/${id}`));
    expect(read.headers.get('ETag')).toBe('"1"');
    expect(await read.text()).toBe('original');
  });
});

describe('agent attribution', () => {
  // Claude Code, Cursor and OpenHands all reach vnsh through the same MCP server,
  // so X-Vnsh-Client reports "mcp" for every one of them. Without a separate agent
  // label, two agents collaborating on a workspace is indistinguishable from one
  // agent writing twice — a false negative on the only question this phase asks.
  it('accepts and does not reject an agent label', async () => {
    const { id } = await createWorkspace();

    const response = await call(
      new Request(`http://localhost/api/workspace/${id}`, {
        headers: { 'X-Vnsh-Client': 'mcp/1.3.0', 'X-Vnsh-Agent': 'Claude Code' },
      }),
    );
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  });

  it('allows the agent header through CORS so browser clients can send it', async () => {
    const response = await call(
      new Request('http://localhost/api/workspace/aaaaaaaaaaaa', { method: 'OPTIONS' }),
    );
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('X-Vnsh-Agent');
    await response.arrayBuffer();
  });
});

describe('homepage', () => {
  it('can create a workspace, not just an immutable drop', async () => {
    const html = await (await call(new Request('http://localhost/'))).text();

    // The site was repositioned around workspaces while its only control still
    // produced a one-shot blob — it could not do the thing it claimed to be for.
    expect(html).toContain('/api/workspace');
    expect(html).toContain('vnsh/enc/v2');
    expect(html).toContain('AES-GCM');
    expect(html).toContain("data-mode=\"workspace\"");
  });

  it('keeps one-shot file sharing available', async () => {
    const html = await (await call(new Request('http://localhost/'))).text();
    expect(html).toContain("data-mode=\"drop\"");
    expect(html).toContain('/api/drop');
    expect(html).toContain('id="dropzone"');
  });
});
