<p align="center">
  <img src="https://vnsh.dev/logo.svg" alt="vnsh logo" width="120" />
</p>

<h1 align="center">vnsh</h1>

<p align="center">
  <strong>The Ephemeral Dropbox for AI</strong>
</p>

<p align="center">
  <a href="https://github.com/raullenchai/vnsh/actions"><img src="https://img.shields.io/github/actions/workflow/status/raullenchai/vnsh/test.yml?branch=main&style=flat-square" alt="Build Status"></a>
  <a href="https://www.npmjs.com/package/vnsh-cli"><img src="https://img.shields.io/npm/v/vnsh-cli?style=flat-square&label=vnsh-cli" alt="npm vnsh-cli"></a>
  <a href="https://www.npmjs.com/package/vnsh-mcp"><img src="https://img.shields.io/npm/v/vnsh-mcp?style=flat-square&label=vnsh-mcp" alt="npm vnsh-mcp"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
</p>

<p align="center">
  <a href="https://vnsh.dev">Website</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#self-hosting">Self-Hosting</a> •
  <a href="#api-reference">API</a>
</p>

---

## What is vnsh?

**Stop pasting walls of text into Claude.** Pipe your logs, diffs, and images into a secure, host-blind URL. The server sees nothing. The data vaporizes in 24 hours.

```bash
# Pipe anything to vnsh, get a secure link
git diff | vn
# https://vnsh.dev/v/a1b2c3d4...#k=...&iv=...
```

### Handles any context your AI needs:

- 🖼️ **Screenshots** — UI bugs, error dialogs, terminal output
- 📜 **Logs** — 5000+ lines of server errors (too long for copy-paste)
- 🔄 **Git Diffs** — Complex PR reviews, multi-file changes
- 📦 **Binaries** — PDFs, CSVs, config files, database dumps
- 🔧 **Debug Context** — Stack traces, environment dumps, crash reports

## Philosophy

> *"Built for the ephemeral nature of AI workflows. Once your session is done, the data should be too."*

Unlike Dropbox or pastebins, vnsh implements a **Zero-Access Architecture** with automatic vaporization:

| Layer | What Happens |
|-------|--------------|
| **Encryption** | AES-256-CBC encryption happens entirely on your device |
| **Transport** | Decryption keys travel only in the URL fragment (`#k=...`) — never sent to servers |
| **Storage** | Server stores encrypted binary blobs with zero knowledge of contents |
| **Vaporization** | Data auto-destructs after 24 hours. No history. No leaks. |

## Quick Start

### Option 1: Web Upload

