import { describe, it, expect } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';

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
  const response = await worker.fetch(new Request('http://localhost' + path), env as Env, ctx);
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
