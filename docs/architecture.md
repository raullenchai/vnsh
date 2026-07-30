# Architecture Overview

## System Design

vnsh implements a **host-blind** architecture where the server acts as a "dumb pipe" — storing and serving encrypted blobs without any ability to decrypt or inspect them.

### Core Principle: Fragment-Based Key Transport

The critical security property relies on how browsers handle URL fragments:

```
https://vnsh.dev/v/abc123#k=deadbeef...&iv=cafebabe...
                         └────────────────────────────┘
                         Fragment: NEVER sent to server
```

When a user visits this URL:
1. Browser sends request to `https://vnsh.dev/v/abc123`
2. Fragment (`#k=...&iv=...`) stays in browser, never transmitted
3. JavaScript extracts key/IV from `location.hash`
4. Blob is fetched and decrypted client-side

## Data Flow

### Write Path (Upload)

```
┌──────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────┐
│  Client  │───▶│  Generate   │───▶│   Encrypt   │───▶│  POST   │
│          │    │  Key + IV   │    │  AES-256-CBC│    │  /api/  │
│          │    │  (32B+16B)  │    │             │    │  drop   │
└──────────┘    └─────────────┘    └─────────────┘    └────┬────┘
                                                          │
                                                          ▼
┌──────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────┐
│  Return  │◀───│  Build URL  │◀───│  Store in   │◀───│  Worker │
│   URL    │    │  with #k=   │    │     R2      │    │         │
└──────────┘    └─────────────┘    └─────────────┘    └─────────┘
```

### Read Path (Browser)

```
┌──────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────┐
│  Visit   │───▶│  Extract    │───▶│  Fetch      │───▶│   GET   │
│   URL    │    │  #k= & #iv= │    │   Blob      │    │  /api/  │
│          │    │  from hash  │    │             │    │ blob/id │
└──────────┘    └─────────────┘    └─────────────┘    └────┬────┘
                                                          │
                                                          ▼
┌──────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────┐
│  Render  │◀───│  Decrypt    │◀───│  Receive    │◀───│  Worker │
│ Content  │    │  WebCrypto  │    │  Ciphertext │    │         │
└──────────┘    └─────────────┘    └─────────────┘    └─────────┘
```

### Read Path (CLI/MCP)

```
┌──────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────┐
│  Parse   │───▶│  Extract    │───▶│  Fetch      │───▶│   GET   │
│   URL    │    │  ID, Key,   │    │   Blob      │    │  /api/  │
│          │    │  IV         │    │             │    │ blob/id │
└──────────┘    └─────────────┘    └─────────────┘    └────┬────┘
                                                          │
                                                          ▼
┌──────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────┐
│  Output  │◀───│  Decrypt    │◀───│  Receive    │◀───│  Worker │
│  stdout  │    │  OpenSSL/   │    │  Ciphertext │    │         │
│          │    │  Node.js    │    │             │    │         │
└──────────┘    └─────────────┘    └─────────────┘    └─────────┘
```

## Component Architecture

### Worker (`/worker`)

Cloudflare Worker serving as the API layer.

```
worker/
├── src/
│   └── index.ts      # Router + all handlers
├── test/
│   └── api.test.ts   # Vitest unit tests
├── wrangler.toml     # Cloudflare configuration
└── package.json
```

**Routes:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Upload page (HTML) |
| GET | `/health` | Health check |
| GET | `/i` | CLI install script |
| GET | `/robots.txt` | Search engine rules |
| GET | `/sitemap.xml` | Sitemap for SEO |
| GET | `/og-image.png` | Social sharing image |
| POST | `/api/workspace` | Create a workspace |
| GET | `/api/workspace/:id` | Read one; `ETag` is the version |
| PUT | `/api/workspace/:id` | Replace one; needs `X-Vnsh-Write` and `If-Match` |
| GET | `/w/:id` | Workspace viewer (decrypts client-side) |
| GET | `/p/:id` | A public workspace, as a plain document — served on `vnshcontent.dev` |
| POST | `/api/event` | Page-reported conversions |
| POST | `/api/drop` | Upload a one-shot blob (v1) |
| GET | `/api/blob/:id` | Download a one-shot blob (v1) |
| GET | `/v/:id` | Blob viewer (preserves hash fragment) |
| OPTIONS | `*` | CORS preflight |

**Bindings:**

- `VNSH_STORE` (R2 Bucket): encrypted blobs and workspaces, with expiry and
  version carried in `customMetadata` — the single source of truth
- `UPLOAD_LIMITER` / `READ_LIMITER` (Rate Limit): native, in-colo, no storage writes
- `VNSH_ANALYTICS` (Analytics Engine, optional): usage counts; absent binding no-ops

### CLI (`/cli`)

Cross-platform POSIX shell script using `openssl` and `curl`. Works on macOS, Linux, WSL, and Git Bash.

**Install:**

```bash
curl -sL vnsh.dev/i | sh
```

**Commands:**

- `vn <file>` — Encrypt and upload file
- `echo "text" | vn` — Encrypt and upload piped input

### MCP Server (`/mcp`)

Model Context Protocol server for Claude Code integration.

