# MCP Server Reference

The vnsh MCP (Model Context Protocol) server enables Claude Code to read and share encrypted content seamlessly.

## Overview

The MCP server acts as a **local crypto-proxy**:

1. Claude (remote model) cannot access URL fragments directly
2. The local MCP server has access to the full URL
3. It fetches, decrypts, and returns content to Claude
4. Encryption keys never leave your machine

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Claude     │────▶│  MCP Server │────▶│    vnsh     │
│  (Remote)   │     │   (Local)   │     │    API      │
│             │◀────│             │◀────│             │
└─────────────┘     └─────────────┘     └─────────────┘
      │                    │
      │ "Read this URL"    │ Decrypt locally
      │                    │ Return plaintext
```

## Installation

### Quick Start (npx)

No installation needed — use npx:

```bash
npx -y vnsh-mcp
```

### Configure Claude

Add the vnsh MCP server to your Claude configuration.

#### Claude Code

Create `.mcp.json` in your **project root**:

```json
{
  "mcpServers": {
    "vnsh": {
      "command": "npx",
      "args": ["-y", "vnsh-mcp"]
    }
  }
}
```

Or via command line:
```bash
cat > .mcp.json << 'EOF'
{
  "mcpServers": {
    "vnsh": {
      "command": "npx",
      "args": ["-y", "vnsh-mcp"]
    }
  }
}
EOF
```

#### Claude Desktop

Add to your Claude Desktop config file:
- **Linux/macOS**: `~/.config/claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "vnsh": {
      "command": "npx",
      "args": ["-y", "vnsh-mcp"]
    }
  }
}
```

**Important**: Restart Claude after adding the config.

### Build from Source

```bash
cd mcp
npm install
npm run build
```

Then configure:

```json
{
  "mcpServers": {
    "vnsh": {
      "command": "node",
      "args": ["/path/to/vnsh/mcp/dist/index.js"]
    }
  }
}
```

### Verify Installation

After restarting Claude Code, the tools should be available:

```
You: What tools do you have for vnsh?

Claude: I have two vnsh tools available:
- vnsh_read: Decrypt and read content from vnsh URLs
- vnsh_share: Encrypt content and upload to vnsh
```

## Tools

### vnsh_read

Securely retrieves and decrypts content from a vnsh URL.

**When to Use:**

- User provides a `vnsh.dev` link
- Any URL with `#k=` and `&iv=` in the fragment
- Claude needs to "see" shared context

**Input Schema:**

```json
{
  "url": {
    "type": "string",
    "description": "The full vnsh URL including the hash fragment (#k=...&iv=...)"
  }
}
```

**Example Usage:**

```
User: Can you read this? https://vnsh.dev/v/abc123#k=dead...&iv=cafe...

Claude: [Uses vnsh_read tool]

I can see the content. It appears to be an error log showing...
```

**Response Format:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "<decrypted content>"
    }
  ],
  "metadata": {
    "blobId": "abc123...",
    "size": 1234,
    "contentType": "text|json|markdown|html"
  }
}
```

**Error Handling:**

| Condition | Response |
|-----------|----------|
| 402 Payment Required | "Payment required: This content requires payment of $X.XX to access." |
| 404 Not Found | "Content not found. It may have expired or been deleted." |
| 410 Expired | "Content has expired and is no longer available." |
| Decryption Error | "Error: Decryption failed..." |

---

### vnsh_share

Encrypts content locally and uploads it to vnsh, returning a shareable URL.

**When to Use:**

- Output is too long to display in chat
- User wants to save content for later
- Sharing code, logs, or other content externally

**Input Schema:**

```json
{
  "content": {
    "type": "string",
    "description": "The content to encrypt and share"
  },
  "ttl": {
    "type": "number",
    "description": "Time-to-live in hours (default: 24, max: 168)"
  },
  "host": {
    "type": "string",
    "description": "Override the vnsh host URL"
  }
}
```

**Example Usage:**

```
User: This build output is too long. Can you share it via vnsh?

Claude: [Uses vnsh_share tool with the build output]

I've uploaded the build output. Here's the shareable URL:
https://vnsh.dev/v/xyz789#k=beef...&iv=face...

The link expires in 24 hours.
```

**Response Format:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "Content encrypted and uploaded successfully.\n\nShareable URL:\nhttps://...\n\nExpires: 2024-01-25T12:00:00Z"
    }
  ],
  "metadata": {
    "url": "https://vnsh.dev/v/...",
    "blobId": "xyz789...",
    "expires": "2024-01-25T12:00:00Z",
    "size": 5678
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VNSH_HOST` | `https://vnsh.dev` | Default API host |
| `NODE_TLS_REJECT_UNAUTHORIZED` | - | Set to `0` for self-signed certs (dev only) |

## Development

### Running Locally

```bash
cd mcp
npm run dev
```

### Testing with MCP Inspector

```bash
# Send initialization
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | node dist/index.js

# List tools
echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node dist/index.js
```

### Testing Tools

```bash
# Test vnsh_read
cat << 'EOF' | node dist/index.js
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"vnsh_read","arguments":{"url":"https://vnsh.dev/v/abc#k=...&iv=..."}}}
EOF
```

## Architecture

### Crypto Module (`src/crypto.ts`)

Provides AES-256-CBC encryption/decryption compatible with:

- OpenSSL CLI (`openssl enc -aes-256-cbc`)
- WebCrypto API (`crypto.subtle`)
- Node.js crypto module

**Functions:**

```typescript
// Key/IV generation
generateKey(): Buffer      // 32 bytes
generateIV(): Buffer       // 16 bytes

// Encryption/Decryption
encrypt(plaintext, key, iv): Buffer
decrypt(ciphertext, key, iv): Buffer

// URL parsing
parseVnshUrl(url): { host, id, key, iv }
buildVnshUrl(host, id, key, iv): string

// Hex conversion
hexToBuffer(hex): Buffer
bufferToHex(buffer): string
```

### Server Module (`src/index.ts`)

MCP server implementation using `@modelcontextprotocol/sdk`.

**Handlers:**

- `ListToolsRequestSchema` — Returns tool definitions
- `CallToolRequestSchema` — Executes `vnsh_read` or `vnsh_share`

## Troubleshooting

### "fetch failed" Error

This is the most common error. Causes:

1. **Wrong VNSH_HOST**: Check your `.mcp.json` config
   ```json
   {
     "mcpServers": {
       "vnsh": {
         "command": "npx",
         "args": ["-y", "vnsh-mcp"],
         "env": {
           "VNSH_HOST": "https://vnsh.dev"
         }
       }
     }
   }
   ```

2. **Local dev server not running**: If using a local URL like `http://localhost:8787`, start the worker:
   ```bash
   cd worker && npm run dev
   ```

3. **Network issues**: Test connectivity:
   ```bash
   curl https://vnsh.dev/health
   ```

**Fix**: After updating config, **restart Claude Code** for changes to take effect.

### "MCP server not found"

1. Check MCP config path is correct
2. Ensure `dist/index.js` exists (run `npm run build`)
3. Restart Claude Code

### "Certificate error" (self-signed)

Add to MCP config:

```json
{
  "env": {
    "NODE_TLS_REJECT_UNAUTHORIZED": "0"
  }
}
```

### "Decryption failed"

- Verify URL was copied completely (including `#k=...&iv=...`)
- Check if blob has expired
- Ensure key/IV are valid hex strings

### Debugging

Enable verbose logging:

```bash
DEBUG=* node dist/index.js
```

Check Claude Code logs:

```bash
tail -f ~/.claude/debug/*.log
```
