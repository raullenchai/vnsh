#!/usr/bin/env node
/**
 * Smoke test against a running vnsh, default production.
 *
 *   node scripts/smoke.mjs                      # https://vnsh.dev
 *   node scripts/smoke.mjs http://localhost:8787
 *
 * This exists because every outage this project has actually had was invisible
 * to the unit suites, which run the worker in a local pool with a fake bucket:
 *
 *   - the KV free-tier write cap ran out and every route began returning 1101.
 *     Nothing in worker/test could have known; the tests do not use the quota.
 *   - a deploy landed and the edge kept serving the previous asset, three
 *     separate times. The tests passed, the deploy reported success, and the
 *     change was not live. Hence the cache-buster on every static fetch here:
 *     without it this file would be capable of reporting the same lie.
 *   - a route worked in tests and 404ed in production because it was never
 *     added to the deployed script.
 *
 * So the checks are deliberately end-to-end and against a real host: they use
 * the real R2 bucket, the real rate limiters, the real content domain, and the
 * real cache. Everything it writes carries a 24h expiry, like any other blob.
 *
 * It is a plain script rather than CI-only YAML on purpose. CI invokes it, but
 * anyone can run it against a laptop or a preview before shipping — a check
 * that can only run inside a workflow is a check nobody ever runs by hand.
 */
import crypto from 'node:crypto';

const HOST = (process.argv[2] || process.env.VNSH_HOST || 'https://vnsh.dev').replace(/\/$/, '');
const CONTENT_HOST = process.env.VNSH_CONTENT_HOST
  || (HOST === 'https://vnsh.dev' ? 'https://vnshcontent.dev' : HOST);

let passed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** Static surfaces are cached at the edge; without this a stale asset passes. */
const bust = (path) => `${HOST}${path}${path.includes('?') ? '&' : '?'}cb=${crypto.randomUUID()}`;

/**
 * Cloudflare weakens the ETag when it compresses a response, so the same
 * version arrives as `"2"` or `W/"2"` depending on the encoding negotiated.
 * Compare on the version, not on the wire form — this project has already had
 * one false 412 from treating the two as different.
 */
const version = (res) => (res.headers.get('etag') || '').replace(/^W\//, '');

const hkdf = (secret, info) => Buffer.from(
  crypto.hkdfSync('sha256', secret, Buffer.alloc(0), Buffer.from(info), 32),
);

function workspaceKeys() {
  const S = crypto.randomBytes(32);
  const K = hkdf(S, 'vnsh/enc/v2');
  const W = hkdf(S, 'vnsh/write/v2').toString('hex');
  const H = crypto.createHash('sha256').update(W, 'ascii').digest('hex');
  return { S, K, W, H };
}

function seal(text, K) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', K, nonce);
  return Buffer.concat([nonce, c.update(Buffer.from(text, 'utf8')), c.final(), c.getAuthTag()]);
}

