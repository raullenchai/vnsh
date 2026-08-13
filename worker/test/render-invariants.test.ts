import { describe, it, expect, beforeAll } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';

// The workspace route now content-negotiates: only real browser navigations
// get the application. A suite asserting the browser page has to identify one.
const BROWSER = { headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } };

type Env = { VNSH_STORE: R2Bucket };

/**
 * Properties of the open-as-rendered decision, as opposed to examples of it.
 *
 * Two suites already test this classifier by example, and both were written
 * after a user reported a real document opening as raw source. Neither caught
 * the next one. The reason is visible in their fixtures: the markdown corpus
 * holds 46 documents whose median length is 45 characters, and the longest is
 * about 90. Every one is a caricature — `# T\n\ntext\n\n- a\n- b`. The bugs that
 * actually shipped needed length and natural English to appear at all, so no
 * corpus of miniatures could ever have contained one, however broad.
 *
 * Both bugs also had the same signature. A veto written to recognise a file
 * format matched a document that merely contained the format's pattern:
 *
 *   #1  a horizontal rule read as YAML front matter
 *   #2  "Concretely:" and "before:", landing at the start of a wrapped line,
 *       read as two lines of a config file
 *
 * Hard-wrapped prose puts some word at the start and the end of every line. Give
 * it enough lines and it will eventually produce any line-anchored pattern by
 * accident — so these vetoes fired *more* readily the longer and more
 * markdown-like a document got, which is backwards. That is a property, and a
 * property can be tested without knowing which pattern collides next. Stated
 * once, it covers the bugs we have had and the ones we have not thought of:
 *
 *   a document that is unambiguously markdown must not stop being markdown
 *   because it got longer
 *
 * Run against the classifier as first fixed, this suite immediately failed 48 of
 * 300 documents and named two further vetoes — the `KEY=value` one and the
 * `line ends in a brace or semicolon` one — with the identical defect. Those are
 * fixed now. The value here is not the three fixes; it is that the next one
 * should show up as a red test rather than as a message from a user.
 */
let classify: (src: string) => 'html' | 'md' | 'text';

beforeAll(async () => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request('http://localhost/w/aBcDeFgHiJkL', BROWSER), env as Env, ctx);
  await waitOnExecutionContext(ctx);
  const page = await res.text();

  // Lifted out of the page the worker actually serves, for the same reason the
  // other two suites do it: a copy here would be a second implementation, free
  // to stay green while the shipped one rots.
  const lift = (from: string, to: string, name: string) => {
    const start = page.indexOf(from);
    const end = page.indexOf(to, start);
    expect(start, `could not find ${from}`).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return new Function(`${page.slice(start, end)};return ${name};`)();
  };
  const looksLikeMarkdown = lift(
    'function looksLikeMarkdown(input)', 'function render(', 'looksLikeMarkdown',
  );
  const looksLikeHtml = lift('function looksLikeHtml(', 'function harden(', 'looksLikeHtml');
  classify = (src) => (looksLikeHtml(src) ? 'html' : looksLikeMarkdown(src) ? 'md' : 'text');
});

/**
 * Deterministic, so that a failure hands back a seed rather than a shrug.
 * Math.random would make the interesting case unreproducible exactly when it
 * matters. xorshift32 is enough for choosing sentences out of a bag.
 */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * Ordinary technical English, of the kind that gets written into a workspace.
 * It contains colons, equals signs, semicolons and braces mid-sentence because
 * real technical writing does — that is precisely the material the vetoes
 * collide with, and sanitising it here would be sanitising the test.
 */
const PROSE = [
  'The first screen after signup is written for engineers, and its most prominent elements are a leak warning and a red danger zone.',
  'Concretely: a non-technical buyer cannot become our customer today, because every call requires a key they cannot create.',
  'We were burned once before: the response was a hard zero, and that setting still holds in production today.',
  'Detection is a race we are structurally losing, and the blocklist behind it is maintained entirely by hand.',
  'Note that the default was FREE_CREDITS_USD = 0, which nobody has revisited since the incident in May.',
  'The old deploy script still exports NODE_ENV = production, and that overrides whatever the file says.',
  'The handler returns early when the pool is exhausted; the caller then retries with backoff and usually succeeds.',
  'Roughly sixteen of the twenty-eight accounts look like real people, arriving from ordinary search engines.',
  'Latency matters more than price at this stage: a first impression is set by time to first token, not by a rate card.',
  'Each of those accounts needs a distinct verified mailbox and a challenge solve, which is where the cost sits.',
  'That sentence only lands if we have been showing the price all along, on every single reply.',
  'The estimate is two to three days including review, since auth and billing already exist.',
  'A residential proxy farm can produce endless mailboxes, but it produces far fewer distinct networks.',
];

