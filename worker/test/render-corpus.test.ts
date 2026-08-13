import { describe, it, expect, beforeAll } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';

// The workspace route now content-negotiates: only real browser navigations
// get the application. A suite asserting the browser page has to identify one.
const BROWSER = { headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } };

type Env = { VNSH_STORE: R2Bucket };

/**
 * A corpus for the decision the viewer makes about every document it opens:
 * render it as HTML, render it as markdown, or show it as source.
 *
 * It exists because the detector's real failure was found by a user pasting a
 * real report, not by the twenty-four fixtures written alongside it — those
 * were all short, and none used a section rule. Breadth is the point here:
 * prose in several scripts, every config and source format that gets pasted
 * into a workspace, pathological shapes, and payloads that would matter if the
 * sandbox ever slipped.
 *
 * Both functions are lifted out of the page the worker actually serves. A copy
 * would be a second implementation free to drift from the one users get.
 */
let classify: (src: string) => 'html' | 'md' | 'text';
let mdToHtml: (src: string) => string;

beforeAll(async () => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request('http://localhost/w/aBcDeFgHiJkL', BROWSER), env as Env, ctx);
  await waitOnExecutionContext(ctx);
  const page = await res.text();

  const lift = (from: string, to: string, name: string) => {
    const start = page.indexOf(from);
    const end = page.indexOf(to, start);
    expect(start, `could not find ${from}`).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return new Function(`${page.slice(start, end)};return ${name};`)();
  };

  const looksLikeMarkdown = lift('function looksLikeMarkdown(input)', 'function render(', 'looksLikeMarkdown');
  const looksLikeHtml = lift('function looksLikeHtml(', 'function harden(', 'looksLikeHtml');
  mdToHtml = lift('var MD_CSS = [', 'function renderHtml(', 'mdToHtml');

  // Mirrors render(): showingSource = !(isHtml || looksLikeMarkdown(plaintext))
  classify = (src: string) =>
    looksLikeHtml(src) ? 'html' : looksLikeMarkdown(src) ? 'md' : 'text';
});

const TICK = String.fromCharCode(96);
const FENCE = TICK.repeat(3);

describe('documents that must open rendered as markdown', () => {
  it.each([
    ['headings and a list', '# Title\n\nProse.\n\n- one\n- two'],
    ['a section rule', '# R\n\n**Date**\n\nIntro.\n\n---\n\n## S\n\n- a\n- b'],
    ['an *** rule', '# T\n\ntext\n\n***\n\n## S\n\n- a\n- b'],
    ['an ___ rule', '# T\n\ntext\n\n___\n\n## S\n\n- a\n- b'],
    ['a table', '# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n**bold**'],
    ['fenced code', `# T\n\n${FENCE}js\nconst x = 1;\n${FENCE}\n\n- a\n- b`],
    ['nested lists', '# T\n\n- a\n  - a1\n    - a2\n- b\n\n**x**'],
    ['a task list', '# T\n\n- [ ] todo\n- [x] done\n\n**bold**'],
    ['links and images', '# T\n\n[a](https://e.com) ![i](https://e.com/x.png)\n\n- a\n- b'],
    ['a blockquote', '# T\n\n> quoted\n\n## S\n\n- a'],
    ['CJK prose with a rule', '# 标题\n\n**日期**\n\n说明。\n\n---\n\n## 一、节\n\n- 要点\n- 要点'],
    ['emoji and mixed scripts', '# 🚀 T\n\n**bold** — ü, 日本語, عربى\n\n- ✅ a\n- ❌ b'],
    ['right-to-left text', '# عنوان\n\n**نص**\n\n- واحد\n- اثنان'],
    ['hard-wrapped prose', '# T\n\nA paragraph that\nwraps hard.\n\n- a\n- b\n\n**bold**'],
    ['CRLF line endings', '# T\r\n\r\ntext\r\n\r\n- a\r\n- b\r\n\r\n**bold**'],
  ])('renders %s', (_label, src) => {
    expect(classify(src)).toBe('md');
  });
});

