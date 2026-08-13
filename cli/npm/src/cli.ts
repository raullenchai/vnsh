#!/usr/bin/env node
/**
 * vnsh CLI - The Ephemeral Dropbox for AI
 *
 * Encrypt and share content via host-blind data tunnel.
 */

import { program } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  encrypt,
  decrypt,
  generateKey,
  generateIV,
  bufferToHex,
  parseVnshUrl,
  buildVnshUrl,
  generateRootSecret,
  deriveWorkspaceKeys,
  encryptWorkspace,
  decryptWorkspace,
  buildWorkspaceUrl,
  buildReadOnlyWorkspaceUrl,
  parseWorkspaceUrl,
  isWorkspaceUrl,
} from './crypto.js';
import { clearToken, deviceLogin, loadToken, openBrowser, saveToken } from './auth.js';

// Read from the manifest npm publishes rather than a constant maintained by
// hand. The constant had drifted twice — it said 2.3.1 while 2.3.3 was on the
// registry, so `vn --version` lied to users and the analytics header reported a
// release that had not existed for two versions.
const VERSION: string = (() => {
  try {
    return String(require('../package.json').version || '0.0.0');
  } catch {
    return '0.0.0';
  }
})();
const DEFAULT_HOST = process.env.VNSH_HOST || 'https://vnsh.dev';
const MAX_SIZE = 25 * 1024 * 1024; // 25MB

function accountOrigin(host: string): string {
  return new URL(host).hostname === 'vnsh.dev' ? 'https://account.vnsh.dev' : host;
}

// Colors for terminal output
const colors = {
  red: (s: string) => process.stderr.isTTY ? `\x1b[31m${s}\x1b[0m` : s,
  green: (s: string) => process.stderr.isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  yellow: (s: string) => process.stderr.isTTY ? `\x1b[33m${s}\x1b[0m` : s,
  cyan: (s: string) => process.stderr.isTTY ? `\x1b[36m${s}\x1b[0m` : s,
};

function info(msg: string): void {
  console.error(`${colors.cyan('→')} ${msg}`);
}

