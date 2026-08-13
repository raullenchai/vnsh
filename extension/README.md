# vnsh Chrome Extension

One-click context sharing for people and AI Agents. Share text, files, screenshots,
and debug bundles as short-lived workspace links.

The popup offers two explicit modes:

- **Agent-ready (default):** anyone with the unguessable link can fetch the
  plaintext directly. The first share asks for confirmation because this mode
  is not encrypted.
- **Encrypted:** host-blind AES-256-GCM. The recipient needs vnsh or another
  local JavaScript-capable client; HTTP-only fetch tools cannot decrypt URL
  fragments.

Right-click and keyboard-shortcut shares remain encrypted because those paths
have no UI in which to confirm publishing plaintext. Shares use a configurable
24-hour, 3-day, or 7-day sliding retention window.

## Features

### AI Debug Bundle
One keyboard shortcut (`Cmd+Shift+D`) packages your current page's full debug context into a single encrypted link:

- Page screenshot
- Console errors
- Selected text / code
- Current URL + page title
- Your description

Paste it to an Agent with vnsh installed. For universal Agent compatibility,
create the bundle from the popup and choose Agent-ready.

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
    crypto.ts            # Legacy one-shot AES-256-CBC crypto
    workspace.ts         # Mutable workspace AES-256-GCM crypto
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

New encrypted workspaces use authenticated AES-256-GCM. Their read and owner
keys are generated client-side and live only in URL fragments. The extension
copies a `#r=` recipient link by default and keeps the `#w=` edit link as a
separately labelled History action. Legacy one-shot links remain readable.

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
# Run all tests
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

- **Explicit visibility**: Agent-ready links store plaintext; encrypted links are host-blind.
- **Client-side crypto**: encrypted workspaces use AES-256-GCM in WebCrypto.
- **Fragment-only keys**: The decryption key is in the URL fragment (`#`), which browsers never send to servers.
- **Ephemeral**: data auto-expires after the selected sliding retention window.
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