Visit **[vnsh.dev](https://vnsh.dev)**, drag & drop a file, or paste text. Get an encrypted link instantly.

### Option 2: CLI Installation

**NPM** (recommended for Node.js users):
```bash
npm install -g vnsh-cli
```

**Homebrew** (macOS/Linux):
```bash
brew tap raullenchai/vnsh
brew install vnsh
```

**Shell script** (universal):
```bash
curl -sL https://vnsh.dev/i | sh
```

### CLI Usage

```bash
# Upload a file
vn secrets.env

# Pipe from stdin
cat crash.log | vn
docker logs app | vn
git diff HEAD~5 | vn

# Read/decrypt a URL
vn read "https://vnsh.dev/v/abc123#k=...&iv=..."

# Custom expiry (1-168 hours)
vn --ttl 1 temp-file.txt   # expires in 1 hour
```

### Option 3: Claude Code (MCP Integration)

**Native to Claude Code.** Unlike Dropbox, vnsh has a first-party MCP server. Claude can "see" inside your encrypted links without leaving the terminal.

Add to your Claude Code MCP settings:

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

Now Claude can:
- **Read** vnsh links automatically when you paste them
- **Share** large outputs via `vnsh_share` tool

## How It Works

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              YOUR DEVICE                                  │
│  ┌─────────┐    ┌──────────────┐    ┌─────────────────────────────────┐  │
│  │  Data   │───▶│ AES-256-CBC  │───▶│  Encrypted Blob + URL Fragment  │  │
│  └─────────┘    │  Encryption  │    │  https://vnsh.dev/v/id#k=...    │  │
│                 └──────────────┘    └─────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
                                           │
                           Only encrypted blob sent to server
                           (key stays in URL fragment, never transmitted)
                                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                           VNSH SERVER (BLIND)                             │
│                                                                           │
│   Receives: [encrypted binary blob]                                       │
│   Stores:   [encrypted binary blob]                                       │
│   Knows:    upload time, size, expiry                                     │
│   Cannot:   decrypt, identify content type, read keys                     │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

### URL Structure

```
https://vnsh.dev/v/a1b2c3d4-5678-90ab-cdef-1234567890ab#k=<64-char-key>&iv=<32-char-iv>
                  └──────────────────────────────────┘ └─────────────────────────────┘
                            Sent to server                    Never sent to server
                            (blob identifier)                 (decryption material)
```

## Self-Hosting

vnsh runs on Cloudflare Workers with R2 storage. Deploy your own instance:

### Prerequisites
- [Cloudflare account](https://cloudflare.com) with Workers & R2 enabled
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

### Deploy

```bash
# Clone the repository
git clone https://github.com/raullenchai/vnsh.git
cd vnsh/worker

# Install dependencies
npm install

# Create R2 bucket
wrangler r2 bucket create vnsh-store

# Deploy
wrangler deploy
```

### Configuration

Edit `wrangler.toml` to customize:

```toml
name = "vnsh"

[[r2_buckets]]
binding = "VNSH_STORE"
bucket_name = "vnsh-store"  # Your R2 bucket name

[[kv_namespaces]]
binding = "VNSH_META"
id = "your-kv-namespace-id"  # Create with: wrangler kv namespace create VNSH_META
```

## API Reference

### `POST /api/drop`

Upload an encrypted blob.

```bash
curl -X POST https://vnsh.dev/api/drop \
  -H "Content-Type: application/octet-stream" \
  --data-binary @encrypted.bin
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `ttl` | number | Time-to-live in hours (1-168, default: 24) |
| `price` | number | Payment required to access (x402 protocol) |

**Response:**
```json
{
  "id": "a1b2c3d4-5678-90ab-cdef-1234567890ab",
  "expires": "2025-01-25T00:00:00.000Z"
}
```

### `GET /api/blob/:id`

Download an encrypted blob.

```bash
curl https://vnsh.dev/api/blob/a1b2c3d4-5678-90ab-cdef-1234567890ab
```

**Response Codes:**
| Code | Description |
|------|-------------|
| 200 | Success — returns encrypted blob |
| 402 | Payment required |
| 404 | Not found |
| 410 | Expired |

### `GET /v/:id`

Web viewer redirect (preserves URL fragment).

### `GET /i`

CLI installation script.

## Security Model

### What vnsh Protects Against

✅ **Server Compromise** — Even with full server access, attackers cannot decrypt blobs
✅ **Database Leaks** — Stored data is indistinguishable from random noise
✅ **Traffic Analysis** — No content-type information stored
✅ **Subpoenas** — Server operator cannot produce plaintext (doesn't have keys)

### What vnsh Does NOT Protect Against

❌ **URL Sharing** — Anyone with the full URL (including `#fragment`) can decrypt
❌ **Client Compromise** — Malware on your device can intercept before encryption
❌ **MITM on Upload Page** — An attacker serving malicious JavaScript could intercept

### Recommendations

- Use vnsh over HTTPS only
- Don't share full URLs in public channels (Slack, Discord, Twitter)
- For maximum security, self-host the worker

## Project Structure

```
vnsh/
├── worker/          # Cloudflare Worker (storage API)
│   ├── src/
│   │   └── index.ts # Main worker code
│   └── test/
│       └── api.test.ts
├── mcp/             # MCP Server (Claude Code integration)
│   ├── src/
│   │   ├── index.ts # MCP tool handlers
│   │   └── crypto.ts # Encryption utilities
│   └── package.json
├── cli/
│   ├── vn           # Bash CLI script
│   ├── npm/         # NPM package (vnsh-cli)
│   │   ├── src/
│   │   │   ├── cli.ts
│   │   │   └── crypto.ts
│   │   └── package.json
│   └── install.sh   # Shell installer
├── homebrew-tap/    # Homebrew formula
│   └── Formula/
│       └── vnsh.rb
└── docs/            # Documentation
```

## Packages

| Package | Description | Install |
|---------|-------------|---------|
| [vnsh-cli](https://www.npmjs.com/package/vnsh-cli) | CLI tool | `npm i -g vnsh-cli` |
| [vnsh-mcp](https://www.npmjs.com/package/vnsh-mcp) | MCP server for Claude | `npx vnsh-mcp` |
| [homebrew-vnsh](https://github.com/raullenchai/homebrew-vnsh) | Homebrew tap | `brew install raullenchai/vnsh/vnsh` |

## Development

```bash
# Clone
git clone https://github.com/raullenchai/vnsh.git
cd vnsh

# Install dependencies
npm install
cd worker && npm install
cd ../mcp && npm install

# Run tests (143 tests, 82%+ coverage)
npm test

# Start local worker
cd worker && npm run dev

# Build MCP server
cd mcp && npm run build
```

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) before submitting a PR.

### Development Workflow

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Run tests (`npm test`)
4. Commit changes (`git commit -m 'Add amazing feature'`)
5. Push to branch (`git push origin feature/amazing-feature`)
6. Open a Pull Request

## License

MIT License — see [LICENSE](LICENSE) for details.

---

<p align="center">
  <sub>The Ephemeral Dropbox for AI. Your context. Your keys. Then it's gone.</sub>
</p>
