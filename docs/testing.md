# How this project is tested

Written after a session in which the test suite was green the whole time and
the product was not. Every method below exists because something got past the
previous one.

The organising idea: **a test that cannot fail against the broken version is
not a test.** Most of what follows is about closing the gap between what a
test observes and what a user gets.

---

## The methods

### 1. Lift the code out of what is actually served

The viewer, the markdown renderer, the detector and the homepage all live
inside a template literal in `worker/src/index.ts` and reach the user as a
string. A test that imports a copy is testing a second implementation.

So the tests fetch the page from the worker and extract the function from the
response body:

```ts
const page = await (await worker.fetch(new Request('http://localhost/w/aBcDeFgHiJkL'), env, ctx)).text();
const start = page.indexOf('function looksLikeMarkdown(input)');
const end = page.indexOf('function render(', start);
const looksLikeMarkdown = new Function(`${page.slice(start, end)};return looksLikeMarkdown;`)();
```

This is the only way a template-literal mangling — a doubled backslash that
should be single, a stray backtick — shows up in a test rather than in
someone's browser. It also fails loudly if the block is renamed, which is the
correct failure.

Used by: `markdown.test.ts`, `render-corpus.test.ts`, `inline-scripts.test.ts`.

### 2. Never assert against a string the test itself wrote

The extension's link-detection test kept a *copy* of the regex. The real regex
gained the content domain; the copy did not; the test stayed green while
public links were invisible to every installed extension.

The fix is to read the literal out of the shipped source:

```ts
const src = readFileSync('../src/content/detector.ts', 'utf-8');
const literal = src.match(/const VNSH_LINK_RE =\s*\/(.+)\/;/);
const LINK_RE = new RegExp(literal[1]);
```

The same trap in another shape: an assertion matched the words `window.open`
**in a comment explaining the fix**, not the call. Anchor on the thing itself
(`window.open(u.href`), not on a phrase that also appears in prose.

### 3. Check that a new test fails against the old code

Before trusting a fixture, run it against the expression you are replacing:

```js
const oldVeto = /^(---|\+\+\+|diff --git|@@ )/m;
oldVeto.test(fixtureWithHorizontalRule)   // true  -> the fixture is meaningful
```

If it passes both before and after, it is decoration.

### 4. Test the artifact that ships, not the source it came from

`npm pack`, install the tarball into an empty directory, and run *that* against
production before publishing:

```bash
npm pack ./cli/npm && npm init -y && npm i ./vnsh-2.3.2.tgz
./node_modules/.bin/vn --public          # must print the content domain
```

Same for the extension: unzip `vnsh-extension.zip` and grep the built bundle,
because the zip is what the store receives. Confirm `host_permissions` is
unchanged — a new permission is what turns a review from days into weeks.

### 5. Distinguish "not deployed" from "not expired"

A change can be live at the origin and stale at the edge. Compare the two
before concluding anything:

```bash
curl -s https://vnsh.raullenchai.workers.dev/           # origin, no zone cache
curl -s "https://vnsh.dev/?cb=$RANDOM"                  # edge
```

If origin has it and the edge does not, wait; do not go looking for a bug.
This cost real time twice in one session.

### 6. Drive a real browser for anything the DOM decides

`curl` cannot tell you whether a page renders, whether an origin is opaque, or
whether a console is clean. Playwright can:

```bash
node scripts/… # see below
```

What is worth observing: `page.on('console')`, `page.on('requestfailed')`,
`page.on('request')` filtered to third-party hosts, `page.frames()` for
cross-origin frames, and `getBoundingClientRect()` for anything about layout
or the fold.

Two live findings came only from this — a 404 font stylesheet and a CSP
violation, both sitting in every visitor's console.

### 7. Run adversarial content through the *real* path

Not through a unit test of the renderer. Create a genuine workspace with the
CLI, open it in a browser, and interrogate the frame from inside:

```js
frame.evaluate(() => ({
  origin: String(window.origin),         // must be "null"
  key: (() => { try { return String(parent.location.hash) } catch (e) { return 'THREW:' + e.name } })(),
  net: fetchResult, ls: storageResult, ck: cookieResult,
}));
```

