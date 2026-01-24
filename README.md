# Opaque

**The Host-Blind Context Tunnel for AI Agents**

Opaque is a trustless infrastructure for securely sharing sensitive data (logs, diffs, configs, images) with AI agents via encrypted, ephemeral URLs. The server never sees your data.

## Philosophy

> "Server-Side Blindness, Client-Side Sovereignty"

Unlike generic pastebins, Opaque implements a **Zero-Access Architecture**:

- **Encryption**: Occurs purely on the client (CLI/Browser) using AES-256-CBC
- **Transport**: Decryption keys are transmitted via URL fragment (`#k=...`) — never sent to server
- **Storage**: Server stores opaque binary blobs with no knowledge of contents
- **Lifecycle**: Data is mathematically irretrievable after expiry (default 24h, max 7 days)

## Quick Start

### Upload via Web

Visit `https://opaque.dev` (or your self-hosted instance), drag & drop a file or paste text.

### Upload via CLI

```bash
# Install
curl -sL https://opaque.dev/install.sh | bash

# Upload a file
oq myfile.txt

# Upload from stdin
git diff | oq
cat error.log | oq

# Upload with 1-hour expiry
oq --ttl 1 temp.txt
```

### Read via CLI

```bash
oq read "https://opaque.dev/v/abc123#k=...&iv=..."
```

### Read via Claude Code (MCP)

Add to your project's `.mcp.json`:

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

Then Claude Code can use `opaque_read` and `opaque_share` tools automatically.

## Architecture

```
┌─────────────┐     ┌─────────────────┐     ┌─────────────┐
│   Client    │     │  Cloudflare     │     │     R2      │
│  (Browser/  │────▶│    Worker       │────▶│   Storage   │
│   CLI/MCP)  │     │  (Dumb Pipe)    │     │  (Blobs)    │
└─────────────┘     └─────────────────┘     └─────────────┘
      │                                            │
      │ Encrypt locally                            │ Stores encrypted
      │ Key in URL #fragment                       │ bytes only
      ▼                                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    HOST-BLIND GUARANTEE                      │
│  Server never sees: plaintext, keys, IVs, or content type   │
└─────────────────────────────────────────────────────────────┘
```

## Components

| Component | Description |
|-----------|-------------|
| `/worker` | Cloudflare Worker — blob storage API |
| `/viewer` | Static web UI — upload page |
| `/cli` | Shell script — `oq` command |
| `/mcp` | MCP server — Claude Code integration |
| `/tests` | Integration & crypto tests |

## Documentation

- [Architecture Overview](docs/architecture.md)
- [API Reference](docs/api.md)
- [CLI Usage](docs/cli.md)
- [MCP Server](docs/mcp.md)
- [Self-Hosting Guide](docs/self-hosting.md)

### Architecture Decision Records

- [ADR-001: AES-256-CBC Encryption](docs/adr/001-encryption-algorithm.md)
- [ADR-002: Key Transport via URL Fragment](docs/adr/002-url-fragment-keys.md)
- [ADR-003: Cloudflare R2 + KV Storage](docs/adr/003-storage-architecture.md)
- [ADR-004: x402 Payment Protocol](docs/adr/004-payment-protocol.md)
- [ADR-005: MCP Integration Design](docs/adr/005-mcp-integration.md)

## Security

Opaque protects against **server compromise** — even if an attacker gains full access to the server, they cannot decrypt stored blobs because:

1. Keys never touch the server (fragment is stripped by browsers)
2. No logs contain decryption material
3. Blobs are indistinguishable from random noise

**Opaque does NOT protect against:**

- User negligence (sharing full URL publicly)
- Client-side compromise (malware on user's device)
- Active MITM attacks on the upload page itself

## Development

```bash
# Start local worker
cd worker && npm install && npm run dev

# Run tests
cd tests && ./integration.sh http://localhost:8787

# Build MCP server
cd mcp && npm install && npm run build
```

## License

MIT / Business Source Available

---

Built for the age of AI agents. Your context, your control.
