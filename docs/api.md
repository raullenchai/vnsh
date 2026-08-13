# API Reference

Base URL: `https://vnsh.dev` (or your self-hosted instance)

Public workspaces are served from a second domain, `https://vnshcontent.dev`,
which answers `/p/{id}` and nothing else — no API. See
[`architecture.md`](architecture.md#two-domains) for why. Never assemble a public
URL yourself; the create and update responses return the exact one.

The full protocol, complete enough to reimplement, is at
<https://vnsh.dev/llms.txt>.

## Workspace endpoints

### POST /api/workspace

Create a workspace. Body is the ciphertext (`nonce(12) || ciphertext || tag(16)`,
AES-256-GCM) or, for a public workspace, the content as written.

| Header | Required | Meaning |
|---|---|---|
| `X-Vnsh-Write-Hash` | yes | `SHA-256` of the write token, hex. The server never receives the token itself. |
| `X-Vnsh-Public: 1` | no | Publish unencrypted. Never inferred; fixed at creation. |
| `Authorization: Bearer ...` | no | Account token. Authenticated creates are retained until deleted. |
| `X-Vnsh-Kind: artifact` | no | Index the document as an artifact and use `/artifact/{id}` links in clients. |

| Query | Meaning |
|---|---|
| `?ttl=` | Lifetime in hours, 1..168 (7 days). Default 24. Same parameter and cap as `/api/drop`. Out of range falls back to the default rather than failing, because published clients have sent this for two major versions. |

```json
201 Created    ETag: "1"
{ "id": "k2p9xf...", "version": 1, "expires": "...", "public": true,
  "url": "https://vnshcontent.dev/p/k2p9xf..." }
```

`url` is present only for public workspaces. Use it verbatim — it is what keeps
both a hosted instance and a single-domain self-hosted one working.

For an authenticated create the response contains `"permanent": true` instead
of `expires`. Its R2 content is still ciphertext unless `X-Vnsh-Public: 1` was
explicitly sent. Account storage contains ownership metadata, never the URL
fragment or content key.

## Account endpoints

The browser account lives at `https://account.vnsh.dev` and uses a 15-minute,
single-use email magic link. A signed-in user can create a CLI/agent bearer token
there and set it as `VNSH_TOKEN`.

- `GET /api/account/documents` lists the current user's workspace/artifact metadata.
- `POST /api/account/token` creates a bearer token and shows it once.
- `GET /api/account/sessions` lists active browser sessions, CLI devices and agent tokens.
- `DELETE /api/account/sessions/{id}` revokes one session or token.
- `DELETE /api/account/documents/{id}` deletes an owned document from R2 and its index row.
- `GET /api/account/me` returns the bearer token's user plus current/history
  byte usage and free-preview limits.
- `DELETE /api/account/token/current` revokes the current bearer token.

The browser dashboard also supports revoking every other session and deleting
the complete account. Account deletion removes documents, retained versions,
sessions, pending device approvals and account rows.

CLI login uses a device flow: `POST /api/auth/device` returns a 10-minute user
code and verification URL; the browser approves it at `/device`, while the CLI
polls `POST /api/auth/device/token`. A successful exchange is single-use and
returns a one-year revocable bearer token. Pending polls return `202`.

Account sessions and tokens are stored only as SHA-256 hashes. The account index
cannot reconstruct a lost document link; keep the link because its fragment is
the only copy of the decryption/editing secret.

Free-preview accounts are limited to 100 documents and 1 GiB across current
objects plus retained versions. Creates or updates that would exceed either
limit return `403 ACCOUNT_QUOTA_EXCEEDED` with current usage and limits.

### GET /api/workspace/:id

Returns the stored bytes. `ETag` is the version. A public workspace comes back
with `X-Vnsh-Public: 1`, since a client that tried to decrypt plaintext would
report the author's own link as corrupt.

### PUT /api/workspace/:id

Replace the contents. Requires `X-Vnsh-Write` (the token) and `If-Match` (the
version you read). Answers `428` without `If-Match`, `412` on a stale version,
`403` on a bad token. Visibility is carried forward and cannot be changed by a
write. The response mirrors create, including `url` when public. The expiry is
renewed for the lifetime the workspace was created with, not for the default —
an edit must not silently demote a seven-day workspace to a one-day one.

### POST /api/workspace/:id/renew

Extend the expiry without changing the content. Requires `X-Vnsh-Write`; takes an
optional `?ttl=` (hours from now, same cap) and otherwise reuses the lifetime the
workspace already had.

The version is deliberately **not** bumped, and no `If-Match` is required: no
content changed, so an editor holding version 7 must not be handed a conflict
because someone pressed "keep this alive". Answers `403` on a bad token, `410`
once expired — expiry is deletion, so there is nothing to extend.

```json
200 OK    ETag: "7"
{ "id": "k2p9xf...", "version": 7, "expires": "..." }
```

### GET /api/workspace/:id/history

Lists up to 20 retained versions, including the current version, newest first.
The response contains version numbers, encrypted byte sizes, archive timestamps,
and a `current` marker. It never contains plaintext or key material.

### GET /api/workspace/:id/history/:version

Returns the retained ciphertext for one version with `X-Vnsh-Historical: 1` and
the requested version as its `ETag`. The same content key decrypts every version.

### POST /api/workspace/:id/history/:version/restore

Restores retained ciphertext as a new latest version. Requires `X-Vnsh-Write`
and the current version in `If-Match`. The version counter always moves forward:
restoring v2 while current is v7 creates v8. Concurrent changes return `412`.

### GET /p/:id

A public workspace as an ordinary document, on the content domain. No key, no
fragment, no JavaScript required. Served with a `sandbox` CSP directive — the
document loads into an opaque origin with no cookies, storage or network — plus
`X-Robots-Tag: noindex`.

## Endpoints

### POST /api/drop

Upload an encrypted blob.

**Request:**

```http
POST /api/drop?ttl=24 HTTP/1.1
Content-Type: application/octet-stream
Content-Length: 1234

<binary encrypted data>
```

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `ttl` | integer | 24 | Time-to-live in hours (max: 168) |

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
| 404 | `NOT_FOUND` | Blob not found or expired |
| 410 | `EXPIRED` | Blob has expired |

There is no paid tier and no 402. An earlier revision had one; see
[ADR-004](adr/004-payment-protocol.md) for why it was removed rather than
finished.

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

## Account Artifact API (Phase 1)

Account Artifacts are a separate, account-authorized collaboration mode. Their
content is not host-blind: vnsh can technically read it so authenticated Agents
can discover and collaborate without receiving a fragment key. Use anonymous
encrypted workspaces when the service must not be able to read the content.

All routes below live on `https://account.vnsh.dev`, require either the account
session cookie or `Authorization: Bearer <agent-token>`, and return
`Cache-Control: no-store`.

| Route | Purpose |
|---|---|
| `POST /api/artifacts` | Create a private permanent Artifact and immutable version 1. |
| `GET /api/artifacts` | List up to 100 Artifacts accessible to the current account principal. |
| `GET /api/artifacts/:uuid` | Read current metadata and string content. `ETag` is the version. |
| `PUT /api/artifacts/:uuid` | Create the next immutable version. Requires numeric `If-Match`. |
| `GET /api/artifacts/:uuid/versions` | List up to 100 newest immutable versions and their provenance. |
| `DELETE /api/artifacts/:uuid` | Delete all versions. Human browser session only. |

Signed-in humans use the Artifact Library at `/`. Each card opens
`/artifacts/:uuid`, a control shell with immutable version history and a
human-only delete action. Artifact content is rendered by
`/artifacts/:uuid/content?version=N` inside an iframe with both the HTML
`sandbox` attribute and a CSP sandbox. The rendered document has an opaque
origin and cannot run scripts, use account cookies/storage, submit forms, or
contact the network. Agents should continue to use the JSON API rather than
the browser shell.

Create and update bodies are JSON:

```json
{
  "title": "Launch readiness brief",
  "summary": "Production-verified release evidence",
  "artifactType": "report",
  "content": "<h1>Ready</h1>",
  "contentType": "text/html; charset=utf-8",
  "changeSummary": "Added production smoke evidence",
  "sourceRef": "https://github.com/raullenchai/vnsh/pull/66",
  "evidence": ["Worker tests passed", "40/40 smoke checks"],
  "harness": "Codex CLI",
  "model": "GPT-5"
}
```

`title` is required on create. `content` is always required in Phase 1 and is a
UTF-8 string; binary Artifact support is a later cross-client contract. Every
Artifact response includes `capabilities` for the authenticated principal.
Agent tokens currently receive `read`, `update`, and `request_review`; human
sessions additionally receive the reserved human-only capabilities such as
`approve`, `publish`, access management, and deletion. Review and publication
operations are introduced by their respective Phase 1 bricks and are not yet
callable in this contract slice.

### Account Workspaces

Account Workspaces are lightweight project containers, not Agent identities or
workflow membership. Every account has a default `Personal` Workspace. Existing
Account Artifacts are migrated into it, and creates that omit `workspaceId`
remain backward compatible by targeting Personal.

| Route | Purpose |
|---|---|
| `GET /api/workspaces` | List the account's active Workspaces and Artifact counts. |
| `POST /api/workspaces` | Create a Workspace. Human browser session only. |
| `GET /api/artifacts?workspace=:id&q=:text&status=:status&type=:type` | List or filter Account Artifacts by Workspace and searchable metadata. |

Include `"workspaceId": "..."` in an Artifact create body to select a
Workspace. Artifact URLs do not contain the Workspace ID, so moving or
reorganizing knowledge later will not invalidate an Artifact link. In this
phase, Workspace is only an organization and discovery boundary; scoped
read/edit capability links are a separate authorization layer.

### Artifact capability links

A signed-in human can create revocable, single-Artifact handoff links. The
random token is shown once and stored only as a SHA-256 hash; listing links
never returns the secret URL.

| Route | Purpose |
|---|---|
| `GET /api/artifacts/:uuid/capabilities` | List link metadata and active/revoked state. Human only. |
| `POST /api/artifacts/:uuid/capabilities` | Create a `read` or `edit` link. Human only. |
| `DELETE /api/artifacts/:uuid/capabilities/:capabilityId` | Revoke a link immediately. Human only. |
| `GET /c/:token` | Return current content directly; HTML browsers receive a sandbox viewer. |
| `HEAD /c/:token` | Return content type, ETag, title, Workspace name and authority headers. |
| `PUT /c/:token` | Create a new immutable version through an edit link. Requires `If-Match`. |

Capability GET responses expose authority in `X-Vnsh-Capability: read|edit`
and never enumerate the containing Workspace. Edit bodies use the same JSON
shape as authenticated Artifact updates. A read link receives `403 READ_ONLY`
for PUT. Revoked and unknown links both return 404. Capability links authorize
only one Artifact and are deliberately independent of Agent identity.

`artifactType` is one of `document`, `report`, `code`, `app`, or `handoff`.
Every version records the authenticated session/token principal and whether it
was a human browser session or Agent token. `harness` and `model` are optional
client annotations, not authenticated claims; history responses return them
under `clientAnnotations` with `verified: false`. Evidence is bounded to 20
strings so an Agent cannot turn version metadata into an unbounded context dump.

Updates use optimistic concurrency:

```http
PUT /api/artifacts/7c12... HTTP/1.1
Authorization: Bearer ...
If-Match: "3"
Content-Type: application/json
```

A stale version returns `412 VERSION_CONFLICT`; an unconditional update returns
`428 PRECONDITION_REQUIRED`. Content versions are immutable R2 objects while D1
stores the authorized current pointer, lifecycle status, provenance, and quota
accounting.

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