function open(buf, K) {
  const d = crypto.createDecipheriv('aes-256-gcm', K, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString('utf8');
}

async function main() {
  console.log(`smoke: ${HOST}  (content: ${CONTENT_HOST})\n`);

  // ---- static surfaces, past the cache -------------------------------------
  console.log('static');
  const home = await fetch(bust('/'));
  const homeBody = await home.text();
  check('homepage responds 200', home.status === 200, `got ${home.status}`);
  check('homepage is the app, not an error page', homeBody.includes('vnsh'));

  const llms = await fetch(bust('/llms.txt'));
  const llmsBody = await llms.text();
  check('llms.txt responds 200', llms.status === 200, `got ${llms.status}`);
  // The agent-facing contract. If this drifts, integrations break silently.
  check('llms.txt documents workspace create', llmsBody.includes('POST https://vnsh.dev/api/workspace'));
  check('llms.txt documents the write hash', llmsBody.includes('X-Vnsh-Write-Hash'));
  check('llms.txt documents the key schedule', llmsBody.includes('vnsh/enc/v2'));

  // ---- v1 blob roundtrip ---------------------------------------------------
  console.log('\nv1 blob');
  const payload = crypto.randomBytes(256);
  const drop = await fetch(`${HOST}/api/drop`, {
    method: 'POST', body: payload,
    headers: { 'Content-Type': 'application/octet-stream', 'X-Vnsh-Client': 'smoke' },
  });
  check('POST /api/drop responds 201', drop.status === 201, `got ${drop.status}`);
  let blobId = null;
  if (drop.status === 201) ({ id: blobId } = await drop.json());
  check('drop returns an id', typeof blobId === 'string' && blobId.length > 0);

  if (blobId) {
    const read = await fetch(`${HOST}/api/blob/${blobId}`);
    check('GET /api/blob responds 200', read.status === 200, `got ${read.status}`);
    check('blob is CORS-readable by the viewer',
      read.headers.get('access-control-allow-origin') === '*');
    const got = Buffer.from(await read.arrayBuffer());
    check('blob roundtrips byte-for-byte', got.equals(payload),
      `sent ${payload.length}b, got ${got.length}b`);
  }

  // ---- v2 workspace: create, read, write, re-read --------------------------
  console.log('\nv2 workspace');
  const { K, W, H } = workspaceKeys();
  const first = 'smoke test, first revision';
  const create = await fetch(`${HOST}/api/workspace`, {
    method: 'POST', body: seal(first, K),
    headers: { 'X-Vnsh-Write-Hash': H, 'X-Vnsh-Client': 'smoke' },
  });
  check('POST /api/workspace responds 201', create.status === 201, `got ${create.status}`);
  check('create returns ETag "1"', version(create) === '"1"', `got ${version(create)}`);
  let wsId = null;
  if (create.status === 201) ({ id: wsId } = await create.json());

  if (wsId) {
    const got = await fetch(`${HOST}/api/workspace/${wsId}`);
    check('GET workspace responds 200', got.status === 200, `got ${got.status}`);
    check('workspace decrypts to what was sealed',
      open(Buffer.from(await got.arrayBuffer()), K) === first);

    // A PUT without If-Match must be refused — this is the whole optimistic
    // concurrency guarantee, and a regression here loses writes silently.
    const blind = await fetch(`${HOST}/api/workspace/${wsId}`, {
      method: 'PUT', body: seal('should not land', K),
      headers: { 'X-Vnsh-Write': W, 'X-Vnsh-Client': 'smoke' },
    });
    check('PUT without If-Match is refused', blind.status >= 400 && blind.status < 500,
      `got ${blind.status}`);

    const second = 'smoke test, second revision';
    const put = await fetch(`${HOST}/api/workspace/${wsId}`, {
      method: 'PUT', body: seal(second, K),
      headers: { 'X-Vnsh-Write': W, 'If-Match': '"1"', 'X-Vnsh-Client': 'smoke' },
    });
    check('PUT with If-Match succeeds', put.status >= 200 && put.status < 300, `got ${put.status}`);
    check('PUT advances the ETag to "2"', version(put) === '"2"', `got ${version(put)}`);

    const again = await fetch(`${HOST}/api/workspace/${wsId}`);
    check('the write is readable back',
      open(Buffer.from(await again.arrayBuffer()), K) === second);

    // A reader without W must not be able to write.
    const forged = await fetch(`${HOST}/api/workspace/${wsId}`, {
      method: 'PUT', body: seal('forged', K),
      headers: { 'X-Vnsh-Write': 'f'.repeat(64), 'If-Match': '"2"', 'X-Vnsh-Client': 'smoke' },
    });
    check('a wrong write token is refused', forged.status >= 400 && forged.status < 500,
      `got ${forged.status}`);
  }

  // ---- retention -----------------------------------------------------------
  // The reported pain: a workspace shared with a colleague was gone the next
  // day, and no parameter existed that could have prevented it. Blobs took
  // ?ttl= up to a week the whole time; workspaces did not.
  console.log('\nretention');
  const longKeys = workspaceKeys();
  const longCreate = await fetch(`${HOST}/api/workspace?ttl=168`, {
    method: 'POST', body: seal('a week, please', longKeys.K),
    headers: { 'X-Vnsh-Write-Hash': longKeys.H, 'X-Vnsh-Client': 'smoke' },
  });
  check('POST /api/workspace?ttl=168 responds 201', longCreate.status === 201,
    `got ${longCreate.status}`);
  let longId = null;
  if (longCreate.status === 201) {
    const body = await longCreate.json();
    longId = body.id;
    const days = (new Date(body.expires) - Date.now()) / 86400000;
    check('a week means a week', days > 6.9 && days <= 7, `got ${days.toFixed(2)} days`);
  }

  if (longId) {
    // The regression that would make the whole thing pointless: ask for seven
    // days, make one edit, silently be back to one day.
    const edit = await fetch(`${HOST}/api/workspace/${longId}`, {
      method: 'PUT', body: seal('edited', longKeys.K),
      headers: { 'X-Vnsh-Write': longKeys.W, 'If-Match': '"1"', 'X-Vnsh-Client': 'smoke' },
    });
    const afterEdit = edit.status < 300 ? (await edit.json()).expires : null;
    check('an edit does not demote a seven-day workspace',
      afterEdit && (new Date(afterEdit) - Date.now()) / 86400000 > 6.9,
      `expires ${afterEdit}`);

    // Renew: extends the clock, leaves the version alone.
    const renew = await fetch(`${HOST}/api/workspace/${longId}/renew?ttl=168`, {
      method: 'POST',
      headers: { 'X-Vnsh-Write': longKeys.W, 'X-Vnsh-Client': 'smoke' },
    });
    check('POST /renew responds 200', renew.status === 200, `got ${renew.status}`);
    if (renew.status === 200) {
      const body = await renew.json();
      check('renew does not bump the version', body.version === 2, `got v${body.version}`);
      check('renew pushes the expiry out',
        (new Date(body.expires) - Date.now()) / 86400000 > 6.9, `expires ${body.expires}`);
    }

    // Renewing decides how long content lives, so it is the author's call.
    const stolen = await fetch(`${HOST}/api/workspace/${longId}/renew`, {
      method: 'POST',
      headers: { 'X-Vnsh-Write': 'f'.repeat(64), 'X-Vnsh-Client': 'smoke' },
    });
    check('renew refuses a wrong write token',
      stolen.status >= 400 && stolen.status < 500, `got ${stolen.status}`);

    const readBack = await fetch(`${HOST}/api/workspace/${longId}`);
    check('content survives a renew unchanged',
      open(Buffer.from(await readBack.arrayBuffer()), longKeys.K) === 'edited');
  }

  // ---- what an automated reader is handed -----------------------------------
  // A reported failure: an agent fetched a workspace URL, read a comment in the
  // HTML addressed to crawlers, concluded the content was unreadable, and told
  // its user so — while holding the key. Non-HTML clients now get the procedure
  // by itself. Verified end-to-end by a subagent with no vnsh code available,
  // which read the guide and wrote its own decryption from it.
  console.log('\nagent-facing surface');
  if (wsId) {
    const asAgent = await fetch(`${HOST}/w/${wsId}`, {
      headers: { 'User-Agent': 'curl/8.4.0', Accept: '*/*' },
    });
    const guide = await asAgent.text();
    check('a non-HTML client gets text, not the app',
      (asAgent.headers.get('content-type') || '').includes('text/plain'),
      asAgent.headers.get('content-type') || 'none');
    check('the guide says the reader already holds the key',
      guide.includes('you already hold the key'));
    check('the guide names the key derivation', guide.includes('vnsh/enc/v2'));

    const asBrowser = await fetch(`${HOST}/w/${wsId}`, { headers: { Accept: 'text/html' } });
    check('a browser still gets the application',
      (asBrowser.headers.get('content-type') || '').includes('text/html'));

    // The card is the one surface every recipient of a shared link sees, and
    // several preview fetchers ask for */*.
    const asCrawler = await fetch(`${HOST}/w/${wsId}`, {
      headers: { 'User-Agent': 'Twitterbot/1.0', Accept: '*/*' },
    });
    check('a link-preview crawler still gets the card',
      (await asCrawler.text()).includes('og:image'));
  }

  // ---- the public content domain -------------------------------------------
  console.log('\npublic content domain');
  const pub = workspaceKeys();
  const pubCreate = await fetch(`${HOST}/api/workspace`, {
    method: 'POST', body: Buffer.from('# smoke\n\nAutomated check. Expires within 24h.', 'utf8'),
    headers: { 'X-Vnsh-Write-Hash': pub.H, 'X-Vnsh-Public': '1', 'X-Vnsh-Client': 'smoke' },
  });
  check('public create responds 201', pubCreate.status === 201, `got ${pubCreate.status}`);
  if (pubCreate.status === 201) {
    const { id } = await pubCreate.json();
    const page = await fetch(`${CONTENT_HOST}/p/${id}?cb=${crypto.randomUUID()}`);
    const body = await page.text();
    check('the content domain serves /p/', page.status === 200, `got ${page.status}`);
    check('a public page carries the sandbox CSP',
      (page.headers.get('content-security-policy') || '').includes('sandbox'),
      page.headers.get('content-security-policy') || 'no CSP');
    check('a public page is not indexable',
      (page.headers.get('x-robots-tag') || '').includes('noindex')
        || body.includes('noindex'));
  }

  // ---- negative surfaces ---------------------------------------------------
  console.log('\nnegative');
  const missing = await fetch(`${HOST}/api/blob/does-not-exist-${crypto.randomUUID()}`);
  check('an unknown blob is 404, not 500', missing.status === 404, `got ${missing.status}`);
  const noHash = await fetch(`${HOST}/api/workspace`, { method: 'POST', body: 'x' });
  check('create without a write hash is 400', noHash.status === 400, `got ${noHash.status}`);
  const bogus = await fetch(bust('/no-such-route-here'));
  check('an unknown route is 404, not 500', bogus.status === 404, `got ${bogus.status}`);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\nsmoke aborted: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
