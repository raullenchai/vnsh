# vnsh Glossary — Canonical Terminology

This is the **single source of truth** for all user-facing terminology across vnsh properties (website, README, blog posts, extension, CLI, MCP, docs). All contributors and AI agents must use these exact terms.

---

## Architecture & Security

| Term | Usage | Notes |
|------|-------|-------|
| **Host-Blind** | Primary security descriptor | The server stores encrypted blobs but never sees decryption keys. Use this, not "zero-knowledge" or "zero-access". |
| **Client-Side Encryption** | How encryption works | AES-256-CBC encryption happens entirely on the user's device before upload. |
| **AES-256-CBC** | Encryption algorithm | Always use the full name. Don't shorten to "AES-256" in technical contexts. "AES-256" is acceptable in taglines/badges. |
| **URL Fragment** | Key transport mechanism | Decryption keys travel in the URL fragment (`#`), which per RFC 3986 is never sent to servers. Don't call this "end-to-end encryption" — that implies a recipient-side key exchange which vnsh doesn't do. |

### Terms to AVOID

| Don't Use | Why | Use Instead |
|-----------|-----|-------------|
| **Zero-Knowledge** | ZKP is a specific cryptographic protocol (proving a statement without revealing information). vnsh uses client-side encryption, not ZKPs. Using this term is technically inaccurate and undermines credibility with security-aware users. | **Host-Blind** |
| **Zero-Access** | Ambiguous — could mean many things. | **Host-Blind** |
| **End-to-End Encrypted** | E2EE implies key exchange between sender and recipient (like Signal). vnsh shares the key in the URL — anyone with the URL can decrypt. | **Client-Side Encrypted** |
| **Dead Drop** | Informal, doesn't convey the product value. | **Ephemeral Dropbox** |
| **Vibecoding** | Slang, not professional. | Remove entirely. |

---

## Product & Branding

| Term | Usage | Notes |
|------|-------|-------|
| **The Ephemeral Dropbox for AI** | Primary tagline | Use everywhere as the one-liner description. |
| **vnsh** | Product name | Always lowercase. Never "VNSH", "Vnsh", or "VnSh". |
| **vn** | CLI command | The shell command users type. Always lowercase monospace. |
| **Host-Blind Data Tunnel** | Technical product description | For docs and technical contexts. |

---

## Features

| Term | Capitalization | Notes |
|------|---------------|-------|
| **AI Debug Bundle** | Title Case | The Chrome Extension feature that packages screenshot + console errors + selected text + URL. Always capitalize. |
| **Burn-on-Read** | Title Case, hyphenated | Pro feature: content is deleted after first read. Both words capitalized. |
| **Web Viewer** | Title Case | The `/v/:id` page that decrypts and displays content in-browser. |

---

## Expiry / Lifecycle

| Context | Term | Example |
|---------|------|---------|
| Marketing / taglines | **Vaporizes** | "Vaporizes in 24h" |
| Technical docs / API | **Auto-expires** | "Content auto-expires after the configured TTL" |
| Time format (short) | **24h** | For badges, taglines, compact UI |
| Time format (prose) | **24 hours** | For sentences and documentation |

Don't use: "auto-destructs", "self-destructs", "disappears"

---

## Packages & Install

| Package | npm Name | Install Command | Binary |
|---------|----------|-----------------|--------|
| CLI (Node.js) | `vnsh` | `npx vnsh` or `npm i -g vnsh` | `vn`, `vnsh` |
| CLI (Bash) | N/A | `curl -sL vnsh.dev/i \| sh` | `vn` |
| MCP Server | `vnsh-mcp` | `npx vnsh-mcp` | `vnsh-mcp` |
| Chrome Extension | N/A | Chrome Web Store | N/A |
| GitHub Action | N/A | `raullenchai/upload-to-vnsh@v1` | N/A |
| Pipe (zero-install) | N/A | `bash <(curl -sL vnsh.dev/pipe)` | N/A |

Don't use: `vnsh-cli` (deprecated, renamed to `vnsh`)

---

## Client Identification Headers

| Client | `X-Vnsh-Client` Value |
|--------|-----------------------|
| Bash CLI | `cli/{version}` |
| npm CLI | `cli-npm/{version}` |
| MCP Server | `mcp/{version}` |
| Chrome Extension | `extension/{version}` |
| Web Upload | `web/1.0` |
| Pipe Script | `pipe/1.0` |
