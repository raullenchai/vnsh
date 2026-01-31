# API Reference

Base URL: `https://vnsh.dev` (or your self-hosted instance)

## Endpoints

### POST /api/drop

Upload an encrypted blob.

**Request:**

```http
POST /api/drop?ttl=24&price=0.01 HTTP/1.1
Content-Type: application/octet-stream
Content-Length: 1234

<binary encrypted data>
```

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `ttl` | integer | 24 | Time-to-live in hours (max: 168) |
| `price` | float | - | Price in USD for x402 payment |

**Response (201 Created):**

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "expires": "2024-01-24T12:00:00.000Z"
}
```

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 400 | `EMPTY_BODY` | Request body is required |
| 413 | `PAYLOAD_TOO_LARGE` | Maximum blob size is 25MB |
| 500 | `ID_COLLISION` | Failed to generate unique ID |
| 500 | `STORAGE_ERROR` | Failed to store blob |

---

### GET /api/blob/:id

Download an encrypted blob.

**Request:**

```http
GET /api/blob/a1b2c3d4-e5f6-7890-abcd-ef1234567890 HTTP/1.1
```

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `paymentProof` | string | JWT token proving payment (for paid blobs) |

**Response (200 OK):**

```http
HTTP/1.1 200 OK
Content-Type: application/octet-stream
Content-Length: 1234
Cache-Control: private, no-store, no-cache
X-Content-Type-Options: nosniff
X-Opaque-Expires: 2024-01-25T12:00:00.000Z

<binary encrypted data>
```

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 402 | `PAYMENT_REQUIRED` | Blob requires payment |
| 404 | `NOT_FOUND` | Blob not found or expired |
| 410 | `EXPIRED` | Blob has expired |

**402 Payment Required Response:**

```json
{
  "error": "PAYMENT_REQUIRED",
  "message": "This blob requires payment",
  "payment": {
    "price": 0.01,
    "currency": "USD",
    "methods": ["lightning", "stripe"]
  }
}
```

**Headers for 402:**

```http
X-Payment-Price: 0.01
X-Payment-Currency: USD
X-Payment-Methods: lightning,stripe
```

---

### GET /v/:id

Serve the viewer HTML directly. This preserves the URL fragment containing encryption keys.

**Request:**

```http
GET /v/a1b2c3d4-e5f6-7890-abcd-ef1234567890#k=...&iv=... HTTP/1.1
```

**Response (200 OK):**

```http
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
Cache-Control: no-cache
```

**Why not redirect?** HTTP redirects replace URL fragments instead of merging them. If we redirected to `/#v/:id`, the encryption keys (`#k=...&iv=...`) would be lost. Serving HTML directly preserves the fragment.

---

### GET /

Serve the unified app (landing page + upload + viewer overlay).

**Response (200 OK):**

```http
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
Cache-Control: public, max-age=3600
```

---

### GET /i

Serve the CLI install script.

**Response (200 OK):**

```http
HTTP/1.1 200 OK
Content-Type: text/plain; charset=utf-8
Cache-Control: public, max-age=3600

#!/bin/sh
# vnsh Installer
...
```

---

### GET /claude

Serve the Claude Code MCP integration installer.

**Response (200 OK):**

```http
HTTP/1.1 200 OK
Content-Type: text/plain; charset=utf-8
Cache-Control: public, max-age=3600

#!/bin/sh
# vnsh Claude Code Integration Installer
...
```

**Usage:**

```bash
curl -sL vnsh.dev/claude | sh
```

Configures Claude Code's MCP settings (`~/.claude.json`) to include vnsh-mcp server.

---

### GET /skill.md

Serve the OpenClaw skill definition for agent integration.

**Response (200 OK):**

```http
HTTP/1.1 200 OK
Content-Type: text/markdown; charset=utf-8
Cache-Control: public, max-age=3600

---
name: vnsh
version: 1.0.0
...
```

