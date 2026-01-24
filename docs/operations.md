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
| POST | `/api/drop` | Upload encrypted blob | ✅ |
| GET | `/api/blob/:id` | Download blob | ✅ |
| GET | `/v/:id` | Redirect to `/#v/:id` | ✅ |
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

### Project Config (`.mcp.json`)

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

### Global Config (`~/.claude/settings.json`)

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
