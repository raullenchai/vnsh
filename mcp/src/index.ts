#!/usr/bin/env node
/**
 * Opaque MCP Server
 *
 * Provides tools for Claude Code to read and share encrypted content
 * via the Opaque host-blind data tunnel.
 *
 * Tools:
 * - opaque_read: Decrypt and read content from an Opaque URL
 * - opaque_share: Encrypt and upload content, return shareable URL
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
import {
  encrypt,
  decrypt,
  generateKey,
  generateIV,
  parseOpaqueUrl,
  buildOpaqueUrl,
  bufferToHex,
} from './crypto.js';

// Configuration
const DEFAULT_HOST = process.env.OPAQUE_HOST || 'https://opaque.dev';

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
    name: 'opaque-mcp',
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
        name: 'opaque_read',
        description:
          'Securely retrieves and decrypts content from an Opaque URL. Use this tool whenever ' +
          'the user provides an opaque.dev link or any URL with #k= and &iv= in the fragment. ' +
          'The content is decrypted locally - the server never sees the decryption key.',
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The full Opaque URL including the hash fragment (#k=...&iv=...)',
            },
          },
          required: ['url'],
        },
      },
      {
        name: 'opaque_share',
        description:
          'Encrypts content locally and uploads it to Opaque, returning a shareable URL. ' +
          'Use this when you need to share code, logs, or other content that is too long ' +
          'to display in chat, or when the user wants to save content for later access. ' +
          'The content is encrypted before upload - the server only sees opaque bytes.',
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
              description: 'Override the Opaque host URL',
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
    if (name === 'opaque_read') {
      return await handleRead(args);
    } else if (name === 'opaque_share') {
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
 * Handle opaque_read tool call
 */
async function handleRead(args: unknown) {
  const { url } = ReadInputSchema.parse(args);

  // Parse the URL to extract components
  const { host, id, key, iv } = parseOpaqueUrl(url);

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

  // Get the encrypted data
  const encrypted = Buffer.from(await response.arrayBuffer());

  // Decrypt
  const decrypted = decrypt(encrypted, key, iv);

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
 * Handle opaque_share tool call
 */
async function handleShare(args: unknown) {
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
  const shareUrl = buildOpaqueUrl(host, data.id, key, iv);

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
  console.error('Opaque MCP server started');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