This endpoint provides a SKILL.md file compatible with OpenClaw/Moltbot agents, enabling bot-to-bot encrypted file sharing.

---

### GET /health

Health check endpoint.

**Response (200 OK):**

```json
{
  "status": "ok",
  "service": "vnsh"
}
```

---

### GET /robots.txt

Search engine crawler rules.

**Response (200 OK):**

```
User-agent: *
Allow: /

Sitemap: https://vnsh.dev/sitemap.xml
```

---

### GET /sitemap.xml

Sitemap for search engines.

**Response (200 OK):**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://vnsh.dev/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
```

---

### OPTIONS (any path)

CORS preflight handler.

**Response (204 No Content):**

```http
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
Access-Control-Max-Age: 86400
```

---

## CORS Headers

All API responses include:

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
Access-Control-Max-Age: 86400
```

---

## Error Format

All errors follow this format:

```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable description"
}
```

---

## Rate Limits

(Implemented via Cloudflare Rules)

| Endpoint | Limit | Window |
|----------|-------|--------|
| POST /api/drop | 10 requests | 1 minute |
| GET /api/blob/:id | 100 requests | 1 minute |

---

## Examples

### Upload with curl

```bash
# Generate key and IV
KEY=$(openssl rand -hex 32)
IV=$(openssl rand -hex 16)

# Encrypt content
echo "Hello World" | openssl enc -aes-256-cbc -K $KEY -iv $IV > encrypted.bin

# Upload
RESPONSE=$(curl -s -X POST \
  --data-binary @encrypted.bin \
  -H "Content-Type: application/octet-stream" \
  "https://vnsh.dev/api/drop")

# Parse response
ID=$(echo $RESPONSE | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

# Build URL
echo "https://vnsh.dev/v/${ID}#k=${KEY}&iv=${IV}"
```

### Download with curl

```bash
# Extract components from URL
URL="https://vnsh.dev/v/abc123#k=deadbeef...&iv=cafebabe..."
ID=$(echo $URL | sed 's|.*/v/||' | sed 's|#.*||')
KEY=$(echo $URL | sed 's|.*#k=||' | sed 's|&.*||')
IV=$(echo $URL | sed 's|.*&iv=||')

# Fetch and decrypt
curl -s "https://vnsh.dev/api/blob/${ID}" | \
  openssl enc -d -aes-256-cbc -K $KEY -iv $IV
```

### Upload with JavaScript (Browser)

```javascript
async function upload(content) {
  // Generate key and IV
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(16));

  // Import key
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key, { name: 'AES-CBC' }, false, ['encrypt']
  );

  // Encrypt
  const plaintext = new TextEncoder().encode(content);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv }, cryptoKey, plaintext
  );

  // Upload
  const response = await fetch('/api/drop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: ciphertext
  });
  const { id } = await response.json();

  // Build URL
  const keyHex = Array.from(key).map(b => b.toString(16).padStart(2, '0')).join('');
  const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${location.origin}/v/${id}#k=${keyHex}&iv=${ivHex}`;
}
```

### Download with JavaScript (Browser)

```javascript
async function download(url) {
  // Parse URL
  const urlObj = new URL(url);
  const id = urlObj.pathname.split('/v/')[1];
  const params = new URLSearchParams(urlObj.hash.slice(1));
  const keyHex = params.get('k');
  const ivHex = params.get('iv');

  // Convert hex to bytes
  const key = new Uint8Array(keyHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const iv = new Uint8Array(ivHex.match(/.{2}/g).map(b => parseInt(b, 16)));

  // Fetch blob
  const response = await fetch(`/api/blob/${id}`);
  const ciphertext = await response.arrayBuffer();

  // Import key and decrypt
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key, { name: 'AES-CBC' }, false, ['decrypt']
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv }, cryptoKey, ciphertext
  );

  return new TextDecoder().decode(plaintext);
}
```
