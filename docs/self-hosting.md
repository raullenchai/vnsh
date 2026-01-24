# Self-Hosting Guide

Deploy your own Opaque instance on Cloudflare Workers.

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/yourusername/opaque.git
cd opaque/worker
npm install
```

### 2. Create R2 Bucket

```bash
wrangler r2 bucket create opaque-store
```

### 3. Create KV Namespace

```bash
wrangler kv:namespace create OPAQUE_META

# Note the ID from output, e.g.:
# { binding = "OPAQUE_META", id = "abc123..." }
```

### 4. Configure wrangler.toml

```toml
name = "opaque"
main = "src/index.ts"
compatibility_date = "2024-12-30"
compatibility_flags = ["nodejs_compat"]

[[r2_buckets]]
binding = "OPAQUE_STORE"
bucket_name = "opaque-store"

[[kv_namespaces]]
binding = "OPAQUE_META"
id = "YOUR_KV_NAMESPACE_ID"  # Replace with actual ID
```

### 5. Deploy

```bash
wrangler deploy
```

Your instance is now live at `https://opaque.<your-subdomain>.workers.dev`

## Custom Domain

### Add Route

```bash
wrangler route add opaque.yourdomain.com/* opaque
```

Or in `wrangler.toml`:

```toml
routes = [
  { pattern = "opaque.yourdomain.com/*", zone_name = "yourdomain.com" }
]
```

### Configure DNS

Add a CNAME record pointing to your workers.dev subdomain, or use Cloudflare's proxy.

## Configuration

### Environment Variables

Set via Wrangler secrets:

```bash
# For x402 payment support (optional)
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler secret put LIGHTNING_API_KEY
wrangler secret put JWT_SECRET
```

### Worker Settings

Edit constants in `src/index.ts`:

```typescript
const MAX_BLOB_SIZE = 25 * 1024 * 1024; // 25MB
const DEFAULT_TTL_HOURS = 24;
const MAX_TTL_HOURS = 168; // 7 days
```

## R2 Lifecycle Rules (Optional)

Auto-delete expired blobs:

1. Go to Cloudflare Dashboard → R2
2. Select `opaque-store` bucket
3. Settings → Lifecycle Rules
4. Add rule: Delete objects where `expiresAt` metadata < current time

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

View logs:

```bash
wrangler tail
```

## Development

### Local Development

```bash
cd worker
npm run dev
# or
wrangler dev --port 8787
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

- [ ] R2 bucket created
- [ ] KV namespace created and ID configured
- [ ] Custom domain configured (optional)
- [ ] Rate limiting rules added
- [ ] CORS configured for your domain (if not using `*`)
- [ ] Secrets configured (if using payments)
- [ ] Monitoring/alerting set up
- [ ] Backup strategy for R2 (if needed)

## Cost Estimation

### Cloudflare Workers

| Resource | Free Tier | Paid ($5/month) |
|----------|-----------|-----------------|
| Requests | 100k/day | 10M/month |
| CPU time | 10ms/request | 50ms/request |

### R2 Storage

| Resource | Free Tier | Paid |
|----------|-----------|------|
| Storage | 10GB | $0.015/GB/month |
| Class A ops | 1M/month | $4.50/million |
| Class B ops | 10M/month | $0.36/million |

### KV

| Resource | Free Tier | Paid |
|----------|-----------|------|
| Reads | 100k/day | $0.50/million |
| Writes | 1k/day | $5.00/million |
| Storage | 1GB | $0.50/GB |

For a typical Opaque deployment with moderate usage, expect to stay well within free tiers.

## Troubleshooting

### "R2 bucket not found"

```bash
# List buckets
wrangler r2 bucket list

# Create if missing
wrangler r2 bucket create opaque-store
```

### "KV namespace not found"

```bash
# List namespaces
wrangler kv:namespace list

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

### Breaking Changes

Check the CHANGELOG before upgrading. Major version bumps may require:

- Database migrations
- Configuration changes
- API endpoint updates
