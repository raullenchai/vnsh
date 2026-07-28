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
