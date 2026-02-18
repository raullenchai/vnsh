# Scaling & Revenue Plan

## Context

vnsh is an AI-native encrypted ephemeral sharing service. As of v2.1.0, it has five entry points: CLI, MCP server, Chrome Extension, web upload, and GitHub Action. The Chrome Extension was submitted to the Chrome Web Store on 2026-02-14.

The core challenge: file-sharing services that scale without revenue cannot sustain themselves. vnsh's answer is **AI-native monetization** — its primary consumers are AI agents (via MCP), and agents can pay for content programmatically using the HTTP 402 protocol.

### Current State (2026-02-18)

| Area | Status |
|------|--------|
| Usage analytics | None (no counters, no telemetry) |
| Revenue | None (x402 payment code is stubbed but unimplemented) |
| Authentication | None (no API keys, no accounts) |
| Chrome Extension | Published on Chrome Web Store, homepage Extension tab, viewer install CTA |
| Blog / SEO | `/blog` with first post, sitemap updated |
| Growth | 5 awesome list PRs submitted |

### Infrastructure Costs (Cloudflare)

| Resource | Free Tier | Paid Pricing |
|----------|-----------|--------------|
| Workers | 100K req/day | $5/mo + $0.50/M requests |
| R2 storage | 10 GB | $0.015/GB/mo |
| R2 Class A (writes) | 1M/mo | $4.50/M |
| R2 Class B (reads) | 10M/mo | $0.36/M |
| R2 egress | **Free** | **Free** (no egress fees) |
| KV reads | 100K/day | $0.50/M |
| KV writes | 1K/day | $5/M |

Key advantage: R2 egress is free and the ephemeral 24h TTL makes storage self-cleaning. At 10K uploads/day, estimated monthly cost is ~$20.

---

## Phase 1: Foundation — prerequisite for scale

### 1.1 Usage Analytics (KV Counters)

**Problem**: Zero visibility into traffic patterns. Cannot make revenue or growth decisions without data.

**Solution**: Lightweight daily counters in KV. No external analytics services, no PII collection.

```
KV key: stats:{YYYY-MM-DD}:{metric}
Metrics: uploads, reads, reads:402, source:cli, source:mcp, source:extension, source:web
Retention: 90 days (via expirationTtl)
```

Add `GET /api/stats?token=SECRET` endpoint for operator visibility (authenticated with env var).

**Files**: `worker/src/index.ts`

### 1.2 Client Identification

Add `X-Vnsh-Client` header to all clients for source attribution:

| Client | Header Value |
|--------|-------------|
| CLI (bash) | `cli/2.0.0` |
| CLI (npm) | `cli-npm/2.0.0` |
| MCP server | `mcp/1.2.0` |
| Chrome Extension | `extension/1.0.0` |
| Web viewer | `web/1.0` |
| Pipe script | `pipe/1.0` |

Worker parses the header and increments the corresponding `source:{client}` counter.

**Files**: `cli/vn`, `cli/npm/src/cli.ts`, `mcp/src/index.ts`, `extension/src/lib/api.ts`, `worker/src/index.ts`

---

## Phase 2: Freemium Gate — first revenue

### 2.1 API Keys (No Accounts)

vnsh should NOT require traditional accounts. API keys are the right primitive for developer tools and AI agents.

- Key generation at `vnsh.dev/keys` (email-only signup, no password)
- Passed via `Authorization: Bearer vnsh_...` header
- KV storage: `apikey:{sha256(key)}` → `{ tier, email, created, usage }`
- CLI: `VNSH_TOKEN=vnsh_... vn myfile.txt`
- MCP: `VNSH_TOKEN` env var in `.mcp.json`
- Extension: settings panel in popup

### 2.2 Tier Structure

| | Free (anonymous) | Pro ($9/month) |
|---|---|---|
| Max upload size | 25 MB | 100 MB |
| Max TTL | **24 hours** | 30 days |
| Upload limit | 20/hour per IP | 200/hour |
| Read limit | 120/min per IP | Unlimited |
| Burn-on-read | No | Yes |
| View count | No | Yes |
| Password-protected links | No | Yes |

**Upgrade triggers** (in order of conversion likelihood):

1. **TTL** — Free tier gets 24h only. The moment someone needs a 7-day link, they upgrade. This is the #1 conversion trigger because it happens organically: a recipient can't open a link the next day.
2. **Upload volume** — CI/CD pipelines (GitHub Action uploading build artifacts) hit 20/hour within minutes.
3. **File size** — Screenshots, PDFs, and video clips push past 25MB quickly.
4. **Burn-on-read** — Security-conscious users want guaranteed single-access.

### 2.3 Stripe Subscription

- `POST /api/subscribe` → creates Stripe Checkout session → redirect back with API key
- Webhook `customer.subscription.created` → create API key in KV with `tier: "pro"`
- Webhook `customer.subscription.deleted` → downgrade key to free tier
- Worker secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`

**Files**: `worker/src/index.ts`

---

## Phase 3: x402 AI Payments — the differentiator

This is what makes vnsh different from every other pastebin. AI agents can pay for content programmatically via the HTTP 402 Payment Required standard.

See also: [architecture-x402-payment-proposal.md](architecture-x402-payment-proposal.md), [ADR 004](adr/004-payment-protocol.md)

### 3.1 Complete x402 Payment Flow

The scaffolding exists in `worker/src/index.ts`. The upload endpoint accepts `?price=X` and the read endpoint returns 402 with payment headers. What's missing:

1. **JWT verification**: The current code accepts any non-empty `paymentProof` string. Implement HS256 JWT verification with `JWT_SECRET` env var.
2. **Stripe Checkout for per-blob payments**: New endpoint `POST /api/pay/:id` creates a one-time Stripe Checkout session.
3. **Split URL model**: Upload with `?price=1.00` returns both:
   - `payUrl`: `vnsh.dev/pay/{id}` (no encryption key, shareable publicly)
   - `secretUrl`: `vnsh.dev/v/{id}#secret...` (full key, kept private by creator)
   - Buyer visits `payUrl` → pays → receives signed JWT → redirect to `secretUrl`
