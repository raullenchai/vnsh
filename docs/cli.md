# CLI Reference

`oq` — The Opaque command-line interface for encrypting and sharing content.

## Installation

```bash
# Download and install
curl -sL https://opaque.dev/install.sh | bash

# Or manually copy to your PATH
cp cli/oq /usr/local/bin/oq
chmod +x /usr/local/bin/oq
```

## Requirements

- `openssl` — For AES-256-CBC encryption
- `curl` — For HTTP requests
- Bash shell

## Usage

```
oq [OPTIONS] [FILE]        Encrypt and upload
command | oq [OPTIONS]     Encrypt and upload from stdin
oq read <URL>              Decrypt and read an Opaque URL
```

## Commands

### Upload (default)

Encrypt and upload content to Opaque.

```bash
# Upload a file
oq myfile.txt

# Upload from stdin
echo "secret data" | oq
git diff | oq
cat error.log | oq

# With options
oq --ttl 1 temp.txt           # 1 hour expiry
oq --price 0.01 premium.txt   # Require payment
```

### Read

Decrypt and display content from an Opaque URL.

```bash
oq read "https://opaque.dev/v/abc123#k=...&iv=..."

# Output can be piped
oq read "$URL" | less
oq read "$URL" > decrypted.txt
```

### Local Mode

Encrypt content locally without uploading (for air-gapped environments).

```bash
echo "secret" | oq --local

# Output:
# Encrypted blob (base64):
# U2FsdGVkX1...
#
# Decryption key: deadbeef...
# IV: cafebabe...
```

## Options

| Option | Description |
|--------|-------------|
| `--local` | Output encrypted blob locally (no upload) |
| `--ttl <hours>` | Set expiry time in hours (default: 24, max: 168) |
| `--price <usd>` | Set price in USD for x402 payment |
| `--host <url>` | Override API host |
| `-h, --help` | Show help |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPAQUE_HOST` | `https://opaque.dev` | API host URL |

## Examples

### Basic Usage

```bash
# Share a config file
oq ~/.ssh/config
# Output: https://opaque.dev/v/abc123#k=...&iv=...

# Share command output
npm test 2>&1 | oq

# Share with short expiry
oq --ttl 1 temp-notes.txt
```

### Integration with Git

```bash
# Share current diff
git diff | oq

# Share specific commit
git show abc123 | oq

# Share git log
git log --oneline -20 | oq
```

### Integration with System Tools

```bash
# Share system logs
tail -100 /var/log/system.log | oq

# Share process list
ps aux | oq

# Share environment (be careful!)
env | oq
```

### Claude Code Integration

```bash
# In your prompt to Claude Code:
# "Here's my error log: $(cat error.log | oq)"

# Or pipe directly:
npm run build 2>&1 | oq
# Then paste the URL into Claude Code
```

### Reading Shared Content

```bash
# Read and display
oq read "https://opaque.dev/v/abc123#k=...&iv=..."

# Save to file
oq read "$URL" > downloaded.txt

# Pipe to other commands
oq read "$URL" | grep ERROR
oq read "$URL" | wc -l
```

## Security Notes

### URL Handling

The URL contains the decryption key in the fragment:

```
https://opaque.dev/v/abc123#k=deadbeef...&iv=cafebabe...
                           └────────────────────────────┘
                           This part is the secret!
```

- **Never share the full URL publicly** unless you want everyone to read it
- The fragment is never sent to the server
- Store URLs securely (password manager, encrypted notes)

### Local Mode

Use `--local` when:

- You're on an air-gapped system
- You want to transfer encrypted data manually
- You're debugging encryption issues

```bash
# Encrypt locally
echo "secret" | oq --local > encrypted.txt

# Later, upload the base64 blob manually
cat encrypted.txt | base64 -d | curl -X POST --data-binary @- https://opaque.dev/api/drop
```

### Self-Signed Certificates

When developing locally with HTTPS, the CLI automatically uses `-k` (insecure) for:

- `localhost`
- `127.0.0.1`
- `100.x.x.x` (Tailscale)
- `192.168.x.x` (Local network)

## Troubleshooting

### "openssl is required but not installed"

Install OpenSSL:

```bash
# macOS
brew install openssl

# Ubuntu/Debian
sudo apt install openssl

# Fedora/RHEL
sudo dnf install openssl
```

### "curl is required but not installed"

Install curl:

```bash
# macOS (usually pre-installed)
brew install curl

# Ubuntu/Debian
sudo apt install curl
```

### "Upload failed (HTTP 413)"

File is too large. Maximum size is 25MB.

```bash
# Check file size
ls -lh largefile.txt

# Consider compression
gzip -c largefile.txt | oq
```

### "Decryption failed"

The key or IV may be incorrect. Verify the URL was copied completely, including the fragment.

```bash
# Check URL format
echo "$URL" | grep '#k=.*&iv='
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (see stderr for details) |