function error(msg: string): never {
  console.error(`${colors.red('error:')} ${msg}`);
  process.exit(1);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

interface UploadOptions {
  ttl?: string;
  host?: string;
  local?: boolean;
  blob?: boolean;
  public?: boolean;
  artifact?: boolean;
}

interface WorkspaceResponse {
  id: string;
  version: number;
  expires?: string;
  permanent?: boolean;
  public?: boolean;
  /** Present for public workspaces: the full link, on whichever domain this
   *  instance publishes from. Absent on older servers, hence the fallback. */
  url?: string;
}

/** Read a file, or stdin when no path is given. Enforces the size ceiling. */
async function readInput(input: string | undefined, label: string): Promise<Buffer> {
  if (input) {
    if (!fs.existsSync(input)) {
      error(`File not found: ${input}`);
    }
    const stats = fs.statSync(input);
    if (stats.size > MAX_SIZE) {
      error(`File too large: ${formatBytes(stats.size)} (max: ${formatBytes(MAX_SIZE)})`);
    }
    info(`${label} ${input} (${formatBytes(stats.size)})...`);
    return fs.readFileSync(input);
  }

  if (process.stdin.isTTY) {
    error('No input provided. Use: echo "text" | vn or vn <file>');
  }
  info(`${label} stdin...`);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const data = Buffer.concat(chunks);
  if (data.length > MAX_SIZE) {
    error(`Input too large: ${formatBytes(data.length)} (max: ${formatBytes(MAX_SIZE)})`);
  }
  return data;
}

/**
 * Create a workspace — the default for `vn`, matching the website.
 *
 * A one-shot drop is just a workspace nobody writes to again, so there is no
 * reason to make the caller choose up front. What actually differs is which of
 * the two links you hand out, and that decision comes after you have both.
 */
/**
 * `?ttl=` for a create or renew, validated here rather than at the server.
 *
 * The server clamps an out-of-range value to the default instead of failing,
 * because published clients have been sending this parameter for two major
 * versions and a 400 would turn a preference into a failed share. That is the
 * right call for the API and the wrong one for a person at a terminal: someone
 * who typed `-t 720` wants to be told a week is the cap, not handed 24 hours.
 */
function ttlQuery(raw: string | undefined): string {
  if (!raw) return '';
  if (!/^\d+$/.test(raw)) {
    error('TTL must be a whole number of hours between 1 and 168');
  }
  const ttl = Number(raw);
  if (ttl < 1 || ttl > 168) {
    error('TTL must be between 1 and 168 hours (168 = 7 days)');
  }
  return `?ttl=${ttl}`;
}

/** "in 7 days" / "in 26 hours", for a timestamp nobody wants to subtract by hand. */
function humanExpiry(iso: string): string {
  const hours = (new Date(iso).getTime() - Date.now()) / 3600000;
  if (!isFinite(hours) || hours <= 0) return '';
  if (hours >= 47) return `in ${Math.round(hours / 24)} days`;
  const rounded = Math.max(1, Math.round(hours));
  return `in ${rounded} ${rounded === 1 ? 'hour' : 'hours'}`;
}

async function createWorkspace(input: string | undefined, options: UploadOptions): Promise<void> {
  const host = options.host || DEFAULT_HOST;
  // Validate before reading input or claiming work has started.
  const ttl = ttlQuery(options.ttl);
  const data = await readInput(input, options.public ? 'Reading for public upload' : 'Encrypting');

  const secret = generateRootSecret();
  const keys = deriveWorkspaceKeys(secret);

  // A public workspace is stored as plaintext so anything that speaks HTTP can
  // read it with no key and no runtime — which is the only way an agent's fetch
  // gets the same experience a human's browser does. The trade is stated at the
  // point of choosing it, not buried: vnsh can read this one.
  const payload = options.public ? data : encryptWorkspace(data, keys.key);
  if (options.public) {
    info(colors.yellow('Public: stored unencrypted so any agent can read it without a key.'));
  }

  if (options.local) {
    console.log(`\n${colors.green('Encrypted workspace payload (base64):')}`);
    console.log(payload.toString('base64'));
    console.log(`\n${colors.green('Root secret:')} ${bufferToHex(secret)}`);
    return;
  }

  info(`Uploading workspace (${formatBytes(payload.length)})...`);
  const accountToken = loadToken(host);
  const response = await fetch(`${host}/api/workspace${ttl}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Vnsh-Client': `cli-npm/${VERSION}`,
      ...(accountToken ? { Authorization: `Bearer ${accountToken}` } : {}),
      'X-Vnsh-Write-Hash': keys.writeHash,
      ...(options.public ? { 'X-Vnsh-Public': '1' } : {}),
      ...(options.artifact ? { 'X-Vnsh-Kind': 'artifact' } : {}),
    },
    body: payload,
  });

  if (!response.ok) {
    error(`Create failed (HTTP ${response.status}): ${await response.text()}`);
  }
  const result = (await response.json()) as WorkspaceResponse;

  console.log('');
  console.log(colors.green('✓ Workspace created'));
  console.log('');
  if (options.public) {
    // No key in the link, because there is no key. That is the honest shape for
    // "anyone can read this", and it is why the read link carries no fragment.
    // The host comes from the server: public documents are served from their own
    // domain, and a client that guessed it would print a link that 404s.
    console.log(result.url || `${host}/p/${result.id}`);
    console.log(`${colors.yellow('  public')}     any agent or person can read it, no key needed`);
    console.log('');
    console.log(buildWorkspaceUrl(host, result.id, secret).replace('/w/', options.artifact ? '/artifact/' : '/w/'));
    console.log(`${colors.yellow('  edit')}       keep this one; it is what lets you change it`);
    console.log('');
  } else {
    console.log(buildWorkspaceUrl(host, result.id, secret).replace('/w/', options.artifact ? '/artifact/' : '/w/'));
    console.log(`${colors.yellow('  edit')}       anyone with this link can change it`);
    console.log('');
    console.log(buildReadOnlyWorkspaceUrl(host, result.id, secret).replace('/w/', options.artifact ? '/artifact/' : '/w/'));
    console.log(`${colors.yellow('  view-only')}  they can read it, never write it`);
    console.log('');
  }
  if (result.expires) {
    // Printed as a duration first, because "2026-08-03T04:27:32.472Z" does not
    // tell anyone whether their colleague can still open this on Monday, and
    // that question is the whole reason the expiry is on screen.
    const human = humanExpiry(result.expires);
    console.log(`${colors.yellow('Expires:')} ${human} — ${result.expires}`);
    if (!options.ttl) {
      console.log(`         ${colors.cyan('-t 168 for a week, or vn renew <edit-url> to extend it later')}`);
    }
  }
  if (result.permanent) console.log(`${colors.yellow('Retention:')} permanent — delete it from your account`);
  console.log(`${colors.yellow('Update:')}  vn write <edit-url> [file]`);
}

/**
 * Push a workspace's expiry out without rewriting it.
 *
 * The version is deliberately not bumped by the server, so an agent that read
 * version 7 can still write version 8 after someone renewed underneath it.
 */
async function renewWorkspace(url: string, options: UploadOptions): Promise<void> {
  const link = parseWorkspaceUrl(url);
  if (!link.canWrite) {
    error('That is a view-only link (#r=). Renewing needs the edit link (#w=).');
  }
  const host = options.host || link.host;

  const response = await fetch(`${host}/api/workspace/${link.id}/renew${ttlQuery(options.ttl)}`, {
    method: 'POST',
    headers: {
      'X-Vnsh-Client': `cli-npm/${VERSION}`,
      'X-Vnsh-Write': link.writeToken as string,
    },
  });

  if (!response.ok) {
    error(`Renew failed (HTTP ${response.status}): ${await response.text()}`);
  }
  const result = (await response.json()) as WorkspaceResponse;

  console.log('');
  console.log(colors.green('✓ Renewed'));
  if (result.expires) {
    console.log(`${colors.yellow('Expires:')} ${humanExpiry(result.expires)} — ${result.expires}`);
  }
}

/**
 * Replace the contents of an existing workspace.
 *
 * Writes are conditional on the version that was just read, so two agents
 * editing at once cannot silently clobber each other — the loser is told.
 */
async function writeWorkspace(url: string, input: string | undefined, options: UploadOptions): Promise<void> {
  const link = parseWorkspaceUrl(url);
  const artifact = new URL(url.split('#')[0]).pathname.startsWith('/artifact/');
  if (!link.canWrite) {
    error('That is a view-only link (#r=). Writing needs the edit link (#w=).');
  }
  const host = options.host || link.host;
  const data = await readInput(input, 'Encrypting');

  info(`Reading current version of ${link.id}...`);
  const current = await fetch(`${host}/api/workspace/${link.id}`, {
    headers: { 'X-Vnsh-Client': `cli-npm/${VERSION}` },
  });
  // Visibility is fixed at creation, so the write has to match how this
  // workspace is stored rather than how the caller feels about it today.
  const isPublic = current.headers.get('X-Vnsh-Public') === '1';
  if (current.status === 404) {
    error('Workspace not found. It may have expired.');
  }
  if (!current.ok) {
    error(`Failed to read workspace (HTTP ${current.status})`);
  }
  await current.arrayBuffer();
  const version = (current.headers.get('ETag') || '').replace(/"/g, '');

  const response = await fetch(`${host}/api/workspace/${link.id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Vnsh-Client': `cli-npm/${VERSION}`,
      'X-Vnsh-Write': link.writeToken as string,
      'If-Match': version,
    },
    body: isPublic ? data : encryptWorkspace(data, link.key),
  });

  if (response.status === 412) {
    error(
      'Someone else wrote to this workspace since you read it (version ' +
        version +
        ' is stale). Re-read it, merge, and write again.',
    );
  }
  if (response.status === 403) {
    error('That write token was rejected. Check you are using the edit link.');
  }
  if (!response.ok) {
    error(`Write failed (HTTP ${response.status}): ${await response.text()}`);
  }

  const result = (await response.json()) as WorkspaceResponse;
  console.log('');
  console.log(colors.green(`✓ Workspace updated to v${result.version}`));
  console.log(
    isPublic
      ? result.url || `${host}/p/${link.id}`
      : buildWorkspaceUrl(host, link.id, link.secret as Buffer).replace('/w/', artifact ? '/artifact/' : '/w/'),
  );
}

