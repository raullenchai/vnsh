# vnsh.dev UX Review

**Date**: 2026-01-24
**Reviewer**: Claude (automated UX audit)
**Scope**: Full user journey across web upload, viewer, CLI tab, MCP tab, mobile, and error states
**Status**: 11 of 16 issues fixed in v1.1.1 (see [ux-fixes-v1.1.1.md](./ux-fixes-v1.1.1.md))

---

## Executive Summary

The vnsh website has a clean, developer-focused aesthetic that aligns with the product's technical audience. ~~However, several UX issues reduce usability, particularly for new users and mobile visitors. The most critical issues are the raw JSON error page and lack of mobile file picker.~~

**Update**: Critical and high-priority issues have been addressed in v1.1.1.

---

## Findings by Priority

### P0 - Critical (Blocks core functionality)

#### 1. Raw JSON Error Page ✅ FIXED
**Location**: `/v/{invalid-id}` or expired links
**Issue**: Users see raw JSON `{"error":"NOT_FOUND","message":"Endpoint not found"}` instead of a styled error page.
**Impact**: Confusing, unprofessional, no way to recover or understand what happened.
**Fix**: Create a styled error page with:
- vnsh branding
- Clear message ("This link has expired or doesn't exist")
- Explanation of 24h expiry
- Link back to homepage
- Different messages for NOT_FOUND vs decryption failure

#### 2. No Mobile File Picker ✅ FIXED
**Location**: Web Upload tab on mobile
**Issue**: Only drag/drop and paste are available. Mobile users cannot drag files.
**Impact**: Mobile users cannot upload files at all.
**Fix**: Add a "Tap to select file" button or make the drop zone clickable to trigger `<input type="file">`.

---

### P1 - High (Significant UX degradation)

#### 3. No Copy Confirmation Feedback ✅ FIXED
**Location**: "Copy URL", "For Claude", "Copy for Claude" buttons
**Issue**: Clicking copy buttons shows no feedback (no toast, no "Copied!" text).
**Impact**: Users don't know if the copy worked.
**Fix**: Add brief toast notification or change button text to "Copied!" for 2 seconds.

#### 4. "For Claude" Button Purpose Unclear ✅ FIXED
**Location**: Upload result area and viewer
**Issue**: No tooltip or explanation of what "For Claude" copies vs regular "Copy URL".
**Impact**: Users don't know what format is copied or why they'd use it.
**Fix**:
- Add tooltip: "Copy URL with instruction for Claude"
- Or rename to "Copy with Instructions"
- Show what was copied in the toast

#### 5. No Expiry Time on Upload Success ✅ FIXED
**Location**: Upload result ("Secure Link Ready")
**Issue**: Users don't know the link expires in 24h until they view it.
**Impact**: Users may share links without knowing they'll expire.
**Fix**: Show "Expires in 24h" or countdown next to the URL on upload success.

#### 6. Architecture & Security Hidden by Default ✅ FIXED
**Location**: Homepage, collapsed accordion
**Issue**: Critical trust-building information is hidden. Users may not know vnsh is zero-knowledge.
**Impact**: Security-conscious users may not trust the service.
**Fix**: Consider showing a brief security summary above the fold, or auto-expand on first visit.

---

### P2 - Medium (Usability friction)

#### 7. Long URL Display ✅ FIXED
**Location**: Upload result area
**Issue**: Full URL with key/iv is very long and wraps awkwardly.
**Impact**: Hard to read, looks intimidating.
**Fix**: Truncate with ellipsis (show `vnsh.dev/v/abc...#k=...`) or use a smaller font for the hash portion.

#### 8. No "Upload Another" Button ⏸️ DEFERRED
**Location**: After successful upload
**Issue**: To upload another file, users must reload or switch tabs and back.
**Impact**: Friction for users uploading multiple files.
**Fix**: Add "New Upload" or "Share Another" button, or make drop zone still active.

#### 9. "MCP" Jargon Unexplained ✅ FIXED
**Location**: Agent (MCP) tab
**Issue**: "MCP" (Model Context Protocol) is not explained anywhere.
**Impact**: Non-technical users or those unfamiliar with Claude ecosystem won't understand.
**Fix**: Add subtitle or tooltip: "MCP (Model Context Protocol) - enables Claude to read vnsh links directly"