describe('documents that must open as source', () => {
  it.each([
    ['YAML front matter', '---\ntitle: post\ntags: [a]\n---\n\n# Body\n\n- one\n- two'],
    ['TOML front matter', '+++\ntitle = "post"\n+++\n\n# Body\n\n- one\n- two'],
    ['a git diff', 'diff --git a/x.md b/x.md\n--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n-# old\n+# new\n\n- a\n- b'],
    ['a bare diff body', '--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n-# a\n+# b\n\n- x\n- y'],
    ['a YAML config', 'name: app\nversion: 1.2.3\nports:\n  - 80\nenv:\n  KEY: value'],
    ['JSON', '{\n  "name": "x",\n  "items": [1, 2],\n  "nested": { "a": true }\n}'],
    ['a JSON array', '[\n  {"a": 1},\n  {"b": 2}\n]'],
    ['a Dockerfile', 'FROM node:20\nRUN npm ci\nCOPY . .\nCMD ["node", "x.js"]'],
    ['a shell script', '#!/bin/bash\nset -e\n# looks like a heading\necho hi'],
    ['a dotenv file', 'DEBUG=true\nPORT=8080\nDATABASE_URL=postgres://x'],
    ['JavaScript source', 'function main() {\n  const x = 1;\n  return x;\n}\n\nmodule.exports = { main };'],
    ['Python source', 'import os\n\ndef main():\n    # heading-looking comment\n    return os.getcwd()'],
    ['CSV', 'name,count,note\na,1,x\nb,2,y'],
    ['log lines', '2026-07-29T05:00:00Z INFO started\n2026-07-29T05:00:01Z WARN slow'],
    ['a stack trace', 'Error: boom\n    at f (/a/b.js:1:1)\n    at g (/a/c.js:2:2)'],
    ['plain prose', 'Just an ordinary paragraph with no markup in it at all.'],
    ['nothing', ''],
    ['whitespace', '   \n\n\t\n  '],
  ])('shows %s as source', (_label, src) => {
    expect(classify(src)).toBe('text');
  });
});

describe('documents that must open as HTML', () => {
  it.each([
    ['a full document', '<!DOCTYPE html><html><head><title>t</title></head><body><h1>Hi</h1></body></html>'],
    ['a fragment', '<div><h1>Hi</h1><p>text</p></div>'],
    ['one behind a comment', '<!-- generated -->\n<!DOCTYPE html><html><body><h1>x</h1></body></html>'],
    ['one behind a BOM', '﻿<!DOCTYPE html><html><body><p>x</p></body></html>'],
    ['unclosed tags', '<div><p>one<p>two<span>three'],
  ])('renders %s', (_label, src) => {
    expect(classify(src)).toBe('html');
  });
});

/**
 * Shapes that should not hang, blow the stack, or throw. The renderer runs on
 * content a stranger wrote, so "it crashed" is a denial of the page, and the
 * failure would look to the reader like the workspace itself is broken.
 */
