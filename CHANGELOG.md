# Changelog

All notable changes to vnsh are documented in this file.

## [1.1.0] - 2026-01-24

### Added

#### Version and Help Flags
Added `--version` / `-v` and `--help` / `-h` flags to the CLI for better discoverability.

```bash
vn --version  # Output: vn 1.1.0
vn --help     # Shows full usage information
```

#### Stdin Size Check
The CLI now checks stdin input size before encryption (previously only checked file size). Large stdin inputs (>25MB) now fail gracefully with a helpful error message instead of failing at upload time.

### Changed

#### Improved POSIX Portability
- Replaced `bc` dependency with `awk` for size calculations (fixes Alpine Linux and minimal containers)
- Added trap-based cleanup for temp files to prevent plaintext leakage if process is killed

### Fixed

#### Temp File Security
Added `trap` for automatic temp file cleanup on EXIT/INT/TERM signals. Previously, if the process was killed between decryption and cleanup, the plaintext temp file would persist on disk.

---

## [Unreleased]

### Added

#### CLI Read Command (2026-01-24)

Added `vn read <url>` command to the shell-installed CLI. Previously, the shell script could only upload content. Now it can also decrypt and display content from vnsh URLs.

**Usage:**
```bash
vn read "https://vnsh.dev/v/abc123#k=...&iv=..."
```

**Files Changed**:
- `worker/src/index.ts`: `INSTALL_SCRIPT` constant updated with read subcommand
- `docs/cli.md`: Added documentation for read command

---

### Fixed

#### Browser Viewer Hash Fragment Bug (2026-01-24)

**Problem**: When visiting a vnsh URL like `https://vnsh.dev/v/abc123#k=...&iv=...` in a browser, the decryption keys were lost and the content couldn't be viewed. MCP worked fine.

**Root Cause**: The `/v/:id` route was redirecting to `/#v/:id`. When a browser follows a redirect where the `Location` header contains a hash fragment, the redirect's fragment **replaces** the original URL's fragment - they don't merge. So the encryption keys (`#k=...&iv=...`) were lost.

**Fix**: Changed `/v/:id` to serve HTML directly (200 response) instead of redirecting. Updated JavaScript to detect `/v/:id` in `location.pathname` and extract keys from `location.hash`.

**Files Changed**:
- `worker/src/index.ts`: Route handler + JavaScript `handleHash()` function
- `worker/test/api.test.ts`: Added regression tests

---

#### CLI Install Script Cross-Platform Compatibility (2026-01-24)

**Problem**: Running `curl -sL vnsh.dev/i | sh` had multiple portability issues:
1. Showed `-e` before each colored line (macOS `/bin/sh` doesn't support `echo -e`)
2. Used `#!/bin/bash` shebang (not available on all systems)
3. No OS detection or Windows compatibility messaging

**Root Cause**: The script was written for bash-specific features that aren't portable across POSIX shells.

**Fix**: Complete rewrite for POSIX compliance:
- Changed shebang from `#!/bin/bash` to `#!/bin/sh`
- Replaced all `echo -e` with `printf "%b"` for escape sequences
- Added OS detection via `uname -s` (macOS, Linux, Windows/MSYS/Cygwin)
- Added dependency checking (`openssl`, `curl`)
- Used `tr -d "\n\r"` for portable base64 newline removal (BSD/GNU compatible)
- Added Windows user messaging for Git Bash/WSL requirements

**Files Changed**:
- `worker/src/index.ts`: `INSTALL_SCRIPT` constant (complete rewrite)
- `worker/test/api.test.ts`: Updated regression tests

---

#### CLI Install Script "cut: bad delimiter" Bug (2026-01-24)

**Problem**: Running `curl -sL vnsh.dev/i | sh` failed on macOS with error: `cut: bad delimiter`

**Root Cause**: The install script used complex shell quoting to parse JSON:
```bash
# Broken - complex single-quote escaping
local ID=$(echo "$RESPONSE" | grep -o '"'"'"id":"[^"]*"'"'" | cut -d'"'"'"' -f4)
```

The `'"'"'` pattern (to embed single quotes in single-quoted strings) was incorrectly formed, resulting in an unclosed double quote being passed to `cut -d`.

**Fix**: Replaced with simpler `sed` command that uses double quotes:
```bash
# Fixed - uses sed with double-quote escaping
local ID=$(echo "$RESPONSE" | sed -n "s/.*\"id\":\"\([^\"]*\)\".*/\1/p")
```

**Files Changed**:
- `worker/src/index.ts`: `INSTALL_SCRIPT` constant
- `worker/test/api.test.ts`: Added regression test

---

## [1.0.0] - 2026-01-23

### Added
- Initial release
- Host-blind encrypted file sharing
- CLI tool (`vn` command)
- MCP server for Claude Code integration
- Web viewer with client-side decryption
- 24-hour default TTL with configurable expiry (1-168 hours)
- x402 payment protocol support (proposed)
