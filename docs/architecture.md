# Architecture Overview

## System Design

Opaque implements a **host-blind** architecture where the server acts as a "dumb pipe" — storing and serving encrypted blobs without any ability to decrypt or inspect them.

### Core Principle: Fragment-Based Key Transport

The critical security property relies on how browsers handle URL fragments:

```
https://opaque.dev/v/abc123#k=deadbeef...&iv=cafebabe...
                           └────────────────────────────┘
                           Fragment: NEVER sent to server
```

When a user visits this URL:
1. Browser sends request to `https://opaque.dev/v/abc123`
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
| POST | `/api/drop` | Upload blob |
| GET | `/api/blob/:id` | Download blob |
| GET | `/v/:id` | Viewer page (HTML) |
| OPTIONS | `*` | CORS preflight |

**Bindings:**

- `OPAQUE_STORE` (R2 Bucket): Stores encrypted blobs
- `OPAQUE_META` (KV Namespace): Stores metadata with TTL

### Viewer (`/viewer`)

Static HTML/JS for browser-based encryption/decryption.

```
viewer/
└── index.html    # Upload page (also embedded in worker)
```

**Features:**

- Drag & drop file upload
- Text paste input
- Client-side AES-256-CBC encryption via WebCrypto
- Copy URL / Open viewer buttons

### CLI (`/cli`)

Zero-dependency shell script using `openssl` and `curl`.

```
cli/
└── oq            # Executable script
```

**Commands:**

- `oq <file>` — Encrypt and upload file
- `oq` (stdin) — Encrypt and upload piped input
- `oq read <url>` — Fetch and decrypt URL
- `oq --local` — Output encrypted blob without upload

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
| `opaque_read` | Decrypt and read content from Opaque URL |
| `opaque_share` | Encrypt content and upload, return URL |

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

All three clients produce identical ciphertext:

| Platform | Library | Compatibility |
|----------|---------|---------------|
| CLI | OpenSSL CLI | Reference implementation |
| Browser | WebCrypto | PKCS#7 via SubtleCrypto |
| MCP | Node.js crypto | createCipheriv/createDecipheriv |

### URL Format

```
https://opaque.dev/v/{uuid}#k={key_hex}&iv={iv_hex}
                     │        │           │
                     │        │           └── 32 hex chars (16 bytes)
                     │        └────────────── 64 hex chars (32 bytes)
                     └─────────────────────── UUID v4
```

## Security Model

### Threat Model

**Protected Against:**

- Server compromise (DB dump, logs, backups)
- Network sniffing (fragment never transmitted)
- Cloudflare employee access (no plaintext exists)

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

## Future Considerations

### Planned Features

- **x402 Payment**: Pay-per-read with Lightning/Stripe
- **Burn-on-Read**: Self-destruct after first access
- **File Type Detection**: Magic byte analysis post-decryption

### Scalability

Current limits:

- Max blob size: 25MB (R2 single-request limit)
- Default TTL: 24 hours
- Max TTL: 7 days

For larger files, consider chunked upload or presigned URLs.
