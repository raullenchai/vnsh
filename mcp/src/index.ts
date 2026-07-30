#!/usr/bin/env node
/**
 * vnsh MCP Server
 *
 * Provides tools for Claude Code to read and share encrypted content
 * via the vnsh host-blind data tunnel.
 *
 * Tools:
 * - vnsh_read: Decrypt and read content from a vnsh URL
 * - vnsh_share: Encrypt and upload text content, return shareable URL
 * - vnsh_share_file: Encrypt and upload a local file, return shareable URL
 * - vnsh_workspace_create/read/update/open: mutable, versioned shared workspaces
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  encrypt,
  decrypt,
  generateKey,
  generateIV,
  parseVnshUrl,
  buildVnshUrl,
  bufferToHex,
  generateRootSecret,
  deriveWorkspaceKeys,
  encryptWorkspace,
  decryptWorkspace,
  buildWorkspaceUrl,
  buildReadOnlyWorkspaceUrl,
  parseWorkspaceUrl,
} from './crypto.js';

// Configuration
const DEFAULT_HOST = process.env.VNSH_HOST || 'https://vnsh.dev';
const MAX_CONTENT_SIZE = 50 * 1024 * 1024; // 50MB limit to prevent OOM
const CLIENT_VERSION = 'mcp/1.3.0';

// Every MCP client — Claude Code, Cursor, OpenHands — speaks through this same
// server, so a fixed header reports them all as "mcp". That makes the one metric
// this phase exists to produce ("did more than one agent touch this workspace?")
// structurally unable to answer its own question: two agents collaborating would
// look identical to one agent writing twice.
//
// The initialize handshake carries the real client identity, so use it.
function agentName(): string | null {
  try {
    const info = server.getClientVersion();
    if (!info || !info.name) return null;
    // Client-controlled, so constrain it rather than forwarding it verbatim.
    const clean = info.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return clean ? clean.slice(0, 32) : null;
  } catch {
    return null;
  }
}

function clientHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'X-Vnsh-Client': CLIENT_VERSION };
  const agent = agentName();
  if (agent) headers['X-Vnsh-Agent'] = agent;
  return headers;
}

// Tool input schemas
const ReadInputSchema = z.object({
  url: z.string().describe('The full Opaque URL including the hash fragment (#k=...&iv=...)'),
});

const ShareInputSchema = z.object({
  content: z.string().describe('The content to encrypt and share'),
  ttl: z.number().optional().describe('Time-to-live in hours (default: 24, max: 168)'),
  host: z.string().optional().describe('Override the Opaque host URL'),
});

const ShareFileInputSchema = z.object({
  file_path: z.string().describe('Absolute path to the file to encrypt and share'),
  ttl: z.number().optional().describe('Time-to-live in hours (default: 24, max: 168)'),
  host: z.string().optional().describe('Override the vnsh host URL'),
});

const WorkspaceCreateSchema = z.object({
  content: z.string().describe('Initial workspace content'),
  // Never inferred. Publishing gives up the guarantee the product is built on,
  // so it has to be asked for explicitly, by someone who knows they are asking.
  public: z
    .boolean()
    .optional()
    .describe('Store unencrypted so any agent can read it with no key. vnsh can read it too.'),
  host: z.string().optional(),
});

const WorkspaceUrlSchema = z.object({
  url: z.string().describe('Full workspace URL including the #w= fragment'),
});

const WorkspaceUpdateSchema = z.object({
  url: z.string(),
  content: z.string(),
  base_version: z.number().optional(),
});

// Create MCP server
const server = new Server(
  {
    name: 'vnsh-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'vnsh_read',
        description:
          'Securely retrieves and decrypts content from a vnsh URL. Use this tool whenever ' +
          'the user provides a vnsh.dev link or any URL with #k= and &iv= in the fragment. ' +
          'The content is decrypted locally - the server never sees the decryption key.',
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The full vnsh URL including the hash fragment (#k=...&iv=...)',
            },
          },
          required: ['url'],
        },
      },
      {
        name: 'vnsh_share',
        description:
          'Encrypts text content locally and uploads it to vnsh, returning a shareable URL. ' +
          'Use this when output exceeds ~50 lines or ~2000 characters, when generating ' +
          'complete code files, or when the user wants portable/shareable output. ' +
          'ALWAYS prefer vnsh_share over dumping large content into chat. ' +
          'The content is encrypted before upload - the server only sees encrypted bytes.',
        inputSchema: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'The content to encrypt and share',
            },
            ttl: {
              type: 'number',
              description: 'Time-to-live in hours (default: 24, max: 168)',
            },
            host: {
              type: 'string',
              description: 'Override the vnsh host URL',
            },
          },
          required: ['content'],
        },
      },
      {
        name: 'vnsh_share_file',
        description:
          'Encrypts a local file and uploads it to vnsh, returning a shareable URL. ' +
          'Use this for images, screenshots, PDFs, binaries, or any file that should not ' +
          'be loaded into context. More efficient than vnsh_share for large or binary files.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'Absolute path to the file to encrypt and share',
            },
            ttl: {
              type: 'number',
              description: 'Time-to-live in hours (default: 24, max: 168)',
            },
            host: {
              type: 'string',
              description: 'Override the vnsh host URL',
            },
          },
          required: ['file_path'],
        },
      },
      {
        name: 'vnsh_workspace_create',
        description:
          'Creates a shared workspace and returns one link that any agent can read AND write. ' +
          'Use this when work will continue somewhere else: handing a plan, status doc, ' +
          'design, or investigation to another agent or another session, or when the user ' +
          'says they will pick this up in a different tool. Unlike vnsh_share (a one-shot ' +
          'snapshot), a workspace keeps the same URL as its content evolves. ' +
          'Content is encrypted locally; the server never sees the key. Expires 24h after ' +
          'the last write.',
        inputSchema: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'Initial content. HTML and markdown render as a page.',
            },
            public: {
              type: 'boolean',
              description:
                'Store unencrypted at /p/{id}, readable by any plain HTTP fetch with no key ' +
                'and no setup. Use only when the recipient cannot run the vnsh tooling and ' +
                'the content is not sensitive: vnsh can read a public workspace. Defaults ' +
                'to false; ask the user before setting it.',
            },
            host: { type: 'string', description: 'Override the vnsh host URL' },
          },
          required: ['content'],
        },
      },
      {
        name: 'vnsh_workspace_read',
        description:
          'Reads the current content of a vnsh workspace URL (a /w/ link with a #w= fragment). ' +
          'Use this whenever the user provides such a link — it is how you pick up work another ' +
          'agent left for you. Returns the content and its version number; pass that version to ' +
          'vnsh_workspace_update to write safely.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Full workspace URL including the #w= fragment' },
          },
          required: ['url'],
        },
      },
      {
        name: 'vnsh_workspace_update',
        description:
          'Replaces the content of a vnsh workspace, keeping the same URL. Use this to record ' +
          'progress so far, revise a shared plan, or leave the next agent an updated document. ' +
          'Writes are version-checked: if someone else wrote first, this returns their current ' +
          'content so you can merge it with yours and call this again.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Full workspace URL including the #w= fragment' },
            content: { type: 'string', description: 'The full new content (replaces everything)' },
            base_version: {
              type: 'number',
              description:
                'Version this edit is based on. Omit to read the latest first. Pass the version ' +
                'from vnsh_workspace_read when you have already merged against it.',
            },
          },
          required: ['url', 'content'],
        },
      },
      {
        name: 'vnsh_workspace_open',
        description:
          'Decrypts a vnsh workspace to a local temp file and opens it in the browser. ' +
          'Use this when the user wants to LOOK at a workspace rather than have its content ' +
          'read into context — HTML reports, dashboards, and diagrams render properly this way. ' +
          'Rendering happens locally from file://, so nothing is exposed to any server.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Full workspace URL including the #w= fragment' },
          },
          required: ['url'],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'vnsh_read') {
      return await handleRead(args);
    } else if (name === 'vnsh_share') {
      return await handleShare(args);
    } else if (name === 'vnsh_share_file') {
      return await handleShareFile(args);
    } else if (name === 'vnsh_workspace_create') {
      return await handleWorkspaceCreate(args);
    } else if (name === 'vnsh_workspace_read') {
      return await handleWorkspaceRead(args);
    } else if (name === 'vnsh_workspace_update') {
      return await handleWorkspaceUpdate(args);
    } else if (name === 'vnsh_workspace_open') {
      return await handleWorkspaceOpen(args);
    } else {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

/**
 * Handle vnsh_read tool call
 * @internal Exported for testing
 */
