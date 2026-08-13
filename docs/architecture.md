# Architecture overview

vnsh gives a mutable document one address that people and AI agents can share.
The default workspace tier is host-blind: clients encrypt and decrypt locally,
while the service stores bytes and concurrency metadata in R2.

## Components

| Component | Responsibility |
|---|---|
| `worker/` | Cloudflare Worker API, browser UI, public-content serving, retention cleanup |
| `cli/npm/` | Cross-platform Node CLI for workspace and legacy blob operations |
| `mcp/` | MCP tools used by AI clients to create, read, update, and open workspaces |
| `extension/` | Chrome link previews and diagnostic capture bundles |
| R2 `VNSH_STORE` | Object bodies plus expiry, version, visibility, type, and authorization metadata |

No database or KV namespace is required. Native rate-limit bindings protect read
and write paths without adding storage writes. Analytics Engine is optional and
does not participate in correctness.

## Encrypted workspace protocol (v2)

The client generates a random 32-byte root secret `S` and derives two independent
values:

```text
K = HKDF-SHA256(S, "vnsh/enc/v2")
W = HKDF-SHA256(S, "vnsh/write/v2")
H = SHA-256(W)
```

`K` encrypts each version with AES-256-GCM and a fresh random 12-byte nonce. The
stored body is `nonce || ciphertext || authentication-tag`. `W` authorizes
writes; only `H` is stored. Keys are carried after `#` in the URL, and URL
fragments are not sent in HTTP requests.

```text
read/write: https://vnsh.dev/w/{id}#w={S}
view-only:  https://vnsh.dev/w/{id}#r={K}
```

The read-only property is cryptographic. A holder of `K` can decrypt every
version but cannot recover `S` or derive `W`.

### Create

1. Client derives `K`, `W`, and `H`, then encrypts locally.
2. Client sends ciphertext to `POST /api/workspace` with
   `X-Vnsh-Write-Hash: H`.
3. Worker creates an R2 object at version 1 and returns its ID and expiry.
4. Client constructs read/write and view-only fragment URLs.

### Read

1. Client requests `GET /api/workspace/{id}`; no key is transmitted.
2. Worker streams the stored body and returns the current version as `ETag`.
3. Client derives or reads `K`, authenticates, and decrypts locally.

### Update

1. Client reads the current version and locally encrypts the replacement with a
   new nonce.
2. Client sends `PUT /api/workspace/{id}` with `X-Vnsh-Write: W` and
   `If-Match: {version}`.
3. Worker hashes `W`, verifies it against stored `H`, and conditionally writes.
4. Missing preconditions return 428; stale versions return 412; invalid write
   tokens return 403.

## Public workspaces

A public workspace is an explicit alternative for content that ordinary HTTP
clients must read without local decryption. Its body is plaintext, so vnsh can
read it. Visibility is selected at creation and cannot be changed by an update.

Public documents are served at `https://vnshcontent.dev/p/{id}`, a separate
registrable domain. This contains the reputation impact of user-authored,
top-level documents. It is separate from the runtime sandbox boundary: public
responses also use a CSP sandbox and `default-src 'none'`, blocking same-origin
privileges and network access.

`CONTENT_HOST` selects this domain. When unset, a self-hosted deployment can
serve public content from the primary host. `LEGACY_PUBLIC_UNTIL` defines the
temporary compatibility window for old primary-host `/p/` links; after it closes
that route returns 410 and does not redirect.

## Legacy one-shot blobs (v1)

The immutable `/v/{id}#k={key}&iv={iv}` format remains for compatibility and
custom-TTL one-shot sharing. Clients encrypt with AES-256-CBC and PKCS#7 padding,
then upload through `POST /api/drop`; reads use `GET /api/blob/{id}`. CBC describes
only this legacy format, not mutable workspaces.

## Worker routes

| Method | Route | Purpose |
|---|---|---|
| GET | `/` | Browser upload UI |
| GET | `/health` | Health check |
| GET | `/llms.txt` | Agent-facing protocol and setup instructions |
| POST | `/api/workspace` | Create a workspace |
| GET | `/api/workspace/{id}` | Read body and version |
| PUT | `/api/workspace/{id}` | Conditional replacement |
| POST | `/api/workspace/{id}/renew` | Authorized expiry renewal |
| GET | `/w/{id}` | Encrypted workspace viewer |
| GET | `/p/{id}` | Public document, restricted by host policy |
| POST | `/api/drop` | Create a legacy one-shot blob |
| GET | `/api/blob/{id}` | Read a legacy blob |
| GET | `/v/{id}` | Legacy browser viewer |
| POST | `/api/event` | Best-effort product event ingestion |

The content domain is routed before this normal table and exposes only public
documents, its root explainer, robots policy, and security contact.

## Storage and retention

R2 is the single source of truth. An object's custom metadata records fields such
as creation/expiry time, workspace version, write hash, visibility, and content
type. Reads reject expired objects. Successful workspace writes refresh expiry;
a scheduled handler removes expired objects as storage cleanup.

Default retention is 24 hours after the latest successful write. Supported
explicit TTL values may extend to seven days. Sharing the complete URL shares the
key, and repeated writes can keep a workspace alive, so encryption does not
replace link hygiene or retention policy.

## Security boundaries

The design protects plaintext from the hosting service and prevents unauthorized
or stale workspace writes. It does not protect against a compromised client,
someone forwarding a complete fragment URL, or metadata disclosure such as
timestamps, sizes, IP-derived rate-limit keys, and access patterns.

Rendered encrypted content is placed in an iframe with `sandbox="allow-scripts"`
but without `allow-same-origin`. An injected `default-src 'none'` policy prevents
network access. This keeps untrusted content from reading the parent fragment key
or exfiltrating decrypted data.

See `docs/api.md` for exact headers and response shapes, `docs/operations.md` for
production procedures, and the ADRs in `docs/adr/` for security decisions.
