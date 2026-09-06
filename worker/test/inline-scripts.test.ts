import { describe, it, expect } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';

// The workspace route now content-negotiates: only real browser navigations
// get the application. A suite asserting the browser page has to identify one.
const BROWSER = { headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } };

type Env = { VNSH_STORE: R2Bucket };

/**
 * Every page this worker serves carries its client-side JavaScript inside a
 * TypeScript template literal. That makes a whole class of breakage invisible to
 * both `tsc` and ordinary tests: a backslash written once instead of twice
 * survives compilation and reaches the browser mangled. `/\+/g` ships as `/+/g`
 * and dies with "Nothing to repeat", taking the entire page down, and nothing
 * short of a real browser notices.
 *
 * The Function constructor parses without executing, so it catches exactly that:
 * a syntax error in the string that is actually served.
 */
async function scriptsOn(path: string): Promise<string[]> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request('http://localhost' + path, BROWSER), env as Env, ctx);
  await waitOnExecutionContext(ctx);
  expect(response.status).toBe(200);
  const html = await response.text();
  return [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
    // Only executable script. A `type` of anything else — JSON-LD in particular —
    // is data the browser never parses as JavaScript.
    .filter(([, attrs]) => {
      const type = /type\s*=\s*["']([^"']+)["']/.exec(attrs)?.[1]?.toLowerCase();
      return !type || type === 'text/javascript' || type === 'module';
    })
    .map(([, , body]) => body)
    .filter((body) => body.trim().length > 0);
}

const PAGES = [
  ['the landing page', '/'],
  ['the workspace viewer', '/w/aBcDeFgHiJkL'],
  ['the blob viewer', '/v/aBcDeFgHiJkL'],
];

describe('inline scripts parse', () => {
  it.each(PAGES)('%s', async (_name, path) => {
    const scripts = await scriptsOn(path);
    expect(scripts.length).toBeGreaterThan(0);
    for (const body of scripts) {
      expect(() => new Function(body)).not.toThrow();
    }
  });

  // Guard the guard: if the extraction or the parse ever stops being able to see
  // a mangled backslash, these tests would pass while the site was broken.
  it('would actually catch a mangled backslash', () => {
    expect(() => new Function('var re = /+/g;')).toThrow();
    expect(() => new Function('var re = /\\+/g;')).not.toThrow();
  });
});

/**
 * The viewer decides whether to render content as a document or print it as
 * text. That decision used to be "does it start with a tag", which quietly
 * failed for any HTML file beginning with a banner comment — a very ordinary
 * thing for a generated file — and showed the reader raw markup instead.
 *
 * These run the function *as served*, so a backslash mangled by the template
 * literal shows up here rather than in someone's browser.
 */
describe('viewer html detection', () => {
  async function servedLooksLikeHtml(): Promise<(s: string) => boolean> {
    const [script] = await scriptsOn('/w/aBcDeFgHiJkL');
    const source = /function looksLikeHtml\(s\) \{[\s\S]*?\n  \}/.exec(script);
    expect(source, 'looksLikeHtml not found in the served page').not.toBeNull();
    return new Function('s', `${source![0]}\nreturn looksLikeHtml(s);`) as (s: string) => boolean;
  }

  it('renders a document that opens with a comment', async () => {
    const looksLikeHtml = await servedLooksLikeHtml();
    expect(looksLikeHtml('<!-- generated, do not edit -->\n<!DOCTYPE html><html></html>')).toBe(true);
    expect(looksLikeHtml('<!--\n multi\n line\n banner\n-->\n<html><body>hi</body></html>')).toBe(true);
    expect(looksLikeHtml('<!-- a --><!-- b --><div>x</div>')).toBe(true);
  });

  it('still renders the plain cases', async () => {
    const looksLikeHtml = await servedLooksLikeHtml();
    expect(looksLikeHtml('<!DOCTYPE html><html>')).toBe(true);
    expect(looksLikeHtml('\n  <html>hi</html>')).toBe(true);
    expect(looksLikeHtml('﻿<!DOCTYPE html>')).toBe(true);
    expect(looksLikeHtml('<?xml version="1.0"?><html>')).toBe(true);
    expect(looksLikeHtml('<p>a paragraph on its own</p>')).toBe(true);
  });

  it('does not mistake text, markdown or JSON for a document', async () => {
    const looksLikeHtml = await servedLooksLikeHtml();
    expect(looksLikeHtml('plain notes, nothing markup about them')).toBe(false);
    expect(looksLikeHtml('# a markdown heading')).toBe(false);
    expect(looksLikeHtml('{"json": true}')).toBe(false);
    expect(looksLikeHtml('<notatag>hello')).toBe(false);
  });

  it('gives up on an unterminated comment instead of scanning forever', async () => {
    const looksLikeHtml = await servedLooksLikeHtml();
    expect(looksLikeHtml('<!-- ' + 'x'.repeat(200_000))).toBe(false);
  });
});

/**
 * The page hands automated readers a self-contained decrypt procedure using
 * only Node's built-in crypto. It is wrapped across lines for legibility inside
 * the block, which is exactly the kind of thing that silently breaks it, so
 * check that what is served still parses and still names the right derivation.
 */