export async function handleRead(args: unknown) {
  const { url } = ReadInputSchema.parse(args);

  // Parse the URL to extract components
  const { host, id, key, iv } = parseVnshUrl(url);

  // Fetch the encrypted blob
  const apiUrl = `${host}/api/blob/${id}`;
  const response = await fetch(apiUrl, {
    headers: {
      Accept: 'application/octet-stream',
      ...clientHeaders(),
    },
  });

  if (response.status === 404) {
    return {
      content: [
        {
          type: 'text',
          text: 'Content not found. It may have expired or been deleted.',
        },
      ],
    };
  }

  if (response.status === 410) {
    return {
      content: [
        {
          type: 'text',
          text: 'Content has expired and is no longer available.',
        },
      ],
    };
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch content: HTTP ${response.status}`);
  }

  // Check content size to prevent OOM
  const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
  if (contentLength > MAX_CONTENT_SIZE) {
    return {
      content: [
        {
          type: 'text',
          text: `Content too large: ${(contentLength / 1024 / 1024).toFixed(1)}MB exceeds the ${MAX_CONTENT_SIZE / 1024 / 1024}MB limit.`,
        },
      ],
    };
  }

  // Get the encrypted data
  const encrypted = Buffer.from(await response.arrayBuffer());

  // Double-check actual size (in case Content-Length was missing or wrong)
  if (encrypted.length > MAX_CONTENT_SIZE) {
    return {
      content: [
        {
          type: 'text',
          text: `Content too large: ${(encrypted.length / 1024 / 1024).toFixed(1)}MB exceeds the ${MAX_CONTENT_SIZE / 1024 / 1024}MB limit.`,
        },
      ],
    };
  }

  // Decrypt
  const decrypted = decrypt(encrypted, key, iv);

  // Detect binary/image content by checking magic bytes
  const imageType = detectImageType(decrypted);

  if (imageType) {
    // Save image to temp file and return the path
    const tempDir = os.tmpdir();
    const tempFile = path.join(tempDir, `opaque-${id}.${imageType.ext}`);
    fs.writeFileSync(tempFile, decrypted);

    return {
      content: [
        {
          type: 'text',
          text: `Image detected (${imageType.mime}). Saved to: ${tempFile}\n\nUse the Read tool to view this image.`,
        },
      ],
      metadata: {
        blobId: id,
        size: encrypted.length,
        contentType: imageType.mime,
        filePath: tempFile,
      },
    };
  }

  // Check if content is binary (has null bytes or non-printable chars)
  const isBinary = detectBinary(decrypted);

  if (isBinary) {
    // Save binary to temp file
    const tempDir = os.tmpdir();
    const tempFile = path.join(tempDir, `opaque-${id}.bin`);
    fs.writeFileSync(tempFile, decrypted);

    return {
      content: [
        {
          type: 'text',
          text: `Binary content detected (${decrypted.length} bytes). Saved to: ${tempFile}`,
        },
      ],
      metadata: {
        blobId: id,
        size: encrypted.length,
        contentType: 'application/octet-stream',
        filePath: tempFile,
      },
    };
  }

  // Try to decode as UTF-8 text
  const content = decrypted.toString('utf-8');

  // Detect content type (simple heuristic)
  let contentType = 'text';
  if (content.startsWith('{') || content.startsWith('[')) {
    try {
      JSON.parse(content);
      contentType = 'json';
    } catch {
      // Not valid JSON
    }
  } else if (content.startsWith('<!DOCTYPE') || content.startsWith('<html')) {
    contentType = 'html';
  } else if (content.startsWith('---\n') || content.startsWith('# ')) {
    contentType = 'markdown';
  }

  return {
    content: [
      {
        type: 'text',
        text: content,
      },
    ],
    metadata: {
      blobId: id,
      size: encrypted.length,
      contentType,
    },
  };
}

/**
 * Detect image type from magic bytes
 */
export function detectImageType(buffer: Buffer): { ext: string; mime: string } | null {
  if (buffer.length < 4) return null;

  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return { ext: 'png', mime: 'image/png' };
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }

  // GIF: 47 49 46
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { ext: 'gif', mime: 'image/gif' };
  }

  // WebP: 52 49 46 46 ... 57 45 42 50
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer.length >= 12 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return { ext: 'webp', mime: 'image/webp' };
  }

  return null;
}

/**
 * Detect if buffer contains binary content
 */
export function detectBinary(buffer: Buffer): boolean {
  // Check first 1024 bytes for null bytes or high proportion of non-printable chars
  const sampleSize = Math.min(buffer.length, 1024);
  let nonPrintable = 0;

  for (let i = 0; i < sampleSize; i++) {
    const byte = buffer[i];
    // Null byte is a strong indicator of binary
    if (byte === 0) return true;
    // Count non-printable chars (excluding common whitespace)
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      nonPrintable++;
    }
  }

  // If more than 10% non-printable, treat as binary
  return nonPrintable / sampleSize > 0.1;
}

/**
 * Handle vnsh_share tool call
 */
/**
 * Handle vnsh_share tool call
 * @internal Exported for testing
 */
export async function handleShare(args: unknown) {
  const { content, ttl, host: hostOverride } = ShareInputSchema.parse(args);

  const host = hostOverride || DEFAULT_HOST;

  // Generate encryption key and IV
  const key = generateKey();
  const iv = generateIV();

  // Encrypt the content
  const encrypted = encrypt(content, key, iv);

  // Build API URL with optional TTL
  let apiUrl = `${host}/api/drop`;
  if (ttl) {
    apiUrl += `?ttl=${ttl}`;
  }

  // Upload to server
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      ...clientHeaders(),
    },
    body: new Uint8Array(encrypted),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Upload failed: HTTP ${response.status} - ${errorText}`);
  }

  const data = await response.json() as { id: string; expires: string };

  // Build the shareable URL
  const shareUrl = buildVnshUrl(host, data.id, key, iv);

  return {
    content: [
      {
        type: 'text',
        text: `Content encrypted and uploaded successfully.\n\nShareable URL:\n${shareUrl}\n\nExpires: ${data.expires}\n\nThe decryption key is in the URL fragment (#k=...) and is never sent to the server.`,
      },
    ],
    metadata: {
      url: shareUrl,
      blobId: data.id,
      expires: data.expires,
      size: encrypted.length,
    },
  };
}

