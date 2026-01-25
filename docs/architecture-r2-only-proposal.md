# Architecture Proposal: R2-Only Storage

**Status**: Proposed (implement when traffic grows)
**Date**: 2025-01-24
**Author**: @raullenchai + Claude

## Overview

This document analyzes a potential architecture simplification: removing KV and using R2 custom metadata for all storage needs.

## Current Architecture (KV + R2)

```
Upload:  Client → Worker → KV.put(metadata) + R2.put(blob)
Download: Worker → KV.get(metadata) → check expiry/payment → R2.get(blob)
```

- **KV**: Stores metadata (expiry time, price, content type)
- **R2**: Stores encrypted blobs

## Proposed Architecture (R2-Only)

```
Upload:  Client → Worker → R2.put(blob, { customMetadata: { expires, price } })
Download: Worker → R2.get(blob + metadata) → check expiry/payment → return
```

- **R2**: Stores both blob and metadata together

## Cost Comparison

### Free Tier

| Metric | KV | R2 | Advantage |
|--------|----|----|-----------|
| Storage | 1 GB | 10 GB | R2 (10x) |
| Writes/month | ~30,000 | 1,000,000 | R2 (33x) |
| Reads/month | ~3,000,000 | 10,000,000 | R2 (3x) |

### Paid Tier (per million operations)

| Operation | KV | R2 | Advantage |
|-----------|----|----|-----------|
| Writes | $5.00 | $4.50 | R2 (10% cheaper) |
| Reads | $0.50 | $0.36 | R2 (28% cheaper) |
| Storage/GB | $0.50 | $0.015 | R2 (97% cheaper) |
| Egress | Standard CF rates | **Free** | R2 (significant) |

## Performance Comparison

| Characteristic | KV | R2 |
|----------------|----|----|
| Consistency | Eventually consistent (up to 60s) | Strong consistency |
| Read latency | ~10-50ms (edge cached) | ~50-100ms |
| Write latency | ~100-500ms | ~50-200ms |
| Small object optimization | Yes (< 25KB optimal) | No (designed for large objects) |
| Global replication | Automatic edge caching | Single region storage |

### vnsh Usage Pattern

```
Typical usage:
- Writes: 1 per blob
- Reads: 1-3 per blob (or 1 with burn-on-read)
- Object size: 1KB - 1MB (most < 100KB)
- Lifecycle: < 24 hours
```

### Current KV+R2 Performance
```
Upload:   KV.put + R2.put = 2 writes
Download: KV.get + R2.get = 2 reads
Latency:  KV ~20ms + R2 ~80ms = ~100ms total
```

### R2-Only Performance
```
Upload:   R2.put (blob + metadata) = 1 write
Download: R2.get (blob + metadata) = 1 read
Latency:  R2 ~80ms (single request)
```

## TTL Expiration Handling

**Challenge**: R2 doesn't support per-object TTL like KV's `expirationTtl`.

### Recommended Solution: Prefix-Based Lifecycle Rules

Use object key prefixes to bucket objects by TTL:

```
/1h/{uuid}   → Lifecycle rule: delete after 1 day
/24h/{uuid}  → Lifecycle rule: delete after 2 days
/7d/{uuid}   → Lifecycle rule: delete after 8 days
```

**Advantages**:
- Zero code required for cleanup
- R2 Lifecycle Rules are free
- Automatic, reliable deletion
- No Cron Worker needed

**Trade-off**:
- Limited to predefined TTL options (acceptable for vnsh)

### Alternative: Cron Worker Cleanup

```typescript
// scheduled worker - runs hourly
export default {
  async scheduled(event, env) {
    const listed = await env.VNSH_STORE.list();
    for (const obj of listed.objects) {
      const head = await env.VNSH_STORE.head(obj.key);
      const expires = head?.customMetadata?.expires;
      if (expires && Date.now() > parseInt(expires)) {
        await env.VNSH_STORE.delete(obj.key);
      }
    }
  }
}
```

```toml
# wrangler.toml
[triggers]
crons = ["0 * * * *"]  # hourly
```

## Summary

| Aspect | Winner | Reason |
|--------|--------|--------|
| Free quota | **R2** | 33x writes, 10x storage |
| Paid cost | **R2** | Cheaper across all operations, no egress fees |
| Read latency | KV | Edge cache is faster |
| Write latency | Tie | Similar performance |
| Consistency | **R2** | Strong vs eventual |
| Architecture | **R2** | Single system, atomic operations |

## Recommendation

**Implement R2-Only architecture when**:
- Monthly writes approach KV free tier limit (~30,000)
- Storage approaches 1GB
- Traffic patterns justify the migration effort

**Implementation steps**:
1. Add R2 Lifecycle Rules for TTL prefixes
2. Modify upload handler to use prefix-based keys
3. Modify download handler to read from R2 metadata
4. Remove KV dependency from wrangler.toml
5. Migrate or let existing KV data expire naturally

## R2 Metadata Limits

- Maximum 2KB total custom metadata per object
- vnsh needs: `expires` (13 bytes), `price` (10 bytes), `contentType` (50 bytes)
- Well within limits

## References

- [Cloudflare R2 Pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare KV Pricing](https://developers.cloudflare.com/kv/platform/pricing/)
- [R2 Object Lifecycle Rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [R2 Custom Metadata](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2object)
