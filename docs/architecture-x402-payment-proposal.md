# Architecture Proposal: x402 Payment Protocol

**Status**: Proposed (future implementation)
**Date**: 2025-01-24
**Author**: @raullenchai + Claude

## Overview

This document proposes an architecture for implementing the x402 (HTTP 402 Payment Required) protocol to enable "pay-to-view" functionality for vnsh blobs.

## Current State

Basic scaffolding exists in the codebase:

```typescript
// Upload with price
POST /api/drop?price=0.05

// Download returns 402 if unpaid
GET /api/blob/:id → 402 Payment Required
Headers:
  X-Payment-Price: 0.05
  X-Payment-Currency: USD
  X-Payment-Methods: lightning,stripe

// Bypass with proof (currently accepts any non-empty proof)
GET /api/blob/:id?paymentProof=token → 200 OK
```

## x402 Protocol Flow

```
┌─────────┐         ┌─────────┐         ┌─────────┐
│  Buyer  │         │  vnsh   │         │ Payment │
│ (Agent) │         │ Worker  │         │ Provider│
└────┬────┘         └────┬────┘         └────┬────┘
     │                   │                   │
     │ GET /api/blob/123 │                   │
     │──────────────────>│                   │
     │                   │                   │
     │ 402 Payment Required                  │
     │ X-Payment-Price: 0.05                 │
     │ X-Payment-Methods: lightning,stripe   │
     │ X-Payment-Address: ln://...           │
     │<──────────────────│                   │
     │                   │                   │
     │ Pay $0.05 ────────────────────────────>
     │                   │                   │
     │<─────────────────── Payment Receipt   │
     │                   │                   │
     │ GET /api/blob/123 │                   │
     │ X-Payment-Proof: {receipt}            │
     │──────────────────>│                   │
     │                   │ Verify ──────────>│
     │                   │<─────── Valid     │
     │                   │                   │
     │<── 200 + Content  │                   │
     └───────────────────┴───────────────────┘
```

## Design Decisions

### 1. Payment Methods

| Method | Pros | Cons | Effort |
|--------|------|------|--------|
| **Lightning** | Instant, low fees, AI-native | Requires node/LSP | Medium |
| **Stripe** | Familiar, cards | High fees (2.9%), KYC | Low |
| **L402 (Macaroons)** | Standard, programmable | Complex | High |
| **Crypto (USDC)** | Permissionless | UX friction | Medium |

**Recommendation**: Start with Lightning (via Strike/Alby API) + Stripe fallback.

### 2. The Key Revelation Problem

**Challenge**: vnsh uses client-side encryption with key in URL fragment (`#k=...&iv=...`). If uploader shares full URL, buyer can skip payment and decrypt locally.

#### Solution: Split URL Model (Recommended)

```
Uploader receives two URLs:
  - Share link:  https://vnsh.dev/pay/abc123        (no key, for buyers)
  - Secret link: https://vnsh.dev/v/abc123#k=...   (full key, keep private)

Buyer flow:
  1. Visit /pay/abc123 → sees paywall with price
  2. Completes payment → receives signed token
  3. Token exchanged for redirect to full URL with key
```

**Advantages**:
- Preserves "host-blind" guarantee (server never sees key)
- Uploader controls monetization
- Simple implementation

**Trade-off**:
- Requires uploader to keep secret link private
- Uploader could share secret link to bypass their own paywall

#### Alternative: Server-Side Key Escrow

```
Upload: Client encrypts, also sends key encrypted with platform pubkey
Pay: Server releases key after payment verification
```

**Con**: Breaks "host-blind" guarantee - server can decrypt content.

### 3. Payment Proof Format

```typescript
interface PaymentProof {
  // JWT signed by payment provider or vnsh
  header: {
    alg: 'ES256';
    typ: 'JWT';
  };
  payload: {
    sub: string;        // blob ID
    amt: number;        // amount paid (cents)
    cur: string;        // currency (USD)
    method: 'lightning' | 'stripe';
    preimage?: string;  // Lightning payment preimage
    txid?: string;      // Stripe payment intent ID
    exp: number;        // JWT expiry timestamp
    iat: number;        // issued at timestamp
  };
  signature: string;
}
```

### 4. Revenue Distribution

```
Buyer pays $1.00
  ├── Platform fee (5%):      $0.05 → vnsh
  ├── Payment processor (3%): $0.03 → Stripe/Lightning LSP
  └── Creator payout (92%):   $0.92 → Uploader wallet
```

**Payout mechanisms**:
- **Lightning**: Uploader provides Lightning address at upload time
- **Stripe**: Requires Stripe Connect (complex, KYC)
- **Simple v1**: No payout, platform keeps all (donation/tip model)

### 5. MCP Agent Integration

New MCP tool for AI agents to pay for content:

```typescript
Tool: vnsh_pay
Description: "Pay for and retrieve a paid vnsh blob"

Input Schema:
{
  "url": {
    "type": "string",
    "description": "The vnsh payment URL"
  },
  "max_price": {
    "type": "number",
    "description": "Maximum price willing to pay (USD)"
  }
}

Output:
{
  "content": "decrypted content...",
  "price_paid": 0.05
}
```

