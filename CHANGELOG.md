# Changelog

All notable changes to vnsh are documented in this file.

## [Unreleased]

---

## [2.3.0] - 2026-02-18

### Added
- **Usage analytics**: Lightweight KV-based daily counters tracking uploads/downloads by client source. `GET /api/stats?token=SECRET` endpoint for viewing 30 days of metrics (90-day TTL auto-expiry).
- **X-Vnsh-Client headers**: All clients now send source attribution headers (cli, cli-npm, mcp, extension, web, pipe) for per-source analytics.
- **`npx vnsh` zero-install**: npm package renamed from `vnsh-cli` to `vnsh` v2.0.0, enabling `echo "hello" | npx vnsh` with no global install.
- **Canonical glossary**: `docs/glossary.md` as single source of truth for all user-facing terminology.

### Changed
- **Terminology standardization**: Replaced all "zero-knowledge" references with "Host-Blind" across website, blog posts, docs, extension, README, and store assets. "Zero-Knowledge Proof" is a specific cryptographic protocol; vnsh uses client-side encryption.
- **Blog slug rename**: `zero-knowledge-sharing-for-ai-coding` → `host-blind-sharing-for-ai-coding`, `zero-knowledge-encryption-in-chrome-extension` → `host-blind-encryption-in-chrome-extension`.
- Homepage install section updated: `npx vnsh` as primary, curl as secondary.
- All `vnsh-cli` references updated to `vnsh` across docs, README, SKILL.md, CLI README.

### Published
- `vnsh@2.0.0` on npm

---

## [2.2.0] - 2026-02-18

### Added
- **Web Viewer extension CTA**: Prominent "Add vnsh to Chrome" card with Chrome logo on all `/v/` viewer pages. Auto-hides when extension is detected, dismissible with localStorage persistence.
- **Homepage Extension tab**: 4th tab on vnsh.dev homepage showing AI Debug Bundle, Inline Decryption, Right-Click Share features with install button.
- **Blog infrastructure**: `/blog` index and `/blog/:slug` routes with SEO meta tags, OG tags, and sitemap integration.
- **5 SEO blog posts**:
  - "Why Your AI Coding Assistant Shouldn't See Your Secrets in Plaintext"
  - "Debug CI Failures Faster with vnsh + Claude Code"
  - "How We Implemented Host-Blind Encryption in a Chrome Extension"
  - "One-Click AI Debug Bundles: Packaging Browser Context for LLMs"
  - "Why URL Fragments Are the Best Place to Hide Encryption Keys"
- **Compact tab layouts**: Redesigned Terminal, Agent, and Extension tabs to fit content without scrolling. Agent manual setup collapsed into `<details>`.
- **Marquee promo template**: 1400x560 HTML template and generated PNG for Chrome Web Store Featured badge nomination.
- **Referrer-Policy header**: `no-referrer` on viewer and homepage responses to prevent fragment leakage.
- **Extension detection**: Content script sets `data-vnsh-ext` attribute on `<html>` for CTA auto-hide.

### Changed
- R2 orphan blob cleanup, rate limiting, and scaling plan moved from unreleased to infrastructure (shipped in prior deploys).
- Cleaned up roadmaps: removed completed items from `docs/scaling-revenue.md` and `extension/PLAN.md`.

### Growth
- Chrome Web Store Featured badge nomination submitted.
- PRs to 5 curated GitHub lists: awesome-chrome, Awesome-WebExtensions, awesome-privacy, chrome-privacy-extensions, awesome-chrome-extensions.

---

## [2.1.0] - 2026-02-14

### Added
- **Chrome Extension v1.0.0**: Full-featured Manifest V3 Chrome Extension for encrypted sharing
  - Right-click context menu: "Share via vnsh", "AI Debug Bundle", "Share image", "Save to vnsh"
  - AI Debug Bundle: one-click capture of screenshot + console errors + selected text + page URL into a single encrypted link
  - Popup panel with 3 tabs: Share (text input, file drag & drop, TTL), Saved (local snippets), History (recent shares with expiry countdown)
  - Screenshot sharing via `Cmd+Shift+S`
  - Link enhancement: hover preview tooltips on vnsh links (GitHub, Slack, Discord, Notion, Linear, Stack Overflow, Reddit, X/Twitter, Claude AI, ChatGPT)
  - Keyboard shortcuts: `Cmd+Shift+D` (debug bundle), `Cmd+Shift+S` (screenshot)
  - First-install onboarding with guided tutorial
  - 48 tests, 93%+ statement coverage
