# Security

vnsh handles content people expect nobody else to read, so this page tries to be
precise about what that does and does not mean, and how to tell us when it is
wrong.

## Reporting a vulnerability

Use [GitHub's private advisory form](https://github.com/raullenchai/vnsh/security/advisories/new).
It reaches the maintainers without the report being public first.

Please do not open a public issue for anything that would let someone read
content they should not, forge a write, or run script on `vnsh.dev`.

Include what you would want if you were on the other side: what you did, what
happened, and what you expected. A curl transcript or a short script is worth
more than a description. If you are unsure whether something is a bug or a
documented limitation, send it anyway — the list below is what we believe, not
what we have proved.

There is no bug bounty. This is a small open-source project. What you get is a
prompt reply, credit in the advisory unless you would rather not have it, and a
fix that names what was wrong.

## What is claimed

These are the properties the design is built to hold. If you break one, it is a
vulnerability.

- **The server cannot read encrypted content.** Content is encrypted in the
  client. The key travels in the URL fragment, which HTTP never sends. What is
  stored is ciphertext, an expiry, a version, and a SHA-256 of the write token.
- **The server cannot write to a workspace.** It receives only the hash of the
  write token, never the token, so it cannot forge one. Verifiable from outside:
  present a fabricated token and you get a 403.
- **A view-only link cannot become an edit link.** `#r=` carries
  `HKDF(secret, "vnsh/enc/v2")`, a one-way derivation. Recovering the secret
  from it, and so deriving a write token, should be infeasible.
- **A concurrent write cannot be lost silently.** Writes require `If-Match`.
  Unconditional writes are refused; stale ones are rejected with a 412 rather
  than overwriting.
- **Rendered content cannot reach the key or the network.** Workspace content is
  untrusted. It renders in a frame with `sandbox="allow-scripts"` and no
  `allow-same-origin`, so it runs in an opaque origin and cannot read
  `location.hash`, storage, or the embedding document. An injected
  `default-src 'none'` removes its network access. Public content is served with
  a `sandbox` directive in the response, so the same holds for a top-level page.
- **Content becomes unrecoverable after expiry.** Deleted 24 hours after the
  last write, with no history and no backup.

## What is not claimed

None of these are bugs. They are the shape of the thing.

- **Whoever holds a link can read it** — including the model provider behind an
  agent you hand it to. The URL is the credential; there is no account, no
  revocation, and no way to un-share. The 24-hour clock is what bounds this.
- **The boundary is the client, not the transport.** Whatever encrypts holds
  your plaintext first, and the vnsh CLI and MCP server both do. `npx -y`
  refetches the latest published version on every start; pin it, install it
  globally once, or build from source if you review what you run.
- **A public workspace is readable by vnsh.** That is the entire point of the
  tier. It is never the default and never inferred. Public workspaces are served
  from `vnshcontent.dev`, a separate registrable domain operated by this project,
  so that content written by users does not share a reputation with the API and
  the installed clients. They are still served with a `sandbox` directive, so
  each one loads into an opaque origin — the domain split is about whose name is
  on the page, not about what the page can reach.

- **Nobody is reviewing the public tier.** There is no moderation queue. Reports
  go to the same address as security reports; we can read and remove a public
  document, and cannot read an encrypted one at all.
- **Metadata is not private.** Request times, sizes and addresses exist for any
  hosted service. Only the content does not.
- **The server cannot moderate what it cannot read.** This is a consequence of
  the design, not an oversight.
- **An edit link forwarded to the wrong place is a compromise.** vnsh protects
  against a hostile or compelled server, not against a link pasted into a public
  channel.

## Cryptography

```
S = random(32)                        root secret, only ever in the fragment
K = HKDF-SHA256(S, "vnsh/enc/v2")     content key — AES-256-GCM
W = HKDF-SHA256(S, "vnsh/write/v2")   write token, sent as 64 hex chars
H = SHA-256(W)                        the only derived value the server stores
```

Workspaces use AES-256-GCM. One-shot blobs (`/v/`) predate them and use
AES-256-CBC for OpenSSL compatibility; they are immutable, so the integrity that
GCM adds matters less there, but new content should be a workspace.

Nonces are 96-bit, random per write, and prepended to the ciphertext — never
derived from a version number. Nonce reuse under GCM leaks the authentication
key, not merely the plaintext.

The full protocol is at <https://vnsh.dev/llms.txt>, complete enough to
reimplement. Doing so and comparing behaviour is a legitimate and welcome way to
look for bugs.

## Supported versions

Fixes go to the latest published version of each package. There are no long-term
support branches.

| Package | Where |
|---|---|
| `vnsh` (CLI) | [npm](https://www.npmjs.com/package/vnsh) |
| `vnsh-mcp` (MCP server) | [npm](https://www.npmjs.com/package/vnsh-mcp) |
| worker | deployed to `vnsh.dev` from `main` |
| extension | Chrome Web Store |