```
mcp/
├── src/
│   ├── index.ts     # MCP server + tools
│   └── crypto.ts    # AES-256-CBC utilities
├── dist/            # Compiled output
└── package.json
```

**Tools:**

| Tool | Description |
|------|-------------|
| `vnsh_read` | Decrypt and read content from vnsh URL |
| `vnsh_share` | Encrypt content and upload, return URL |

## Storage Architecture

### R2 (Blob Storage)

- **Object Key**: UUID (e.g., `a1b2c3d4-e5f6-...`)
- **Content**: Raw encrypted bytes
- **Custom Metadata**: `createdAt`, `expiresAt` (ISO 8601)

### KV (Metadata)

- **Key**: `blob:{id}`
- **Value**: JSON `{ createdAt, expiresAt, hasPayment, priceUSD }`
- **TTL**: Matches blob expiry (auto-cleanup)

### Expiry Handling

1. KV entries auto-expire via Cloudflare's built-in TTL
2. Worker checks expiry timestamp as belt-and-suspenders
3. R2 lifecycle rules (optional) for orphan cleanup

## Encryption Details

### Algorithm: AES-256-CBC

- **Key Size**: 256 bits (32 bytes, 64 hex chars)
- **IV Size**: 128 bits (16 bytes, 32 hex chars)
- **Padding**: PKCS#7 (OpenSSL-compatible)

### Cross-Platform Compatibility

All clients produce identical ciphertext:

| Platform | Library | Compatibility |
|----------|---------|---------------|
| CLI | OpenSSL CLI | Reference implementation |
| Browser | WebCrypto | PKCS#7 via SubtleCrypto |
| MCP | Node.js crypto | createCipheriv/createDecipheriv |

### URL Format

```
https://vnsh.dev/v/{uuid}#k={key_hex}&iv={iv_hex}
                   │        │           │
                   │        │           └── 32 hex chars (16 bytes)
                   │        └────────────── 64 hex chars (32 bytes)
                   └─────────────────────── UUID v4
```

## Two Domains

Public workspaces are served from `vnshcontent.dev`; everything else — the API,
the viewer, the homepage, `llms.txt` — stays on `vnsh.dev`.

The split answers a threat that sandboxing cannot. Two are easy to conflate:

| | What it is | What stops it |
|---|---|---|
| **Escape** | Rendered content reaches the key, storage, or the network | An opaque origin: `sandbox` with no `allow-same-origin`, plus `default-src 'none'`. Already held before the split. |
| **Reputation** | A person or a crawler sees attacker-drawn pixels while the address bar reads `vnsh.dev` | Only the top-level URL being somewhere else. Sandboxing does nothing here. |

Reputation systems act on the registrable domain, so the blast radius of one
abusive page is not that page — it is the API, the site, and every CLI, MCP
server and extension already installed elsewhere, which would fail silently. A
subdomain does not help: `content.vnsh.dev` is the same registrable domain. The
prior art is the same shape (`claudeusercontent.com` for rendering,
`claude.site` for publicly shared artifacts).

`/w/` stays on the brand domain because its key lives in the URL fragment, which
HTTP never transmits: the server has never seen that plaintext and neither can a
crawler, so there is nothing to enumerate or index. The gate decides the domain.

Operationally:

- `CONTENT_HOST` names the public domain. Unset serves everything from one host,
  which is what a self-hosted instance wants.
- The content domain answers `/p/{id}`, `/robots.txt`, `/.well-known/security.txt`
  and a root explainer. Everything else 404s, including the whole API, and it is
  dispatched before any other route so a route added later is off it by default.
- Public responses carry `X-Robots-Tag: noindex`, enforced rather than hoped for.
- `LEGACY_PUBLIC_UNTIL` keeps `vnsh.dev/p/` answering for one workspace lifetime
  after a cutover, then 410 forever. Deliberately not a redirect: scanners can
  tag the *source* of a redirect that leads to bad content.

What the split does not buy: it does not stop abuse, it decides what abuse costs.
The public tier is readable by us and unmoderated, and the name still says vnsh,
so separation is clean for machines and only partial for people.

## Security Model

### Threat Model

**Protected Against:**

- Server compromise (DB dump, logs, backups)
- Network sniffing (fragment never transmitted)
- Cloudflare employee access (no plaintext exists)
- Subpoenas (server operator cannot produce plaintext)

**NOT Protected Against:**

- User sharing full URL publicly
- Client-side malware
- Compromised upload page (serve malicious JS)
- Timing attacks (metadata leakage)

### Metadata Leakage

The server knows:

- When blobs are uploaded/accessed
- Blob sizes (encrypted size ≈ plaintext + padding)
- IP addresses of uploaders/readers
- Access patterns (frequency, timing)

The server does NOT know:

- Content of blobs
- Content type (text, image, etc.)
- Relationship between blobs
- Who the intended recipients are

## Limits

| Resource | Limit |
|----------|-------|
| Max blob size | 25MB |
| Default TTL | 24 hours |
| Max TTL | 7 days (168 hours) |

## Future Considerations

### Planned Features

- **Burn-on-Read**: Self-destruct after first access
- **File Type Detection**: Magic byte analysis post-decryption