4. **Revenue split**: Platform 10%, Stripe 2.9% + $0.30, creator ~87%.

### 3.2 MCP `vnsh_pay` Tool

New tool in the MCP server for programmatic agent payments:

```
Tool: vnsh_pay
Description: Pay for and retrieve content behind a vnsh paywall
Input: { url: string, max_price: number }
Behavior: detect 402 → create payment → submit proof → return decrypted content
```

Agent configuration:
```json
{
  "mcpServers": {
    "vnsh": {
      "command": "npx",
      "args": ["-y", "vnsh-mcp"],
      "env": {
        "VNSH_HOST": "https://vnsh.dev",
        "VNSH_SPENDING_LIMIT": "5.00",
        "VNSH_STRIPE_TOKEN": "sk_..."
      }
    }
  }
}
```

**The AI-native value proposition**: Developer shares a paid vnsh link → another developer's Claude agent encounters it → agent pays automatically within configured budget → decrypted content is injected into context. vnsh becomes the payment layer for AI-to-AI context exchange.

### 3.3 Extension Support

- Extension popup: add "Price" field next to TTL when sharing
- Extension link detector: detect 402 on hover → show "Paid content — $X" in tooltip instead of decrypted preview

**Files**: `worker/src/index.ts`, `mcp/src/index.ts`, `extension/src/popup/popup.ts`, `extension/src/content/detector.ts`

---

## Phase 4: Team & Enterprise

### 4.1 Team Tier ($29/month per seat)

- Shared upload namespace: all team members see team upload history
- Team API key with pooled quota
- Audit log: who uploaded what, when, from which client
- KV namespace: `team:{teamId}:blob:{blobId}` prefix

### 4.2 CI/CD Tier ($19/month per repo)

The GitHub Action ([upload-to-vnsh](https://github.com/raullenchai/upload-to-vnsh)) is the enterprise wedge:
- Free: 24h artifact retention
- Paid: 7-day retention, Slack/Teams webhook on upload, auto-upload on test failure

### 4.3 Enterprise Self-Hosted ($99/month)

Already documented in [self-hosting.md](self-hosting.md). Formalize as a paid offering:
- Dedicated R2 bucket (data isolation)
- Custom domain (`vnsh.company.com`)
- SSO/SAML integration
- SLA guarantee (99.9% uptime)

---

## Cost Projections

| Traffic Level | Uploads/day | R2 Storage (steady-state) | Monthly Cost | Breakeven |
|---|---|---|---|---|
| Current | ~5 | < 1 GB | $0 (free tier) | — |
| 1K/day | 1,000 | ~3 GB | ~$5/mo | 1 Pro sub |
| 10K/day | 10,000 | ~30 GB | ~$15-25/mo | 3 Pro subs |
| 100K/day | 100,000 | ~300 GB | ~$100-150/mo | 17 Pro subs |

The ephemeral nature (24h default TTL) and free R2 egress make vnsh dramatically cheaper to run than traditional file-hosting services.

---

## Implementation Priority

| # | Item | Effort | Revenue Impact | Status |
|---|------|--------|---------------|--------|
| 1 | Usage analytics | 2 days | Decision data | Pending |
| 2 | Client ID headers | 0.5 days | Attribution | Pending |
| 3 | API key system | 3 days | Gate for paid features | Pending |
| 4 | TTL + size gating | 1 day | Conversion trigger | Pending |
| 5 | Stripe subscription | 3 days | Recurring revenue | Pending |
| 6 | x402 JWT verification | 2 days | Creator paywall | Pending |
| 7 | Stripe per-blob payment | 5 days | Micropayment revenue | Pending |
| 8 | MCP `vnsh_pay` tool | 2 days | Agent-native payments | Pending |

Recommended order: **1-2** (remaining foundation, ~3 days) → **3-5** (freemium, ~1 week) → **6-8** (x402, ~2 weeks). Total: ~3-4 weeks to first revenue.

---

## Strategic Thesis

vnsh's moat is not encryption (anyone can encrypt) or ephemerality (temp file hosts exist). The moat is the **AI-native consumption interface**:

1. Every other pastebin optimizes for human readers. vnsh optimizes for AI agents via MCP.
2. x402 is the HTTP-native payment standard. AI agents can handle 402 responses programmatically. vnsh becomes one of the first services with agent-native payments.
3. The Chrome Extension creates a **viral loop** (shared link → Web Viewer → extension install CTA → new user). The MCP integration creates a **monetization loop** (agent encounters paid content → pays automatically → creator earns).

**Near-term** (Q1 2026): Foundation + freemium gate. Revenue from Pro subscriptions ($9/mo).
**Medium-term** (Q2 2026): x402 agent payments. Revenue from creator paywalls (platform takes 10%).
**Long-term** (Q3+ 2026): Context marketplace where developers sell AI-optimized content. Revenue from marketplace fees.