- **Privacy policy page**: `GET /privacy` route on vnsh.dev Worker for Chrome Web Store compliance
- **Chrome Web Store assets**: HTML templates + Puppeteer generator for store icon, screenshot, and promo tile

### Technical Details
- AES-256-CBC via WebCrypto API, byte-identical with CLI and MCP implementations
- v1 + v2 URL format support
- Zero runtime dependencies, IIFE bundles via Vite
- Content script scoped to specific developer sites (not `<all_urls>`) for faster CWS review
- Offscreen document fallback for clipboard on restricted pages

---

## [2.0.0] - 2026-02-14

### Added
- **v2 URL Format**: Compact URLs that are ~40% shorter (~95 chars vs ~160 chars)
  - 12-character base62 IDs (replacing 36-char UUIDs)
  - 64-character base64url secret (key+iv combined, replacing `#k=...&iv=...`)
- `generateShortId()` in Worker for base62 ID generation
- `base64urlToBuffer()` / `bufferToBase64url()` in MCP crypto utilities
- `hex_to_base64url()` / `base64url_to_hex()` in CLI

### Changed
- CLI version bumped to 2.0.0
- MCP version bumped to 1.2.0
- All components now output v2 format URLs
- Updated skill.md examples to v2 format
- Updated README.md with v2 URL documentation

### Backward Compatibility
- Full support for v1 URLs (`#k=...&iv=...`) in all components
- Existing links continue to work without any changes

---

## [1.2.0] - 2026-01-24

### Added

#### Official MCP Registry Support
vnsh-mcp is now published to the [Official MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.raullenchai/vnsh`. Added `mcpName` field and `server.json` for registry verification.

#### Enhanced "For Claude" Copy Button
The "For Claude" button now copies an AI-friendly prompt with brand mention and instructions:
```
Here is context shared securely via vnsh.dev:
https://vnsh.dev/v/abc123#k=...&iv=...

(Note to AI: Fetch and read the link content. The data is end-to-end encrypted and auto-expires in 24h.)
```

#### GitHub Action for CI/CD
Added reference to [upload-to-vnsh](https://github.com/raullenchai/upload-to-vnsh) GitHub Action in README. Debug CI failures with Claude in one click.

### Changed

#### vnsh-mcp Version Bump
- `vnsh-mcp` updated to v1.0.1 with MCP Registry support

#### CLI Read Command
Added `vn read <url>` command to the shell-installed CLI. Now it can decrypt and display content from vnsh URLs.

```bash
vn read "https://vnsh.dev/v/abc123#k=...&iv=..."
```

---

## [1.1.0] - 2026-01-24

### Added

#### Version and Help Flags
Added `--version` / `-v` and `--help` / `-h` flags to the CLI for better discoverability.

```bash
vn --version  # Output: vn 1.1.0
vn --help     # Shows full usage information
```

#### Stdin Size Check
The CLI now checks stdin input size before encryption (previously only checked file size). Large stdin inputs (>25MB) now fail gracefully with a helpful error message instead of failing at upload time.

### Changed

#### Improved POSIX Portability
- Replaced `bc` dependency with `awk` for size calculations (fixes Alpine Linux and minimal containers)
- Added trap-based cleanup for temp files to prevent plaintext leakage if process is killed

### Fixed

#### Temp File Security
Added `trap` for automatic temp file cleanup on EXIT/INT/TERM signals. Previously, if the process was killed between decryption and cleanup, the plaintext temp file would persist on disk.

---

## [1.0.0] - 2026-01-23

### Added
- Initial release
- Host-blind encrypted file sharing
- CLI tool (`vn` command)
- MCP server for Claude Code integration
- Web viewer with client-side decryption
- 24-hour default TTL with configurable expiry (1-168 hours)
- x402 payment protocol support (proposed)
