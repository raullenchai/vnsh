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

    // Every shared workspace is opened by someone who may not know vnsh — and who
    // is looking at it working. That makes this the warmest install surface there is.
    expect(html).toContain('Get this in your own agent');

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
  });

  it('still shares files — that capability was never the thing being simplified', async () => {
    const html = await (await call(new Request('http://localhost/'))).text();

    // Dropping or pasting a file still works and still yields a link. What went
    // away is being asked to pick a lifecycle first; the upload path itself is
    // untouched, it just produces a workspace now.
    expect(html).toContain('id="dropzone"');
    expect(html).toContain('id="file-input"');
    expect(html).toContain('uploadFile');
  });
});

describe('agent setup prompt', () => {
  it('is short enough to read at a glance', async () => {
    const html = await (await call(new Request('http://localhost/'))).text();
    const m = html.match(/const SETUP_PROMPT = "((?:[^"\\]|\\.)*)"/);
    expect(m).not.toBeNull();
    // A call to action nobody reads is not one. The instructions it used to carry
    // moved into /llms.txt, which is where an agent will look anyway.
    expect(m![1].length).toBeLessThan(120);
    // Names the concept and the scope; everything operational lives behind the URL.
    // An inline install command was tried and dropped: `npx -y vnsh-mcp` only starts
    // the server in the foreground, registering nothing, so it did not rescue the
    // case it was added for.
    expect(m![1]).toContain('workspaces');
    expect(m![1]).toContain('people and agents');
    expect(m![1]).toContain('vnsh.dev/llms.txt');
  });

  it('is the first thing on the page, and offered on the viewer too', async () => {
    const home = await (await call(new Request('http://localhost/'))).text();
    const viewer = await (await call(new Request('http://localhost/w/aBcDeFgHiJkL'))).text();

    expect(home.indexOf('cta-block')).toBeLessThan(home.indexOf('id="dropzone"'));
    expect(viewer).toContain('Get this in your own agent');
  });

  it('llms.txt carries what the prompt no longer does', async () => {
    const llms = await (await call(new Request('http://localhost/llms.txt'))).text();

    // Installing a tool does not make an agent reach for it, so the setup
    // instructions have to include writing a standing rule somewhere durable.
    expect(llms).toContain('standing rule');

    // Naming the file is the part that matters: writing the rule is what makes
    // vnsh a default rather than merely installed, so "whichever file you read"
    // was close to no instruction at all. Verified by fetching this page as an
    // agent — it asked where to put it until these paths were spelled out.
    for (const path of [
      '~/.claude/CLAUDE.md',
      '.cursor/rules',
      '.openhands/microagents',
      '.clinerules',
      '.windsurfrules',
      'AGENTS.md',
    ]) {
      expect(llms).toContain(path);
    }
    for (const agent of ['Cursor', 'OpenHands', 'Cline', 'Windsurf', 'Zed']) {
      expect(llms).toContain(agent);
    }
    expect(llms).toContain('vnsh/enc/v2');
    expect(llms).toContain('If-Match');
  });
});

describe('homepage information architecture', () => {
  it('presents one action, not a menu of surfaces', async () => {
    const html = await (await call(new Request('http://localhost/'))).text();

    // Tabs organised the page by surface, which made a first-time visitor
    // classify themselves before they knew what the product was.
    expect(html).not.toContain('data-tab=');

    // Choosing "workspace" vs "one-shot drop" asked people to model the product
    // in order to use it. A workspace nobody writes to again is a one-shot drop,
    // and what actually differs — can the recipient change it — is answered by
    // which of the two links you send.
    expect(html).not.toContain('data-mode=');

    // Secondary surfaces are still reachable, just folded away.
    expect(html).toContain('<details class="fold">');
  });

  it('names the product concept where a first-time visitor looks', async () => {
    const html = await (await call(new Request('http://localhost/'))).text();

    // The headline has to carry the object, not just the mechanism: "one link
    // you can read and write" leaves "read and write what?" unanswered.
    expect(html).toContain('One workspace all your agents can read and write.');

    // And the diagram names the same concept, so the two reinforce rather than
    // repeat: the eyebrow lists the agents instead of echoing the headline.
    expect(html).toContain('The portable workspace');
  });

  it('describes the workspace crypto as GCM, not the v1 blob CBC', async () => {
    const html = await (await call(new Request('http://localhost/'))).text();

    // Mutable content needs integrity — without an authentication tag anyone
    // able to rewrite storage, the host included, could flip ciphertext bits
    // undetectably. So workspaces are GCM, and the page said CBC in its trust
    // copy and its footer long after that stopped being true.
    // Bound the slice at the viewer overlay, which comes later in the DOM and
    // legitimately says CBC — an unbounded slice would fail on correct markup.
    const start = html.indexOf('Why you can hand it a private log');
    const end = html.indexOf('<!-- Viewer Overlay -->');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const claims = html.slice(start, end);
    expect(claims).not.toContain('AES-256-CBC');
    expect(claims).toContain('AES-256-GCM');

    // The v1 blob viewer genuinely is CBC and must keep saying so; this test
    // must not push anyone into mislabelling it.
    expect(html).toContain('Decrypting (AES-256-CBC)');
  });
});

