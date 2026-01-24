# ADR-005: MCP Integration Design

## Status

Accepted

## Context

Claude Code (and other AI coding assistants) needs to read and share encrypted Opaque content. The challenge: Claude (the remote model) cannot access URL fragments, which contain the decryption keys.

### The Fragment Problem

When a user pastes an Opaque URL into Claude Code:

```
https://opaque.dev/v/abc123#k=deadbeef...&iv=cafebabe...
```

Claude (the model) sees this as text, but cannot:
1. Visit the URL (it's a language model, not a browser)
2. Access the fragment (even if it could fetch, fragments are client-side)
3. Decrypt content (no crypto capabilities)

### Options Considered

#### Browser Extension

**Pros:**
- Full access to URL fragments
- Native browser crypto

**Cons:**
- Doesn't help CLI-based Claude Code
- Separate install/maintenance
- Browser-specific

#### Proxy Service

**Pros:**
- Simple architecture
- Works for any client

**Cons:**
- Defeats host-blind guarantee
- Key passes through server
- Trust issue

#### Local MCP Server

**Pros:**
- Runs on user's machine
- Has full URL access
- Uses local crypto
- Keys never leave machine
- Standard MCP protocol

**Cons:**
- Requires local installation
- Additional process to manage

## Decision

**Implement a local MCP server** that acts as a crypto-proxy for Claude Code.

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      User's Machine                           │
│                                                               │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     │
│  │   Claude    │────▶│  MCP Server │────▶│   Opaque    │     │
│  │    Code     │     │   (Local)   │     │    API      │     │
│  │             │◀────│             │◀────│             │     │
│  └─────────────┘     └─────────────┘     └─────────────┘     │
│        │                    │                                 │
│        │ Tool call          │ Fetch + decrypt                 │
│        │ opaque_read        │ locally                         │
│        ▼                    ▼                                 │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              Keys stay on local machine                  │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### MCP Protocol

Model Context Protocol provides:
1. **Tool Discovery**: Claude learns what tools are available
2. **Tool Invocation**: Claude calls tools with structured arguments
3. **Result Return**: Tools return structured responses

### Tool Design

#### opaque_read

**Purpose**: Read and decrypt content from an Opaque URL.

**Input**:
```json
{
  "url": "https://opaque.dev/v/abc123#k=...&iv=..."
}
```

**Process**:
1. Parse URL to extract ID, key, IV
2. Fetch encrypted blob from API
3. Decrypt using Node.js crypto
4. Return plaintext to Claude

**Output**:
```json
{
  "content": [{ "type": "text", "text": "<decrypted content>" }],
  "metadata": {
    "blobId": "abc123",
    "size": 1234,
    "contentType": "text"
  }
}
```

#### opaque_share

**Purpose**: Encrypt content and upload to Opaque.

**Input**:
```json
{
  "content": "Hello, World!",
  "ttl": 24,
  "host": "https://opaque.dev"
}
```

**Process**:
1. Generate random key and IV
2. Encrypt content locally
3. Upload to Opaque API
4. Build URL with fragment

**Output**:
```json
{
  "content": [{ "type": "text", "text": "Uploaded: https://..." }],
  "metadata": {
    "url": "https://opaque.dev/v/xyz#k=...&iv=...",
    "expires": "2024-01-25T12:00:00Z"
  }
}
```

## Consequences

### Positive

- **Preserves Host-Blindness**: Keys never leave user's machine
- **Standard Protocol**: Works with any MCP-compatible client
- **Full Crypto Access**: Node.js crypto for reliable encryption
- **Local Trust**: User controls the MCP server

### Negative

- **Installation Overhead**: Users must install MCP server
- **Process Management**: Another daemon to run
- **Node.js Dependency**: Requires Node.js runtime

### Security Model

The MCP server is trusted because:
1. It runs locally on the user's machine
2. User explicitly configures it
3. Keys only exist in local memory
4. No network exposure (stdio transport)

## Implementation Details

### MCP SDK Usage

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server({
  name: 'opaque-mcp',
  version: '1.0.0'
}, {
  capabilities: { tools: {} }
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'opaque_read', ... },
    { name: 'opaque_share', ... }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // Handle tool calls
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

### Crypto Compatibility

The MCP server uses the same encryption as CLI and browser:

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// Encrypt (same as OpenSSL)
const cipher = createCipheriv('aes-256-cbc', key, iv);
const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);

// Decrypt (compatible with WebCrypto)
const decipher = createDecipheriv('aes-256-cbc', key, iv);
const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
```

### Configuration

In project `.mcp.json`:

```json
{
  "mcpServers": {
    "opaque": {
      "command": "node",
      "args": ["/path/to/opaque/mcp/dist/index.js"],
      "env": {
        "OPAQUE_HOST": "https://opaque.dev"
      }
    }
  }
}
```

### User Experience

**Reading Content**:
```
User: Can you read this error log?
      https://opaque.dev/v/abc123#k=...&iv=...

Claude: [Uses opaque_read tool]

I can see the error log. The issue is on line 42...
```

**Sharing Content**:
```
User: This output is too long. Can you share it?

Claude: [Uses opaque_share tool]

I've uploaded the content. Here's the link:
https://opaque.dev/v/xyz789#k=...&iv=...
```

## Future Considerations

### Automatic URL Detection

Claude could automatically detect Opaque URLs and read them:

```typescript
// In tool description
description: "Use this tool whenever you see an opaque.dev URL..."
```

### Binary Content

Extend to handle images, PDFs:

```typescript
// Detect content type post-decrypt
if (decrypted.slice(0, 8).equals(PNG_MAGIC)) {
  return { content: [{ type: 'image', data: base64(decrypted) }] };
}
```

### Multiple Hosts

Support multiple Opaque instances:

```typescript
// Parse host from URL
const { host, id, key, iv } = parseOpaqueUrl(url);
// Use host from URL, not default
```

## References

- [Model Context Protocol](https://modelcontextprotocol.io/)
- [MCP SDK](https://github.com/modelcontextprotocol/sdk)
- [Claude Code MCP Integration](https://docs.anthropic.com/claude-code/mcp)