/**
 * Handle vnsh_share_file tool call
 * @internal Exported for testing
 */
export async function handleShareFile(args: unknown) {
  const { file_path: filePath, ttl, host: hostOverride } = ShareFileInputSchema.parse(args);

  const host = hostOverride || DEFAULT_HOST;

  // Resolve and validate path
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${resolved}`);
  }

  if (stat.size > 25 * 1024 * 1024) {
    throw new Error(`File too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max 25MB)`);
  }

  if (stat.size === 0) {
    throw new Error('File is empty');
  }

  // Read file as buffer
  const fileBuffer = fs.readFileSync(resolved);

  // Generate encryption key and IV
  const key = generateKey();
  const iv = generateIV();

  // Encrypt the file content
  const encrypted = encrypt(fileBuffer, key, iv);

  // Build API URL with optional TTL
  let apiUrl = `${host}/api/drop`;
  if (ttl) {
    apiUrl += `?ttl=${ttl}`;
  }

  // Upload to server
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      ...clientHeaders(),
    },
    body: new Uint8Array(encrypted),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Upload failed: HTTP ${response.status} - ${errorText}`);
  }

  const data = await response.json() as { id: string; expires: string };

  // Build the shareable URL
  const shareUrl = buildVnshUrl(host, data.id, key, iv);

  const fileName = path.basename(resolved);
  const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
  const sizeKB = (stat.size / 1024).toFixed(1);
  const sizeStr = stat.size > 1024 * 1024 ? `${sizeMB}MB` : `${sizeKB}KB`;

  return {
    content: [
      {
        type: 'text',
        text: `File encrypted and uploaded successfully.\n\n📎 ${fileName} (${sizeStr})\n\nShareable URL:\n${shareUrl}\n\nExpires: ${data.expires}\n\nThe decryption key is in the URL fragment (#k=...) and is never sent to the server.`,
      },
    ],
    metadata: {
      url: shareUrl,
      blobId: data.id,
      expires: data.expires,
      size: encrypted.length,
      fileName,
      originalSize: stat.size,
    },
  };
}

