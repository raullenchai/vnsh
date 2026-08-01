import { describe, it, expect, beforeAll } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';

type Env = { VNSH_STORE: R2Bucket };

/**
 * The markdown renderer ships inside the viewer's inline script, so a copy of it
 * here would be a second implementation free to drift from the one users get.
 * Instead the block is lifted out of the page the worker actually serves and
 * evaluated, which means these assertions run against shipped code and the
 * extraction fails loudly if the block is moved or renamed.
 */
let mdBody: (src: string) => string;
let page = '';

beforeAll(async () => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request('http://localhost/w/aBcDeFgHiJkL'), env as Env, ctx);
  await waitOnExecutionContext(ctx);
  page = await res.text();

  const start = page.indexOf('var MD_CSS = [');
  const end = page.indexOf('function renderHtml(');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  mdBody = new Function(page.slice(start, end) + ';return mdBody;')() as typeof mdBody;
});

describe('markdown rendering', () => {
  describe('blocks', () => {
    it('renders ATX headings at their level', () => {
      expect(mdBody('# One')).toContain('<h1>One</h1>');
      expect(mdBody('### Three')).toContain('<h3>Three</h3>');
    });

    it('renders fenced code without interpreting what is inside', () => {
      const out = mdBody('```\n**not bold**\n```');
      expect(out).toContain('<pre><code>');
      expect(out).toContain('**not bold**');
      expect(out).not.toContain('<strong>');
    });

    it('renders unordered and ordered lists', () => {
      expect(mdBody('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
      expect(mdBody('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
    });

    it('renders a GFM table with alignment', () => {
      const out = mdBody('| a | b |\n| --- | ---: |\n| 1 | 2 |');
      expect(out).toContain('<th>a</th>');
      expect(out).toContain('style="text-align:right"');
      expect(out).toContain('<td>1</td>');
    });

    it('leaves prose containing a pipe alone', () => {
      // Without the delimiter-row check, this would be torn into columns.
      const out = mdBody('use grep | wc to count');
      expect(out).not.toContain('<table>');
      expect(out).toContain('<p>');
    });

    it('renders nested blockquote content as blocks', () => {
      expect(mdBody('> # quoted')).toBe('<blockquote><h1>quoted</h1></blockquote>');
    });

    it('renders a horizontal rule', () => {
      expect(mdBody('---')).toBe('<hr>');
    });

    it('reflows a hard-wrapped paragraph instead of preserving the wrap', () => {
      // Source wrapped at some column should not reach the reader wrapped at
      // that column. A single newline is a soft break.
      expect(mdBody('one\ntwo')).toBe('<p>one two</p>');
      expect(mdBody('one\ntwo')).not.toContain('<br>');
    });

    it('honours the explicit hard-break forms', () => {
      expect(mdBody('one  \ntwo')).toBe('<p>one<br>two</p>');
      expect(mdBody('one\\\ntwo')).toBe('<p>one<br>two</p>');
    });

    it('does not let the document forge a line break', () => {
      // The sentinel used to mark hard breaks is stripped from the input.
      expect(mdBody('a\u0001b')).toBe('<p>ab</p>');
    });
  });

  describe('inline', () => {
    it('renders emphasis and strong', () => {
      expect(mdBody('**b** and *i*')).toContain('<strong>b</strong>');
      expect(mdBody('**b** and *i*')).toContain('<em>i</em>');
    });

    it('leaves snake_case identifiers intact', () => {
      // Underscore emphasis at word boundaries only, or every identifier in a
      // technical document would sprout italics.
      expect(mdBody('call some_var_name now')).toContain('some_var_name');
      expect(mdBody('call some_var_name now')).not.toContain('<em>');
    });

    it('does not re-read the inside of a code span', () => {
      const out = mdBody('`a_b_c **d**`');
      expect(out).toContain('<code>a_b_c **d**</code>');
      expect(out).not.toContain('<strong>');
    });

    it('renders links', () => {
      expect(mdBody('[x](https://example.com)')).toContain('<a href="https://example.com">x</a>');
    });
  });

  describe('untrusted input', () => {
    it('escapes tags rather than emitting them', () => {
      const out = mdBody('<script>alert(1)</script>');
      expect(out).not.toContain('<script>');
      expect(out).toContain('&lt;script&gt;');
    });

    it('drops a javascript: href but keeps the text', () => {
      // The frame allows scripts, so an unfiltered href would run in it.
      const out = mdBody('[click](javascript:alert(1))');
      expect(out).not.toContain('javascript:');
      expect(out).not.toContain('<a ');
      expect(out).toContain('click');
    });

    it('drops a data: href', () => {
      const out = mdBody('[x](data:text/html,<script>alert(1)</script>)');
      expect(out).not.toContain('<a ');
    });

    it('cannot break out of an href attribute', () => {
      const out = mdBody('[x](https://e.com/"onmouseover="alert(1))');
      expect(out).not.toContain('onmouseover="alert');
    });

    it('renders an image as a link, since the frame policy blocks remote images', () => {
      const out = mdBody('![alt](https://example.com/a.png)');
      expect(out).toContain('<a href="https://example.com/a.png">alt</a>');
      expect(out).not.toContain('<img');
    });
  });

  describe('the served page', () => {
    it('carries the renderer and its stylesheet', () => {
      expect(page).toContain('function mdToHtml(');
      expect(page).toContain('var MD_CSS = [');
    });

    it('offers the view toggle for every document, not only HTML', () => {
      // Previously the button was revealed inside an `if (looksLikeHtml(...))`,
      // which left plain-text documents with no way to ask for a rendered view.
      expect(page).toContain("var renderedLabel = isHtml ? 'View page' : 'View rendered';");
      expect(page).toContain('raw.hidden = false;');
    });

    it('routes markdown through the same hardened frame as HTML', () => {
      // The guarantee is that rendered markdown reaches the reader the same way
      // rendered HTML does — through renderHtml, which hardens and sandboxes —
      // and never through a second path. Asserted on that rather than on the
      // exact line, which changes whenever the branch above it does.
      expect(page).toMatch(/renderHtml\(mdToHtml\(plaintext\)\)/);
      const uses = [...page.matchAll(/mdToHtml\(plaintext\)/g)].length;
      const hardened = [...page.matchAll(/renderHtml\(mdToHtml\(plaintext\)\)/g)].length;
      expect(hardened).toBe(uses);
    });

    it('opens a markdown document rendered, and a log as source', () => {
      // The point of the issue is the screen a recipient sees first, so the
      // default is chosen rather than always falling back to source. Detection
      // decides only that; the toggle above is always present, so being wrong
      // costs one click in either direction.
      expect(page).toContain('showingSource = !(isHtml || looksLikeMarkdown(plaintext));');
      expect(page).toContain('function looksLikeMarkdown(input)');
    });
  });
});

/**
 * Choosing the default is the part this PR deliberately left out, on the
 * reasonable grounds that no heuristic cleanly separates a markdown document
 * from a shell script whose first line begins with a hash. It is included here
 * because the issue is about the screen a recipient sees first, and opening a
 * report as raw source loses exactly that — but only as a default, with the
 * toggle always present, so a misfire costs one click.
 *
 * The objection is answered by measurement rather than by argument: a naive
 * "starts with # or -" test misfires on six of these, and every one of those
 * six is a file someone would actually paste.
 */
describe('choosing whether a document opens rendered', () => {
  let looksLikeMarkdown: (s: string) => boolean;

  beforeAll(() => {
    const start = page.indexOf('function looksLikeMarkdown(input)');
    const end = page.indexOf('function render()', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    looksLikeMarkdown = new Function(
      `${page.slice(start, end)};return looksLikeMarkdown;`,
    )() as typeof looksLikeMarkdown;
  });

  const RENDERED: [string, string][] = [
    ['a report', '# Incident review\n\nRoot cause: pool exhaustion.\n\n- p99 hit 4.2s\n- pool was 10\n'],
    ['fenced code', '## Findings\n\n```ts\nconst x = 1;\n```\n'],
    ['a table', '# Results\n\n| case | status |\n|---|---|\n| a | ok |\n'],
    ['links and bold', 'See the [doc](https://x.dev) and the **root cause**.\n\n- one\n- two\n'],
  ];
  const SOURCE: [string, string][] = [
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

  it.each(RENDERED)('opens %s rendered', (_name, body) => {
    expect(looksLikeMarkdown(body)).toBe(true);
  });

  it.each(SOURCE)('opens %s as source', (_name, body) => {
    expect(looksLikeMarkdown(body)).toBe(false);
  });
});

/**
 * A real document, reported by a user, that opened as source instead of
 * rendered. It is unmistakably markdown — headings, bold, lists, tables, a
 * blockquote — but it contained a horizontal rule, and the front-matter veto
 * matched "---" on any line rather than only at the start of the document. A
 * horizontal rule is also one of the positive signals, so the rule was voting
 * against itself and the veto ran first.
 */
describe('a horizontal rule is not front matter', () => {
  let looksLikeMarkdown: (s: string) => boolean;

  beforeAll(() => {
    const start = page.indexOf('function looksLikeMarkdown(input)');
    const end = page.indexOf('function render(', start);
    expect(start).toBeGreaterThan(-1);
    looksLikeMarkdown = new Function(
      `${page.slice(start, end)};return looksLikeMarkdown;`,
    )() as typeof looksLikeMarkdown;
  });

  const withRule = [
    '# A report',
    '',
    '**Date: 2026-07-29**',
    '',
    'An opening paragraph that sets out what the document covers.',
    '',
    '---',
    '',
    '## First section',
    '',
    '- a point',
    '- another point',
    '',
    '> a quoted line',
  ].join('\n');

  it('renders a document whose sections are separated by a rule', () => {
    expect(looksLikeMarkdown(withRule)).toBe(true);
  });

  it('renders one that uses *** and ___ rules too', () => {
    expect(looksLikeMarkdown(withRule.replace('---', '***'))).toBe(true);
    expect(looksLikeMarkdown(withRule.replace('---', '___'))).toBe(true);
  });

  // The veto still has a job: these must not open rendered.
  it('still declines YAML front matter', () => {
    expect(looksLikeMarkdown('---\ntitle: a post\ntags: [x]\n---\n\n# Body\n\n- one\n- two')).toBe(
      false,
    );
  });

  it('still declines TOML front matter', () => {
    expect(looksLikeMarkdown('+++\ntitle = "a post"\n+++\n\n# Body\n\n- one\n- two')).toBe(false);
  });

  it('still declines a unified diff', () => {
    const diff = [
      'diff --git a/readme.md b/readme.md',
      '--- a/readme.md',
      '+++ b/readme.md',
      '@@ -1,4 +1,4 @@',
      '-# Old heading',
      '+# New heading',
      '',
      '- a list item',
      '- another',
    ].join('\n');
    expect(looksLikeMarkdown(diff)).toBe(false);
  });

  it('still declines a bare diff body with no git header', () => {
    expect(
      looksLikeMarkdown('--- a/one.md\n+++ b/one.md\n@@ -1 +1 @@\n-# x\n+# y\n\n- item\n- item'),
    ).toBe(false);
  });
});

/**
 * The second real document to open as source instead of rendered. Same shape of
 * mistake as the horizontal rule above: a veto meant for config files matched
 * two lines of ordinary English. Hard-wrapped prose puts a word at the start of
 * every line, and sooner or later one of them ends in a colon — here
 * "Concretely:" and "before:", eleven pages apart. Two was the whole threshold.
 *
 * What separates the two cases is proportion, not the presence of the pattern:
 * a config file is made of key-value lines, a report contains a couple by
 * accident. So these fixtures pin both directions of that ratio.
 */
describe('a colon in wrapped prose is not a config file', () => {
  let looksLikeMarkdown: (s: string) => boolean;

  beforeAll(() => {
    const start = page.indexOf('function looksLikeMarkdown(input)');
    const end = page.indexOf('function render(', start);
    expect(start).toBeGreaterThan(-1);
    looksLikeMarkdown = new Function(
      `${page.slice(start, end)};return looksLikeMarkdown;`,
    )() as typeof looksLikeMarkdown;
  });

  // Trimmed from the reported workspace, keeping the two lines that tripped the
  // veto at the column the author's wrapping put them in.
  const report = [
    '# QuickSilver Pro — zero-friction trial',
    '',
    '**Goal:** a registered user tries the product without configuring anything.',
    '',
    '---',
    '',
    '## 1. The problem, measured',
    '',
    '| Stage | July | June |',
    '|---|---|---|',
    '| Registered, never created a key | 28 | 30 |',
    '| Paid | 4 | 7 |',
    '',
    'The first screen after signup is written for engineers, and its most prominent',
    'elements are a leak warning and a red danger zone.',
    '',
    'Concretely: **a non-technical buyer cannot become our customer today.** Every',
    'call requires a key, and the only path to a key is that screen.',
    '',
    '## 2. Preventing farming',
    '',
    '> **Do not try to win by detecting bots.**',
    '',
    'This is the part that decides whether the whole thing is safe to ship. We were',
    'burned in the week of ~05-11, when 373 Sybil accounts burned $507 of credits',
    'before: the response was a hard zero, which still holds in production today.',
    '',
    '- Denominated in tokens, never dollars',
    '- One cheap model only',
  ].join('\n');

  it('renders a wrapped report whose lines happen to start with a colon word', () => {
    expect(looksLikeMarkdown(report)).toBe(true);
  });

  it('renders it no matter how many such lines the wrapping produces', () => {
    // The old test was an absolute count, so a longer document was strictly
    // more likely to be rejected — exactly backwards for a signal that scales
    // with length by accident.
    expect(looksLikeMarkdown(report + '\n\nFinally: one more wrapped sentence.\n')).toBe(true);
  });

  // The veto still has a job, and a config file clears the ratio comfortably.
  it('still declines YAML that opens with a comment', () => {
    expect(looksLikeMarkdown('# deploy\nname: ci\non:\n  - push\n')).toBe(false);
  });

  it('still declines docker-compose', () => {
    expect(looksLikeMarkdown('# stack\nservices:\n  web:\n    image: nginx\n')).toBe(false);
  });

  it('still declines a workflow file, which is nearly all key lines', () => {
    const workflow = [
      '# CI',
      'name: test',
      'on:',
      '  push:',
      '    branches:',
      '      - main',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
    ].join('\n');
    expect(looksLikeMarkdown(workflow)).toBe(false);
  });
});
