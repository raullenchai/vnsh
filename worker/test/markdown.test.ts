import { describe, it, expect } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';

type Env = { VNSH_STORE: R2Bucket };

/**
 * Agents write markdown by default, and it was the one format this viewer
 * showed as raw text — the format its main authors produce was the one that
 * looked worst on arrival.
 *
 * These exercise the code *as served*, not the source, because the whole
 * renderer lives inside a template literal where a single backslash instead of
 * two turns `[^\]]` into `[^]]` and takes the page down. That happened while
 * building this.
 */
async function served(): Promise<{
  looksLikeMarkdown: (s: string) => boolean;
  renderMarkdown: (s: string) => string;
  markdownDocument: (s: string) => string;
}> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request('http://localhost/w/aBcDeFgHiJkL'),
    env as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const html = await response.text();
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
  const from = script.indexOf('var BT = String.fromCharCode(96)');
  const to = script.indexOf('function render()');
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return new Function(
    `${script.slice(from, to)}; return { looksLikeMarkdown, renderMarkdown, markdownDocument };`,
  )() as never;
}

describe('deciding what is markdown', () => {
  // A naive "starts with # or -" test misfires on six of these. Rendering a
  // shell script as prose is worse than not rendering markdown at all, so the
  // detector is biased towards leaving things alone.
  const YES = [
    ['a report', '# Incident review\n\nRoot cause: pool exhaustion.\n\n- p99 hit 4.2s\n- pool was 10\n'],
    ['fenced code', '## Findings\n\n```ts\nconst x = 1;\n```\n'],
    ['a table', '# Results\n\n| case | status |\n|---|---|\n| a | ok |\n'],
    ['links and bold', 'See the [doc](https://x.dev) and the **root cause**.\n\n- one\n- two\n'],
  ];
  const NO = [
    ['a shell script', '#!/usr/bin/env bash\nset -e\n# clean up\nrm -rf x\n'],
    ['python without a shebang', '# Copyright 2026\nimport sys\n\ndef main():\n    pass\n'],
    ['a Dockerfile', '# syntax=x\nFROM node:22\nRUN npm ci\n'],
    ['an nginx config', '# server\nserver {\n  listen 80;\n}\n'],
    ['a unified diff', '--- a/x\n+++ b/x\n- old\n+ new\n'],
    ['YAML', '# deploy\nname: ci\non:\n  - push\n'],
    ['docker-compose', '# stack\nservices:\n  web:\n    image: nginx\n'],
    ['a .env file', '# secrets\nAPI_KEY=abc\nDB_URL=x\n'],
    ['JSON', '{"a":1}'],
    ['HTML', '<!DOCTYPE html><html></html>'],
    ['plain prose', 'We should raise the pool size.\nIt is ten.\n'],
    ['a log file', '2026-07-28 ERROR pool exhausted\n2026-07-28 WARN retry\n'],
    ['a lone heading', '# Just a title\n'],
    ['nothing', '   \n'],
  ];

  it.each(YES)('renders %s', async (_name, body) => {
    expect((await served()).looksLikeMarkdown(body as string)).toBe(true);
  });

  it.each(NO)('leaves %s alone', async (_name, body) => {
    expect((await served()).looksLikeMarkdown(body as string)).toBe(false);
  });
});

describe('rendering', () => {
  it('covers what an agent actually writes', async () => {
    const { renderMarkdown } = await served();
    const html = renderMarkdown(
      '# Title\n\nSome **bold** and `code` and a [link](https://x.dev).\n\n' +
        '- one\n- two\n\n1. first\n2. second\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n' +
        '> quoted\n\n```js\nvar x = 1;\n```\n\n---\n',
    );
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<a href="https://x.dev">link</a>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<blockquote>quoted</blockquote>');
    expect(html).toContain('data-lang="js"');
    expect(html).toContain('<hr>');
  });

  it('leaves fenced code exactly as written', async () => {
    const { renderMarkdown } = await served();
    // Markdown syntax inside a fence is content, not markup.
    const html = renderMarkdown('```\n# not a heading\n**not bold**\n```\n');
    expect(html).toContain('# not a heading');
    expect(html).toContain('**not bold**');
    expect(html).not.toContain('<h1>');
    expect(html).not.toContain('<strong>');
  });

  it('neutralises markup and unsafe links in the source', async () => {
    const { renderMarkdown } = await served();
    const html = renderMarkdown(
      '# <img src=x onerror=alert(1)>\n\n[click](javascript:alert(1))\n\n' +
        '- <script>alert(2)</script>\n\n[ok](https://x.dev)\n',
    );
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');

    // The invariant is about attributes, not about the string appearing at all:
    // an unsafe link is left as inert text rather than becoming an anchor, so
    // "javascript:" is still present and harmless. Assert what matters — that
    // nothing ends up in an href or src that could execute.
    const urls = [...html.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url, `unsafe URL reached an attribute: ${url}`).toMatch(/^(https?:\/\/|mailto:|#|\/)/);
    }
    expect(html).toContain('[click](javascript:alert(1))');
    // A safe link still works, so this is escaping rather than blanket removal.
    expect(html).toContain('<a href="https://x.dev">ok</a>');
  });

  it('wraps output in a document, so it goes through the same sandbox', async () => {
    const { markdownDocument } = await served();
    const doc = markdownDocument('# Hi\n\n- a\n');
    expect(doc.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(doc).toContain('<h1>Hi</h1>');
  });
});

describe('the reader keeps the last word', () => {
  it('offers the source toggle for markdown as well as HTML', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request('http://localhost/w/aBcDeFgHiJkL'),
      env as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const html = await response.text();
    // Detection can be wrong either way; the cost of that must be one click.
    expect(html).toContain('looksLikeHtml(plaintext) || looksLikeMarkdown(plaintext)');
    expect(html).toContain("'View rendered'");
  });
});
