import { describe, it, expect } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';

/**
 * File names, carried without being read.
 *
 * The complaint was that everything downloaded as `.txt`. It was accurate:
 * nothing ever sent a name, so the viewer sniffed magic bytes and fell back to
 * `.txt` for every format that has none — .py, .json, .csv, .sql, .yaml.
 *
 * The name now rides in R2 custom metadata, which is where metadata belongs,
 * but a name is content: `analysis.py` is harmless and `Q3-layoff-list.xlsx` is
 * not. So the value is opaque — ciphertext the client made with its own content
 * key, base64url on the wire. These tests pin the two halves of that: the
 * service must carry the string faithfully, and must never be in a position to
 * interpret it.
 */

type Env = { VNSH_STORE: R2Bucket };

const WRITE_TOKEN = 'a'.repeat(64);
const OTHER_TOKEN = 'b'.repeat(64);

// Stands in for base64url(nonce ‖ ciphertext ‖ tag). Its content is irrelevant
// to the worker by design, which is the point being asserted.
const SEALED = 'ZmFrZS1zZWFsZWQtbmFtZS1ieXRlcw';
const OTHER_SEALED = 'YW5vdGhlci1zZWFsZWQtbmFtZQ';

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

async function create(opts: { name?: string; public?: boolean; body?: string } = {}) {
  const response = await call(
    new Request('http://localhost/api/workspace', {
      method: 'POST',
      headers: {
        'X-Vnsh-Write-Hash': await sha256Hex(WRITE_TOKEN),
        ...(opts.name === undefined ? {} : { 'X-Vnsh-Name': opts.name }),
        ...(opts.public ? { 'X-Vnsh-Public': '1' } : {}),
      },
      body: opts.body ?? 'ciphertext-v1',
    }),
  );
  const json = (await response.json()) as { id: string; version: number };
  return { response, ...json };
}

async function get(id: string) {
  const response = await call(new Request(`http://localhost/api/workspace/${id}`));
  // Draining matters: an unconsumed R2 body outlives the test and fails the
  // whole file under isolated storage.
  await response.arrayBuffer();
  return response;
}

function put(id: string, body: string, ifMatch: string, name?: string, token = WRITE_TOKEN) {
  return call(
    new Request(`http://localhost/api/workspace/${id}`, {
      method: 'PUT',
      headers: {
        'X-Vnsh-Write': token,
        'If-Match': ifMatch,
        ...(name === undefined ? {} : { 'X-Vnsh-Name': name }),
      },
      body,
    }),
  );
}

describe('a workspace carries the name its author attached', () => {
  it('hands back exactly the string it was given', async () => {
    const { id } = await create({ name: SEALED });
    expect((await get(id)).headers.get('X-Vnsh-Name')).toBe(SEALED);
  });

  it('omits the header entirely when no name was attached', async () => {
    const { id } = await create();
    expect((await get(id)).headers.get('X-Vnsh-Name')).toBeNull();
  });

  it('never decodes the value, so a name it cannot read is still stored', async () => {
    // The wire value is base64url of ciphertext. If the worker were decoding it
    // to do anything at all, a value that is valid base64url but not valid
    // UTF-8 once decoded would break — it must not, because the worker is not
    // supposed to be looking.
    const notUtf8 = '_____w';
    const { id } = await create({ name: notUtf8 });
    expect((await get(id)).headers.get('X-Vnsh-Name')).toBe(notUtf8);
  });

  it('exposes the header to browser clients, which read it cross-origin', async () => {
    const { id } = await create({ name: SEALED });
    const exposed = (await get(id)).headers.get('Access-Control-Expose-Headers') || '';
    expect(exposed).toContain('X-Vnsh-Name');
  });
});

describe('an edit does not lose the name', () => {
  it('carries the existing name forward when the writer sends none', async () => {
    // The PUT handler rebuilds custom metadata from scratch, so anything not
    // explicitly carried is dropped. That is exactly how the TTL was once
    // demoted on every edit.
    const { id } = await create({ name: SEALED });
    const written = await put(id, 'ciphertext-v2', '"1"');
    expect(written.status).toBe(200);
    expect((await get(id)).headers.get('X-Vnsh-Name')).toBe(SEALED);
  });

  it('replaces the name when the writer sends a new one', async () => {
    const { id } = await create({ name: SEALED });
    expect((await put(id, 'ciphertext-v2', '"1"', OTHER_SEALED)).status).toBe(200);
    expect((await get(id)).headers.get('X-Vnsh-Name')).toBe(OTHER_SEALED);
  });

  it('can attach a name to a workspace created without one', async () => {
    const { id } = await create();
    expect((await put(id, 'ciphertext-v2', '"1"', SEALED)).status).toBe(200);
    expect((await get(id)).headers.get('X-Vnsh-Name')).toBe(SEALED);
  });

  it('ignores a name presented with the wrong write token', async () => {
    const { id } = await create({ name: SEALED });
    const rejected = await put(id, 'ciphertext-v2', '"1"', OTHER_SEALED, OTHER_TOKEN);
    expect(rejected.status).toBe(403);
    expect((await get(id)).headers.get('X-Vnsh-Name')).toBe(SEALED);
  });
});

