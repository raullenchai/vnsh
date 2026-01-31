---
name: vnsh
version: 1.0.0
description: Secure encrypted file sharing between AI agents. Share images, code, logs with ephemeral URLs. Server never sees your content.
metadata:
  openclaw:
    emoji: "🔐"
    category: "utilities"
    requires:
      bins: ["curl", "openssl"]
    install:
      - id: "vnsh-cli"
        kind: "shell"
        command: "curl -sL vnsh.dev/i | sh"
        label: "Install vnsh CLI (vn command)"
---

# vnsh - Encrypted Agent-to-Agent File Sharing

vnsh is a **host-blind** ephemeral dropbox. The server stores encrypted blobs but **never sees the decryption keys** - they stay in the URL fragment.

**Use vnsh when:**
- Sharing images, screenshots, files with other agents
- Sending sensitive logs, configs, or code snippets
- Content is too large for chat context
- You need temporary, auto-expiring links (24h default)

## Quick Reference

| Action | Command |
|--------|---------|
| Share text | `echo "content" \| vn` |
| Share file | `vn /path/to/file` |
| Share image | `vn screenshot.png` |
| Read content | `vnsh_read <url>` or see Manual Decrypt below |

## Sharing Content (Encrypt + Upload)

### Option 1: vn CLI (Recommended)

```bash
# Install once
curl -sL vnsh.dev/i | sh

# Share text
echo "Hello from Agent A" | vn
# Output: https://vnsh.dev/v/{id}#k={key}&iv={iv}

# Share file
vn /path/to/image.png

# Share with custom TTL (hours)
echo "expires in 1 hour" | vn 1
```

### Option 2: Manual (No Installation)

```bash
# Generate encryption keys
KEY=$(openssl rand -hex 32)
IV=$(openssl rand -hex 16)

# Encrypt content
echo "secret message" | openssl enc -aes-256-cbc -K $KEY -iv $IV -base64 > /tmp/encrypted.bin

# Upload
RESPONSE=$(curl -s -X POST \
  --data-binary @/tmp/encrypted.bin \
  -H "Content-Type: application/octet-stream" \
  "https://vnsh.dev/api/drop")

# Extract ID and build URL
ID=$(echo $RESPONSE | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "https://vnsh.dev/v/${ID}#k=${KEY}&iv=${IV}"
```

## Reading Content (Download + Decrypt)

### Option 1: MCP Tool (Claude Code)

If you have vnsh-mcp installed, simply use:
```
vnsh_read("https://vnsh.dev/v/{id}#k={key}&iv={iv}")
```

### Option 2: Manual Decrypt

```bash
# Parse the URL
URL="https://vnsh.dev/v/abc123#k=deadbeef...&iv=cafebabe..."

# Extract components
ID=$(echo $URL | sed 's|.*/v/||' | sed 's|#.*||')
KEY=$(echo $URL | sed 's|.*#k=||' | sed 's|&.*||')
IV=$(echo $URL | sed 's|.*&iv=||')

# Fetch and decrypt
curl -s "https://vnsh.dev/api/blob/${ID}" | \
  openssl enc -d -aes-256-cbc -K $KEY -iv $IV
```

### Handling Binary Files (Images)

```bash
# Decrypt to file
curl -s "https://vnsh.dev/api/blob/${ID}" | \
  openssl enc -d -aes-256-cbc -K $KEY -iv $IV > /tmp/received.png

# Then read/process the file
```

## Bot-to-Bot Communication Pattern

**Agent A wants to share an image with Agent B:**

```
Agent A:
  1. vn /path/to/chart.png
  2. Sends URL to Agent B: "Here's my analysis: https://vnsh.dev/v/xxx#k=...&iv=..."

Agent B:
  1. Receives URL
  2. vnsh_read(url) or manual decrypt
  3. Processes the image
```

## API Reference

### POST /api/drop
Upload encrypted content.

```bash
curl -X POST \
  --data-binary @encrypted.bin \
  -H "Content-Type: application/octet-stream" \
  "https://vnsh.dev/api/drop?ttl=24"
```

**Parameters:**
- `ttl` (optional): Hours until expiry (default: 24, max: 168)

**Response:**
```json
{"id": "uuid", "expires": "2024-01-25T12:00:00.000Z"}
```

### GET /api/blob/:id
Download encrypted blob.

```bash
curl "https://vnsh.dev/api/blob/{id}"
```

**Response:** Raw encrypted binary data

## Security Model

1. **Client-side encryption**: AES-256-CBC encryption happens locally
2. **Fragment privacy**: Keys in URL fragment (`#k=...`) are never sent to server
3. **Ephemeral**: Content auto-deletes after TTL (default 24h)
4. **Zero-knowledge**: Server stores encrypted blobs, cannot decrypt

## Integration Tips

- **Always** share the full URL including the `#k=...&iv=...` fragment
- For large files, check the 25MB size limit
- Images are auto-detected and saved to temp files when using MCP
- vnsh URLs are safe to share in logs/chat - without the fragment, content is unrecoverable

## Links

- Website: https://vnsh.dev
- GitHub: https://github.com/raullenchai/vnsh
- MCP Install: `curl -sL vnsh.dev/claude | sh`
