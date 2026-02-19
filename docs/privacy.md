# Privacy Policy — vnsh Chrome Extension

**Effective Date:** February 14, 2026
**Last Updated:** February 14, 2026

## Overview

The vnsh Chrome Extension is built on a **host-blind architecture**. We cannot access, read, or decrypt your data.

## Data Encryption

All data is encrypted **locally in your browser** using AES-256-CBC via the Web Crypto API before any transmission. The decryption key is embedded in the URL fragment (`#...`) and is never sent to our servers.

The vnsh.dev server receives only:
- Encrypted binary blobs (unreadable ciphertext)
- Metadata: blob size, upload timestamp, expiration time

**The server is host-blind — it has no access to your data's content.**

## Data Storage

Encrypted blobs are stored temporarily on vnsh.dev servers with a default retention of 24 hours. After expiration, data is permanently deleted and mathematically irretrievable.

## Local Storage

The extension uses `chrome.storage.local` for:
- Saved snippets (local only, never synced)
- Share history (local only, never synced)

This data never leaves your device.

## Data Collection

We do **not** collect:
- Personal information
- Usage analytics or telemetry
- IP addresses (beyond standard HTTP server logs)
- Browsing history

We use **no** third-party tracking, analytics, or advertising services.

## Permissions

| Permission | Purpose |
|------------|---------|
| `contextMenus` | Right-click share and debug bundle actions |
| `activeTab` | Capture screenshot and selected text from current tab |
| `notifications` | Show confirmation after sharing |
| `storage` | Local snippet and history storage (device only) |
| `scripting` | Inject error collector for debug bundles |
| `offscreen` | Clipboard fallback on restricted pages |

## Open Source

The full source code is publicly available at [github.com/raullenchai/vnsh](https://github.com/raullenchai/vnsh). You can verify all privacy claims by reviewing the code.

## Contact

For privacy questions, open an issue: [github.com/raullenchai/vnsh/issues](https://github.com/raullenchai/vnsh/issues)

## License

MIT License.
