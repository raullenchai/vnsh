# vnsh contributor context

vnsh is an ephemeral shared workspace for people and AI agents. Its design
principle is server-side blindness: encrypted workspace plaintext and keys never
reach the service. The repository is MIT licensed.

## Current product model

There are three link types:

- `/w/{id}#w={secret}` is an encrypted read/write workspace.
- `/w/{id}#r={key}` is an encrypted, cryptographically view-only workspace.
- `https://vnshcontent.dev/p/{id}` is an explicitly public workspace.

Encrypted workspaces use a random 32-byte root secret. HKDF-SHA256 derives an
AES-256-GCM content key and a separate write token. The service stores ciphertext
and SHA-256(write token), never either secret. Updates require `If-Match`, so a
stale client receives 412 rather than silently overwriting a newer version.

The legacy one-shot `/v/` blob format remains supported and uses AES-256-CBC with
its key and IV in the URL fragment. Do not describe CBC as the workspace format.

Workspaces expire 24 hours after the last successful write by default. A caller
may request a supported TTL up to seven days. R2 object data and custom metadata
are the source of truth; KV is no longer part of the runtime architecture.

## Repository

- `worker/`: Cloudflare Worker, R2 API, browser UI, public-content host, cleanup
- `cli/npm/`: Node CLI (`vn` and `vnsh`)
- `mcp/`: MCP server for workspace create/read/update/open and legacy share/read
- `extension/`: Chrome extension for previews and capture bundles
- `scripts/smoke.mjs`: production end-to-end verification

The Worker serves `vnsh.dev`. Explicitly public documents are isolated on the
separate registrable domain `vnshcontent.dev`. The content host is dispatched
before all normal routes and serves only its narrow public surface. The legacy
`vnsh.dev/p/` compatibility window is controlled by `LEGACY_PUBLIC_UNTIL`; after
the cutoff it intentionally returns 410 rather than redirecting.

## Development and deployment

From the repository root:

```bash
npm test
npm run dev
```

Deploy only through:

```bash
npm run deploy
```

The root command enters `worker/`, whose `predeploy` runs the Worker test suite
before Wrangler deploys. Do not call `wrangler deploy` directly and bypass that
gate. After deployment run:

```bash
node scripts/smoke.mjs
```

The production service uses the `VNSH_STORE` R2 binding, native
`UPLOAD_LIMITER` and `READ_LIMITER` bindings, and optional Analytics Engine
binding `VNSH_ANALYTICS`. Secrets belong in Wrangler secrets, never source or
`wrangler.toml`.

## Security invariants

- Never send fragment keys to the server or place them in logs.
- Never infer public visibility; it is an explicit, immutable creation choice.
- Keep rendered untrusted content in an opaque sandbox with networking disabled.
- Preserve conditional writes and constant-shape responses that avoid revealing
  whether a private workspace ID exists.
- Treat the CLI, MCP server, extension, and browser as security-sensitive clients:
  changes to crypto or URL formats require cross-client tests.

The canonical user-facing explanation is `README.md`; protocol details live in
`docs/api.md`, and the component/data-flow overview is in `docs/architecture.md`.
