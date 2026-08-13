import { describe, it, expect } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';

/**
 * Retention: how long a document lives, and who gets to say.
 *
 * The bug these guard against was reported as "I shared a plan with a colleague
 * and 24 hours later it was gone". The cause was not policy — blobs have taken
 * `?ttl=` up to a week since v2.0 — it was that workspaces had no such
 * parameter at all, while every extension entry point creates a workspace. So
 * the assertions here are mostly about parity with the blob path, and about the
 * two ways a longer lifetime could be granted and then silently lost: an edit
 * that resets the clock to the default, and no way to extend without editing.
 */

type Env = { VNSH_STORE: R2Bucket };

const WRITE_TOKEN = 'a'.repeat(64);
const OTHER_TOKEN = 'b'.repeat(64);
const HOUR = 60 * 60 * 1000;

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

async function createWorkspace(
  opts: { ttl?: string; body?: string; token?: string; public?: boolean } = {},
) {
  const token = opts.token ?? WRITE_TOKEN;
  const query = opts.ttl === undefined ? '' : `?ttl=${opts.ttl}`;
  const response = await call(
    new Request(`http://localhost/api/workspace${query}`, {
      method: 'POST',
      headers: {
        'X-Vnsh-Write-Hash': await sha256Hex(token),
        ...(opts.public ? { 'X-Vnsh-Public': '1' } : {}),
      },
      body: opts.body ?? 'ciphertext-v1',
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

function renew(id: string, opts: { token?: string | null; ttl?: string } = {}) {
  const query = opts.ttl === undefined ? '' : `?ttl=${opts.ttl}`;
  const token = opts.token === undefined ? WRITE_TOKEN : opts.token;
  return call(
    new Request(`http://localhost/api/workspace/${id}/renew${query}`, {
      method: 'POST',
      headers: token === null ? {} : { 'X-Vnsh-Write': token },
    }),
  );
}

/** Hours from now until `iso`, so assertions read in the unit the API speaks. */
function hoursOut(iso: string): number {
  return (new Date(iso).getTime() - Date.now()) / HOUR;
}

describe('Retention', () => {
  describe('workspace lifetime at creation', () => {
    it('defaults to 24 hours', async () => {
      const { expires } = await createWorkspace();
      expect(hoursOut(expires)).toBeGreaterThan(23);
      expect(hoursOut(expires)).toBeLessThanOrEqual(24);
    });

    it('accepts a week, the same cap the blob path has always had', async () => {
      const { expires } = await createWorkspace({ ttl: '168' });
      expect(hoursOut(expires)).toBeGreaterThan(167);
      expect(hoursOut(expires)).toBeLessThanOrEqual(168);
    });

    it.each([
      ['above the cap', '169'],
      ['absurd', '100000'],
      ['zero', '0'],
      ['negative', '-5'],
      ['not a number', 'forever'],
      ['empty', ''],
    ])('falls back to the default when ttl is %s', async (_label, ttl) => {
      // A rejected upload would be a worse answer than a shorter one: clients
      // have been sending this parameter for two major versions and a 400 turns
      // a preference into a failed share.
      const { response, expires } = await createWorkspace({ ttl });
      expect(response.status).toBe(201);
      expect(hoursOut(expires)).toBeLessThanOrEqual(24);
      expect(hoursOut(expires)).toBeGreaterThan(23);
    });
  });

  describe('an edit must not demote the lifetime', () => {
    it('keeps the week a seven-day workspace was created with', async () => {
      // The regression that would make the whole feature pointless: ask for
      // seven days, type one character, silently be back to one day.
      const { id, expires } = await createWorkspace({ ttl: '168' });
      expect(hoursOut(expires)).toBeGreaterThan(167);

      const response = await put(id, 'edited-v2', '"1"');
      expect(response.status).toBe(200);

      const after = (await response.json()) as { expires: string; version: number };
      expect(after.version).toBe(2);
      expect(hoursOut(after.expires)).toBeGreaterThan(167);
    });

    it('accepts the lowercase metadata spelling used by production R2', async () => {
      const { id } = await createWorkspace({ ttl: '168' });
      const key = `w/${id}`;
      const existing = await env.VNSH_STORE.get(key);
      const body = await existing!.arrayBuffer();
      const md = { ...(existing!.customMetadata || {}) };
      delete md.ttlHours;
      md.ttlhours = '168';
      await env.VNSH_STORE.put(key, body, { customMetadata: md });

      const response = await put(id, 'edited-v2', '"1"');
      expect(response.status).toBe(200);
      const after = (await response.json()) as { expires: string };
      expect(hoursOut(after.expires)).toBeGreaterThan(167);
    });

    it('keeps the default lifetime for a workspace that never asked for more', async () => {
      const { id } = await createWorkspace();
      const response = await put(id, 'edited-v2', '"1"');
      const after = (await response.json()) as { expires: string };
      expect(hoursOut(after.expires)).toBeLessThanOrEqual(24);
      expect(hoursOut(after.expires)).toBeGreaterThan(23);
    });

    it('survives repeated edits', async () => {
      const { id } = await createWorkspace({ ttl: '168' });
      let etag = '"1"';
      for (let i = 2; i <= 4; i++) {
        const response = await put(id, `edit-${i}`, etag);
        expect(response.status).toBe(200);
        const after = (await response.json()) as { expires: string; version: number };
        expect(after.version).toBe(i);
        expect(hoursOut(after.expires)).toBeGreaterThan(167);
        etag = `"${after.version}"`;
      }
    });
  });

  describe('POST /api/workspace/:id/renew', () => {
    it('pushes the expiry out without bumping the version', async () => {
      // Renewing is not editing. An agent holding version 1 must still be able
      // to write, or "keep this alive" would manufacture conflicts.
      const { id } = await createWorkspace();

      const response = await renew(id, { ttl: '168' });
      expect(response.status).toBe(200);

      const after = (await response.json()) as { version: number; expires: string };
      expect(after.version).toBe(1);
      expect(response.headers.get('ETag')).toBe('"1"');
      expect(hoursOut(after.expires)).toBeGreaterThan(167);

      const write = await put(id, 'still-writable', '"1"');
      expect(write.status).toBe(200);
    });

    it('keeps the existing lifetime when no ttl is given', async () => {
      const { id } = await createWorkspace({ ttl: '168' });
      const after = (await renew(id).then((r) => r.json())) as { expires: string };
      expect(hoursOut(after.expires)).toBeGreaterThan(167);
    });

    it('leaves the content byte-identical', async () => {
      const body = 'ciphertext-that-must-not-change';
      const { id } = await createWorkspace({ body, ttl: '48' });

      expect((await renew(id)).status).toBe(200);

      const read = await call(new Request(`http://localhost/api/workspace/${id}`));
      expect(read.status).toBe(200);
      expect(await read.text()).toBe(body);
    });

    it('carries the public flag forward', async () => {
      // Visibility is fixed at creation and a renew is not a write, so it must
      // not be a way to change what the author advertised.
      const { id } = await createWorkspace({ public: true });
      expect((await renew(id)).status).toBe(200);

      const read = await call(new Request(`http://localhost/api/workspace/${id}`));
      // Draining the body is not decoration: an unread R2 stream outlives the
      // test and the pool then fails the whole file on isolated storage.
      await read.arrayBuffer();
      expect(read.headers.get('X-Vnsh-Public')).toBe('1');
    });

    it('reports the new expiry on a subsequent read', async () => {
      const { id } = await createWorkspace();
      const after = (await renew(id, { ttl: '168' }).then((r) => r.json())) as { expires: string };

      const read = await call(new Request(`http://localhost/api/workspace/${id}`));
      await read.arrayBuffer();
      expect(read.headers.get('X-Vnsh-Expires')).toBe(after.expires);
    });

    it('refuses a reader who holds no write token', async () => {
      const { id } = await createWorkspace();
      const response = await renew(id, { token: null });
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: string }).error).toBe('INVALID_WRITE_TOKEN');
    });

    it('refuses a malformed write token', async () => {
      const { id } = await createWorkspace();
      const response = await renew(id, { token: 'not-hex' });
      expect(response.status).toBe(401);
    });

    it('refuses the wrong write token', async () => {
      const { id } = await createWorkspace();
      const response = await renew(id, { token: OTHER_TOKEN });
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: string }).error).toBe('FORBIDDEN');
    });

    it('does not extend a workspace that never existed', async () => {
      const response = await renew('Zzzzzzzzzzzz');
      expect(response.status).toBe(404);
    });

    it('rejects a method other than POST', async () => {
      const { id } = await createWorkspace();
      const response = await call(new Request(`http://localhost/api/workspace/${id}/renew`));
      expect(response.status).toBe(405);
    });

    it('does not shorten a lifetime by accident when ttl is junk', async () => {
      const { id } = await createWorkspace({ ttl: '168' });
      // Junk falls back to the default, which here is shorter than what the
      // workspace had. That is a real reduction and it should be visible, not a
      // silent no-op — assert the documented behaviour rather than a wish.
      const after = (await renew(id, { ttl: 'forever' }).then((r) => r.json())) as {
        expires: string;
      };
      expect(hoursOut(after.expires)).toBeLessThanOrEqual(24);
    });
  });

  describe('the blob path is unchanged', () => {
    // parseTtlHours was factored out of handleDrop. These are the assertions
    // that the extraction preserved behaviour on the path that already worked.
    async function drop(query = '') {
      const response = await call(
        new Request(`http://localhost/api/drop${query}`, { method: 'POST', body: 'blob' }),
      );
      return (await response.json()) as { id: string; expires: string };
    }

    it('still defaults to 24 hours', async () => {
      expect(hoursOut((await drop()).expires)).toBeLessThanOrEqual(24);
      expect(hoursOut((await drop()).expires)).toBeGreaterThan(23);
    });

    it('still honours a week', async () => {
      expect(hoursOut((await drop('?ttl=168')).expires)).toBeGreaterThan(167);
    });

    it('still ignores an out-of-range ttl', async () => {
      expect(hoursOut((await drop('?ttl=99999')).expires)).toBeLessThanOrEqual(24);
    });
  });
});
