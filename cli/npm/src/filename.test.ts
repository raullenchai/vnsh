import { describe, it, expect } from 'vitest';
import {
  generateRootSecret,
  deriveWorkspaceKeys,
  sealWorkspaceName,
  openWorkspaceName,
  sanitizeFileName,
} from './crypto.js';

/**
 * A file name is content, and gets the guarantee content gets.
 *
 * The service stores this string in R2 custom metadata and hands it back
 * untouched. Everything that makes it safe to put a name there happens on this
 * side of the wire, so this is where it has to be pinned down.
 */
describe('sealing a name', () => {
  const key = deriveWorkspaceKeys(generateRootSecret()).key;

  it('round-trips through the same key', () => {
    const sealed = sealWorkspaceName('analysis.py', key);
    expect(sealed).not.toBeNull();
    expect(openWorkspaceName(sealed, key)).toBe('analysis.py');
  });

  it('produces something the wire and R2 both accept', () => {
    // Base64url only: the value becomes an HTTP header, and the worker rejects
    // anything outside that alphabet rather than risk a header it cannot build.
    expect(sealWorkspaceName('report.csv', key)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('reveals nothing about the name to anyone without the key', () => {
    const sealed = sealWorkspaceName('Q3-layoff-list.xlsx', key) as string;
    const decoded = Buffer.from(sealed.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    expect(decoded.toString('latin1')).not.toContain('layoff');
    expect(decoded.toString('latin1')).not.toContain('xlsx');
  });

  it('encrypts under a fresh nonce, so the same name never looks the same twice', () => {
    // Two documents called `notes.md` must not be linkable by their metadata.
    expect(sealWorkspaceName('notes.md', key)).not.toBe(sealWorkspaceName('notes.md', key));
  });

  it('is the same length whatever the name, so the length leaks nothing', () => {
    // AES-GCM hides the bytes of a name but not how many there are. Unpadded,
    // the header length alone separates `ok.txt` from
    // `acquisition-targets.xlsx` and rules candidate names in or out — for a
    // service whose claim is that it cannot read the name at all.
    const lengths = ['a.c', 'ok.txt', 'acquisition-targets.xlsx', 'x'.repeat(150)].map(
      (name) => (sealWorkspaceName(name, key) as string).length,
    );
    expect(new Set(lengths).size).toBe(1);
  });

  it('stays inside the header limit the server enforces', () => {
    const longest = sealWorkspaceName('x'.repeat(400), key) as string;
    expect(longest.length).toBeLessThanOrEqual(512);
  });

  it('stores a public workspace name in the clear, matching its body', () => {
    // Sealing here would be theatre: a public workspace has no key, and nobody
    // could ever open it.
    const sealed = sealWorkspaceName('release-notes.md', null) as string;
    expect(openWorkspaceName(sealed, null)).toBe('release-notes.md');
  });

  it('keeps non-ASCII names intact', () => {
    const sealed = sealWorkspaceName('季度报告.pdf', key);
    expect(openWorkspaceName(sealed, key)).toBe('季度报告.pdf');
  });
});

describe('opening a name refuses anything it cannot vouch for', () => {
  const key = deriveWorkspaceKeys(generateRootSecret()).key;
  const other = deriveWorkspaceKeys(generateRootSecret()).key;

  it('returns null for the wrong key rather than guessing', () => {
    expect(openWorkspaceName(sealWorkspaceName('secret.txt', key), other)).toBeNull();
  });

  it('returns null when the sealed value was tampered with', () => {
    const sealed = sealWorkspaceName('invoice.pdf', key) as string;
    // Character 5 lands inside the nonce, so the GCM tag stops verifying.
    const tampered = sealed.slice(0, 5) + (sealed[5] === 'A' ? 'B' : 'A') + sealed.slice(6);
    expect(tampered).not.toBe(sealed);
    expect(openWorkspaceName(tampered, key)).toBeNull();
  });

  it.each([null, '', 'not base64url', 'a'.repeat(513), 'A/B', 'cGFk=='])(
    'returns null for %p',
    (input) => {
      expect(openWorkspaceName(input as string | null, key)).toBeNull();
    },
  );

  it('returns null rather than throwing on a value too short to be sealed', () => {
    expect(openWorkspaceName('AAAA', key)).toBeNull();
  });
});

describe('a name is a name, never a path', () => {
  // The CLI joins this onto a temp directory and the browser puts it in a
  // download attribute. Either way, a separator in it would choose the
  // destination instead of describing the file.
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['/absolute/path/notes.md', 'notes.md'],
    ['C:\\Users\\rc\\secret.docx', 'secret.docx'],
    ['  spaced.txt  ', 'spaced.txt'],
  ])('reduces %p to %p', (raw, expected) => {
    expect(sanitizeFileName(raw)).toBe(expected);
  });

  it.each(['', '.', '..', '/', '   ', '\u0000\u0001'])('rejects %p outright', (raw) => {
    expect(sanitizeFileName(raw)).toBeNull();
  });

  it('strips control characters that would break a header or a shell', () => {
    expect(sanitizeFileName('note\u0000\u001b[31m.txt')).toBe('note[31m.txt');
  });

  it('caps the length in bytes, matching what the wire format can carry', () => {
    expect(sanitizeFileName('x'.repeat(400))).toHaveLength(200);
  });

  it('counts bytes, not code units, so a CJK name is not silently dropped', () => {
    // 200 CJK characters are 600 UTF-8 bytes. Capping on code units here would
    // produce a value the server rejects for length, and the reader would get a
    // generated name despite the client accepting theirs.
    const long = sanitizeFileName('季'.repeat(200)) as string;
    expect(Buffer.byteLength(long, 'utf-8')).toBeLessThanOrEqual(200);
    // And it must not cut a character in half on the way.
    expect(long).toBe('季'.repeat(66));
  });

  it('strips bidirectional overrides that disguise an extension', () => {
    // U+202E reverses everything after it, so this renders as "invoicefdp.exe"
    // read left to right but shows the .exe last — the whole point of using one
    // in a file name is that the reader sees a PDF and opens a program.
    expect(sanitizeFileName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(sanitizeFileName('a\u200Bb\uFEFF.txt')).toBe('ab.txt');
  });

  it('removes the NTFS alternate data stream separator', () => {
    expect(sanitizeFileName('notes.txt:payload.exe')).toBe('notes.txtpayload.exe');
  });

  it('drops trailing dots and spaces, which Windows would strip anyway', () => {
    expect(sanitizeFileName('report.txt.')).toBe('report.txt');
    expect(sanitizeFileName('report.txt   ')).toBe('report.txt');
    expect(sanitizeFileName('...')).toBeNull();
  });

  it.each(['CON', 'con.png', 'NUL.txt', 'com1', 'LPT9.log'])(
    'defuses the Windows device name %p',
    (raw) => {
      expect(sanitizeFileName(raw)).toBe(`_${raw}`);
    },
  );

  it('survives the round trip after sanitising, not before', () => {
    const key = deriveWorkspaceKeys(generateRootSecret()).key;
    expect(openWorkspaceName(sealWorkspaceName('../../../evil.sh', key), key)).toBe('evil.sh');
  });
});
