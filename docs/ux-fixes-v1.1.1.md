# UX Fixes v1.1.1

**Date**: 2026-01-24
**Based on**: [UX Review](./ux-review.md)

---

## Summary

Implemented 11 UX improvements across P0, P1, and P2 priorities to improve usability, trust signals, and mobile support.

---

## Changes Implemented

### P0 - Critical

#### 1. Styled Error Page for Invalid/Expired Links
**File**: `worker/src/index.ts`

**Before**: Raw JSON `{"error":"NOT_FOUND","message":"Endpoint not found"}`

**After**: Branded HTML error page with:
- vnsh logo and styling
- Clear message distinguishing expired vs not-found
- Explanation of 24h auto-expiry
- "Create New Link" button back to homepage

**Implementation**:
```typescript
function ERROR_HTML(code: string, message: string, status: number): string {
  const isExpired = code === 'EXPIRED' || status === 410;
  const title = isExpired ? 'Link Expired' : 'Link Not Found';
  // Returns full branded HTML page
}

function errorResponse(code: string, message: string, status: number, request?: Request): Response {
  const acceptHeader = request?.headers.get('Accept') || '';
  const isBrowser = acceptHeader.includes('text/html');
  if (isBrowser && (status === 404 || status === 410)) {
    return new Response(ERROR_HTML(code, message, status), {
      status,
      headers: { 'Content-Type': 'text/html' }
    });
  }
  // JSON response for API clients
}
```

---

### P1 - High Priority

#### 2. Copy Confirmation Toast Notifications
**File**: `worker/src/index.ts` (APP_HTML)

**Before**: No feedback when clicking copy buttons

**After**: Toast notification appears for 2 seconds showing "Copied to clipboard!"

**Implementation**:
```css
.toast {
  position: fixed;
  bottom: 2rem;
  left: 50%;
  transform: translateX(-50%) translateY(100px);
  background: #10b981;
  color: white;
  padding: 0.75rem 1.5rem;
  border-radius: 8px;
  font-size: 0.9rem;
  opacity: 0;
  transition: all 0.3s ease;
  z-index: 1000;
}
.toast.show {
  transform: translateX(-50%) translateY(0);
  opacity: 1;
}
```

```javascript
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}
```

#### 3. "For Claude" Button Tooltip
**File**: `worker/src/index.ts` (APP_HTML)

**Before**: No explanation of what "For Claude" copies

**After**: Tooltip on hover: "Copies URL with instruction for Claude to read this content"

**Implementation**:
```html
<button class="result-btn" onclick="copyForClaude()"
        data-tooltip="Copies URL with instruction for Claude to read this content">
  For Claude
</button>
```

```css
[data-tooltip] {
  position: relative;
}
[data-tooltip]:hover::after {
  content: attr(data-tooltip);
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  /* ... styling ... */
}
```

#### 4. Expiry Time on Upload Success
**File**: `worker/src/index.ts` (APP_HTML)

**Before**: Users didn't know links expire until viewing

**After**: Badge showing "🔥 Expires in 24 hours" next to result URL

**Implementation**:
```html
<div class="result-header">
  <span class="result-title">Secure Link Ready</span>
  <span class="expiry-badge">🔥 Expires in 24 hours</span>
</div>
```

#### 5. Security Information Visible
**File**: `worker/src/index.ts` (APP_HTML)

**Before**: Security details hidden in collapsed accordion

**After**: Security badge visible below main title

**Implementation**:
```html
<p class="security-badge">
  🔒 AES-256 encrypted · Server never sees your data · Auto-vaporizes in 24h
</p>
```

---

### P2 - Medium Priority

#### 6. URL Truncation with Toggle
**File**: `worker/src/index.ts` (APP_HTML)

**Before**: Full URL with long key/iv displayed, hard to read

**After**: Truncated URL with "Show full URL" / "Hide" toggle

