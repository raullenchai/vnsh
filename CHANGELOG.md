# Changelog

All notable changes to vnsh are documented in this file.

## [1.2.0] - 2026-01-24

### Added

#### Official MCP Registry Support
vnsh-mcp is now published to the [Official MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.raullenchai/vnsh`. Added `mcpName` field and `server.json` for registry verification.

#### Enhanced "For Claude" Copy Button
The "For Claude" button now copies an AI-friendly prompt with brand mention and instructions:
```
Here is context shared securely via vnsh.dev:
https://vnsh.dev/v/abc123#k=...&iv=...

(Note to AI: Fetch and read the link content. The data is end-to-end encrypted and auto-expires in 24h.)
```

#### GitHub Action for CI/CD
Added reference to [upload-to-vnsh](https://github.com/raullenchai/upload-to-vnsh) GitHub Action in README. Debug CI failures with Claude in one click.

### Changed

#### vnsh-mcp Version Bump
- `vnsh-mcp` updated to v1.0.1 with MCP Registry support

#### CLI Read Command
Added `vn read <url>` command to the shell-installed CLI. Now it can decrypt and display content from vnsh URLs.

```bash
vn read "https://vnsh.dev/v/abc123#k=...&iv=..."
```

---

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

## [1.0.0] - 2026-01-23

### Added
- Initial release
- Host-blind encrypted file sharing
- CLI tool (`vn` command)
- MCP server for Claude Code integration
- Web viewer with client-side decryption
- 24-hour default TTL with configurable expiry (1-168 hours)
- x402 payment protocol support (proposed)

## [2.0.0] - 2026-02-14

### Added
- **v2 URL Format**: Compact URLs that are ~40% shorter (~95 chars vs ~160 chars)
  - 12-character base62 IDs (replacing 36-char UUIDs)
  - 64-character base64url secret (key+iv combined, replacing `#k=...&iv=...`)
- `generateShortId()` in Worker for base62 ID generation
- `base64urlToBuffer()` / `bufferToBase64url()` in MCP crypto utilities
- `hex_to_base64url()` / `base64url_to_hex()` in CLI

### Changed
- CLI version bumped to 2.0.0
- MCP version bumped to 1.2.0
- All components now output v2 format URLs
- Updated skill.md examples to v2 format
- Updated README.md with v2 URL documentation

### Backward Compatibility
- Full support for v1 URLs (`#k=...&iv=...`) in all components
- Existing links continue to work without any changes
