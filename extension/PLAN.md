# vnsh Chrome Extension - Implementation Plan

## Context

vnsh 目前的用户入口是 CLI + MCP，只覆盖开发者中的终端用户。Chrome 插件的目标是：
1. **降低门槛** — 不装 CLI，浏览器里就能加密分享
2. **制造传播飞轮** — 每个分享出去的链接都是 vnsh 曝光
3. **AI-native** — 不只是"格式化 prompt"，而是一键打包开发者调试上下文给 AI

定位：**开发者的 AI 调试助手 + 加密分享工具**。

---

## Growth Strategy（增长设计先行）

### 获客（Acquisition）

**核心引擎：Web Viewer → 插件转化**
- 每个 vnsh 链接的接收者都会打开 Web Viewer
- **在 Web Viewer 页面加入插件安装 CTA**（"Install extension → share back in one click"）
- 这是获客的主通道，插件的安装量直接与分享链接的打开量挂钩
- 需要 Worker 端配合：在 viewer HTML 加入 Extension Install Banner（仅当检测到未安装插件时显示）

**行动项**：Phase 5 增加 Worker 端改动 — viewer 页面添加 extension install prompt。

**首次安装 Onboarding**
- 安装后自动打开一个 onboarding 页面（`chrome.runtime.onInstalled`）
- 页面内容："试试看 → 选中下面这段代码 → 右键 → Share via vnsh"
- 即时体验 aha moment，不用自己找内容

### 增长（Growth）—— "AI Debug Bundle" 是杀手功能

**问题**：普通的 "Share for AI" 只是在链接前加一句 prompt，这不值得装插件。

**解决**："AI Debug Bundle" — 一键打包当前页面的完整调试上下文：

| 打包内容 | 来源 |
|---------|------|
| 页面截图 | `chrome.tabs.captureVisibleTab` |
| Console errors | `chrome.scripting.executeScript` 注入脚本抓取 |
| 选中的文字/代码 | Selection API |
| 当前 URL + 页面标题 | `tab.url` + `tab.title` |
| 用户追加的描述 | Popup 输入框 |

全部打包成一个 JSON → 加密 → 上传 → 一个链接 → 粘贴给 AI，AI 拿到完整上下文。

**这是核心差异化**：没有其他工具能做到"一键把 bug 的所有上下文打包给 AI"。

**上下文意识（Context-aware content script）**
- 检测用户在 claude.ai / chatgpt.com 上时，在输入框旁注入一个小按钮 "📎 vnsh"
- 点击后展示最近分享的 vnsh 链接列表，一键插入到 AI 对话
- 这让 vnsh 成为 AI chat 的"附件系统"

### 留存（Retention）

**问题**：分享是低频行为，用一两次就忘了。

**解决 1：Snippet Collector（开发者剪贴板）**
- 右键菜单增加 "Save to vnsh"（不上传，仅本地加密存储）
- Popup 里有 "Saved" tab 显示收集的片段
- 随时可以一键分享已保存的片段
- 从"分享工具"变成"收集+分享工具"，日常使用频率更高

**解决 2：分享数据反馈**
- 后期（需要 Worker 配合）：链接被访问时，extension badge 显示通知
- "你分享的链接被查看了 3 次" — 创造反馈回路，让分享有成就感

---

## MVP Features（按增长优先级排序）

### Feature 1: Right-click Context Menu（获客核心）
- **"Share via vnsh"** — 选中文字 → 加密上传 → 复制链接
- **"AI Debug Bundle"** — 选中文字 + 自动抓取 console errors + 截图 + URL → 打包加密 → 复制带 AI prompt 的链接
- **"Share image via vnsh"** — 右键图片 → 加密上传 → 复制链接
- **"Save to vnsh"** — 选中文字 → 本地存储（不上传）

