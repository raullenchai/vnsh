# Chrome Web Store — Privacy Practices Answers

Copy these into the Privacy tab of the Developer Dashboard.

Everything here is written to be true rather than convenient. Two answers are
deliberately less flattering than the previous version of this file, and both
are explained where they appear — a declaration that quietly overstates is worse
than one that admits a limit, because the store checks it against the code.

---

## Single purpose description

```
Share content from a page — selected text, a screenshot, console errors, or a debug bundle — as a single link to a vnsh workspace, and preview vnsh links inline. Content is encrypted in the browser before upload by default, so vnsh cannot read it, and every workspace is deleted 24 hours after its last edit.
```

---

## Permission justifications

### contextMenus justification

```
Registers four right-click menu items: "Share via vnsh" (share selected text), "AI Debug Bundle" (package selected text, console errors and a screenshot into one link), "Share image" (share a right-clicked image), and "Save to vnsh" (store selected text locally for later). These are the primary ways users interact with the extension.
```

### activeTab justification

```
Reads the active tab only in response to an explicit user action — a right-click menu item or a keyboard shortcut. Used to capture a visible-area screenshot, to read the page URL and title for a debug bundle, and to read the text the user selected. Nothing is read from tabs the user has not acted on.
```

### notifications justification

```
Shows a brief confirmation after an action the user started — "Link copied to clipboard", "Screenshot shared" — or reports a failure such as "Upload failed". No promotional or tracking content.
```

### storage justification

```
Uses chrome.storage.local for two things: a list of links the user has created, so they can be re-copied from the popup, and text fragments the user explicitly saved with "Save to vnsh". Both stay on the device. Nothing is synced and nothing is transmitted.
```

### scripting justification

```
Injects a small script into the active tab, on user action only, to read the current text selection and to collect console errors already recorded on the page for a debug bundle. It is not injected on page load and does not run in the background.
```

### offscreen justification

```
Creates an offscreen document to write to the clipboard. A Manifest V3 service worker has no DOM, so clipboard access requires one. It is used for nothing else.
```

### Host permission justification

```
Access to https://vnsh.dev/* is required to reach the vnsh API: creating a workspace, reading one back for an inline link preview, and updating one. vnsh.dev is our own service and no other host is contacted. Decryption keys are held in the URL fragment, which is never transmitted, so the server receives ciphertext it cannot read — except for workspaces the user has explicitly chosen to publish unencrypted (see Data usage).
```

---

## Are you using remote code?

Select: **No, I am not using remote code.**

All code ships inside the package. Nothing is fetched and executed — no remote
scripts, no `eval`, no `new Function`, no WebAssembly from the network.
Encryption uses the built-in Web Crypto API. The only host contacted is
`vnsh.dev`, and only for data, never for code.

---

## Data usage

**What user data do you collect or transmit?**

Check **Website content**. Leave every other box unchecked.

This differs from the earlier version of this file, which checked nothing. That
was wrong. When a user shares a selection, a screenshot or a debug bundle, the
extension is collecting text and images from the page and transmitting them to
`vnsh.dev`. That the payload is normally ciphertext changes *who can read it* —
it does not change the fact that website content leaves the device. The honest
answer is to declare it and explain the handling.

Do **not** check: personally identifiable information, health, financial,
authentication, personal communications, location, web history, or user
activity. None of those are read. There is no analytics, telemetry, or tracking
of browsing behaviour of any kind.

**Explanation to include:**

```
Website content is transmitted only when the user explicitly asks for it — via a right-click menu item, a keyboard shortcut, or the popup — and never automatically. By default the content is encrypted in the browser with AES-256-GCM before upload, and the decryption key is placed in the URL fragment, which browsers never send to a server. The developer therefore cannot read what is shared by default.

One exception, chosen by the user per item and never the default: the popup offers "Readable without a key", which uploads that item unencrypted so that automated tools holding no key can read it. The checkbox says plainly that vnsh can read anything shared that way. It is off unless ticked.

Every workspace is deleted 24 hours after its last edit. There is no account, no profile, and no record retained beyond that window.
```

---

## Data usage certification

Check: **I certify that my data usage complies with the Developer Program Policies.**

---

## If a reviewer asks

The source is public at <https://github.com/raullenchai/vnsh> under MIT; the
extension lives in `extension/` and builds with `npm ci && npm run build`. The
protocol, including the key schedule, is documented at
<https://vnsh.dev/llms.txt>. Every claim above is checkable against both.
