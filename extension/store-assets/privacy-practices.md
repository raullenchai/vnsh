# Chrome Web Store — Privacy Practices Answers

Copy-paste these into the Privacy tab of the Chrome Web Store Developer Dashboard.

---

## Single purpose description

```
Encrypt and share text, screenshots, and debug context via ephemeral, self-destructing URLs on vnsh.dev. All encryption happens locally in the browser — the server never sees your data.
```

---

## Permission justifications

### contextMenus justification

```
Registers four right-click menu items: "Share via vnsh" (share selected text), "AI Debug Bundle" (package selected text + console errors + screenshot into one encrypted link), "Share image" (encrypt and share a right-clicked image), and "Save to vnsh" (save selected text locally for later sharing). These are the primary ways users interact with the extension.
```

### activeTab justification

```
Accesses the currently active tab to: (1) capture a visible-area screenshot for screenshot sharing and debug bundles, (2) read the page URL and title to include in debug bundles, and (3) get selected text from the page when triggered via context menu. Only accessed in response to explicit user actions (right-click menu or keyboard shortcut).
```

### notifications justification

```
Displays brief browser notifications to confirm successful actions (e.g., "Link copied to clipboard", "Screenshot shared") or to report errors (e.g., "Upload failed"). Notifications are only triggered by explicit user actions and contain no tracking or promotional content.
```

### storage justification

```
Uses chrome.storage.local to store: (1) share history — a list of recently created vnsh URLs so users can re-copy them from the popup, and (2) saved snippets — text fragments the user explicitly saved via "Save to vnsh" for later sharing. All data is stored locally on the user's device. Nothing is synced or transmitted externally.
```

### scripting justification

```
Injects small scripts into the active tab for two purposes: (1) capture console error messages when the user triggers "AI Debug Bundle" — the script reads recent console.error entries so they can be included in the encrypted debug package, and (2) write the generated vnsh URL to the clipboard via navigator.clipboard.writeText(). Scripts are only injected in response to explicit user actions (context menu click or keyboard shortcut), never automatically.
```

### offscreen justification

```
Creates an offscreen document solely as a fallback clipboard mechanism. When the active tab is a restricted page (chrome://, edge://, browser internal pages) where content script injection is blocked, the offscreen document provides an alternative way to copy the generated vnsh URL to the clipboard. It is only created when needed and closed immediately after use.
```

### Host permission justification

```
Requires access to https://vnsh.dev/* to communicate with the vnsh API: POST /api/drop to upload encrypted blobs, and GET /api/blob/{id} to download encrypted blobs for link preview tooltips. vnsh.dev is our own service. No other hosts are accessed. The extension never sends decryption keys to the server — all encryption and decryption happens locally.
```

---

## Are you using remote code?

Select: **No, I am not using remote code**

All code is bundled within the extension package. No external JavaScript, WebAssembly, or remotely-hosted code is loaded or executed. Encryption uses the built-in Web Crypto API.

---

## Data usage

**What user data do you plan to collect from users now or in the future?**

Check **NONE** of the boxes. The extension does not collect:

- [ ] Personally identifiable information
- [ ] Health information
- [ ] Financial and payment information
- [ ] Authentication information
- [ ] Personal communications
- [ ] Location
- [ ] Web history
- [ ] User activity
- [ ] Website content

All data the extension processes (text, screenshots, console errors) is encrypted locally before upload. The server receives only encrypted binary blobs — it cannot read the content. Decryption keys exist only in the URL fragment and never leave the user's browser. No analytics, telemetry, or tracking of any kind is implemented.

---

## Data usage certification

Check the box: **I certify that my data usage complies with the Developer Program Policies.**
