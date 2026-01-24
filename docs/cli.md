# CLI Reference

`vn` — The vnsh command-line interface for encrypting and sharing content.

## Installation

```bash
# One-liner install (adds `vn` to your shell)
curl -sL vnsh.dev/i | sh

# Restart terminal or source your rc file
source ~/.zshrc  # or ~/.bashrc
```

## Requirements

- `openssl` — For AES-256-CBC encryption
- `curl` — For HTTP requests
- Bash or Zsh shell

## Usage

```
vn [FILE]              Encrypt and upload a file
command | vn           Encrypt and upload from stdin
```

## Examples

### Basic Usage

```bash
# Upload a file
vn myfile.txt
# Output: https://vnsh.dev/v/abc123#k=...&iv=...

# Pipe command output
echo "secret data" | vn

# Share error logs
npm test 2>&1 | vn

# Share with short expiry
cat temp.txt | vn --ttl 1
```

### Integration with Git

```bash
# Share current diff
git diff | vn

# Share specific commit
git show abc123 | vn

# Share git log
git log --oneline -20 | vn

# Share staged changes
git diff --cached | vn
```

### Integration with Kubernetes

```bash
# Share pod logs
kubectl logs pod/app-xyz | vn

# Share deployment yaml
kubectl get deployment myapp -o yaml | vn

# Share events
kubectl get events --sort-by='.lastTimestamp' | vn
```

### Integration with Docker

```bash
# Share container logs
docker logs mycontainer | vn

# Share docker compose logs
docker compose logs | vn

# Share running processes
docker ps | vn
```

### System Debugging

```bash
# Share system logs
tail -100 /var/log/system.log | vn

# Share process list
ps aux | vn

# Share disk usage
df -h | vn

# Share network connections
netstat -an | vn
```

### Claude Code Workflow

```bash
# Share build errors with Claude
npm run build 2>&1 | vn
# Then paste the URL into Claude Code

# Share test failures
npm test 2>&1 | vn

# Share a screenshot
cat screenshot.png | vn
```

## How It Works

1. **Generate Keys**: Creates random 32-byte key and 16-byte IV
2. **Encrypt**: Uses OpenSSL AES-256-CBC encryption
3. **Upload**: POSTs encrypted blob to vnsh.dev
4. **Return URL**: Prints URL with key/IV in fragment

```
https://vnsh.dev/v/abc123#k=deadbeef...&iv=cafebabe...
                         └────────────────────────────┘
                         Fragment: Never sent to server
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VNSH_HOST` | `https://vnsh.dev` | Override API host |

```bash
# Use self-hosted instance
export VNSH_HOST="https://vnsh.mycompany.com"
echo "data" | vn
```

## Security Notes

### URL Handling

The URL contains the decryption key in the fragment:

```
https://vnsh.dev/v/abc123#k=deadbeef...&iv=cafebabe...
                         └────────────────────────────┘
                         This part is the secret!
```

- **Never share the full URL publicly** unless you want everyone to read it
- The fragment is never sent to the server
- Store URLs securely (password manager, encrypted notes)
- Share URLs only with intended recipients

### What the Server Sees

The server only sees:
- Encrypted binary blob (indistinguishable from random noise)
- Upload timestamp
- Blob size
- Your IP address

The server CANNOT see:
- Your plaintext content
- The encryption key
- What type of file it is

## Troubleshooting

### "openssl: command not found"

Install OpenSSL:

```bash
# macOS
brew install openssl

# Ubuntu/Debian
sudo apt install openssl

# Fedora/RHEL
sudo dnf install openssl
```

### "curl: command not found"

Install curl:

```bash
# macOS (usually pre-installed)
brew install curl

# Ubuntu/Debian
sudo apt install curl
```

### "vn: command not found"

Re-run the installer and source your shell config:

```bash
curl -sL vnsh.dev/i | sh
source ~/.zshrc  # or ~/.bashrc
```

### "Upload failed"

Check network connectivity:

```bash
curl -I https://vnsh.dev/health
```

### Large files (>25MB)

vnsh has a 25MB limit. For larger files, consider compression:

```bash
# Compress before uploading
gzip -c largefile.log | vn

# Or split into chunks
split -b 20M largefile.log chunk_
for f in chunk_*; do vn "$f"; done
```

## Uninstall

Remove the `vn` function from your shell config:

```bash
# Edit your rc file
nano ~/.zshrc  # or ~/.bashrc

# Remove the vn() function block
# Save and exit

# Reload
source ~/.zshrc
```
