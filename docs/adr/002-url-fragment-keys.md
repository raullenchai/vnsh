# ADR-002: Key Transport via URL Fragment

## Status

Accepted

## Context

Opaque needs to transport encryption keys from uploader to reader without the server ever seeing them. This is the core "host-blind" guarantee.

### Options Considered

#### Query Parameters (`?k=...`)

```
https://opaque.dev/v/abc123?k=deadbeef&iv=cafebabe
```

**Pros:**
- Simple to parse
- Works everywhere

**Cons:**
- **Sent to server** in HTTP request
- Logged in server access logs
- Cached by CDNs and proxies
- Visible in browser history synced to cloud

#### HTTP Headers

```
GET /api/blob/abc123
X-Opaque-Key: deadbeef
X-Opaque-IV: cafebabe
```

**Pros:**
- Not visible in URL
- Can be encrypted in transit

**Cons:**
- Can't share via URL (requires client implementation)
- Still visible to server
- Complex for browser-only clients

#### URL Fragment (`#k=...`)

```
https://opaque.dev/v/abc123#k=deadbeef&iv=cafebabe
```

**Pros:**
- **Never sent to server** (browser strips it)
- Accessible via `location.hash` in JavaScript
- Standard behavior across all browsers
- URL is shareable

**Cons:**
- Visible in browser history (local only, not synced)
- Can be leaked via `Referer` header (mitigated by `Referrer-Policy`)
- Maximum length limits (varies by browser, ~2KB is safe)

#### Separate Channel (Out-of-Band)

Share blob ID and key separately via different channels.

**Pros:**
- Maximum security
- No single point of compromise

**Cons:**
- Poor UX (two things to share)
- Easy to mix up keys

## Decision

**Use URL fragments** (`#k=...&iv=...`) for key transport.

### Rationale

1. **Browser Guarantee**: RFC 3986 specifies that fragments are client-side only:
   > "...the fragment identifier is not sent as part of the request"

2. **Single Shareable URL**: Users share one URL that contains everything needed.

3. **JavaScript Access**: Both upload page and viewer can access `location.hash`.

4. **No Server Modification**: Works with standard HTTP servers, CDNs, and proxies.

5. **Precedent**: Used by other security tools:
   - PrivateBin
   - Firefox Send (deprecated)
   - Standard Notes

## Consequences

### Positive

- True host-blindness — server mathematically cannot see keys
- Simple user experience — share one URL
- Works with any HTTP infrastructure

### Negative

- Keys visible in local browser history
- Referer header leakage risk (mitigated)
- URL length limits for very long keys

### Mitigations

#### Referer Header Leakage

Add to viewer HTML:

```html
<meta name="referrer" content="no-referrer">
```

And in HTTP response:

```
Referrer-Policy: no-referrer
```

#### Browser History

- Keys in history are local only
- History entries expire with browser cleanup
- Incognito/private mode doesn't save history

#### URL Length

- Key: 64 hex chars (32 bytes)
- IV: 32 hex chars (16 bytes)
- Total fragment: ~100 chars
- Well within all browser limits

## Implementation Notes

### URL Format

```
https://opaque.dev/v/{uuid}#k={key_hex}&iv={iv_hex}
         │          │       │          │
         │          │       │          └── 32 hex chars (16 bytes)
         │          │       └───────────── 64 hex chars (32 bytes)
         │          └───────────────────── UUID v4
         └──────────────────────────────── Host
```

### Parsing in JavaScript

```javascript
const params = new URLSearchParams(location.hash.slice(1));
const key = params.get('k');
const iv = params.get('iv');
```

### Parsing in Bash

```bash
URL="https://opaque.dev/v/abc#k=dead&iv=cafe"
FRAGMENT="${URL#*#}"
KEY=$(echo "$FRAGMENT" | grep -o 'k=[^&]*' | cut -d= -f2)
IV=$(echo "$FRAGMENT" | grep -o 'iv=[^&]*' | cut -d= -f2)
```

## Security Analysis

### What the server sees

```
GET /v/abc123 HTTP/1.1
Host: opaque.dev
```

No fragment. No key. No IV.

### What access logs contain

```
192.168.1.1 - - [01/Jan/2024:12:00:00] "GET /v/abc123 HTTP/1.1" 200 1234
```

Only the blob ID, not the decryption key.

### What CDN caches

```
Cache-Key: /v/abc123
```

Fragments are ignored in cache keys.

## References

- [RFC 3986 Section 3.5](https://datatracker.ietf.org/doc/html/rfc3986#section-3.5) - Fragment Identifier
- [Referrer-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Referrer-Policy)
- [PrivateBin Security](https://github.com/PrivateBin/PrivateBin/wiki/FAQ#how-does-privatebin-provide-confidentiality)
