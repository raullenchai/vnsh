# Self-Hosting Guide

Deploy your own vnsh instance on Cloudflare Workers.

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) with Workers & R2 enabled
- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/raullenchai/vnsh.git
cd vnsh/worker
npm install
```

### 2. Authenticate with Cloudflare

```bash
wrangler login
# Or use API token:
export CLOUDFLARE_API_TOKEN="your-api-token"
```

### 3. Create R2 Bucket

```bash
wrangler r2 bucket create vnsh-store
```

### 4. Create KV Namespace

```bash
wrangler kv namespace create VNSH_META

# Note the ID from output, e.g.:
# { binding = "VNSH_META", id = "abc123..." }
```

### 5. Configure wrangler.toml

```toml
name = "vnsh"
main = "src/index.ts"
compatibility_date = "2024-12-30"
compatibility_flags = ["nodejs_compat"]

[[r2_buckets]]
binding = "VNSH_STORE"
bucket_name = "vnsh-store"

[[kv_namespaces]]
binding = "VNSH_META"
id = "YOUR_KV_NAMESPACE_ID"  # Replace with actual ID
```

### 6. Deploy

```bash
wrangler deploy
```

Your instance is now live at `https://vnsh.<your-subdomain>.workers.dev`

## Custom Domain

### Via Cloudflare Dashboard

1. Go to Workers & Pages → your worker → Settings → Domains & Routes
2. Click "Add" → "Custom Domain"
3. Enter your domain (e.g., `vnsh.yourdomain.com`)
4. Cloudflare handles DNS and SSL automatically

### Via wrangler.toml

```toml
routes = [
  { pattern = "vnsh.yourdomain.com/*", zone_name = "yourdomain.com" }
]
```

## Configuration

### Worker Settings

Edit constants in `src/index.ts`:

```typescript
const MAX_BLOB_SIZE = 25 * 1024 * 1024; // 25MB
const DEFAULT_TTL_HOURS = 24;
const MAX_TTL_HOURS = 168; // 7 days
```

### Environment Variables (Optional)

Set via Wrangler secrets for x402 payment support:

```bash
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler secret put LIGHTNING_API_KEY
wrangler secret put JWT_SECRET
```

## R2 Lifecycle Rules (Optional)

Auto-delete expired blobs:

1. Go to Cloudflare Dashboard → R2
2. Select `vnsh-store` bucket
3. Settings → Lifecycle Rules
4. Add rule: Delete objects older than X days

Or use Cron Triggers:

```toml
# wrangler.toml
[triggers]
crons = ["0 * * * *"]  # Every hour
```

```typescript
// In worker
export default {
  async scheduled(event, env, ctx) {
    // Cleanup expired blobs
  }
}
```

## Rate Limiting

Add Cloudflare Rate Limiting Rules:

1. Dashboard → Security → WAF → Rate limiting rules
2. Create rules:

| Rule | Path | Limit | Action |
|------|------|-------|--------|
| Upload | `/api/drop` | 10/min per IP | Block |
| Download | `/api/blob/*` | 100/min per IP | Block |

## Monitoring

### Workers Analytics

View in Cloudflare Dashboard:

- Request counts
- Error rates
- CPU time
- Latency percentiles

### Tail Logs

```bash
wrangler tail
```

### Custom Logging

```typescript
// Add to worker
console.log(JSON.stringify({
  event: 'upload',
  blobId: id,
  size: body.length,
  timestamp: Date.now()
}));
```

## Development

### Local Development

```bash
cd worker
npm run dev
# Worker runs at http://localhost:8787
```

### With HTTPS (for WebCrypto)

```bash
wrangler dev --local-protocol https
```

### Bind to All Interfaces

```bash
wrangler dev --ip 0.0.0.0 --port 8787
```

### Run Tests

```bash
npm test
```

## Production Checklist

- [ ] R2 bucket created (`vnsh-store`)
- [ ] KV namespace created and ID configured
- [ ] Custom domain configured (optional)
- [ ] Rate limiting rules added
- [ ] Monitoring/alerting set up
- [ ] Test upload/download flow end-to-end

## Cost Estimation

### Cloudflare Workers (Free Tier)

| Resource | Free Tier | Paid ($5/month) |
|----------|-----------|-----------------|
| Requests | 100k/day | 10M/month |
| CPU time | 10ms/request | 50ms/request |

### R2 Storage (Free Tier)

| Resource | Free Tier | Paid |
|----------|-----------|------|
| Storage | 10GB | $0.015/GB/month |
| Class A ops | 1M/month | $4.50/million |
| Class B ops | 10M/month | $0.36/million |

### KV (Free Tier)

| Resource | Free Tier | Paid |
|----------|-----------|------|
| Reads | 100k/day | $0.50/million |
| Writes | 1k/day | $5.00/million |
| Storage | 1GB | $0.50/GB |

For a typical vnsh deployment with moderate usage, expect to stay well within free tiers.

## Troubleshooting

### "R2 bucket not found"

```bash
# List buckets
wrangler r2 bucket list

# Create if missing
wrangler r2 bucket create vnsh-store
```

### "KV namespace not found"

```bash
# List namespaces
wrangler kv namespace list

# Verify ID in wrangler.toml matches
```

### "Worker not deploying"

```bash
# Check for errors
wrangler deploy --dry-run

# View logs
wrangler tail
```

### CORS Issues

If your frontend is on a different domain, ensure CORS headers are correct:

```typescript
const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://your-frontend.com',
  // ...
};
```

## Upgrading

```bash
cd worker
git pull origin main
npm install
wrangler deploy
```

## Security Considerations

### For Production

- Use a custom domain with Cloudflare proxy enabled
- Enable rate limiting
- Consider IP allowlisting for sensitive deployments
- Monitor for abuse patterns

### What Self-Hosting Provides

- **Data sovereignty**: Your blobs stay on your infrastructure
- **Custom TTL policies**: Adjust retention as needed
- **Audit logging**: Full control over access logs
- **Network isolation**: Deploy behind VPN/firewall if needed

### What Self-Hosting Does NOT Change

- **Encryption model**: Still client-side, server never sees keys
- **URL fragment security**: Keys still travel in fragments
- **User responsibility**: Full URLs must still be shared securely
