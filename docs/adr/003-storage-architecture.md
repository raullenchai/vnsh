# ADR-003: Cloudflare R2 + KV Storage Architecture

## Status

Accepted

## Context

Opaque needs to store encrypted blobs with:

1. Fast upload/download (global edge)
2. Automatic expiry (TTL support)
3. Low cost at scale
4. No egress fees (users download directly)
5. Simple operations (no database management)

### Options Considered

#### AWS S3 + DynamoDB

**Pros:**
- Industry standard
- Mature tooling
- Lifecycle policies

**Cons:**
- Egress fees ($0.09/GB)
- Complex IAM setup
- Separate services to manage
- Higher latency from Workers

#### Cloudflare R2 (S3-compatible)

**Pros:**
- Zero egress fees
- S3-compatible API
- Native Workers integration
- Global distribution

**Cons:**
- No built-in TTL for objects
- Younger product (2022)
- 25MB single-request upload limit

#### Cloudflare KV (Key-Value Store)

**Pros:**
- Built-in TTL support
- Global replication
- Native Workers integration
- Simple API

**Cons:**
- 25MB value size limit
- Higher cost per operation
- Eventually consistent
- Not ideal for large blobs

#### Durable Objects

**Pros:**
- Strong consistency
- Stateful compute
- WebSocket support

**Cons:**
- Complex programming model
- Overkill for simple storage
- Higher cost

## Decision

**Use R2 for blob storage + KV for metadata with TTL.**

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Worker Request                          │
└──────────────────────────┬──────────────────────────────────┘
                           │
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
    ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
    │  R2 Bucket  │ │ KV Namespace│ │  Response   │
    │             │ │             │ │             │
    │ Blob data   │ │ Metadata:   │ │ Blob stream │
    │ (encrypted) │ │ - createdAt │ │    or       │
    │             │ │ - expiresAt │ │ JSON error  │
    │             │ │ - hasPayment│ │             │
    │             │ │   (TTL set) │ │             │
    └─────────────┘ └─────────────┘ └─────────────┘
```

### Rationale

1. **R2 for Blobs**:
   - Zero egress = users can download freely
   - 25MB limit matches our max blob size
   - Streaming upload/download
   - Custom metadata for createdAt/expiresAt

2. **KV for Metadata**:
   - Native TTL support (auto-delete on expiry)
   - Fast lookups (check expiry before R2 fetch)
   - Small values (JSON metadata)
   - Eventually consistent is fine for metadata

3. **Separation of Concerns**:
   - KV handles expiry lifecycle
   - R2 handles bulk storage
   - Worker orchestrates both

## Consequences

### Positive

- Zero egress costs
- Automatic metadata cleanup via KV TTL
- Fast metadata checks (KV) before blob fetch (R2)
- Simple operational model

### Negative

- R2 blobs not auto-deleted (need lifecycle rules or cron)
- Two services to manage
- Eventual consistency in KV (rare edge case)

### Orphan Blob Cleanup

KV entries auto-expire, but R2 objects persist. Solutions:

1. **R2 Lifecycle Rules** (Recommended):
   - Delete objects with `expiresAt` metadata < now
   - Configure in Cloudflare dashboard

2. **Cron Trigger**:
   ```typescript
   export default {
     async scheduled(event, env, ctx) {
       // Scan and delete expired blobs
     }
   }
   ```

3. **Lazy Deletion**:
   - Delete R2 object when KV lookup returns null
   - Already implemented in `handleBlob()`

## Implementation Details

### Data Model

**R2 Object:**
```
Key: {uuid}
Body: <encrypted bytes>
CustomMetadata:
  createdAt: "2024-01-01T00:00:00.000Z"
  expiresAt: "2024-01-02T00:00:00.000Z"
```

**KV Entry:**
```
Key: blob:{uuid}
Value: {
  "createdAt": 1704067200000,
  "expiresAt": 1704153600000,
  "hasPayment": false,
  "priceUSD": null
}
TTL: 86400 (24 hours)
```

### Upload Flow

```typescript
// 1. Generate ID
const id = crypto.randomUUID();

// 2. Store blob in R2
await env.OPAQUE_STORE.put(id, body, {
  customMetadata: { createdAt, expiresAt }
});

// 3. Store metadata in KV with TTL
await env.OPAQUE_META.put(`blob:${id}`, JSON.stringify(meta), {
  expirationTtl: ttlSeconds
});
```

### Download Flow

```typescript
// 1. Check KV (fast path for expiry/404)
const meta = await env.OPAQUE_META.get(`blob:${id}`);
if (!meta) return 404;

// 2. Check expiry (belt and suspenders)
if (Date.now() > meta.expiresAt) return 410;

// 3. Fetch from R2
const object = await env.OPAQUE_STORE.get(id);
if (!object) {
  // Orphan cleanup
  await env.OPAQUE_META.delete(`blob:${id}`);
  return 404;
}

// 4. Stream response
return new Response(object.body);
```

## Cost Analysis

### R2 Pricing

| Resource | Free Tier | Paid |
|----------|-----------|------|
| Storage | 10 GB | $0.015/GB/month |
| Class A (writes) | 1M/month | $4.50/million |
| Class B (reads) | 10M/month | $0.36/million |
| Egress | Unlimited | Free |

### KV Pricing

| Resource | Free Tier | Paid |
|----------|-----------|------|
| Reads | 100k/day | $0.50/million |
| Writes | 1k/day | $5.00/million |
| Deletes | 1k/day | $5.00/million |
| Storage | 1 GB | $0.50/GB |

### Example: 10,000 blobs/day (avg 100KB)

- Storage: 1GB/day × 30 = 30GB → $0.45/month
- R2 Writes: 300k/month → Free tier
- R2 Reads: 300k/month → Free tier
- KV Writes: 300k/month → ~$1.50/month
- KV Reads: 600k/month → ~$0.30/month

**Total: ~$2.25/month** for 300k blobs

## References

- [Cloudflare R2 Documentation](https://developers.cloudflare.com/r2/)
- [Cloudflare KV Documentation](https://developers.cloudflare.com/kv/)
- [R2 Pricing](https://developers.cloudflare.com/r2/pricing/)
