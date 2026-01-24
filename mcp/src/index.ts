#!/usr/bin/env node
/**
 * vnsh MCP Server
 *
 * Provides tools for Claude Code to read and share encrypted content
 * via the vnsh host-blind data tunnel.
 *
 * Tools:
 * - vnsh_read: Decrypt and read content from a vnsh URL
 * - vnsh_share: Encrypt and upload content, return shareable URL
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
} from './crypto.js';

// Configuration
const DEFAULT_HOST = process.env.VNSH_HOST || 'https://vnsh.dev';
const MAX_CONTENT_SIZE = 50 * 1024 * 1024; // 50MB limit to prevent OOM

// Tool input schemas
const ReadInputSchema = z.object({
  url: z.string().describe('The full Opaque URL including the hash fragment (#k=...&iv=...)'),
});

const ShareInputSchema = z.object({
  content: z.string().describe('The content to encrypt and share'),
  ttl: z.number().optional().describe('Time-to-live in hours (default: 24, max: 168)'),
  host: z.string().optional().describe('Override the Opaque host URL'),
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
          'Encrypts content locally and uploads it to vnsh, returning a shareable URL. ' +
          'Use this when you need to share code, logs, or other content that is too long ' +
          'to display in chat, or when the user wants to save content for later access. ' +
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
    },
  });

  if (response.status === 402) {
    const data = await response.json() as { payment?: { price?: number } };
    return {
      content: [
        {
          type: 'text',
          text: `Payment required: This content requires payment of $${data.payment?.price || '?'} to access.`,
        },
      ],
    };
  }

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
