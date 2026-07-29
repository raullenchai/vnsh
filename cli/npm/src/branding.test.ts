import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The same sentence is written in six places that ship independently — the
 * site, this package, the MCP package, the extension manifest, the README, and
 * the CLI's own help text. Nothing kept them in step, and they had drifted into
 * five variants: one dropped "AI", one reordered the words, one pluralised the
 * noun. None of it breaks anything, which is exactly why nobody notices until a
 * visitor reads two of them in the same minute.
 *
 * This package's tests are the only ones running under Node with filesystem
 * access, which is why the cross-package check lives here.
 */
const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const read = (p: string) => readFileSync(repo(p), 'utf-8');
const json = (p: string) => JSON.parse(read(p));

// The one sentence. Anything claiming to be the tagline must be exactly this.
const TAGLINE = 'One workspace all your AI agents can read and write';

// The category line, used where a descriptor is wanted rather than a benefit.
const CATEGORY = 'Portable Workspaces for AI and Humans';

describe('the tagline is the same sentence everywhere', () => {
  it.each([
    ['README', () => read('README.md')],
    ['the CLI package description', () => json('cli/npm/package.json').description],
    ['the MCP package description', () => json('mcp/package.json').description],
    ['the extension description', () => json('extension/manifest.json').description],
  ])('%s carries it verbatim', (_label, get) => {
    expect(get()).toContain(TAGLINE);
  });

  it("appears in the CLI's own help text", () => {
    // Lower-cased there because it follows "vnsh - ", mid-sentence.
    expect(read('cli/npm/src/cli.ts')).toContain(TAGLINE.replace('One', 'one'));
  });

  it('has no stale variants left anywhere', () => {
    const sources = [
      read('README.md'),
      read('cli/npm/src/cli.ts'),
      JSON.stringify(json('cli/npm/package.json')),
      JSON.stringify(json('mcp/package.json')),
      JSON.stringify(json('extension/manifest.json')),
    ].join('\n');
    // Each of these was a real variant found in the wild.
    expect(sources).not.toContain('your agents can all read and write');
    expect(sources).not.toContain('One workspace all your agents can read');
  });
});

describe('the category line is the same everywhere', () => {
  it('is current in the worker, which serves it to social cards and llms.txt', () => {
    const worker = read('worker/src/index.ts');
    expect(worker).toContain(CATEGORY);
    expect(worker).not.toContain('Portable Workspaces for AI Agents');
  });
});

describe('the social card says one thing, not two', () => {
  const worker = read('worker/src/index.ts');
  const app = worker.slice(worker.indexOf('const APP_HTML = '));
  const meta = (name: string, attr: 'property' | 'name') =>
    app.match(new RegExp(`<meta ${attr}="${name}" content="(.*?)"`))?.[1] ?? '';

  it('uses the same description for Open Graph and Twitter', () => {
    // They differed for no reason, so a shared link read differently depending
    // on where it was pasted.
    expect(meta('og:description', 'property')).toBe(meta('twitter:description', 'name'));
  });

  it('uses the same title for both', () => {
    expect(meta('og:title', 'property')).toBe(meta('twitter:title', 'name'));
  });

  it('keeps the meta description short enough to survive a search result', () => {
    const description = meta('description', 'name');
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(160);
  });
});
