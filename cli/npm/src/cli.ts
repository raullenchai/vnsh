#!/usr/bin/env node
/**
 * vnsh CLI - The Ephemeral Dropbox for AI
 *
 * Encrypt and share content via host-blind data tunnel.
 */

import { program } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
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

const VERSION = '2.3.1';
const DEFAULT_HOST = process.env.VNSH_HOST || 'https://vnsh.dev';
const MAX_SIZE = 25 * 1024 * 1024; // 25MB

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
  price?: string;
  host?: string;
  local?: boolean;
  blob?: boolean;
  public?: boolean;
}

interface WorkspaceResponse {
  id: string;
  version: number;
  expires: string;
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
async function createWorkspace(input: string | undefined, options: UploadOptions): Promise<void> {
  const host = options.host || DEFAULT_HOST;
  const data = await readInput(input, 'Encrypting');

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
  const response = await fetch(`${host}/api/workspace`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Vnsh-Client': `cli-npm/${VERSION}`,
      'X-Vnsh-Write-Hash': keys.writeHash,
      ...(options.public ? { 'X-Vnsh-Public': '1' } : {}),
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
    console.log(buildWorkspaceUrl(host, result.id, secret));
    console.log(`${colors.yellow('  edit')}       keep this one; it is what lets you change it`);
    console.log('');
  } else {
    console.log(buildWorkspaceUrl(host, result.id, secret));
    console.log(`${colors.yellow('  edit')}       anyone with this link can change it`);
    console.log('');
    console.log(buildReadOnlyWorkspaceUrl(host, result.id, secret));
    console.log(`${colors.yellow('  view-only')}  they can read it, never write it`);
    console.log('');
  }
  if (result.expires) {
    console.log(`${colors.yellow('Expires:')} ${result.expires} (renewed on every write)`);
  }
  console.log(`${colors.yellow('Update:')}  vn write <edit-url> [file]`);
}

/**
 * Replace the contents of an existing workspace.
 *
 * Writes are conditional on the version that was just read, so two agents
 * editing at once cannot silently clobber each other — the loser is told.
 */
async function writeWorkspace(url: string, input: string | undefined, options: UploadOptions): Promise<void> {
  const link = parseWorkspaceUrl(url);
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
      : buildWorkspaceUrl(host, link.id, link.secret as Buffer),
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

  // A public workspace has an edit link too, and it is a /w/ link — so this
  // path has to expect plaintext, or holding your own edit link looks like
  // corruption.
  if (response.headers.get('X-Vnsh-Public') === '1') {
    info(`Public workspace v${response.headers.get('ETag') || '?'} — no decryption needed`);
    process.stdout.write(payload);
    return;
  }

  info(`Decrypting workspace v${response.headers.get('ETag') || '?'} (${formatBytes(payload.length)})...`);
  try {
    process.stdout.write(decryptWorkspace(payload, link.key));
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
  if (options.price) {
    params.set('price', options.price);
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
  if (options.price) {
    console.log(`${colors.yellow('Price:')} $${options.price} (x402 payment required)`);
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
  .option('-t, --ttl <hours>', 'Expiry in hours, one-shot blobs only (max: 168)')
  .option('-p, --price <usd>', 'Price in USD for x402 payment, one-shot blobs only')
  .option('-H, --host <url>', 'Override API host', DEFAULT_HOST)
  .option('-l, --local', 'Encrypt locally and print the payload (no upload)')
  .option('-b, --blob', 'Create a v1 one-shot blob instead of a workspace')
  .option('--public', 'Store unencrypted so any agent can read it with no key (vnsh can read it too)')
  .action(async (file: string | undefined, options: UploadOptions) => {
    try {
      // A custom TTL and a price are properties of the v1 blob API; workspaces
      // are fixed at 24h from the last write. Rather than silently ignore the
      // flag, treat asking for one as asking for a blob.
      if (options.public && options.blob) {
        error('--public applies to workspaces; it cannot be combined with --blob.');
      }
      const blobOnly = Boolean(options.blob || options.ttl || options.price);
      if (blobOnly) {
        await upload(file, options);
      } else {
        await createWorkspace(file, options);
      }
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
  .command('write <url> [file]')
  .description('Replace the contents of a workspace (needs the edit link)')
  .option('-H, --host <url>', 'Override API host')
  .action(async (url: string, file: string | undefined, options: UploadOptions) => {
    try {
      await writeWorkspace(url, file, options);
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    }
  });

program.parse();