**Agent workflow**:
```
1. Agent encounters: "Check this report: https://vnsh.dev/pay/abc123"
2. Agent calls: vnsh_pay({ url, max_price: 0.10 })
3. MCP Server:
   a. GET /api/blob/abc123 → 402, price: $0.05
   b. Verify max_price >= actual_price
   c. Call payment API (Lightning/Stripe)
   d. GET /api/blob/abc123 with payment proof
   e. Decrypt content locally
4. Agent receives decrypted content
```

## API Specification

### New Endpoints

```
GET /pay/:id
  Response: HTML payment page
  - Shows price, payment methods
  - No decryption key in URL
  - QR codes for Lightning/Stripe

POST /api/pay/:id
  Body: { method: 'lightning' | 'stripe' }
  Response: {
    method: 'lightning',
    invoice: 'lnbc...',
    expires: 1234567890
  }
  OR
  Response: {
    method: 'stripe',
    checkoutUrl: 'https://checkout.stripe.com/...'
  }

POST /api/verify/:id
  Body: {
    proof: PaymentProof,
    method: 'lightning' | 'stripe'
  }
  Response: {
    success: true,
    redirectUrl: 'https://vnsh.dev/v/abc123#k=...&iv=...'
  }

GET /api/blob/:id
  Header: X-Payment-Proof: <jwt>
  OR
  Query: ?paymentProof=<jwt>
  Response: 200 + encrypted blob (if proof valid)
```

### Modified Upload Endpoint

```
POST /api/drop?price=0.05&payout=user@getalby.com
  Body: encrypted blob
  Response: {
    id: 'abc123',
    payUrl: 'https://vnsh.dev/pay/abc123',
    fullUrl: 'https://vnsh.dev/v/abc123#k=...&iv=...',
    price: 0.05,
    currency: 'USD'
  }
```

### Storage Schema

```typescript
// R2 custom metadata (or KV)
interface BlobMetadata {
  expires?: number;       // Unix timestamp
  price?: number;         // Price in cents (500 = $5.00)
  currency?: 'USD';       // Currency code
  payoutAddress?: string; // Lightning address for creator
  keyHash?: string;       // SHA-256 of decryption key (for verification)
}
```

## CLI Changes

```bash
# Upload with price
echo "premium content" | vn --price 0.05

# Output:
# Share link (for buyers): https://vnsh.dev/pay/abc123
# Secret link (keep private): https://vnsh.dev/v/abc123#k=...&iv=...
# Price: $0.05 USD

# Upload with price and payout address
echo "premium content" | vn --price 0.05 --payout user@getalby.com
```

## Implementation Phases

### Phase 1: Basic Paywall (MVP)
- [ ] Price parameter on upload stored in metadata
- [ ] 402 response with payment headers
- [ ] Payment page at `/pay/:id`
- [ ] Manual/mock payment proof verification
- [ ] Split URL model (payUrl vs fullUrl)

### Phase 2: Lightning Integration
- [ ] Integrate Alby or Strike API
- [ ] Generate Lightning invoices
- [ ] Verify payment via preimage
- [ ] Implement MCP `vnsh_pay` tool
- [ ] Webhook for payment confirmation

### Phase 3: Stripe Integration
- [ ] Stripe Checkout integration
- [ ] Payment intent creation
- [ ] Webhook for payment confirmation
- [ ] JWT proof generation

### Phase 4: Creator Payouts
- [ ] Lightning address support on upload
- [ ] Automatic payment forwarding
- [ ] Revenue dashboard/API
- [ ] Stripe Connect (optional, complex)

## Security Considerations

### Payment Verification
- All proofs must be cryptographically signed
- Lightning: verify preimage matches payment hash
- Stripe: verify via Stripe API, not just webhook
- Proofs should be single-use or time-limited

### Rate Limiting
- Prevent invoice generation spam
- Limit failed payment attempts per IP
- Consider CAPTCHA for payment page

### Key Security
- Never log or store decryption keys server-side
- Key only revealed after verified payment
- Consider key hash in metadata for additional verification

## Open Questions

1. **Minimum price?**
   - Lightning: can go as low as $0.01
   - Stripe: minimum ~$0.50 due to fixed fees
   - Platform minimum: TBD

2. **Refund policy?**
   - Burn-on-read + payment = content consumed, no refund?
   - Time-limited refund window?
   - Dispute resolution?

3. **Agent spending authorization?**
   - How does user set spending limits for AI agents?
   - Per-transaction limit vs daily budget?
   - Require confirmation above threshold?

4. **Multi-access pricing?**
   - Pay once, access forever?
   - Pay per access?
   - Subscription model?

5. **Free preview?**
   - Allow first N bytes free?
   - Truncated preview before paywall?

## References

- [HTTP 402 Payment Required](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/402)
- [L402 Protocol](https://docs.lightning.engineering/the-lightning-network/l402)
- [Lightning Address](https://lightningaddress.com/)
- [Alby API](https://guides.getalby.com/alby-wallet-api/reference/api-reference)
- [Strike API](https://docs.strike.me/)
- [Stripe Checkout](https://stripe.com/docs/payments/checkout)