/** True for a public workspace link: /p/{id}, and never carrying a key. */
function isPublicUrl(url: string): boolean {
  try {
    return /^\/p\/[0-9A-Za-z]{12}$/.test(new URL(url.split('#')[0]).pathname);
  } catch {
    return false;
  }
}

/** Fetch a public workspace. No key, no crypto — it is an ordinary document. */
async function readPublic(url: string): Promise<void> {
  const target = new URL(url.split('#')[0]);
  info(`Fetching public workspace from ${target.origin}...`);
  const response = await fetch(target.toString(), {
    headers: { 'X-Vnsh-Client': `cli-npm/${VERSION}` },
  });
  if (response.status === 404 || response.status === 410) {
    error('Not found. It may have expired, or it may be an encrypted /w/ link.');
  }
  if (!response.ok) {
    error(`Failed to fetch (HTTP ${response.status})`);
  }
  process.stdout.write(Buffer.from(await response.arrayBuffer()));
}

/** Fetch and decrypt a workspace, writing the plaintext to stdout. */
async function readWorkspace(url: string): Promise<void> {
  const link = parseWorkspaceUrl(url);
  info(`Fetching workspace ${link.id} from ${link.host}...`);

  const response = await fetch(`${link.host}/api/workspace/${link.id}`, {
    headers: { 'X-Vnsh-Client': `cli-npm/${VERSION}` },
  });
  if (response.status === 404) {
    error('Workspace not found. It may have expired or been deleted.');
  }
  if (!response.ok) {
    error(`Failed to fetch workspace (HTTP ${response.status})`);
  }

  const payload = Buffer.from(await response.arrayBuffer());

/**
 * Binary going to a terminal reads as a failure, whatever the exit code.
 *
 * `vn read` on a workspace holding a screenshot was byte-perfect when redirected
 * to a file, and 53KB of mojibake when it was not. An agent ran it, saw the
 * mojibake, and reported that the CLI "does not accept /w/ workspaces" — a wrong
 * conclusion from a fair observation, and it then advised its user to switch
 * formats to work around a bug that did not exist.
 *
 * Piped or redirected output is unchanged: exactly the bytes, so `vn read ... >
 * shot.jpg` and every existing script keep working.
 */
function writeOut(bytes: Buffer, label: string): void {
  const kind = detectFileType(bytes);
  if (!process.stdout.isTTY || !(kind || looksBinary(bytes))) {
    process.stdout.write(bytes);
    return;
  }
  const ext = kind ? kind.ext : 'bin';
  const file = path.join(os.tmpdir(), `vnsh-${label}.${ext}`);
  fs.writeFileSync(file, bytes);
  info(`${kind ? kind.mime : 'Binary content'} (${formatBytes(bytes.length)}) — not printed to a terminal.`);
  info(`Saved unmodified to: ${file}`);
}

/** First-bytes identification, matching the MCP server and the web viewer. */
function detectFileType(b: Buffer): { ext: string; mime: string } | null {
  if (b.length < 4) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: 'png', mime: 'image/png' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { ext: 'gif', mime: 'image/gif' };
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b.length >= 12 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { ext: 'webp', mime: 'image/webp' };
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return { ext: 'pdf', mime: 'application/pdf' };
  return null;
}

function looksBinary(b: Buffer): boolean {
  const n = Math.min(b.length, 1024);
  let odd = 0;
  for (let i = 0; i < n; i++) {
    if (b[i] === 0) return true;
    if (b[i] < 32 && b[i] !== 9 && b[i] !== 10 && b[i] !== 13) odd++;
  }
  return n > 0 && odd / n > 0.1;
}

  // A public workspace has an edit link too, and it is a /w/ link — so this
  // path has to expect plaintext, or holding your own edit link looks like
  // corruption.
  if (response.headers.get('X-Vnsh-Public') === '1') {
    info(`Public workspace v${(response.headers.get('ETag') || '?').replace(/"/g, '')} — no decryption needed`);
    writeOut(payload, `${link.id}-public`);
    return;
  }

  info(`Decrypting workspace v${(response.headers.get('ETag') || '?').replace(/"/g, '')} (${formatBytes(payload.length)})...`);
  try {
    writeOut(decryptWorkspace(payload, link.key), link.id);
  } catch {
    error('Decryption failed. The link may be truncated or the key incorrect.');
  }
}

