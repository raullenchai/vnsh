# ADR-004: x402 Payment Protocol

## Status

Proposed (Not Yet Implemented)

## Context

Opaque should support monetization of shared content via the emerging x402 payment standard. Content creators can set a price, and viewers must pay to access.

### Requirements

1. Creator specifies price at upload time
2. Server returns HTTP 402 for unpaid access
3. Multiple payment methods (Lightning, Stripe)
4. Host-blind: Server doesn't know payment destination
5. Stateless verification: No payment database needed

### Options Considered

#### Traditional Payment Gateway

**Pros:**
- Well-understood flow
- Supports credit cards

**Cons:**
- Requires account setup
- High fees for micropayments
- Server must store payment state

#### Lightning Network (Bitcoin L2)

**Pros:**
- Instant settlement
- Low fees (< 1%)
- No account needed
- Proof of payment (preimage)

**Cons:**
- Requires Lightning wallet
- Volatile exchange rates
- Learning curve

#### x402 Protocol Standard

**Pros:**
- HTTP-native (402 status code)
- Method-agnostic
- Emerging standard
- Self-describing payments

**Cons:**
- Not widely adopted yet
- Still evolving

## Decision

**Implement x402-compatible payment with Lightning and Stripe support.**

### Design: Host-Blind Payment

The key insight: Payment destination is encrypted inside the blob header.

```
┌─────────────────────────────────────────────────────────────┐
│                        Blob Structure                        │
├─────────────────────────────────────────────────────────────┤
│ [4 bytes] Header length                                      │
│ [N bytes] Header JSON (cleartext, describes payment)         │
│ [M bytes] Encrypted content                                  │
└─────────────────────────────────────────────────────────────┘
```

**Header (cleartext):**
```json
{
  "version": 1,
  "payment": {
    "price": 0.01,
    "currency": "USD",
    "lightning": "lnurl1dp68gurn8ghj7...",
    "stripe": "price_1234..."
  }
}
```

**Server stores only:**
```json
{
  "hasPayment": true,
  "priceUSD": 0.01
}
```

Server knows a payment is required and the price, but NOT where the money goes.

### Payment Flow

#### Upload (Creator)

```bash
oq --price 0.01 --lightning lnaddr... --stripe price_... content.txt
```

1. CLI builds header with payment info
2. Header + encrypted content uploaded
3. Server extracts price, stores `hasPayment: true`

#### Access (Viewer)

```
GET /api/blob/{id}
→ 402 Payment Required
  X-Payment-Price: 0.01
  X-Payment-Methods: lightning,stripe
```

1. Viewer fetches blob header (cleartext)
2. Viewer chooses payment method
3. Viewer pays (Lightning invoice / Stripe Checkout)
4. Viewer receives payment proof
5. Viewer requests blob with proof

```
GET /api/blob/{id}?paymentProof={jwt}
→ 200 OK
  <encrypted content>
```

### Payment Proof (JWT)

```json
{
  "sub": "blob_id",
  "iat": 1704067200,
  "exp": 1704070800,
  "method": "lightning",
  "receipt": "preimage_hex"
}
```

- Signed by server's JWT secret
- Self-validating (no DB lookup)
- 1-hour TTL
- Single blob access

### Lightning Flow

```
┌────────┐     ┌────────┐     ┌────────┐     ┌────────┐
│ Viewer │────▶│ Opaque │────▶│  Get   │────▶│ Viewer │
│        │     │ Server │     │ Invoice│     │  Pays  │
└────────┘     └────────┘     └────────┘     └────────┘
     │              │              │              │
     │  GET blob    │              │              │
     │─────────────▶│              │              │
     │◀─────────────│              │              │
     │  402 + info  │              │              │
     │              │              │              │
     │  Fetch header│              │              │
     │─────────────▶│              │              │
     │◀─────────────│              │              │
     │  Payment info│              │              │
     │              │              │              │
     │  Pay invoice │              │              │
     │──────────────────────────────────────────▶│
     │◀──────────────────────────────────────────│
     │  Preimage    │              │              │
     │              │              │              │
     │  GET + proof │              │              │
     │─────────────▶│              │              │
     │◀─────────────│              │              │
     │  Content     │              │              │
```

### Stripe Flow

```
┌────────┐     ┌────────┐     ┌────────┐     ┌────────┐
│ Viewer │────▶│ Opaque │────▶│ Stripe │────▶│ Webhook│
│        │     │ Server │     │Checkout│     │        │
└────────┘     └────────┘     └────────┘     └────────┘
     │              │              │              │
     │  GET blob    │              │              │
     │─────────────▶│              │              │
     │◀─────────────│              │              │
     │  402 + info  │              │              │
     │              │              │              │
     │  Create session              │              │
     │─────────────▶│─────────────▶│              │
     │◀─────────────│◀─────────────│              │
     │  Redirect URL│              │              │
     │              │              │              │
     │  Pay via Stripe              │              │
     │──────────────────────────────▶              │
     │              │              │──────────────▶│
     │              │◀─────────────────────────────│
     │              │  Confirm     │              │
     │              │              │              │
     │  Poll status │              │              │
     │─────────────▶│              │              │
     │◀─────────────│              │              │
     │  JWT proof   │              │              │
     │              │              │              │
     │  GET + proof │              │              │
     │─────────────▶│              │              │
     │◀─────────────│              │              │
     │  Content     │              │              │
```

## Consequences

### Positive

- Host-blind: Server doesn't know payment destination
- Stateless: No payment database, JWT is self-contained
- Flexible: Multiple payment methods
- Standard: HTTP 402 is semantically correct

### Negative

- Complex client implementation
- Payment destination in cleartext header
- Requires trusted viewer (or verify header client-side)

### Security Considerations

1. **Header Tampering**: Attacker could modify payment destination
   - Mitigation: Include header hash in encrypted section
   - Viewer verifies hash after decrypt

2. **Proof Replay**: Stolen JWT could be reused
   - Mitigation: Short TTL (1 hour)
   - Future: One-time use tokens (requires state)

3. **Price Manipulation**: Server could lie about price
   - Mitigation: Price in header, viewer verifies

## API Extensions

### Upload with Payment

```http
POST /api/drop?price=0.01
Content-Type: application/octet-stream

[header_length][header_json][encrypted_content]
```

### 402 Response

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json
X-Payment-Price: 0.01
X-Payment-Currency: USD
X-Payment-Methods: lightning,stripe

{
  "error": "PAYMENT_REQUIRED",
  "message": "This blob requires payment",
  "payment": {
    "price": 0.01,
    "currency": "USD",
    "methods": ["lightning", "stripe"]
  }
}
```

### Create Lightning Invoice

```http
POST /api/pay/{id}/lightning
→ {
    "bolt11": "lnbc...",
    "expires": "2024-01-01T12:00:00Z"
  }
```

### Create Stripe Session

```http
POST /api/pay/{id}/stripe
→ {
    "sessionId": "cs_...",
    "url": "https://checkout.stripe.com/..."
  }
```

### Poll Payment Status

```http
GET /api/pay/{id}/status?session={stripe_session}
→ {
    "status": "paid",
    "proof": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
```

## References

- [HTTP 402 Payment Required](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/402)
- [Lightning BOLT11](https://github.com/lightning/bolts/blob/master/11-payment-encoding.md)
- [LNURL](https://github.com/lnurl/luds)
- [Stripe Checkout](https://stripe.com/docs/payments/checkout)