describe('the zero-install decrypt path stays runnable', () => {
  async function snippet(): Promise<string> {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request('http://localhost/w/aBcDeFgHiJkL', BROWSER),
      env as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const html = await response.text();
    const match = /node -e '([\s\S]*?)' "THE_FULL_URL"/.exec(html);
    expect(match, 'decrypt snippet missing from the page').not.toBeNull();
    return match![1].replace(/\n\s+/g, '');
  }

  it('parses as JavaScript', async () => {
    const code = await snippet();
    expect(() => new Function(code)).not.toThrow();
  });

  it('derives the content key the way the server expects', async () => {
    const code = await snippet();
    // Change either of these and every link ever issued stops opening.
    expect(code).toContain('vnsh/enc/v2');
    expect(code).toContain('aes-256-gcm');
    // #r= carries the content key already derived; #w= carries the root secret.
    expect(code).toContain('f.startsWith("r=")');
  });

  it('pulls the ciphertext from the API, not from this page', async () => {
    const code = await snippet();
    expect(code).toContain('/api/workspace/');
  });
});

/**
 * The blob viewer names a download after the file the uploader sent, decrypting
 * that name in the browser with the blob's own AES-256-CBC key. Run the served
 * functions rather than the TypeScript: the sanitizer is regex-heavy, and a
 * template-literal backslash mangled anywhere in it ships as a different regex.
 */
describe('the blob viewer opens a legacy file name as served', () => {
  async function servedOpenLegacyName(): Promise<(h: string, k: Uint8Array) => Promise<string | null>> {
    const scripts = await scriptsOn('/v/aBcDeFgHiJkL');
    const script = scripts.find((s) => s.includes('openLegacyName'));
    expect(script, 'openLegacyName not found in the served page').toBeDefined();
    const pieces = [
      /function base64urlToBytes\([^)]*\) \{[\s\S]*?\n    \}/,
      /var RESERVED_DEVICE_NAMES = [^\n]*;/,
      /function sanitizeName\([^)]*\) \{[\s\S]*?\n    \}/,
      /var LEGACY_NAME_BYTES = [^\n]*;/,
      /async function openLegacyName\([^)]*\) \{[\s\S]*?\n    \}/,
    ].map((re) => {
      const m = re.exec(script!);
      expect(m, `${re} not found in the served page`).not.toBeNull();
      return m![0];
    });
    return new Function('h', 'k', `${pieces.join('\n')}\nreturn openLegacyName(h, k);`) as never;
  }

  async function sealCbc(name: string, key: Uint8Array): Promise<string> {
    const slot = new Uint8Array(200);
    slot.set(new TextEncoder().encode(name));
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const k = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt']);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, k, slot));
    const out = new Uint8Array(16 + ct.length);
    out.set(iv);
    out.set(ct, 16);
    return btoa(String.fromCharCode(...out)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  const key = crypto.getRandomValues(new Uint8Array(32));

  it('recovers the name the CLI sealed, at the constant 299 characters', async () => {
    const open = await servedOpenLegacyName();
    const sealed = await sealCbc('quarterly-analysis.py', key);
    expect(sealed).toHaveLength(299);
    expect(await open(sealed, key)).toBe('quarterly-analysis.py');
    expect(await open(await sealCbc('季度报告.pdf', key), key)).toBe('季度报告.pdf');
  });

  it('reduces a hostile name to something safe for a download attribute', async () => {
    const open = await servedOpenLegacyName();
    expect(await open(await sealCbc('../../etc/passwd', key), key)).toBe('passwd');
    expect(await open(await sealCbc('invoice‮fdp.exe', key), key)).toBe('invoicefdp.exe');
    expect(await open(await sealCbc('notes.txt:payload.exe', key), key)).toBe('notes.txtpayload.exe');
    expect(await open(await sealCbc('report.txt.', key), key)).toBe('report.txt');
    expect(await open(await sealCbc('CON.png', key), key)).toBe('_CON.png');
  });

  it('yields nothing for the wrong key, a truncated header, or no header', async () => {
    const open = await servedOpenLegacyName();
    const sealed = await sealCbc('secret.docx', key);
    expect(await open(sealed, crypto.getRandomValues(new Uint8Array(32)))).toBeNull();
    expect(await open(sealed.slice(0, -8), key)).toBeNull();
    expect(await open('', key)).toBeNull();
  });
});

describe('the workspace viewer sanitizer matches the other clients', () => {
  it('drops the characters Windows refuses and caps by bytes', async () => {
    const scripts = await scriptsOn('/w/aBcDeFgHiJkL');
    const script = scripts.find((s) => s.includes('function sanitizeName'))!;
    const pieces = [/var RESERVED_DEVICE_NAMES = [^\n]*;/, /function sanitizeName\([^)]*\) \{[\s\S]*?\n  \}/]
      .map((re) => re.exec(script)![0]);
    const sanitize = new Function('n', `${pieces.join('\n')}\nreturn sanitizeName(n);`) as (n: string) => string | null;
    expect(sanitize('report?.csv')).toBe('report.csv');
    expect(sanitize('a<b>c"d|e*f.txt')).toBe('abcdef.txt');
    expect(new TextEncoder().encode(sanitize('季'.repeat(120) + '.pdf')!).length).toBeLessThanOrEqual(200);
  });
});