interface UploadResponse {
  id: string;
  expires: string;
}

/**
 * Upload content (file or stdin)
 */
async function upload(input: string | undefined, options: UploadOptions): Promise<void> {
  const host = options.host || DEFAULT_HOST;
  let data: Buffer;

  if (input) {
    // File mode
    if (!fs.existsSync(input)) {
      error(`File not found: ${input}`);
    }
    const stats = fs.statSync(input);
    if (stats.size > MAX_SIZE) {
      error(`File too large: ${formatBytes(stats.size)} (max: ${formatBytes(MAX_SIZE)})`);
    }
    info(`Encrypting ${input} (${formatBytes(stats.size)})...`);
    data = fs.readFileSync(input);
  } else {
    // Stdin mode
    if (process.stdin.isTTY) {
      error('No input provided. Use: echo "text" | vn or vn <file>');
    }
    info('Encrypting stdin...');
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    data = Buffer.concat(chunks);

    if (data.length > MAX_SIZE) {
      error(`Input too large: ${formatBytes(data.length)} (max: ${formatBytes(MAX_SIZE)})`);
    }
  }

  // Generate key and IV
  const key = generateKey();
  const iv = generateIV();

  // Encrypt
  const encrypted = encrypt(data, key, iv);

  // Local mode - output encrypted blob
  if (options.local) {
    console.log(`\n${colors.green('Encrypted blob (base64):')}`);
    console.log(encrypted.toString('base64'));
    console.log(`\n${colors.green('Decryption key:')} ${bufferToHex(key)}`);
    console.log(`${colors.green('IV:')} ${bufferToHex(iv)}`);
    return;
  }

  // Build API URL
  let apiUrl = `${host}/api/drop`;
  const params = new URLSearchParams();
  if (options.ttl) {
    const ttl = parseInt(options.ttl, 10);
    if (isNaN(ttl) || ttl < 1 || ttl > 168) {
      error('TTL must be between 1 and 168 hours');
    }
    params.set('ttl', options.ttl);
  }
  if (params.toString()) {
    apiUrl += `?${params.toString()}`;
  }

  info(`Uploading encrypted blob (${formatBytes(encrypted.length)})...`);

  // Upload
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Vnsh-Client': `cli-npm/${VERSION}`,
    },
    body: encrypted,
  });

  if (!response.ok) {
    const text = await response.text();
    error(`Upload failed (HTTP ${response.status}): ${text}`);
  }

  const result = await response.json() as UploadResponse;

  // Build final URL
  const finalUrl = buildVnshUrl(host, result.id, key, iv);

  console.log('');
  console.log(colors.green('✓ Uploaded successfully'));
  console.log('');
  console.log(finalUrl);
  console.log('');
  if (result.expires) {
    console.log(`${colors.yellow('Expires:')} ${result.expires}`);
  }
}