### Feature 2: Popup Panel（留存核心）
- **Share tab**: 文本输入 + 文件拖放 + TTL 选择 + "Share" / "AI Debug Bundle" 按钮
- **Saved tab**: 本地收集的片段列表，每条可一键分享或删除
- **History tab**: 最近分享的链接（最多50条），显示过期倒计时
- Dark theme，monospace，匹配 vnsh 品牌

### Feature 3: Screenshot Share（增长辅助）
- Popup → "Screenshot" 按钮 → 截取可见区域 → 加密上传 → 复制链接
- MVP 只做 visible area，选区截图后续迭代

### Feature 4: Link Enhancement（传播转化）
- Content script 检测 `vnsh.dev/v/` 链接
- Hover 显示解密预览 tooltip（文字前500字符 / 图片缩略图）
- Tooltip 底部 "Get vnsh extension" 品牌 + 安装链接
- MutationObserver 支持 Slack/GitHub/Discord 动态内容

### Feature 5: AI Platform Integration（差异化，可放 v1.1）
- 检测 claude.ai / chatgpt.com 页面
- 在 AI 输入框旁注入 "📎 vnsh" 按钮
- 点击展示最近分享 / 已保存的 vnsh 链接，一键插入

---

## Technical Architecture

### Directory Structure
```
vnsh-extension/
  manifest.json
  tsconfig.json
  package.json
  vite.config.ts
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
      collect-errors.ts  # Injected script: capture console.error entries
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
  tests/
    crypto.test.ts
    url.test.ts
    bundle.test.ts
```

### Manifest V3
```json
{
  "manifest_version": 3,
  "name": "vnsh - AI Debug Sharing",
  "version": "1.0.0",
  "description": "One-click encrypted debug bundles for AI. Share text, screenshots, console errors via ephemeral URLs.",
  "permissions": [
    "contextMenus",
    "activeTab",
    "clipboardWrite",
    "notifications",
    "storage",
    "scripting",
    "offscreen"
  ],
  "host_permissions": ["https://vnsh.dev/*"],
  "background": { "service_worker": "dist/background/service-worker.js" },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["dist/content/detector.js"],
    "css": ["dist/content/detector.css"],
    "run_at": "document_idle"
  }],
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": { "16": "assets/icon-16.png", "32": "assets/icon-32.png" }
  },
  "commands": {
    "debug-bundle": {
      "suggested_key": { "default": "Ctrl+Shift+D", "mac": "Command+Shift+D" },
      "description": "AI Debug Bundle - capture & share context"
    },
    "screenshot": {
      "suggested_key": { "default": "Ctrl+Shift+S", "mac": "Command+Shift+S" },
      "description": "Screenshot & share via vnsh"
    }
  }
}
```

### Build: Vite
- Zero runtime dependencies
- Entry points: service-worker, content script, popup, onboarding
- Output: IIFE bundles
- `npm run dev` → watch, `npm run build` → prod, `npm run package` → zip

### Crypto
Port from existing implementations, must be byte-identical:
- **Reference**: `mcp/src/crypto.ts` — Node.js crypto (encrypt/decrypt/URL parse)
- **Reference**: `worker/src/index.ts:2517-2524` — WebCrypto encrypt
- **Reference**: `worker/src/index.ts:2629-2681` — WebCrypto decrypt
- v2 URL format: `key(32B) + iv(16B)` → base64url → 64 chars
- Validate against `tests/crypto-vectors.json`

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
Web Viewer 检测到 `type: "debug-bundle"` 时，渲染为结构化调试视图（截图 + 错误列表 + 代码上下文）。

### Key Architecture Decisions

1. **Console error capture**: 通过 `chrome.scripting.executeScript` 注入脚本，用 `window.addEventListener('error')` + 覆盖 `console.error` 来收集错误。注入脚本在 debug bundle 触发时执行，不常驻。
2. **Bundle 大小控制**: 截图压缩为 JPEG quality 60，console errors 最多保留 20 条，总包控制在 5MB 以内。
3. **Crypto 不走消息传递** — service worker 和 content script 都有 WebCrypto，各自直接加解密。
4. **Clipboard 用 `chrome.scripting.executeScript`** — 在 active tab 执行 `navigator.clipboard.writeText()`，比 offscreen document 更简单。如果 tab 不可注入（chrome:// 页面），fallback 到 offscreen。
5. **Link detection 用 MutationObserver** — 每个 link 只处理一次 + 限定新增子树扫描。
6. **Saved snippets 纯本地** — `chrome.storage.local`，不上传不加密（已经在本地），保持 vnsh 的隐私理念。