describe('homepage onboarding order', () => {
  it('explains the product before asking for anything', async () => {
    const html = await (await call(new Request('http://localhost/'))).text();

    // Match elements, not bare class names: the class names also appear in the
    // stylesheet far above the markup, which silently inverts a naive indexOf.
    const at = (sel: string) => {
      const i = html.indexOf(sel);
      expect(i, 'missing from the page: ' + sel).toBeGreaterThan(-1);
      return i;
    };

    // The diagram carries the one idea prose cannot: a workspace hosted by a
    // party that cannot open it. It comes before either call to action.
    expect(at('<svg class="diagram"')).toBeLessThan(at('id="dropzone"'));

    // Installing an MCP server pays off later and shows nothing on screen;
    // making a workspace pays off in two seconds and explains the product by
    // producing it. The demo therefore reads first.
    expect(at('id="dropzone"')).toBeLessThan(at('id="setup-prompt-text"'));
  });

  it('gives the setup prompt more weight than the demo', async () => {
    const html = await (await call(new Request('http://localhost/'))).text();

    // Making a workspace by hand happens once. Pasting the prompt is the only
    // thing on the page that produces a second use, so it is the promoted half
    // of the pair, not an equal peer.
    expect(html).toContain('class="door door-promote"');
    expect(html).toContain('btn-primary btn-wide setup-prompt-btn');
  });

  it('keeps the dropzone available after a workspace is made', async () => {
    const html = await (await call(new Request('http://localhost/'))).text();

    // Dropping a file is what that box is; if it vanishes on success, making a
    // second one means hunting for a reset.
    expect(html).toContain("dropzone.classList.add('compact')");
    expect(html).toContain('.dropzone.compact {');
  });

  it('reads as a container rather than a placeholder', async () => {
    const html = await (await call(new Request('http://localhost/'))).text();

    // A flat dashed grey box reads as disabled. Assert the treatment exists
    // without pinning the exact declaration, which is pure churn.
    expect(html).toMatch(/\.dropzone \{[^}]*dashed/);
    expect(html).toMatch(/\.dropzone:hover[^{]*\{[^}]*accent-edge/);

    // And it creates a workspace, not "a file upload" — the wording carries the
    // concept rather than reverting to the v1 story.
    expect(html).toContain('Workspace created');
  });
});

/**
 * An agent handed a workspace link fetches it, gets a shell that says
 * "Decrypting…", and has no way forward — so it goes back and asks the human,
 * which is the one thing the product exists to avoid. The page has to explain
 * itself to a reader that will never run its JavaScript.
 */
describe('workspace page explains itself to agents', () => {
  async function page(): Promise<string> {
    return (await call(new Request('http://localhost/w/aBcDeFgHiJkL'))).text();
  }

  it('heads off the two things an agent would otherwise try', async () => {
    const html = await page();
    // Re-fetching can never work: the fragment is not sent to the server.
    expect(html).toMatch(/never transmits|never sent/i);
    // And it already holds the key, so it does not need to ask for the content.
    expect(html).toMatch(/you already hold the key/i);
  });

  // An agent found the earlier version of this block, correctly refused to act
  // on it, and went back to ask its user. That refusal was right: an imperative
  // buried in fetched content has the exact shape of a prompt injection, and no
  // page can grant anyone permission to run a command. The block has to inform,
  // not command, or it converts one dead end into another.
  it('describes a format rather than issuing orders', async () => {
    const html = await page();
    const block = html.slice(html.indexOf('ABOUT THIS PAGE'), html.indexOf('</div>', html.indexOf('ABOUT THIS PAGE')));

    expect(block).toMatch(/description of a file\s+format, not an instruction to you/i);
    // The wording that reads as an injection attempt, and did get refused.
    expect(block).not.toMatch(/INSTRUCTIONS FOR AI AGENTS/);
    expect(block).not.toMatch(/^\s*TO READ IT, run/im);
    expect(block).not.toMatch(/\bDo NOT\b/);
  });

  it('names the tool the user already authorised before the one they did not', async () => {
    const html = await page();
    const block = html.slice(html.indexOf('ABOUT THIS PAGE'));
    // The MCP tools are something the user installed, so using them needs no
    // new authority; npx installs and runs a package, so it does.
    expect(block.indexOf('vnsh_workspace_read')).toBeLessThan(block.indexOf('npx -y vnsh read'));
    // Executing anything is the reader's decision and their user's; a page
    // cannot hand out that permission, and saying so is what stops this block
    // from reading as an injection attempt.
    expect(block).toMatch(/your call and your user['\u2019]s, not this page/i);
    // And the lowest-authority option — no download, no third-party code —
    // comes before the one that installs a package.
    expect(block.indexOf('node -e')).toBeLessThan(block.indexOf('npx -y vnsh read'));
    expect(block).toMatch(/does install and run an npm package/i);
  });

  it('leaves the agent something useful to say when it can do nothing', async () => {
    const html = await page();
    // Otherwise it goes back to the human with a shrug, which is the failure.
    expect(html).toMatch(/the useful thing to tell the user/i);
    expect(html).toContain('https://vnsh.dev/llms.txt');
  });

  it('explains the write semantics, including how a write fails', async () => {
    const html = await page();
    expect(html).toContain('vnsh_workspace_write');
    expect(html).toMatch(/412/);
    expect(html).toMatch(/#r= link is read-only by construction/i);
  });

  it('advertises the protocol description in a header too', async () => {
    const response = await call(new Request('http://localhost/w/aBcDeFgHiJkL'));
    await response.text();
    expect(response.headers.get('Link')).toContain('rel="describedby"');
    expect(response.headers.get('Link')).toContain('/llms.txt');
  });

  it('keeps the block away from human readers', async () => {
    const html = await page();
    expect(html).toMatch(/left:-9999px[^>]*"\s+aria-hidden="true"/);
  });
});
