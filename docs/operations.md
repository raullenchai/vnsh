# Operations & Deployment Guide

Production deployment details and operational knowledge for vnsh.

## Production Environment

### URLs

| Service | URL |
|---------|-----|
| Website | https://vnsh.dev |
| Worker (direct) | https://vnsh.raullenchai.workers.dev |
| GitHub | https://github.com/raullenchai/vnsh |

### Cloudflare Resources

| Resource | Type | Name/ID |
|----------|------|---------|
| Worker | Cloudflare Worker | `vnsh` |
| R2 Bucket | Object Storage | `vnsh-store` |
| KV Namespace | Key-Value Store | `VNSH_META` (ID: `67d2bdbe539e4620a20a65be26744a5e`) |
| Custom Domain | DNS | `vnsh.dev` |

### Worker Bindings

```toml
# wrangler.toml
[[r2_buckets]]
binding = "VNSH_STORE"
bucket_name = "vnsh-store"

[[kv_namespaces]]
binding = "VNSH_META"
id = "67d2bdbe539e4620a20a65be26744a5e"
```

---

## Deployment

### Prerequisites

1. Cloudflare API Token with Workers/R2/KV permissions
2. Node.js 18+
3. Wrangler CLI (`npm install -g wrangler`)

### Deploy Command

```bash
cd worker
CLOUDFLARE_API_TOKEN="your-token" npx wrangler deploy
```

### Verify Deployment

```bash
# Health check
curl https://vnsh.dev/health
# Expected: {"status":"ok","service":"vnsh"}

# Upload test
echo "test" | openssl enc -aes-256-cbc -K $(openssl rand -hex 32) -iv $(openssl rand -hex 16) | \
  curl -s -X POST --data-binary @- https://vnsh.dev/api/drop
```

---

## Endpoints (Production)

| Method | Path | Description | Status |
|--------|------|-------------|--------|
| GET | `/` | Landing page | ✅ |
| GET | `/health` | Health check | ✅ |
| GET | `/robots.txt` | SEO robots | ✅ |
| GET | `/sitemap.xml` | SEO sitemap | ✅ |
| GET | `/og-image.png` | Social share image | ✅ |
| GET | `/i` | CLI install script | ✅ |
| GET | `/claude` | Claude Code integration install script | ✅ |
| POST | `/api/drop` | Upload encrypted blob | ✅ |
| GET | `/api/blob/:id` | Download blob | ✅ |
| GET | `/v/:id` | Serve viewer HTML (preserves hash fragment) | ✅ |
| OPTIONS | `*` | CORS preflight | ✅ |

---

## SEO Configuration

### Meta Tags

- Title: `vnsh | The Ephemeral Dropbox for AI & CLI Tool`
- Description: `Host-blind encrypted file sharing. Upload logs, diffs, and configs with AES-256 encryption. Data vaporizes in 24 hours. CLI + MCP for Claude Code integration.`

### Open Graph

- og:image: `/og-image.png` (SVG)
- og:type: `website`
- og:site_name: `vnsh`

### JSON-LD Schema

Type: `SoftwareApplication`
- applicationCategory: `DeveloperApplication`
- operatingSystem: `macOS, Linux, Windows`
- offers: Free

### GitHub Repository Metadata

- **Description**: "The Ephemeral Dropbox for AI. Host-blind, client-side encrypted sharing for logs, diffs, and images. Vaporizes in 24h."
- **Website**: https://vnsh.dev
- **Topics**: `cli`, `claude`, `mcp`, `file-sharing`, `encryption`, `privacy`, `host-blind`

Update with:
```bash
gh repo edit raullenchai/vnsh \
  --description "The Ephemeral Dropbox for AI. Host-blind, client-side encrypted sharing for logs, diffs, and images. Vaporizes in 24h." \
  --homepage "https://vnsh.dev" \
  --add-topic cli --add-topic claude --add-topic mcp \
  --add-topic file-sharing --add-topic encryption \
  --add-topic privacy --add-topic host-blind
```

---

## MCP Server Configuration

### Claude Code (`.mcp.json` in project root)

```json
{
  "mcpServers": {
    "vnsh": {
      "command": "npx",
      "args": ["-y", "vnsh-mcp"]
    }
  }
}
```

### Claude Code (local build)

```json
{
  "mcpServers": {
    "vnsh": {
      "command": "node",
      "args": ["/path/to/vnsh/mcp/dist/index.js"],
      "env": {
        "VNSH_HOST": "https://vnsh.dev"
      }
    }
  }
}
```

### Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| `fetch failed` | Wrong VNSH_HOST | Set `VNSH_HOST=https://vnsh.dev` |
| `fetch failed` | Local dev server down | Start `wrangler dev` or use production |
| TLS errors | Self-signed cert | Add `NODE_TLS_REJECT_UNAUTHORIZED=0` (dev only) |

---

## Production Testing

### Quick Health Check