The classification matters: a payload starting with `<script>` is shown as
source, never reaches the renderer, and proves nothing. Wrap payloads in a tag
`looksLikeHtml()` accepts (`<html>`, `<div>`, `<body>`) or the run is green
because nothing happened.

### 8. Run a control for every negative result

The most expensive lesson. A harness reported that untrusted content could
open popups with no user gesture. The control — an *ordinary* page calling
`window.open` with no gesture — opened too. Playwright launches Chromium with
`--disable-popup-blocking`, so the harness could not have detected the
protection it was claiming was absent.

**Before believing "X is not blocked", prove the harness can observe blocking
at all.**

### 9. Prefer unauthenticated ground truth

A Cloudflare API call that fails authentication returns `result: null`, and
`d.get('result') or []` renders that identically to "no records exist". An
OAuth token expiring mid-session turned "does this zone have MX records" into
a silent false negative.

Use `dig` for DNS. Use the response itself for headers. When an API is the
only route, print `success` and `errors`, never just the result.

### 10. Attribute edge behaviour with a Ray ID, do not guess

A 403 at the edge was first blamed on Bot Fight Mode. It was off. The correct
route is to generate a blocked request, take its `cf-ray`, and look it up in
**Security → Events**, which names the service exactly (`Browser integrity
check`). Guessing sent the user to the wrong toggle once.

### 11. Corpus breadth over fixture depth

The markdown detector had twenty-four fixtures and shipped a bug that rejected
any document with a section rule — because every fixture was short and none
used one. The replacement is a corpus organised by *what people actually
paste*: prose in several scripts, every config and source format, pathological
shapes, adversarial payloads. `render-corpus.test.ts`.

### 12. Send a stranger who was not told how it works

Not a method for code, but the highest-yield check available: give the product
to someone with no context and watch what they do. Six unaware subagents found
six real defects that no test had.

---

## The false signals seen in one session

Each of these looked like a product bug and was not, or looked fine and was
not. They are listed because recognising the shape is faster than
re-deriving it.

| What it looked like | What it was |
|---|---|
| Viewer renders nothing | Old `--headless` mode dumped the DOM before JS finished; `--headless=new` was fine |
| Content can open popups freely | Playwright disables the popup blocker; the control proved the harness blind |
| Content exfiltrated to an external host | Playwright reports a request *before* CSP blocks it; the load failed with reason `csp` |
| Hardened frame had no CSP | The frame had been replaced by a Chrome error page — the parent's `frame-src` stopped the navigation |
| Fix not deployed | Edge cache; the origin had it |
| Zone has no MX records | The API call was unauthenticated and returned null |
| Four changes missing from production | A bug in the shell function doing the checking; direct `grep` showed all four present |
| Web upload broken | Waited on `#result-url-full`, which is `display:none` by design |
| Detector regex fine | The test held a copy of the regex |
| Activation gate present | The assertion matched the word in its own comment |

---

## Running everything

```bash
# every package
npm test                                  # from the repo root

# the worker suite alone (the largest)
cd worker && npm test

# usage funnel from Analytics Engine, no credential to create
cd worker && npm run stats

# the ad-hoc harnesses used for launch verification live in the session
# scratchpad; the durable parts of them have been folded into
# worker/test/render-corpus.test.ts and worker/test/content-domain.test.ts
```

## What a pre-launch pass covers

1. All four test suites green.
2. Every recent change confirmed **on the live edge**, by direct `grep`, with
   the origin as a tiebreaker.
3. Bare-client matrix: `curl`, `python-urllib`, `python-requests`,
   `Go-http-client`, `node-fetch`, empty UA — against both `llms.txt` and a
   public document. This is the product's central claim; it is also what an
   edge security setting silently breaks.
4. CLI round trips from a **clean `npx`**: create, read, write, re-read,
   stale-write refusal, public, legacy blob.
5. MCP server starts and lists its tools.
6. Browser: homepage upload for both tiers, links resolve, viewer decrypts and
   renders, frame is opaque with CSP injected, zero third-party requests, zero
   console errors.
7. Content domain serves `/p/` and 404s everything else.
8. `security.txt`, `robots.txt`, `X-Robots-Tag` present.
