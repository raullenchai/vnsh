# CLI Reference

`vn` — The vnsh command-line interface for encrypting and sharing content.

## Installation

```bash
# One-liner install (adds `vn` to your shell)
curl -sL vnsh.dev/i | sh

# Restart terminal or source your rc file
source ~/.zshrc  # or ~/.bashrc, ~/.profile, etc.
```

### Platform Support

The install script is cross-platform and works on:

| Platform | Shell | Notes |
|----------|-------|-------|
| **macOS** | zsh, bash, sh | Default since Catalina is zsh |
| **Linux** | bash, zsh, sh | Most distros use bash |
| **Windows (WSL)** | bash, zsh | Full support via Windows Subsystem for Linux |
| **Windows (Git Bash)** | bash | Works with Git for Windows |
| **Windows (Native)** | PowerShell | Use `npm install -g vnsh` instead |

The installer automatically detects your shell and adds `vn` to the appropriate config file (`.zshrc`, `.bashrc`, `.bash_profile`, `.profile`, or `config.fish`).

## Requirements

- `openssl` — For AES-256-CBC encryption
- `curl` — For HTTP requests
- `base64` — For encoding (included on all Unix systems)
- Any POSIX-compatible shell (sh, bash, zsh, etc.)

## Usage

```
vn [FILE]              Encrypt and upload a file
command | vn           Encrypt and upload from stdin
vn read <URL>          Decrypt and display content from a vnsh URL
vn --version           Show version (v1.1.0)
vn --help              Show help
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

### Reading Content

```bash
# Read and display decrypted content
vn read "https://vnsh.dev/v/abc123#k=...&iv=..."

# Pipe to another command
vn read "$URL" | grep "error"

# Save to a file
vn read "$URL" > downloaded.txt

# View in pager
vn read "$URL" | less
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

# Then source the appropriate file for your shell:
source ~/.zshrc        # zsh (macOS default)
source ~/.bashrc       # bash (Linux default)
source ~/.bash_profile # bash on macOS
source ~/.profile      # sh/dash
```

### Windows Users

For native Windows PowerShell, the shell script won't work. Use npm instead:

```powershell
npm install -g vnsh
```

For Git Bash or WSL, the shell script works normally.

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