```bash
curl -s https://vnsh.dev/health | jq .
```

### Full Integration Test

```bash
#!/bin/bash
# Generate keys
KEY=$(openssl rand -hex 32)
IV=$(openssl rand -hex 16)
TEST="vnsh-test-$(date +%s)"

# Encrypt and upload
ID=$(echo -n "$TEST" | openssl enc -aes-256-cbc -K $KEY -iv $IV | \
  curl -s -X POST --data-binary @- https://vnsh.dev/api/drop | \
  grep -o '"id":"[^"]*"' | cut -d'"' -f4)

# Download and decrypt
RESULT=$(curl -s "https://vnsh.dev/api/blob/$ID" | \
  openssl enc -d -aes-256-cbc -K $KEY -iv $IV)

# Verify
[ "$RESULT" = "$TEST" ] && echo "✓ PASS" || echo "✗ FAIL"
```

### Full Production Probe

Run this to verify all endpoints:

```bash
#!/bin/bash
HOST="https://vnsh.dev"

echo "1. Health check..."
curl -s "$HOST/health" | grep -q '"ok"' && echo "✓ /health" || echo "✗ /health"

echo "2. Landing page..."
[ "$(curl -s -o /dev/null -w '%{http_code}' $HOST/)" = "200" ] && echo "✓ /" || echo "✗ /"

echo "3. robots.txt..."
curl -s "$HOST/robots.txt" | grep -q "User-agent" && echo "✓ /robots.txt" || echo "✗ /robots.txt"

echo "4. sitemap.xml..."
curl -s "$HOST/sitemap.xml" | grep -q "urlset" && echo "✓ /sitemap.xml" || echo "✗ /sitemap.xml"

echo "5. og-image.png..."
[ "$(curl -s -o /dev/null -w '%{http_code}' $HOST/og-image.png)" = "200" ] && echo "✓ /og-image.png" || echo "✗ /og-image.png"

echo "6. Install script..."
curl -s "$HOST/i" | grep -q "#!/bin/sh" && echo "✓ /i" || echo "✗ /i"

echo "7. CORS headers..."
curl -s -X OPTIONS -I "$HOST/api/drop" | grep -q "access-control-allow-origin" && echo "✓ CORS" || echo "✗ CORS"

echo "8. Upload/Download round-trip..."
KEY=$(openssl rand -hex 32)
IV=$(openssl rand -hex 16)
TEST="probe-$(date +%s)"
ID=$(echo -n "$TEST" | openssl enc -aes-256-cbc -K $KEY -iv $IV | \
  curl -s -X POST --data-binary @- -H "Content-Type: application/octet-stream" "$HOST/api/drop" | \
  grep -o '"id":"[^"]*"' | cut -d'"' -f4)
RESULT=$(curl -s "$HOST/api/blob/$ID" | openssl enc -d -aes-256-cbc -K $KEY -iv $IV 2>/dev/null)
[ "$RESULT" = "$TEST" ] && echo "✓ Round-trip encryption" || echo "✗ Round-trip encryption"

echo "9. Viewer HTML..."
[ "$(curl -s -o /dev/null -w '%{http_code}' $HOST/v/$ID)" = "200" ] && echo "✓ /v/:id serves HTML" || echo "✗ /v/:id serves HTML"

echo "10. 404 handling..."
[ "$(curl -s -o /dev/null -w '%{http_code}' $HOST/api/blob/00000000-0000-0000-0000-000000000000)" = "404" ] && echo "✓ 404" || echo "✗ 404"

echo "Done!"
```

### Last Verified: 2026-01-24

All endpoints passing. Production is healthy.

### Recent Bug Fixes

See [CHANGELOG.md](/CHANGELOG.md) for full details.

| Date | Bug | Status |
|------|-----|--------|
| 2026-01-24 | Browser viewer lost hash fragment keys due to redirect | Fixed |
| 2026-01-24 | CLI install "cut: bad delimiter" on macOS | Fixed |
| 2026-01-24 | CLI install script not cross-platform (echo -e, bash-only) | Fixed |

### MCP Tool Test

After configuring MCP, test in Claude Code:
```
You: Read this: https://vnsh.dev/v/{id}#k={key}&iv={iv}
Claude: [Uses vnsh_read tool and returns decrypted content]
```

---

## Monitoring

### Cloudflare Dashboard

- Workers Analytics: Request counts, error rates, CPU time
- R2 Metrics: Storage usage, operations
- KV Metrics: Read/write operations

### Tail Logs

```bash
cd worker
CLOUDFLARE_API_TOKEN="token" npx wrangler tail
```

---

## Rate Limits (Cloudflare WAF)

| Endpoint | Limit | Action |
|----------|-------|--------|
| POST `/api/drop` | 10/min per IP | Block |
| GET `/api/blob/*` | 100/min per IP | Block |

Configure in: Cloudflare Dashboard → Security → WAF → Rate limiting rules

---

