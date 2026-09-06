import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateRootSecret,
  deriveWorkspaceKeys,
  decryptWorkspace,
  sealWorkspaceName,
  sanitizeFileName,
  base64urlToBytes,
  NAME_SLOT_BYTES,
} from '../src/lib/workspace';
import { createWorkspace } from '../src/lib/api';

/**
 * The extension is where the name was most visibly lost: the popup already had
 * `file.name` in hand, wrote it into local history, and then uploaded the bytes
 * without it. The recipient got a generated `.txt`.
 */
describe('sealing a name in the extension', () => {
  it('round-trips through the same content key', async () => {
    const { key } = await deriveWorkspaceKeys(generateRootSecret());
    const sealed = (await sealWorkspaceName('crash-log.json', key)) as string;
    const slot = await decryptWorkspace(base64urlToBytes(sealed), key);
    // A fixed-width slot, not the bare name: 2-byte length, then the bytes,
    // then padding. Encryption hides a name's bytes but not how many there are.
    expect(slot).toHaveLength(2 + NAME_SLOT_BYTES);
    const length = (slot[0] << 8) | slot[1];
    expect(new TextDecoder().decode(slot.slice(2, 2 + length))).toBe('crash-log.json');
  });

  it('is the same length whatever the name, so the length leaks nothing', async () => {
    const { key } = await deriveWorkspaceKeys(generateRootSecret());
    const lengths = await Promise.all(
      ['a.c', 'crash-log.json', 'severance-agreement.pdf'].map(
        async (name) => ((await sealWorkspaceName(name, key)) as string).length,
      ),
    );
    expect(new Set(lengths).size).toBe(1);
  });

  it('produces a value the worker will accept as a header', async () => {
    const { key } = await deriveWorkspaceKeys(generateRootSecret());
    expect(await sealWorkspaceName('screenshot.png', key)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('leaves a public workspace name readable, matching its body', async () => {
    const sealed = (await sealWorkspaceName('changelog.md', null)) as string;
    expect(new TextDecoder().decode(base64urlToBytes(sealed))).toBe('changelog.md');
  });

  it('yields null when there is nothing worth sending', async () => {
    const { key } = await deriveWorkspaceKeys(generateRootSecret());
    expect(await sealWorkspaceName('', key)).toBeNull();
    expect(await sealWorkspaceName('..', key)).toBeNull();
  });

  it.each([
    ['../../etc/passwd', 'passwd'],
    ['C:\\temp\\notes.md', 'notes.md'],
    // U+202E reverses what follows, so a .exe can be shown as a .pdf.
    ['invoice\u202Efdp.exe', 'invoicefdp.exe'],
    // `:` addresses an NTFS alternate data stream.
    ['notes.txt:payload.exe', 'notes.txtpayload.exe'],
    // Windows strips these, so keeping them gives one file two names.
    ['report.txt.', 'report.txt'],
    ['CON.png', '_CON.png'],
  ])('reduces %p to %p before it reaches a download attribute', (raw, expected) => {
    expect(sanitizeFileName(raw)).toBe(expected);
  });
});

describe('createWorkspace sends the name it was given', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'aBcDeFgHiJkL', expires: '2026-01-01T00:00:00.000Z' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function headersOf(): Record<string, string> {
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    return init.headers as Record<string, string>;
  }

  it('attaches a sealed name when one is supplied', async () => {
    await createWorkspace(new TextEncoder().encode('body'), { name: 'analysis.py' });
    const name = headersOf()['X-Vnsh-Name'];
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
    // Sealed, not merely encoded: the server must not be able to read it.
    expect(new TextDecoder().decode(base64urlToBytes(name))).not.toContain('analysis');
  });

  it('sends no header at all when there is no name', async () => {
    await createWorkspace(new TextEncoder().encode('body'), {});
    expect(headersOf()['X-Vnsh-Name']).toBeUndefined();
  });

  it('sends a public name in the clear, because there is no key to seal it with', async () => {
    await createWorkspace(new TextEncoder().encode('body'), {
      public: true,
      name: 'release-notes.md',
    });
    const name = headersOf()['X-Vnsh-Name'];
    expect(new TextDecoder().decode(base64urlToBytes(name))).toBe('release-notes.md');
  });
});

describe('the share paths hand over the name they already had', () => {
  // Reading the source rather than driving the service worker: these call sites
  // had the name in a local variable and dropped it, and a property assertion
  // is what stops that from happening again as new entry points are added.
  const source = readSource();

  it('passes the dropped file name through to the upload', () => {
    const share = section(source, 'async function handleShareBinary');
    expect(share).toContain('name: filename');
  });

  it('names the debug bundle for what it is, since JSON has no magic bytes', () => {
    const bundle = section(source, 'async function handleDebugBundle');
    expect(bundle).toContain(".json'");
  });
});

function readSource(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  return fs.readFileSync(
    path.join(__dirname, '..', 'src', 'background', 'service-worker.ts'),
    'utf-8',
  );
}

/** The body of one function, so an assertion cannot match a neighbour's code. */
function section(source: string, header: string): string {
  const start = source.indexOf(header);
  expect(start).toBeGreaterThan(-1);
  const next = source.indexOf('\nasync function ', start + header.length);
  return source.slice(start, next === -1 ? source.length : next);
}