/** Greedy wrap. The column varies because authors and editors vary. */
function wrap(text: string, columns: number): string {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && (line + ' ' + word).length > columns) { out.push(line); line = word; }
    else line = line ? line + ' ' + word : word;
  }
  if (line) out.push(line);
  return out.join('\n');
}

/**
 * A document that no reasonable reader would call anything but markdown: a
 * title, and at least three different kinds of block structure. The floor
 * matters. Without it the generator can emit a heading followed by plain
 * paragraphs, which is genuinely ambiguous — the example corpus deliberately
 * classifies a lone heading as source — and the suite would then be asserting
 * something the product does not believe.
 */
function buildReport(seed: number, blocks: number): string {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const out = ['# A report on the thing we measured', ''];

  // The guaranteed floor, so the document is never a borderline case.
  out.push('## Summary', '');
  out.push('- the first point worth making', '- the second point worth making', '');
  out.push('| stage | july | june |', '|---|---|---|', '| registered | 28 | 30 |', '');

  for (let i = 0; i < blocks; i++) {
    switch (Math.floor(r() * 6)) {
      case 0: {
        const n = 2 + Math.floor(r() * 4);
        const para: string[] = [];
        for (let j = 0; j < n; j++) para.push(pick(PROSE));
        out.push(wrap(para.join(' '), 76 + Math.floor(r() * 24)), '');
        break;
      }
      case 1: out.push(`## Section ${i}`, ''); break;
      case 2: out.push(`- ${pick(PROSE).slice(0, 54)}`, '- another point entirely', ''); break;
      case 3: out.push(`> ${pick(PROSE).slice(0, 62)}`, ''); break;
      case 4: out.push('---', ''); break;
      default: out.push(`**${pick(PROSE).slice(0, 44)}**`, ''); break;
    }
  }
  return out.join('\n');
}

const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);
const LENGTHS = [4, 8, 16, 32, 64];
const CORPUS = SEEDS.flatMap((seed) => LENGTHS.map((blocks) => ({
  seed, blocks, doc: buildReport(seed, blocks),
})));

/**
 * The generator is itself under test, and this is the assertion that keeps it
 * honest. Every one of these shapes has already caused a misclassification, and
 * the cheapest way to make the suite below go green is to stop generating them —
 * by trimming a sentence, dropping the rules, narrowing the wrap. That would
 * leave 200 passing tests measuring nothing. If a hazard stops appearing, this
 * fails first and says which one went missing.
 */
describe('the generated corpus still contains the shapes that break things', () => {
  // Each hazard is stated at the number of occurrences that actually caused the
  // bug. #1 and #3 were absolute vetoes, so a single line was enough to trigger
  // them; #2 needed two. Asserting the wrong count would let the shape that
  // matters disappear behind a threshold that a harmless one still clears.
  const HAZARDS: [string, RegExp, number, number][] = [
    ['a horizontal rule, once read as front matter (bug #1)',
      /^(---|\+\+\+)[ \t]*$/gm, 1, 100],
    ['two colon-terminated words at the start of a wrapped line (bug #2)',
      /^[ \t]*[\w.-]+:(?:[ \t]|$)/gm, 2, 20],
    ['a "KEY = value" at the start of a wrapped line (bug #3)',
      /^[ \t]*[\w.-]+[ \t]*=[ \t]*\S/gm, 1, 25],
    ['two of them, which is what the replacement veto now needs',
      /^[ \t]*[\w.-]+[ \t]*=[ \t]*\S/gm, 2, 5],
    ['a line closing on a brace or semicolon (bug #4)',
      /[{};][ \t]*$/gm, 1, 40],
  ];

  it.each(HAZARDS)('contains %s', (_label, pattern, occurrences, floor) => {
    const hit = CORPUS.filter(({ doc }) => (doc.match(pattern) || []).length >= occurrences).length;
    expect(hit).toBeGreaterThanOrEqual(floor);
  });

  it('spans real documents, not miniatures', () => {
    // The failure of the example corpora was length, so state the floor.
    const longest = Math.max(...CORPUS.map(({ doc }) => doc.length));
    expect(longest).toBeGreaterThan(8000);
    expect(CORPUS.filter(({ doc }) => doc.length > 2000).length).toBeGreaterThan(60);
  });
});

