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
} from './crypto.js';

const VERSION = '1.0.0';
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
    headers: { 'Content-Type': 'application/octet-stream' },
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
  .description('vnsh - The Ephemeral Dropbox for AI\n\nEncrypt and share content via host-blind data tunnel.')
  .version(VERSION, '-v, --version')
  .argument('[file]', 'File to encrypt and upload')
  .option('-t, --ttl <hours>', 'Set expiry time in hours (default: 24, max: 168)')
  .option('-p, --price <usd>', 'Set price in USD for x402 payment')
  .option('-H, --host <url>', 'Override API host', DEFAULT_HOST)
  .option('-l, --local', 'Output encrypted blob locally (no upload)')
  .action(async (file: string | undefined, options: UploadOptions) => {
    try {
      await upload(file, options);
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    }
  });

program
  .command('read <url>')
  .description('Decrypt and read a vnsh URL')
  .action(async (url: string) => {
    try {
      await read(url);
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    }
  });

program.parse();