/**
 * Read and decrypt a vnsh URL
 */
async function read(url: string): Promise<void> {
  // Both link generations stay readable forever: /w/ is a workspace, /v/ is a
  // v1 one-shot blob. Every link already in the wild keeps working.
  if (isPublicUrl(url)) {
    return readPublic(url);
  }
  if (isWorkspaceUrl(url)) {
    return readWorkspace(url);
  }

  const { host, id, key, iv } = parseVnshUrl(url);

  info(`Fetching blob ${id} from ${host}...`);

  const response = await fetch(`${host}/api/blob/${id}`);

  if (response.status === 402) {
    error('Payment required. This blob requires payment to access.');
  }
  if (response.status === 404) {
    error('Blob not found. It may have expired or been deleted.');
  }
  if (response.status === 410) {
    error('Blob has expired and is no longer available.');
  }
  if (!response.ok) {
    error(`Failed to fetch blob (HTTP ${response.status})`);
  }

  const encrypted = Buffer.from(await response.arrayBuffer());
  info(`Decrypting blob (${formatBytes(encrypted.length)})...`);

  try {
    const decrypted = decrypt(encrypted, key, iv);
    process.stdout.write(decrypted);
  } catch (e) {
    error('Decryption failed. The key or IV may be incorrect.');
  }
}

// Setup CLI
program
  .name('vn')
  .description(
    'vnsh - one workspace all your AI agents can read and write\n\n' +
      'Encrypts locally and returns two links: one that can edit, one that can only read.',
  )
  .version(VERSION, '-v, --version')
  .argument('[file]', 'File to encrypt and share (default: stdin)')
  .option('-t, --ttl <hours>', 'How long it lives, in hours (default: 24, max: 168)')
  .option('-H, --host <url>', 'Override API host', DEFAULT_HOST)
  .option('-l, --local', 'Encrypt locally and print the payload (no upload)')
  .option('-b, --blob', 'Create a v1 one-shot blob instead of a workspace')
  .option('--public', 'Store unencrypted so any agent can read it with no key (vnsh can read it too)')
  .option('--artifact', 'Create a rendered artifact URL (signed-in accounts keep it permanently)')
  .action(async (file: string | undefined, options: UploadOptions) => {
    try {
      // `-t` used to force the v1 blob path, because workspaces were fixed at
      // 24h and silently ignoring the flag would have been worse. Workspaces now
      // take the same parameter with the same cap, so the flag no longer decides
      // which kind of thing gets created — which matters, since routing a
      // request for a longer life into a one-shot blob quietly took away the
      // editing that made it a workspace.
      if (options.public && options.blob) {
        error('--public applies to workspaces; it cannot be combined with --blob.');
      }
      if (options.blob) {
        await upload(file, options);
      } else {
        await createWorkspace(file, options);
      }
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    }
  });