describe('length does not turn a markdown document into source', () => {
  it('classifies every generated report as markdown', () => {
    const wrong = CORPUS
      .filter(({ doc }) => classify(doc) !== 'md')
      .map(({ seed, blocks, doc }) => `seed ${seed} / ${blocks} blocks / ${doc.length}b`);
    expect(wrong, `${wrong.length} of ${CORPUS.length} misclassified:\n${wrong.join('\n')}`)
      .toEqual([]);
  });

  it('never flips its answer as one document grows', () => {
    // The sharpest form of the property: hold the seed, add content, and the
    // verdict must not change. Both shipped bugs were exactly this flip.
    for (const seed of SEEDS) {
      const verdicts = LENGTHS.map((blocks) => classify(buildReport(seed, blocks)));
      expect(new Set(verdicts).size, `seed ${seed} flipped: ${verdicts.join(' -> ')}`).toBe(1);
    }
  });

  it('is not rescued by the structure it happens to start with', () => {
    // Growing a document by prose alone is the case with no positive signal
    // arriving to offset the accidental one.
    for (const seed of [3, 11, 29]) {
      const base = buildReport(seed, 6);
      const r = rng(seed);
      let doc = base;
      for (let i = 0; i < 40; i++) {
        doc += '\n' + wrap(PROSE[Math.floor(r() * PROSE.length)], 78) + '\n';
        expect(classify(doc), `seed ${seed} died after ${i} added paragraphs`).toBe('md');
      }
    }
  });
});

/**
 * The converse, which is what stops the fix above from being a way to delete the
 * vetoes. Proportion has to keep rejecting the files the vetoes were written
 * for, at every size — a long config is still a config.
 */
describe('length does not turn a config or source file into markdown', () => {
  const machine: [string, (n: number) => string][] = [
    ['YAML', (n) => '# deploy\n' + Array.from({ length: n },
      (_, i) => `service_${i}:\n  image: nginx:1.2${i}\n  replicas: ${i}`).join('\n')],
    ['dotenv', (n) => '# secrets\n' + Array.from({ length: n },
      (_, i) => `API_KEY_${i}=abc${i}\nDB_URL_${i}=postgres://host/${i}`).join('\n')],
    ['JavaScript', (n) => Array.from({ length: n },
      (_, i) => `function step${i}(x) {\n  const y = x + ${i};\n  return y;\n}`).join('\n\n')],
    ['nginx', (n) => '# server\n' + Array.from({ length: n },
      (_, i) => `server {\n  listen ${8000 + i};\n  server_name a${i}.example.com;\n}`).join('\n')],
    ['a workflow', (n) => '# CI\nname: test\non:\n  push:\n    branches:\n      - main\njobs:\n'
      + Array.from({ length: n }, (_, i) => `  job_${i}:\n    runs-on: ubuntu-latest`).join('\n')],
  ];

  it.each(machine)('shows %s as source at every size', (label, build) => {
    for (const n of [1, 2, 5, 20, 100]) {
      expect(classify(build(n)), `${label} with ${n} entries`).toBe('text');
    }
  });

  it('still shows the reported false-positive shapes as source', () => {
    // Spot checks that the ratio did not quietly become unreachable.
    expect(classify('name: app\nversion: 1.2.3\nports:\n  - 80\nenv:\n  KEY: value')).toBe('text');
    expect(classify('DEBUG=true\nPORT=8080\nDATABASE_URL=postgres://x')).toBe('text');
    expect(classify('#!/bin/bash\nset -e\n# looks like a heading\necho hi')).toBe('text');
    expect(classify('FROM node:20\nRUN npm ci\nCOPY . .\nCMD ["node", "x.js"]')).toBe('text');
  });
});