---

## Implementation Order

### Phase 0: Scaffolding
- `extension/` 目录 + package.json + tsconfig + vite.config + manifest
- Icon assets

### Phase 1: Core Library
- `constants.ts`, `crypto.ts`, `url.ts`, `api.ts`, `storage.ts`
- Tests: crypto roundtrip + vector validation + URL parsing

### Phase 2: Service Worker + Context Menus
- 4 个 context menu: "Share via vnsh", "AI Debug Bundle", "Share image", "Save to vnsh"
- shareText, shareImage, saveSnippet 流程
- AI Debug Bundle: capture screenshot + inject error collector + package + encrypt + upload
- Clipboard handling（executeScript + offscreen fallback）
- Keyboard shortcuts
- Notifications

### Phase 3: Popup UI
- 3-tab layout: Share / Saved / History
- Share tab: text input + file drop + TTL + Share/Debug Bundle buttons
- Saved tab: snippet list + share/delete actions
- History tab: recent shares + copy + expiry countdown
- Dark theme matching vnsh brand

### Phase 4: Content Script
- Link detector + MutationObserver
- Hover tooltip with decrypted preview
- Tooltip branding + extension install link

### Phase 5: Onboarding + Web Viewer CTA
- `onboarding.html`: guided first-use tutorial
- `chrome.runtime.onInstalled` → open onboarding
- **Worker 改动**: Web Viewer 页面添加 extension install banner（检测 `chrome.runtime.sendMessage` 可达性判断是否已安装）

### Phase 6: Testing & Packaging
- Unit tests + integration tests
- Manual testing: context menu, popup, tooltips, debug bundle
- Chrome Web Store packaging

---

## Key Files to Reference (in vnsh repo)

| File | Purpose |
|------|---------|
| `mcp/src/crypto.ts` | Crypto reference: encrypt/decrypt, URL parse/build, base64url |
| `worker/src/index.ts:2507-2576` | WebCrypto encrypt + upload flow |
| `worker/src/index.ts:2629-2681` | WebCrypto decrypt + render flow |
| `worker/src/index.ts:2883-2896` | base64url / hexToBytes helpers |
| `worker/src/index.ts:2587-2594` | "For Claude" prompt format |
| `tests/crypto-vectors.json` | Cross-platform crypto test vectors |

---

## Verification Plan

1. **Crypto**: Encrypt with extension → `vn read` CLI decrypts → content matches
2. **URL interop**: Extension URL opens in vnsh.dev web viewer
3. **Context menu share**: Right-click text on GitHub → Share → clipboard link → open → see text
4. **AI Debug Bundle**: On a page with JS errors → Debug Bundle → link → open → see structured debug view (screenshot + errors + selected text)
5. **Screenshot**: Popup → Screenshot → link → open → see image
6. **Save snippet**: Right-click → Save → Popup → Saved tab → see snippet → Share → link works
7. **Link preview**: Page with vnsh link → hover → tooltip shows decrypted content
8. **Onboarding**: Fresh install → onboarding page opens → guided tutorial works
9. **Tests**: `cd extension && npm test` passes

---

## Growth Metrics to Track (Post-Launch)

- **安装量**: Chrome Web Store installs
- **日活**: `chrome.runtime` background activations / day
- **分享量**: Context menu + popup share clicks / day
- **Debug Bundle 使用率**: Debug Bundle vs 普通 Share 的比例
- **转化率**: Web Viewer 页面的 "Install Extension" 点击率
- **留存**: 7d / 30d retention（通过 storage 中的活跃天数计算）
