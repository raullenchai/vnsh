# vnsh Chrome Extension - Implementation Plan

## Context

vnsh's user entry points were CLI + MCP, covering only terminal users. The Chrome Extension aims to:
1. **Lower the barrier** — share encrypted content from the browser without installing CLI
2. **Create a viral loop** — every shared link is vnsh exposure
3. **AI-native** — not just "format a prompt" but one-click packaging of developer debug context for AI

Positioning: **Developer AI debugging assistant + encrypted sharing tool**.

---

## Implementation Status

| Phase | Status | Description |
|-------|--------|-------------|
| Phase 0: Scaffolding | Done | Directory structure, package.json, tsconfig, vite, manifest, icons |
| Phase 1: Core Library | Done | crypto.ts, url.ts, api.ts, storage.ts, bundle.ts, constants.ts + tests |
| Phase 2: Service Worker | Done | 4 context menus, debug bundle, screenshot, clipboard, shortcuts, notifications |
| Phase 3: Popup UI | Done | 3-tab layout (Share/Saved/History), dark theme, file drag & drop |
| Phase 4: Content Script | Done | Link detector, MutationObserver, hover tooltip with decrypted preview |
| Phase 5: Onboarding | Done | Guided first-install tutorial, `chrome.runtime.onInstalled` trigger |
| Phase 6: Testing & Packaging | Done | 48 tests, 93%+ coverage, Chrome Web Store submission |

### Remaining (v1.1+)
- Web Viewer CTA: extension install banner on vnsh.dev viewer pages
- AI Platform Integration: inject vnsh button on claude.ai / chatgpt.com input areas
- Share analytics: badge notification when shared links are viewed

---

## Growth Strategy

### Acquisition

**Core engine: Web Viewer -> Extension conversion**
- Every vnsh link recipient opens the Web Viewer
- Add extension install CTA on viewer pages ("Install extension -> share back in one click")
- Extension installs scale directly with shared link opens
- Requires Worker changes: add Extension Install Banner to viewer HTML (show only when extension not detected)

**First-install Onboarding** (Done)
- `chrome.runtime.onInstalled` opens onboarding page
- Guided tutorial: "Select code below -> Right-click -> Share via vnsh"
- Instant aha moment without needing to find content

### Growth - "AI Debug Bundle" is the killer feature

**Problem**: A generic "Share for AI" just prepends a prompt to a link. Not worth installing an extension.

**Solution**: "AI Debug Bundle" — one-click packaging of complete debug context:

| Content | Source |
|---------|--------|
| Page screenshot | `chrome.tabs.captureVisibleTab` |
| Console errors | `chrome.scripting.executeScript` injection |
| Selected text/code | Selection API |
| Current URL + page title | `tab.url` + `tab.title` |
| User description | Popup input |

All packaged as JSON -> encrypted -> uploaded -> one link -> paste to AI with full context.

**Core differentiator**: No other tool offers "one-click bug context packaging for AI".

### Retention

**Solution 1: Snippet Collector** (Done)
- "Save to vnsh" context menu item (local only, no upload)
- Popup "Saved" tab shows collected snippets
- One-click share from saved snippets
- Transforms from "sharing tool" to "collect + share tool"

**Solution 2: Share analytics** (Future)
- Badge notification when links are viewed
- "Your shared link was viewed 3 times" — feedback loop

---

## MVP Features

### Feature 1: Right-click Context Menu (Done)
- **"Share via vnsh"** — select text -> encrypt -> upload -> copy link
- **"AI Debug Bundle"** — selected text + console errors + screenshot + URL -> encrypted link
- **"Share image via vnsh"** — right-click image -> encrypt -> upload -> copy link
- **"Save to vnsh"** — select text -> save locally (no upload)

