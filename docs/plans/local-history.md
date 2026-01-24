# Feature Plan: Local History

## Problem Statement
Users lose track of recently uploaded links. "I just uploaded that log, where's the link?"

## Solution Overview
Store upload history locally (never on server) with automatic expiry cleanup.

| Platform | Storage | Location |
|----------|---------|----------|
| Web | LocalStorage | `vnsh_history` key |
| CLI | JSON file | `~/.vnsh_history` |

---

## Data Structure

```typescript
interface HistoryEntry {
  id: string;           // Blob ID (for display: "abc123...")
  url: string;          // Full URL with #k=...&iv=...
  timestamp: number;    // Unix timestamp (ms)
  expires: number;      // Unix timestamp (ms) when blob expires
  size?: number;        // Optional: file size in bytes
  filename?: string;    // Optional: original filename (Web only)
}

// Storage format
interface HistoryStore {
  version: 1;
  entries: HistoryEntry[];  // Max 50 entries, newest first
}
```

---

## Web Implementation

### 1. Storage Layer (`history.js`)

```javascript
const STORAGE_KEY = 'vnsh_history';
const MAX_ENTRIES = 50;

function getHistory() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return { version: 1, entries: [] };
  const store = JSON.parse(raw);
  // Filter out expired entries
  const now = Date.now();
  store.entries = store.entries.filter(e => e.expires > now);
  return store;
}

function addToHistory(entry) {
  const store = getHistory();
  // Add to front, dedupe by id
  store.entries = [entry, ...store.entries.filter(e => e.id !== entry.id)];
  // Trim to max
  store.entries = store.entries.slice(0, MAX_ENTRIES);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function clearHistory() {
  localStorage.removeItem(STORAGE_KEY);
}
```

### 2. UI Component

**Location**: Top-right corner, next to GitHub link

**Icon**: Clock/history icon (⏱ or custom SVG)

**Dropdown Panel**:
```
┌─────────────────────────────────────────┐
│  History                        Clear ⨉ │
├─────────────────────────────────────────┤
│  📄 abc123...  2 min ago    [Copy] [👁]  │
│  📄 def456...  15 min ago   [Copy] [👁]  │
│  📄 ghi789...  1 hour ago   [Copy] [👁]  │
│  ─────────────────────────────────────  │
│  📄 xyz999...  23h left     [Copy] [👁]  │
└─────────────────────────────────────────┘
```

**Features**:
- Show blob ID (truncated)
- Relative time ("2 min ago" or "23h left" if expiring soon)
- Copy button → copies full URL
- View button → opens in viewer
- Clear all button
- Empty state: "No recent uploads"

### 3. Integration Points

**After successful upload** (`worker/src/index.ts`):
```javascript
// In progressEl success handler
addToHistory({
  id: data.id,
  url: generatedUrl,
  timestamp: Date.now(),
  expires: new Date(data.expires).getTime(),
  size: file?.size,
  filename: file?.name
});
```

### 4. CSS Styling

```css
.history-btn {
  /* Icon button in header */
}

.history-dropdown {
  position: absolute;
  right: 1rem;
  top: 3rem;
  width: 320px;
  max-height: 400px;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
}

.history-item {
  display: flex;
  align-items: center;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border);
}

.history-item:hover {
  background: var(--hover);
}

.history-item.expiring-soon {
  /* Yellow/orange tint for <1h remaining */
  border-left: 3px solid var(--warning);
}
```

---

## CLI Implementation

### 1. History File (`~/.vnsh_history`)

Same JSON format as web:
```json
{
  "version": 1,
  "entries": [
    {
      "id": "abc123...",
      "url": "https://vnsh.dev/v/abc123#k=...&iv=...",
      "timestamp": 1706123456789,
      "expires": 1706209856789
    }
  ]
}
```

### 2. CLI Changes (`cli/vn`)

**New command**: `vn history`

```bash
# Show recent uploads
vn history

# Output:
# Recent uploads (5 entries):
#   1. abc123...  2 min ago   https://vnsh.dev/v/abc123#k=...
#   2. def456...  1 hour ago  https://vnsh.dev/v/def456#k=...
#   ...

# Clear history
vn history --clear

# Copy specific entry to clipboard (if pbcopy/xclip available)
vn history 1
```

**Auto-save after upload**:
```bash
save_to_history() {
  local id="$1"
  local url="$2"
  local expires="$3"
  local history_file="$HOME/.vnsh_history"

  # Create if not exists
  if [ ! -f "$history_file" ]; then
    echo '{"version":1,"entries":[]}' > "$history_file"
  fi

  # Add entry (using jq if available, else simple append)
  # ... implementation
}
```

### 3. npm CLI Changes (`cli/npm/src/cli.ts`)

Add `history` subcommand with same behavior.

---

## Privacy & Security

1. **Keys stored locally only** - History includes full URLs with encryption keys
2. **Never synced to server** - Pure client-side storage
3. **Auto-cleanup** - Expired entries removed on read
4. **Clear option** - User can wipe history anytime
5. **No cross-device sync** - By design (keys shouldn't leave device)

---

## Edge Cases

| Case | Handling |
|------|----------|
| LocalStorage disabled | Graceful degradation, no history |
| Storage quota exceeded | Remove oldest entries first |
| Corrupted JSON | Reset to empty state |
| Clock skew | Use server's `expires` timestamp |
| Multiple tabs | Last-write-wins (acceptable) |

---

## Implementation Order

1. **Phase 1: Web UI** (highest impact)
   - [ ] Add history storage functions
   - [ ] Add history icon to header
   - [ ] Build dropdown component
   - [ ] Hook into upload success
   - [ ] Test localStorage limits

2. **Phase 2: CLI**
   - [ ] Add `vn history` command to bash CLI
   - [ ] Add history file management
   - [ ] Add to npm CLI package
   - [ ] Update man page / help text

3. **Phase 3: Polish**
   - [ ] Keyboard shortcuts (H to open history)
   - [ ] Export history as JSON
   - [ ] Search/filter in history

---

## Estimated Scope

| Component | Files Changed | Complexity |
|-----------|---------------|------------|
| Web history storage | `worker/src/index.ts` | Low |
| Web history UI | `worker/src/index.ts` | Medium |
| Bash CLI history | `cli/vn` | Medium |
| npm CLI history | `cli/npm/src/cli.ts` | Low |

**Total**: ~200-300 lines of code