describe('pathological input is survivable', () => {
  const cases: [string, string][] = [
    ['a very long document', '# T\n\n' + Array.from({ length: 400 }, (_, i) => `## S${i}\n\npara ${i} **b**\n\n- a\n- b\n`).join('\n')],
    ['deeply nested HTML', '<div>'.repeat(2000) + 'x' + '</div>'.repeat(2000)],
    ['a deeply indented list', '# T\n\n' + Array.from({ length: 500 }, (_, i) => ' '.repeat(i % 20) + '- item').join('\n') + '\n\n**b**'],
    ['an unterminated fence', `# T\n\n${FENCE}js\nconst x = 1;\n\n- a\n- b`],
    ['an unterminated table', '# T\n\n| a | b\n|---\n| 1'],
    ['thousands of links', '# T\n\n' + Array.from({ length: 3000 }, (_, i) => `[l${i}](https://e.com/${i})`).join(' ') + '\n\n- a'],
    ['one enormous line', '# T\n\n' + 'word '.repeat(60000) + '\n\n- a\n- b'],
    ['many rules', '# T\n\n' + '---\n\n'.repeat(2000) + '- a\n- b'],
    ['lone surrogates', '# T\n\n\uD800 text \uDFFF\n\n- a\n- b'],
    ['control characters', '# T\n\n[31mred[0m\n\n- a\n- b'],
    ['mixed line endings', '# T\r\n\r\ntext\r\n\r\n- a\r- b\n\n**bold**'],
  ];

  it.each(cases)('classifies %s without throwing', (_label, src) => {
    expect(() => classify(src)).not.toThrow();
  });

  it.each(cases)('renders %s without throwing', (_label, src) => {
    expect(() => mdToHtml(src)).not.toThrow();
  });

  it('finishes a large document in reasonable time', () => {
    const big = '# T\n\n' + Array.from({ length: 2000 }, (_, i) => `## S${i}\n\n- a\n- b\n\n**x** [l](https://e.com)\n`).join('\n');
    const started = Date.now();
    mdToHtml(big);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

/**
 * The frame these land in has an opaque origin and no network, so none of this
 * is the last line of defence — but a renderer that emits an event handler from
 * markdown is still wrong, and would become a real hole the day someone adds
 * allow-same-origin. Verified separately in a browser that none of these
 * execute, reach the parent, read the key, or reach the network.
 */
describe('markdown never produces executable output', () => {
  it.each([
    ['a javascript: link', '# T\n\n[click](javascript:alert(1))\n\n- a\n- b'],
    ['a data: link', '# T\n\n[click](data:text/html,<script>alert(1)</script>)\n\n- a\n- b'],
    ['an image with a quote break', '# T\n\n![x](https://e.com/a.png"onerror="alert(1))\n\n- a\n- b'],
    ['a script tag in emphasis', '# T\n\n**<script>alert(1)</script>**\n\n- a\n- b'],
    ['a vbscript: link', '# T\n\n[click](vbscript:alert(1))\n\n- a\n- b'],
  ])('neutralises %s', (_label, src) => {
    const html = mdToHtml(src);
    expect(html).not.toMatch(/<script[\s>]/i);
    expect(html).not.toMatch(/\son\w+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/vbscript:/i);
    expect(html).not.toMatch(/<iframe[\s>]|<object[\s>]|<embed[\s>]/i);
  });

  it('keeps a script inside a code fence as text, not as a tag', () => {
    const html = mdToHtml(`# T\n\n${FENCE}html\n<script>alert(1)</script>\n${FENCE}\n\n- a`);
    expect(html).not.toMatch(/<script[\s>]/i);
    expect(html).toContain('&lt;script&gt;');
  });
});

/**
 * Links inside a sandboxed frame would navigate the frame itself, so the viewer
 * injects a hook that asks the parent to open them instead. Codex flagged that
 * the parent accepted that request from any script in the frame, tied to
 * nothing — content can post the same shape on load or on a timer, so the only
 * thing standing between a stranger's document and window.open was the
 * browser's popup blocker.
 *
 * Whether a real browser's blocker would have caught it could not be settled
 * here — headless Chrome has no popup blocker, and the harness said "allowed"
 * even for an ordinary ungestured window.open, so the measurement proved
 * nothing either way. The listener now requires live user activation, which
 * makes the answer not matter.
 */
describe('the link hook cannot be driven without a user gesture', () => {
  let listener: string;

  beforeAll(async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request('http://localhost/w/aBcDeFgHiJkL', BROWSER), env as Env, ctx);
    await waitOnExecutionContext(ctx);
    const page = await res.text();
    const start = page.indexOf("window.addEventListener('message'");
    const end = page.indexOf('function renderText(', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    listener = page.slice(start, end);
  });

  it('checks user activation before opening anything', () => {
    expect(listener).toContain('navigator.userActivation');
    // The check has to gate the open, not merely be mentioned. Anchor on the
    // call itself rather than the words "window.open", which also appear in the
    // comment explaining why the gate is there.
    const gate = listener.indexOf('activation.isActive');
    const call = listener.indexOf('window.open(u.href');
    expect(gate).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(call);
  });

  it('still requires the message to come from the content frame', () => {
    expect(listener).toContain('e.source !== contentFrame.contentWindow');
  });

  it('still refuses anything that is not http or https', () => {
    expect(listener).toContain("u.protocol !== 'http:'");
    expect(listener).toContain("u.protocol !== 'https:'");
  });

  it('opens with noopener and noreferrer', () => {
    expect(listener).toContain("'noopener,noreferrer'");
  });

  it('throttles so one gesture cannot become a burst of tabs', () => {
    expect(listener).toMatch(/lastOpenedAt/);
  });
});