**Implementation**:
```javascript
function truncateUrl(url) {
  const hashIndex = url.indexOf('#');
  if (hashIndex === -1) return url;
  const base = url.substring(0, hashIndex);
  const hash = url.substring(hashIndex);
  if (hash.length > 20) {
    return base + hash.substring(0, 20) + '...';
  }
  return url;
}
```

#### 7. MCP Explanation
**File**: `worker/src/index.ts` (APP_HTML)

**Before**: "MCP" jargon unexplained

**After**: Added explanation section in Agent (MCP) tab

**Implementation**:
```html
<div class="mcp-explanation">
  <strong>What is MCP?</strong> Model Context Protocol enables Claude to read vnsh links directly.
  Add this to your Claude config:
</div>
```

#### 8. CLI `vn read` Documentation
**File**: `worker/src/index.ts` (APP_HTML)

**Before**: Only upload examples shown

**After**: Added download/decrypt examples

**Implementation**:
```html
<div class="comment"># Download & decrypt</div>
<div><span class="prompt">$ </span>vn read https://vnsh.dev/v/a3f...#k=...</div>
<div class="output">→ outputs decrypted content</div>
<div><span class="prompt">$ </span>vn read URL > file.pdf</div>
<div class="output">→ saves binary to file</div>
```

#### 9. Install Methods (Removed Homebrew)
**File**: `worker/src/index.ts` (APP_HTML)

**Before**: Three install methods including `brew install raullenchai/vnsh/vnsh`

**After**: Two methods only (curl and npm) - removed personal Homebrew tap

**Reason**: Personal tap `raullenchai/vnsh` appears untrustworthy. Will add Homebrew back when eligible for Homebrew Core (requires 30+ GitHub stars).

**Implementation**:
```html
<div class="section-label">// 1. Install</div>
<div class="code-block" onclick="copyCommand('curl -sL vnsh.dev/i | sh', this)">
  <code><span class="prompt">$ </span>curl -sL vnsh.dev/i | sh</code>
</div>
<div class="code-block" onclick="copyCommand('npm install -g vnsh-cli', this)">
  <code><span class="prompt">$ </span>npm i -g vnsh-cli</code>
</div>
```

#### 10. MCP JSON Config Copy Button
**File**: `worker/src/index.ts` (APP_HTML)

**Before**: Users had to manually select and copy JSON

**After**: Copy button for MCP config block

**Implementation**:
```html
<button class="copy-config-btn" onclick="copyMcpConfig()">Copy Config</button>
```

```javascript
function copyMcpConfig() {
  const config = {
    "mcpServers": {
      "vnsh": {
        "command": "npx",
        "args": ["-y", "vnsh-mcp"]
      }
    }
  };
  navigator.clipboard.writeText(JSON.stringify(config, null, 2));
  showToast('MCP config copied!');
}
```

#### 11. Mobile File Picker
**File**: `worker/src/index.ts` (APP_HTML)

**Before**: Only drag/drop and paste - mobile users couldn't upload

**After**: Added clickable file input trigger

**Implementation**:
```html
<input type="file" id="fileInput" style="display: none;" onchange="handleFileSelect(event)">
<p class="paste-hint">⌘V / Ctrl+V to paste, drag & drop, or
  <span class="file-picker-link" onclick="document.getElementById('fileInput').click()">
    click to select file
  </span>
</p>
```

```javascript
function handleFileSelect(event) {
  const file = event.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = (e) => handleUpload(e.target.result, file.name);
    reader.readAsArrayBuffer(file);
  }
}
```

---

## Not Implemented

#### "Upload Another" Button (P2)
**Reason**: User explicitly requested to skip this fix.

---

## Deployment

```bash
cd worker && npx wrangler deploy
```

**Deployed Version**: `41047afa-81cd-4ad1-92ca-730f70f74ad0`

---

## Future Work

1. **Homebrew Core submission** - Once vnsh reaches 30+ GitHub stars, submit formula to homebrew-core for trusted distribution
2. **P3 fixes** - Lower priority polish items from UX review