describe('a renew keeps the name', () => {
  it('survives a lifetime extension, which rewrites the object', async () => {
    const { id } = await create({ name: SEALED });
    const renewed = await call(
      new Request(`http://localhost/api/workspace/${id}/renew`, {
        method: 'POST',
        headers: { 'X-Vnsh-Write': WRITE_TOKEN },
      }),
    );
    expect(renewed.status).toBe(200);
    await renewed.arrayBuffer();
    expect((await get(id)).headers.get('X-Vnsh-Name')).toBe(SEALED);
  });
});

describe('a malformed name is dropped, not stored and not fatal', () => {
  // The value round-trips into a response header. A control character or
  // anything past Latin-1 throws when that response is built, which would turn
  // a cosmetic feature into a document nobody can read. Rejecting the header is
  // the safe failure: the client falls back to a generated name.
  const bad: [string, string][] = [
    ['spaces', 'not base64url'],
    ['a slash', 'has/slash'],
    ['padding', 'cGFkZGVk=='],
    ['a quote', 'name"quote'],
    ['too long', 'a'.repeat(513)],
    ['empty', ''],
  ];

  it.each(bad)('drops %s without failing the create', async (_label, value) => {
    const { response, id } = await create({ name: value });
    expect(response.status).toBe(201);
    expect((await get(id)).headers.get('X-Vnsh-Name')).toBeNull();
  });

  it('accepts a value at the length limit', async () => {
    const atLimit = 'a'.repeat(512);
    const { id } = await create({ name: atLimit });
    expect((await get(id)).headers.get('X-Vnsh-Name')).toBe(atLimit);
  });
});

describe('a name belongs to a version, not to the workspace', () => {
  // Restoring v1 used to serve v1's bytes under v2's name: the archive carried
  // no name, and the PUT that performs the restore kept the current metadata.
  // A Python file called results.json is exactly the mismatch a restore exists
  // to undo.
  async function twoVersions() {
    const { id } = await create({ name: SEALED });
    expect((await put(id, 'ciphertext-v2', '"1"', OTHER_SEALED)).status).toBe(200);
    return id;
  }

  it('reads an old version back under the name it was written with', async () => {
    const id = await twoVersions();
    const historical = await call(new Request(`http://localhost/api/workspace/${id}/history/1`));
    expect(historical.status).toBe(200);
    await historical.arrayBuffer();
    expect(historical.headers.get('X-Vnsh-Historical')).toBe('1');
    expect(historical.headers.get('X-Vnsh-Name')).toBe(SEALED);
  });

  it('restores the name along with the content', async () => {
    const id = await twoVersions();
    const restored = await call(
      new Request(`http://localhost/api/workspace/${id}/history/1/restore`, {
        method: 'POST',
        headers: { 'X-Vnsh-Write': WRITE_TOKEN, 'If-Match': '"2"' },
      }),
    );
    expect(restored.status).toBe(200);
    await restored.arrayBuffer();

    const latest = await get(id);
    expect(latest.headers.get('ETag')).toBe('"3"');
    expect(latest.headers.get('X-Vnsh-Name')).toBe(SEALED);
  });

  it('lets an explicit name on the restore win over the archived one', async () => {
    const id = await twoVersions();
    const restored = await call(
      new Request(`http://localhost/api/workspace/${id}/history/1/restore`, {
        method: 'POST',
        headers: {
          'X-Vnsh-Write': WRITE_TOKEN,
          'If-Match': '"2"',
          'X-Vnsh-Name': OTHER_SEALED,
        },
      }),
    );
    expect(restored.status).toBe(200);
    await restored.arrayBuffer();
    expect((await get(id)).headers.get('X-Vnsh-Name')).toBe(OTHER_SEALED);
  });
});

describe('a public workspace names itself openly, like its body', () => {
  it('stores and returns the name of a document that has no key', async () => {
    const { id } = await create({ name: SEALED, public: true });
    const response = await get(id);
    expect(response.headers.get('X-Vnsh-Public')).toBe('1');
    expect(response.headers.get('X-Vnsh-Name')).toBe(SEALED);
  });
});