## Troubleshooting

### "R2 bucket not found"

```bash
CLOUDFLARE_API_TOKEN="token" npx wrangler r2 bucket list
CLOUDFLARE_API_TOKEN="token" npx wrangler r2 bucket create vnsh-store
```

### "KV namespace not found"

```bash
CLOUDFLARE_API_TOKEN="token" npx wrangler kv namespace list
# Verify ID matches wrangler.toml
```

### Worker not deploying

```bash
CLOUDFLARE_API_TOKEN="token" npx wrangler deploy --dry-run
CLOUDFLARE_API_TOKEN="token" npx wrangler tail
```

### SSL Certificate Issues

New domains take ~60 seconds for SSL provisioning. Check:
```bash
curl -I https://vnsh.dev/health
```

### CORS Issues

Verify headers:
```bash
curl -I -X OPTIONS https://vnsh.dev/api/drop
# Should include: access-control-allow-origin: *
```

---

## Cost Estimation

### Free Tier Limits

| Service | Free Tier |
|---------|-----------|
| Workers | 100k requests/day |
| R2 Storage | 10GB |
| R2 Class A ops | 1M/month |
| R2 Class B ops | 10M/month |
| KV Reads | 100k/day |
| KV Writes | 1k/day |

Typical vnsh deployment stays well within free tier.

---

## Security Checklist

- [x] Custom domain with Cloudflare proxy
- [x] CORS configured (`*` for API access)
- [x] No secrets in code (keys in URL fragment only)
- [x] Rate limiting configured
- [ ] IP allowlisting (optional for sensitive deployments)
- [ ] Abuse monitoring alerts

---

## Release Process

### Pre-Release Checklist

1. Update version numbers:
   - `worker/src/index.ts` - CLI version string (`vn 1.x.x`)
   - `mcp/package.json` - if MCP server changed

2. Update `CHANGELOG.md` with release notes

3. Commit changes:
   ```bash
   git add CHANGELOG.md worker/src/index.ts
   git commit -m "chore: prepare vX.Y.Z release"
   ```

### Deploy and Tag

```bash
# 1. Push to GitHub
git push

# 2. Deploy worker
cd worker && npx wrangler deploy

# 3. Create and push tag
git tag vX.Y.Z
git push origin vX.Y.Z

# 4. Create GitHub release
gh release create vX.Y.Z --title "vX.Y.Z" --notes "$(cat <<'EOF'
## What's New

- Feature 1
- Feature 2

Full changelog: [CHANGELOG.md](https://github.com/raullenchai/vnsh/blob/main/CHANGELOG.md)
EOF
)"
```

### Publishing vnsh-mcp to npm

```bash
cd mcp
npm version patch  # or minor/major
npm publish
```

### Publishing to Official MCP Registry

Requires GitHub OAuth via `mcp-publisher`:

```bash
npx @anthropic-ai/mcp-publisher@latest publish
# Opens browser for GitHub auth
```

Requirements:
- `mcp/server.json` with valid schema
- `mcpName` field in `mcp/package.json`
- Package already published to npm

Registry URL: https://registry.modelcontextprotocol.io

---

## Git Workflow

### Commit Convention

```bash
git commit -m "$(cat <<'EOF'
type: short description

Longer explanation if needed.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

### Push to Production

```bash
git push origin main
cd worker && CLOUDFLARE_API_TOKEN="token" npx wrangler deploy
```

---

## Quick Reference Card

### Installation

```bash
# CLI
curl -sL vnsh.dev/i | sh

# Claude Code Integration (one-line setup)
curl -sL vnsh.dev/claude | sh

# MCP (manual - add to .mcp.json)
{"mcpServers":{"vnsh":{"command":"npx","args":["-y","vnsh-mcp"]}}}
```

### Usage

```bash
# Upload file
vn myfile.txt

# Pipe stdin
cat logs.txt | vn
git diff | vn
kubectl logs pod/app | vn

# Custom TTL (hours)
vn --ttl 1 temp.txt
```

### Key URLs

| URL | Purpose |
|-----|---------|
| https://vnsh.dev | Website |
| https://vnsh.dev/i | CLI installer |
| https://vnsh.dev/claude | Claude Code integration installer |
| https://vnsh.dev/health | Health check |
| https://vnsh.dev/api/drop | Upload API |
| https://vnsh.dev/api/blob/:id | Download API |

### Key Files

| File | Purpose |
|------|---------|
| `.mcp.json` | MCP config (create in project root) |
| `worker/wrangler.toml` | Cloudflare config |
| `worker/src/index.ts` | Main worker code |
| `mcp/src/index.ts` | MCP server code |

### Key IDs

| Resource | Value |
|----------|-------|
| KV Namespace ID | `67d2bdbe539e4620a20a65be26744a5e` |
| R2 Bucket | `vnsh-store` |
| Worker Name | `vnsh` |
| GitHub | `raullenchai/vnsh` |