### Feature 2: Popup Panel (Done)
- **Share tab**: text input + file drag & drop + TTL selection + Share / Debug Bundle buttons
- **Saved tab**: local snippet list, one-click share or delete
- **History tab**: recent shares (max 50), expiry countdown
- Dark theme, monospace, matches vnsh brand (#22c55e, Geist Mono)

### Feature 3: Screenshot Share (Done)
- Popup "Screenshot" button -> capture visible area -> encrypt -> upload -> copy link

### Feature 4: Link Enhancement (Done)
- Content script detects `vnsh.dev/v/` links on specific sites
- Sites: GitHub, GitLab, Slack, Discord, Notion, Linear, Stack Overflow, Reddit, X/Twitter, Claude AI, ChatGPT, vnsh.dev
- Hover shows decrypted preview tooltip (text first 500 chars / image thumbnail)
- MutationObserver for dynamic content

### Feature 5: AI Platform Integration (Future - v1.1)
- Detect claude.ai / chatgpt.com pages
- Inject vnsh button near AI input areas
- Show recent shares / saved links, one-click insert into AI conversation

---

## Technical Architecture

### Directory Structure
```
extension/
  manifest.json
  tsconfig.json
  package.json
  build.ts              # Vite build script (IIFE bundles per entry point)
  vitest.config.ts      # Test config with coverage
  src/
    lib/
      crypto.ts          # AES-256-CBC encrypt/decrypt (WebCrypto)
      api.ts             # fetch wrapper for /api/drop, /api/blob/:id
      url.ts             # v1+v2 URL parsing & construction
      storage.ts         # chrome.storage.local: shares history + saved snippets
      bundle.ts          # AI Debug Bundle: package screenshot + errors + text
      constants.ts       # VNSH_HOST, patterns, limits
    background/
      service-worker.ts  # Context menus, screenshot, message hub, debug bundle
    content/
      detector.ts        # Link detection + tooltip injection
      detector.css       # Tooltip styles
    popup/
      popup.html
      popup.ts
      popup.css
    offscreen/
      offscreen.html     # Clipboard writes from service worker
      offscreen.ts
    onboarding/
      onboarding.html    # First-install guided tutorial
      onboarding.ts
      onboarding.css
    assets/
      icon-16.png
      icon-32.png
      icon-48.png
      icon-128.png
  store-assets/
    generate.mjs         # Puppeteer script to generate PNGs from HTML templates
    icon-128.html/png    # Store icon (128x128)
    screenshot-1280x800.html/png  # Store screenshot (1280x800)
    promo-440x280.html/png        # Small promo tile (440x280)
    privacy-practices.md           # CWS Privacy tab answers
  tests/
    crypto.test.ts       # 13 tests
    url.test.ts          # 9 tests
    api.test.ts          # 8 tests
    storage.test.ts      # 11 tests
    bundle.test.ts       # 7 tests
```

### Manifest V3
```json
{
  "manifest_version": 3,
  "name": "vnsh — Encrypted Sharing for AI",
  "version": "1.0.0",
  "permissions": ["contextMenus", "activeTab", "notifications", "storage", "scripting", "offscreen"],
  "host_permissions": ["https://vnsh.dev/*"],
  "content_scripts": [{
    "matches": [
      "https://*.github.com/*", "https://*.gitlab.com/*",
      "https://*.slack.com/*", "https://*.discord.com/*",
      "https://*.notion.so/*", "https://*.linear.app/*",
      "https://*.stackoverflow.com/*", "https://*.stackexchange.com/*",
      "https://*.reddit.com/*", "https://*.twitter.com/*", "https://*.x.com/*",
      "https://*.claude.ai/*", "https://*.chatgpt.com/*",
      "https://*.vnsh.dev/*", "https://vnsh.dev/*"
    ]
  }]
}
```

### Key Architecture Decisions

1. **Console error capture**: `chrome.scripting.executeScript` injects a script that captures `console.error` entries. Injected on-demand when debug bundle is triggered, not persistent.
2. **Bundle size control**: Screenshots compressed to JPEG quality 60, max 20 console errors, total bundle capped at 5MB.
3. **Crypto runs locally everywhere**: Both service worker and content script use WebCrypto directly. No message passing for crypto operations.
4. **Clipboard via `chrome.scripting.executeScript`**: Executes `navigator.clipboard.writeText()` in the active tab. Falls back to offscreen document for restricted pages (chrome://).
5. **Link detection via MutationObserver**: Each link processed only once (WeakSet tracking). Scans only newly added subtrees.
6. **Saved snippets are local-only**: `chrome.storage.local`, never uploaded. Consistent with vnsh's privacy philosophy.
7. **Content script scoped to specific sites**: Avoids `<all_urls>` to prevent Chrome Web Store "Broad Host Permissions" review delay.

---

## Crypto

Port from existing implementations, byte-identical output:
- **Reference**: `mcp/src/crypto.ts` — Node.js crypto (encrypt/decrypt/URL parse)
- **Reference**: `worker/src/index.ts` — WebCrypto encrypt/decrypt
- v2 URL format: `key(32B) + iv(16B)` -> base64url -> 64 chars
- Validated against `tests/crypto-vectors.json`

### AI Debug Bundle Format
```json
{
  "version": 1,
  "type": "debug-bundle",
  "timestamp": "2026-02-14T12:00:00Z",
  "url": "https://example.com/app/dashboard",
  "title": "My App - Dashboard",
  "selected_text": "TypeError: Cannot read property 'map' of undefined",
  "console_errors": [
    { "message": "Uncaught TypeError: ...", "source": "app.js:142", "timestamp": 1234567890 }
  ],
  "screenshot_base64": "iVBORw0KGgo...",
  "user_note": "This happens when I click the filter button"
}
```

---

## Verification Plan

1. **Crypto**: Encrypt with extension -> `vn read` CLI decrypts -> content matches
2. **URL interop**: Extension URL opens in vnsh.dev web viewer
3. **Context menu share**: Right-click text on GitHub -> Share -> clipboard link -> open -> see text
4. **AI Debug Bundle**: On a page with JS errors -> Debug Bundle -> link -> open -> see structured debug view
5. **Screenshot**: Popup -> Screenshot -> link -> open -> see image
6. **Save snippet**: Right-click -> Save -> Popup -> Saved tab -> see snippet -> Share -> link works
7. **Link preview**: Page with vnsh link on GitHub/Slack -> hover -> tooltip shows decrypted content
8. **Onboarding**: Fresh install -> onboarding page opens -> guided tutorial works
9. **Tests**: `cd extension && npm test` — 48 tests pass, 93%+ coverage
