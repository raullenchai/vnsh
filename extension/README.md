# vnsh Chrome Extension

One-click encrypted debug bundles for AI. Share text, screenshots, and console errors via ephemeral, end-to-end encrypted URLs.

**vnsh** encrypts everything in your browser before upload. The server is mathematically blind to your data. Links auto-expire in 24 hours.

## Features

### AI Debug Bundle
The killer feature: one keyboard shortcut (`Cmd+Shift+D`) packages your current page's full debug context into a single encrypted link:

- Page screenshot
- Console errors
- Selected text / code
- Current URL + page title
- Your description

Paste the link to any AI assistant (Claude, ChatGPT, etc.) and it gets the complete context.

### Right-Click Context Menu
- **Share via vnsh** - Encrypt and share selected text
- **AI Debug Bundle** - Full debug context capture
- **Share image via vnsh** - Encrypt and share any image
- **Save to vnsh** - Save snippets locally for later

### Popup Panel
- **Share tab** - Text input, file drag & drop, TTL selection
- **Saved tab** - Local snippet collection, one-click share
- **History tab** - Recent shares with expiry countdown

### Link Enhancement
Detects `vnsh.dev` links and shows a decrypted preview tooltip on hover. Runs on GitHub, GitLab, Slack, Discord, Notion, Linear, Stack Overflow, Reddit, X/Twitter, Claude AI, ChatGPT, and vnsh.dev. Uses MutationObserver for dynamic content.

### Keyboard Shortcuts
| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+D` | AI Debug Bundle |
| `Cmd+Shift+S` | Screenshot & share |

## Architecture

```
src/
  lib/                   # Shared library (crypto, API, storage)
    crypto.ts            # AES-256-CBC via WebCrypto API
    api.ts               # vnsh.dev API client
    url.ts               # v1+v2 URL parsing & construction
    storage.ts           # chrome.storage.local wrappers
    bundle.ts            # Debug bundle assembly
    constants.ts         # Configuration constants
  background/
    service-worker.ts    # Context menus, shortcuts, message hub
  content/
    detector.ts          # Link detection + tooltip preview
    detector.css         # Tooltip styles
  popup/
    popup.html/ts/css    # Extension popup UI
  offscreen/
    offscreen.html/ts    # Clipboard fallback for restricted pages
  onboarding/
    onboarding.html/ts/css  # First-install tutorial
  assets/
    icon-{16,32,48,128}.png
```

### Crypto

AES-256-CBC encryption via the WebCrypto API. Byte-identical output with OpenSSL CLI and Node.js `crypto` module.

- Key (32 bytes) and IV (16 bytes) are generated client-side
- Transmitted only in the URL fragment (`#`) which never reaches the server
- v2 URL format: `https://vnsh.dev/v/{id}#{base64url(key+iv)}`

### Build System

Each entry point is built as a self-contained IIFE bundle using Vite. No shared chunks, no ES module imports between files. This is required because Chrome extension content scripts can't use ES module imports.

## Development

### Prerequisites

- Node.js 20+
- npm

### Setup

```bash
git clone https://github.com/raullenchai/vnsh.git
cd vnsh/extension
npm install
```

### Commands

```bash
npm run build      # Type-check + build to dist/
npm test           # Run tests (vitest)
npm run test:watch # Run tests in watch mode
npm run package    # Build + create vnsh-extension.zip
```

### Load in Chrome

1. Run `npm run build`
2. Open `chrome://extensions/`
3. Enable "Developer mode" (top right)
4. Click "Load unpacked" and select the `dist/` directory
5. The vnsh icon appears in your toolbar

### Testing

```bash
# Run all tests (48 tests)
npm test

# Run with coverage (93%+ statements)
npm run test:cov

# Tests cover:
# - Crypto: encrypt/decrypt roundtrips, known vectors, unicode, wrong key detection
# - URL: v1/v2 parsing, building, roundtrip, validation
# - Bundle: creation, optional fields, size limits, detection, parsing
# - API: upload/download, error handling (404, 410, 402, 500), TTL params
# - Storage: history CRUD, snippet CRUD, expiry pruning, ID generation
```

## Publishing to Chrome Web Store

### One-time setup

1. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. Pay the one-time **$5 registration fee**
3. Complete identity verification

### Required materials

| Asset | Spec |
|-------|------|
| Extension icon | 128x128 PNG (included in build) |
| Screenshots | 1280x800 or 640x400, PNG/JPEG, 1-5 images |
| Privacy policy | Public URL (required since we make network requests) |
| Description | Short (132 char) + detailed (16K char max) |

### Submission steps

1. Build the zip: `npm run package`
2. Upload `vnsh-extension.zip` to the Developer Dashboard
3. Fill in the Store Listing (name, description, screenshots, category: "Developer Tools")
4. Fill in Privacy Practices (declare permissions, link privacy policy)
5. Set Distribution to Public (or Unlisted for beta)
6. Submit for review (typically 1-3 business days)

### Permission justifications

| Permission | Justification |
|------------|---------------|
| `contextMenus` | Right-click "Share via vnsh" and "AI Debug Bundle" actions |
| `activeTab` | Access current tab for screenshot capture and text selection |
| `notifications` | Show confirmation after sharing |
| `storage` | Save snippet collection and share history locally |
| `scripting` | Inject error collector for debug bundles, clipboard writes |
| `offscreen` | Clipboard fallback on restricted pages (chrome://, etc.) |
| `https://vnsh.dev/*` | Upload encrypted blobs and download for preview tooltips |

## Security

- **Host-blind**: The server stores encrypted blobs. It never sees keys, plaintext, or file types.
- **Client-side crypto**: AES-256-CBC encryption happens entirely in your browser via WebCrypto.
- **Fragment-only keys**: The decryption key is in the URL fragment (`#`), which browsers never send to servers.
- **Ephemeral**: Data auto-expires (default 24h). After expiry, the ciphertext is deleted from storage.
- **No analytics**: No tracking, no telemetry, no external scripts. Strict CSP.

### Store Assets

Pre-built Chrome Web Store assets are in `store-assets/`:

```bash
# Regenerate PNGs from HTML templates (requires puppeteer)
npm install puppeteer --no-save
node store-assets/generate.mjs
```

| File | Size | Purpose |
|------|------|---------|
| `icon-128.png` | 128x128 | Store icon |
| `screenshot-1280x800.png` | 1280x800 | Store screenshot |
| `promo-440x280.png` | 440x280 | Small promo tile |
| `privacy-practices.md` | - | CWS Privacy tab answers |

## Related

- [vnsh](https://github.com/raullenchai/vnsh) - CLI + MCP server + Cloudflare Worker
- [vnsh.dev](https://vnsh.dev) - Web viewer for decrypting vnsh links

## License

MIT