program
  .command('login')
  .description('Sign in through your browser so new documents are kept permanently')
  .option('-H, --host <url>', 'Override API host')
  .action(async (options: UploadOptions) => {
    try {
      const host = options.host || program.opts().host || DEFAULT_HOST;
      if (loadToken(host)) info('Replacing the account already saved for this host...');
      const token = await deviceLogin(host, (device) => {
        console.log(`Your one-time code: ${colors.yellow(device.user_code)}`);
        console.log(`Open: ${device.verification_uri}`);
        if (openBrowser(device.verification_uri)) info('Opened your browser. Approve the CLI there...');
        else info('Open the URL above in a browser to continue...');
      });
      saveToken(host, token);
      const response = await fetch(`${accountOrigin(host)}/api/account/me`, {
        headers: { Authorization: `Bearer ${token}`, 'X-Vnsh-Client': `cli-npm/${VERSION}` },
      });
      const data = response.ok ? await response.json() as { user?: { email?: string } } : {};
      console.log(colors.green(`✓ Signed in${data.user?.email ? ` as ${data.user.email}` : ''}`));
      console.log('New workspaces and artifacts will be kept until you delete them.');
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    }
  });

program
  .command('whoami')
  .description('Show the vnsh account used by this CLI')
  .option('-H, --host <url>', 'Override API host')
  .action(async (options: UploadOptions) => {
    try {
      const host = options.host || program.opts().host || DEFAULT_HOST;
      const token = loadToken(host);
      if (!token) error('Not signed in. Run `vn login`.');
      const response = await fetch(`${accountOrigin(host)}/api/account/me`, {
        headers: { Authorization: `Bearer ${token}`, 'X-Vnsh-Client': `cli-npm/${VERSION}` },
      });
      if (response.status === 401) error('Your login expired. Run `vn login` again.');
      if (!response.ok) error(`Could not read account (HTTP ${response.status})`);
      const data = await response.json() as { user: { email: string; tier: string } };
      console.log(data.user.email);
      console.log(`tier: ${data.user.tier}`);
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    }
  });

program
  .command('logout')
  .description('Revoke and remove the account token saved on this device')
  .option('-H, --host <url>', 'Override API host')
  .action(async (options: UploadOptions) => {
    try {
      if (process.env.VNSH_TOKEN) error('VNSH_TOKEN is set in the environment; unset it to log out this shell.');
      const host = options.host || program.opts().host || DEFAULT_HOST;
      const token = loadToken(host);
      if (!token) {
        console.log('Not signed in.');
        return;
      }
      let revoked: Response;
      try {
        revoked = await fetch(`${accountOrigin(host)}/api/account/token/current`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}`, 'X-Vnsh-Client': `cli-npm/${VERSION}` },
        });
      } catch {
        error('Could not reach vnsh to revoke this token. Your saved login was kept so you can retry.');
      }
      if (!revoked.ok && revoked.status !== 401) error(`Could not revoke login (HTTP ${revoked.status}). Try again.`);
      clearToken();
      console.log(colors.green('✓ Signed out'));
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    }
  });

program
  .command('read <url>')
  .description('Decrypt and print a vnsh URL (workspace or one-shot blob)')
  .action(async (url: string) => {
    try {
      await read(url);
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    }
  });

program
  .command('renew <url>')
  .description('Keep a workspace alive longer without changing it (needs the edit link)')
  .option('-t, --ttl <hours>', 'New lifetime in hours, from now (max: 168)')
  .option('-H, --host <url>', 'Override API host')
  .action(async (url: string, options: UploadOptions) => {
    try {
      // `--ttl` and `--host` also exist on the root command. Commander accepts
      // them around the subcommand but may store them on the parent, so merge
      // both scopes instead of silently dropping a valid option.
      await renewWorkspace(url, { ...program.opts(), ...options });
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    }
  });

program
  .command('write <url> [file]')
  .description('Replace the contents of a workspace (needs the edit link)')
  .option('-H, --host <url>', 'Override API host')
  .action(async (url: string, file: string | undefined, options: UploadOptions) => {
    try {
      await writeWorkspace(url, file, { ...program.opts(), ...options });
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    }
  });

program.parse();