#### 10. No `vn read` Documentation on Website ✅ FIXED
**Location**: Terminal (CLI) tab
**Issue**: Only shows upload examples, not how to read/download with CLI.
**Impact**: Users don't know CLI can also fetch vnsh URLs.
**Fix**: Add example: `$ vn read https://vnsh.dev/v/abc...#k=...`

#### 11. No npm/Homebrew Install Alternatives ✅ FIXED (partial)
**Location**: Terminal (CLI) tab
**Issue**: Only shows `curl | sh` which some users avoid for security.
**Impact**: Security-conscious users may not install.
**Fix**: Added npm install option. Homebrew removed (personal tap appears untrustworthy; will add when eligible for Homebrew Core with 30+ stars).

#### 12. No Copy Button for MCP JSON Config ✅ FIXED
**Location**: Agent (MCP) tab
**Issue**: Users must manually select and copy the JSON block.
**Impact**: Friction, risk of partial selection.
**Fix**: Add copy button for the JSON config block.

---

### P3 - Low (Polish) - Not yet addressed

#### 13. Viewer "Close" Button Destination Unclear
**Location**: Content viewer page
**Issue**: "Close" returns to homepage, but this isn't obvious.
**Impact**: Minor confusion about navigation.
**Fix**: Rename to "Back to Home" or add home icon.

#### 14. No Keyboard Shortcut Help
**Location**: Sitewide
**Issue**: The "⌘V / Ctrl+V to paste" hint is good, but no other shortcuts documented.
**Impact**: Power users may miss shortcuts.
**Fix**: Add `?` keyboard shortcut to show help modal (if other shortcuts exist).

#### 15. Tab Title Changes
**Location**: Browser tab
**Issue**: Title changes from "vnsh" to "✓ vnsh" to "Opaque - Viewing" inconsistently.
**Impact**: Minor branding inconsistency.
**Fix**: Standardize: "vnsh" (home), "vnsh - Uploaded" (success), "vnsh - Viewing" (viewer).

#### 16. Blob ID in Viewer Header
**Location**: Viewer page header
**Issue**: Shows "Blob: 0e33eb42..." which is technical/internal.
**Impact**: Takes space, not useful to most users.
**Fix**: Remove or move to a "Details" expandable section.

---

## Positive UX Elements

These work well and should be preserved:

1. **Countdown timer with fire emoji** (🔥 23h 58m) - Memorable, clear urgency
2. **Raw/Formatted toggle** - Smart toggle for code vs plain text
3. **Line numbers** - Helpful for code content
4. **Syntax highlighting** - JSON and code are nicely highlighted
5. **Clean dark theme** - Professional, developer-friendly
6. **Responsive layout** - Tabs and content adapt well to mobile
7. **Keyboard paste support** - Good for power users
8. **Download button** - Easy file save option

---

## Implementation Status

### Phase 1 - Critical Fixes ✅ COMPLETE
1. ✅ Styled error page for invalid/expired links
2. ✅ Mobile file picker button

### Phase 2 - High Impact ✅ COMPLETE
3. ✅ Copy confirmation toasts
4. ✅ Expiry time on upload success
5. ✅ Clarify "For Claude" button

### Phase 3 - Medium Priority ✅ COMPLETE
6. ✅ URL truncation
7. ✅ MCP documentation improvements
8. ✅ CLI `read` command docs
9. ✅ Alternative install methods (npm added, Homebrew deferred)

### Phase 4 - Low Priority (Future)
10. ⏸️ "Upload Another" button
11. 🔲 Viewer "Close" button rename
12. 🔲 Keyboard shortcut help
13. 🔲 Tab title standardization
14. 🔲 Blob ID removal from viewer

---

## Test URLs Used

- Homepage: https://vnsh.dev
- Invalid link: https://vnsh.dev/v/invalid-id-12345#k=fake&iv=fake
- Mobile viewport: 375x812 (iPhone X)