/**
 * Handle vnsh_workspace_create tool call
 * @internal Exported for testing
 */
export async function handleWorkspaceCreate(args: unknown) {
  const { content, public: isPublic, host: hostOverride } = WorkspaceCreateSchema.parse(args);
  const host = hostOverride || DEFAULT_HOST;

  const secret = generateRootSecret();
  const { key, writeHash } = deriveWorkspaceKeys(secret);
  // A public workspace is stored as written, which is what lets an agent with
  // only fetch read it. The encryption step is skipped rather than performed
  // and discarded, so there is no pretence of a guarantee that is not there.
  const body = isPublic ? Buffer.from(content, 'utf-8') : encryptWorkspace(content, key);

  const response = await fetch(`${host}/api/workspace`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Vnsh-Write-Hash': writeHash,
      ...(isPublic ? { 'X-Vnsh-Public': '1' } : {}),
      ...clientHeaders(),
    },
    body: new Uint8Array(body),
  });

  if (!response.ok) {
    throw new Error(`Create failed: HTTP ${response.status} - ${await response.text()}`);
  }

  const data = (await response.json()) as {
    id: string;
    version: number;
    expires: string;
    url?: string;
  };
  const url = buildWorkspaceUrl(host, data.id, secret);
  // A public workspace has no key, so its shareable link carries no fragment.
  // Reporting a "view-only" link here would misdescribe who can read it.
  // The host is the server's to decide — public documents are served from a
  // separate domain, and the fallback only covers servers predating that.
  const viewUrl = isPublic
    ? data.url || `${host}/p/${data.id}`
    : buildReadOnlyWorkspaceUrl(host, data.id, secret);

  const text = isPublic
    ? `Public workspace created at version ${data.version}.\n\n` +
      `Share this — no key, readable by any plain fetch:\n${viewUrl}\n\n` +
      `Keep this — it is the only way to change it later:\n${url}\n\n` +
      `This one is stored unencrypted, so vnsh can read it; that is the trade for ` +
      `being readable without any setup. It still disappears ${data.expires}, renewed ` +
      `on every write, and only the link above can change it.`
    : `Workspace created at version ${data.version}. Two links, pick by intent:\n\n` +
      `Edit link (read + write):\n${url}\n\n` +
      `View-only link (read, cannot change it):\n${viewUrl}\n\n` +
      `Give the edit link to agents that will contribute; give the view-only link to ` +
      `anyone who just needs to read it. The view-only link cannot be turned back into ` +
      `the edit link. Expires ${data.expires}, renewed on every write. Keys live in the ` +
      `fragment and never reach the server.`;

  return {
    content: [{ type: 'text', text }],
    metadata: {
      url,
      viewUrl,
      public: Boolean(isPublic),
      workspaceId: data.id,
      version: data.version,
      expires: data.expires,
    },
  };
}

