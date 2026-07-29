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
      expect(page).toContain('else renderHtml(mdToHtml(plaintext));');
    });
  });
});