// Fetch and decrypt a workspace. Shared by read/update/open.
async function fetchWorkspace(url: string) {
  const link = parseWorkspaceUrl(url);
  const { host, id, key, secret, writeToken, canWrite } = link;

  const response = await fetch(`${host}/api/workspace/${id}`, {
    headers: { Accept: 'application/octet-stream', ...clientHeaders() },
  });

  if (response.status === 404) {
    throw new Error('Workspace not found — it may have expired (24h after the last write).');
  }
  if (response.status === 410) {
    throw new Error('Workspace has expired.');
  }
  if (!response.ok) {
    throw new Error(`Read failed: HTTP ${response.status} - ${await response.text()}`);
  }

  const payload = Buffer.from(await response.arrayBuffer());
  if (payload.length > MAX_CONTENT_SIZE) {
    throw new Error(`Workspace is too large (${payload.length} bytes)`);
  }

  const version = parseInt((response.headers.get('ETag') || '"1"').replace(/"/g, ''), 10);

  // A public workspace is stored as plaintext so that an agent's fetch can read
  // it without a key or a runtime. Its edit link is still a /w/ link, so this
  // path has to expect plaintext or the author's own link looks corrupted.
  const isPublic = response.headers.get('X-Vnsh-Public') === '1';

  let plaintext: Buffer;
  if (isPublic) {
    plaintext = payload;
  } else
  try {
    plaintext = decryptWorkspace(payload, key);
  } catch {
    // GCM tag failure means the key is wrong or the bytes were altered — the
    // integrity guarantee CBC could not give us.
    throw new Error(
      'Decryption failed: the key in the URL does not match, or the content was tampered with.',
    );
  }

  return { host, id, version, writeToken, key, secret, canWrite, plaintext };
}

/**
 * Handle vnsh_workspace_read tool call
 * @internal Exported for testing
 */
export async function handleWorkspaceRead(args: unknown) {
  const { url } = WorkspaceUrlSchema.parse(args);
  const { host, id, version, secret, canWrite, plaintext } = await fetchWorkspace(url);
  const text = plaintext.toString('utf-8');
  const viewUrl = secret ? buildReadOnlyWorkspaceUrl(host, id, secret) : url;

  const header = canWrite
    ? `Workspace ${id} — version ${version}.\n` +
      `To modify it, call vnsh_workspace_update with base_version: ${version}.\n` +
      `To let someone read it without being able to change it, share:\n${viewUrl}\n\n`
    : `Workspace ${id} — version ${version}. This is a view-only link; it cannot be written to.\n\n`;

  return {
    content: [{ type: 'text', text: header + text }],
    metadata: { workspaceId: id, version, canWrite, viewUrl, size: plaintext.length },
  };
}

/**
 * Handle vnsh_workspace_update tool call
 * @internal Exported for testing
 */
export async function handleWorkspaceUpdate(args: unknown) {
  const { url, content, base_version } = WorkspaceUpdateSchema.parse(args);
  const { host, id, key, writeToken, canWrite } = parseWorkspaceUrl(url);

  if (!canWrite || !writeToken) {
    throw new Error(
      'This is a view-only link (#r=). It can decrypt the workspace but cannot write to it. ' +
      'Ask whoever shared it for the edit link (#w=) if you need to make changes.',
    );
  }

  // Without an explicit base, read the latest so we write against something real.
  let version = base_version;
  if (version === undefined) {
    version = (await fetchWorkspace(url)).version;
  }

  const encrypted = encryptWorkspace(content, key);
  const response = await fetch(`${host}/api/workspace/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Vnsh-Write': writeToken,
      'If-Match': `"${version}"`,
      ...clientHeaders(),
    },
    body: new Uint8Array(encrypted),
  });

  if (response.status === 412) {
    // Someone wrote first. Hand back their content in the same turn so the agent
    // can merge and retry immediately instead of guessing what changed.
    const current = await fetchWorkspace(url);
    return {
      content: [
        {
          type: 'text',
          text:
            `Write rejected: the workspace moved to version ${current.version} while you were ` +
            `working from version ${version}. Your content was NOT saved.\n\n` +
            `Below is the current content. Merge your intended change into it, then call ` +
            `vnsh_workspace_update again with base_version: ${current.version}.\n\n` +
            `--- current version ${current.version} ---\n${current.plaintext.toString('utf-8')}`,
        },
      ],
      isError: true,
      metadata: { workspaceId: id, conflict: true, currentVersion: current.version },
    };
  }

  if (response.status === 403) {
    throw new Error('This URL does not grant write access to that workspace.');
  }
  if (!response.ok) {
    throw new Error(`Update failed: HTTP ${response.status} - ${await response.text()}`);
  }

  const data = (await response.json()) as { version: number; expires: string };
  return {
    content: [
      {
        type: 'text',
        text:
          `Workspace updated to version ${data.version}. The URL is unchanged.\n` +
          `Expires ${data.expires}.`,
      },
    ],
    metadata: { workspaceId: id, version: data.version, expires: data.expires },
  };
}

/**
 * Is this content an HTML document meant to be rendered?
 *
 * Skips everything that may legitimately precede the first element: a byte order
 * mark, whitespace, XML declarations, and leading comments. The comment case is
 * the one that mattered — a generated file whose first line is a banner comment
 * is still HTML, and was being written out as .txt and shown as plain text.
 *
 * Scanned with indexOf rather than a lazy regex so a large unterminated comment
 * cannot cause catastrophic backtracking. Kept identical to the worker's copy in
 * WORKSPACE_PAGE: the two renderers must agree on what gets sandboxed.
 */
export function looksLikeHtml(input: string): boolean {
  const t = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  let i = 0;
  for (let guard = 0; guard < 64; guard++) {
    while (i < t.length && (t[i] === ' ' || t[i] === '\t' || t[i] === '\n' || t[i] === '\r')) i++;
    if (t.substr(i, 4) === '<!--') {
      const end = t.indexOf('-->', i + 4);
      if (end === -1) return false;
      i = end + 3;
      continue;
    }
    if (t.substr(i, 2) === '<?') {
      const q = t.indexOf('?>', i + 2);
      if (q === -1) return false;
      i = q + 2;
      continue;
    }
    break;
  }
  return /^<(!doctype html|html|head|body|div|section|main|article|style|h[1-6]|p|table|ul|ol|svg|header|footer|nav|figure|pre|blockquote)[\s>/]/i.test(
    t.slice(i, i + 64),
  );
}

/**
 * Handle vnsh_workspace_open tool call
 * @internal Exported for testing
 */
export async function handleWorkspaceOpen(args: unknown) {
  const { url } = WorkspaceUrlSchema.parse(args);
  const { id, version, plaintext } = await fetchWorkspace(url);

  const text = plaintext.toString('utf-8');
  const looksHtml = looksLikeHtml(text);
  const ext = looksHtml ? 'html' : 'txt';
  const filePath = path.join(os.tmpdir(), `vnsh-workspace-${id}-v${version}.${ext}`);

  // Workspace content is untrusted — it came from whoever holds the link. Writing
  // it straight to disk and opening it would run it as a file:// document, where
  // scripts can fetch freely and would happily post the decrypted plaintext to an
  // attacker. Wrap it in the same isolation the web viewer uses instead.
  fs.writeFileSync(filePath, looksHtml ? sandboxHtml(text) : plaintext, { mode: 0o600 });

  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  let opened = true;
  try {
    const { spawn } = await import('child_process');
    spawn(opener, [filePath], {
      detached: true,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    }).unref();
  } catch {
    opened = false;
  }

  return {
    content: [
      {
        type: 'text',
        text:
          (opened
            ? `Opened workspace ${id} (version ${version}) in the browser.\n`
            : `Could not launch a browser automatically.\n`) +
          `File: ${filePath}\n` +
          `Rendered locally — the decrypted content never leaves this machine, and it runs\n` +
          `in a sandboxed frame with no network access so it cannot send itself anywhere.`,
      },
    ],
    metadata: { workspaceId: id, version, filePath, opened, sandboxed: looksHtml },
  };
}

/**
 * Wrap untrusted HTML so opening it locally cannot leak the plaintext.
 *
 * The payload is base64-encoded rather than templated in, so no combination of
 * `</script>` or quoting in the content can break out of the wrapper. The wrapper
 * then hardens it with DOMParser — inserting the CSP into the real <head> rather
 * than after the first `<head` match, which content can fake inside a comment —
 * and hands it to an iframe with `allow-scripts` but deliberately without
 * `allow-same-origin`, so the frame gets an opaque origin and cannot read the
 * wrapper, its URL, or local storage.
 */
export function sandboxHtml(html: string): string {
  const payload = Buffer.from(html, 'utf-8').toString('base64');
  const csp =
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
    'img-src data: blob:; media-src data: blob:; font-src data:; ' +
    "form-action 'none'; base-uri 'none'";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vnsh workspace</title>
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html,body{height:100%;margin:0}
  body{display:flex;flex-direction:column;background:#0d1117;color:#e6edf3;
    font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',system-ui,sans-serif}
  header{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:9px 14px;
    background:#161b22;border-bottom:1px solid #21262d}
  .b{font-weight:700}
  .w{margin-left:auto;font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:.72rem;
    color:#d29922;background:#2b2113;border:1px solid #3d2f16;border-radius:5px;padding:.25em .6em}
  iframe{flex:1 1 auto;width:100%;border:0;background:#fff}
</style>
</head>
<body>
<header><span class="b">vnsh</span><span class="w">untrusted content &middot; no network</span></header>
<script>
(function () {
  var CSP = ${JSON.stringify(csp)};
  // Links inside the sandbox would navigate the frame itself, and the target
  // would inherit the sandbox — which is what makes them appear dead. Route them
  // to the wrapper instead of granting allow-popups-to-escape-sandbox, which
  // would also let content open windows with no click and use the URL to leak.
  var HOOK = [
    '(function(){',
    'document.addEventListener("click", function(e){',
    '  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey) return;',
    '  var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;',
    '  if (!a) return;',
    '  var h = a.getAttribute("href") || "";',
    '  if (h.charAt(0) === "#") return;',
    '  var u; try { u = new URL(h, "https://example.invalid/"); } catch (err) { return; }',
    '  if (u.protocol !== "http:" && u.protocol !== "https:") return;',
    '  e.preventDefault();',
    '  parent.postMessage({ vnshOpen: u.href }, "*");',
    '});',
    '})();'
  ].join('');
  var raw = new TextDecoder().decode(
    Uint8Array.from(atob(${JSON.stringify(payload)}), function (c) { return c.charCodeAt(0); }));

  var doc = null;
  try { doc = new DOMParser().parseFromString(raw, 'text/html'); } catch (e) {}
  var out;
  if (doc && doc.head && doc.documentElement) {
    var m = doc.createElement('meta');
    m.setAttribute('http-equiv', 'Content-Security-Policy');
    m.setAttribute('content', CSP);
    doc.head.insertBefore(m, doc.head.firstChild);
    var hook = doc.createElement('script');
    hook.textContent = HOOK;
    (doc.body || doc.head).appendChild(hook);
    out = '<!DOCTYPE html>' + doc.documentElement.outerHTML;
  } else {
    out = '<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="' +
          CSP + '"></head><body></body></html>';
  }

  var f = document.createElement('iframe');
  window.addEventListener('message', function (e) {
    if (e.source !== f.contentWindow) return;
    var t = e.data && e.data.vnshOpen;
    if (typeof t !== 'string') return;
    var u; try { u = new URL(t); } catch (err) { return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    window.open(u.href, '_blank', 'noopener,noreferrer');
  });
  f.setAttribute('sandbox', 'allow-scripts');
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.setAttribute('title', 'Workspace content');
  f.srcdoc = out;
  document.body.appendChild(f);
})();
</script>
</body>
</html>`;
}

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('vnsh MCP server started');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
