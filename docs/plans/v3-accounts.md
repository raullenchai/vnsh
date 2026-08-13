# v3: Accounts, retention, and what that costs the guarantee

Status: implementation in progress 2026-08-13. The product decision below
supersedes the earlier 7-day signed-in free tier: signed-in documents are kept
until the owner deletes them during the free preview.

> **2026-08-13 mode boundary:** this plan describes account ownership applied
> to encrypted capability-link workspaces. Phase 1 account-based Artifacts add
> a second, intentionally non-host-blind collaboration mode so authenticated
> Agents can discover content without already possessing a fragment key. The
> encrypted workspace guarantees below still hold for that original mode; they
> are not claims about account Artifacts. See GitHub issue #59.

## The problem, stated exactly

A workspace shared with a colleague is gone 24 hours later. The colleague opens
the link on Monday and finds nothing.

## What the code actually does today

This matters, because the obvious framing of the fix is wrong.

| Path | Default | Maximum | How |
|---|---|---|---|
| Blob `/v/` | 24h | **168h (7 days)** | `?ttl=`, already live, already anonymous |
| Workspace `/w/` | 24h | **24h** | no parameter exists |

Verified against production on 2026-08-02: `POST /api/drop?ttl=168` returns an
expiry seven days out, with no credential of any kind. `MAX_TTL_HOURS = 168` has
been in `worker/src/index.ts` the whole time, and the CLI (`-t`), the MCP tools
(`ttl`), and `extension/src/lib/api.ts` all pass it through.

Two consequences:

1. **Seven days is not a thing to sell. It already shipped, for free, to
   everyone.** A tier table with "Free: 24h / Pro: 7 days" would be taking back
   a live capability and re-selling it. `docs/scaling-revenue.md` §2.2 proposes
   exactly that; it was written in February against a state that has changed,
   and this document supersedes it on the retention question.
2. **The reported pain is the workspace gap, not a missing account.** Every
   extension entry point creates a workspace (`service-worker.ts`, five call
   sites), and `workspaceExpiry()` hardcodes 24h. There is no parameter, so
   there is no price at which that path gives you more than a day.

So retention is fixed first, for free, for everyone. Accounts are then built on
top for what accounts are actually good at — finding a document again — rather
than as the toll gate on a road that was never closed.

## What accounts cost us

Section 7 of `CLAUDE.md` says the server knows *when* and *how much*, never
*what*. An account adds *who*, and *who* is the field that turns anonymous
metadata into a profile.

We are going to add it anyway, deliberately, with these limits:

- **Anonymous use does not change.** No route requires a session. Every existing
  client keeps working untouched. The strong guarantee still exists in full; it
  becomes a mode you can choose rather than the only mode.
- **The server never gains the ability to read content.** Encryption, key
  schedule, and fragment transport are untouched. What it gains is a list of
  ids and an email beside them.
- **The claim gets restated, not quietly kept.** `CLAUDE.md` §7, `docs/privacy.md`,
  and the homepage must say: for a signed-in user, vnsh stores your email and
  the ids of documents you created; it still cannot read any of them. Shipping
  accounts while the front page still implies otherwise is the ADR-004 failure
  mode — an unverifiable claim left standing in a response — and is not
  acceptable here.

### Document titles: the field that will try to leak

A dashboard listing twelve opaque ids is useless, so it wants titles, and a
title is content. The options are all bad in different ways, and the least bad
is a split:

- The **server list is authoritative for what exists** — ids, sizes, expiry.
- **Names live in the browser** (`localStorage`, and the extension history that
  already exists), keyed by id and merged into the list at render time. A
  document created on another device shows as an id until you open it once.
- A per-document **opt-in** lets you store a plaintext name on the server, with
  the trade named at the moment you make it: *"vnsh will be able to read this
  name."* Off by default.

No scheme where the server holds an encrypted title survives contact with the
facts: the dashboard has no document keys, because keys live in fragments that
were never sent to it, and a passwordless login gives the user no secret to
derive one from.

## Tiers

| | Anonymous | Signed in (free) | Paid |
|---|---|---|---|
| Default retention | 24h | Permanent | To be priced |
| Maximum retention | 7 days | Permanent | To be priced |
| Extend before expiry | needs the write token | one click | one click |
| Find it again | local history only | any device | any device |
| Delete on demand | needs the write token | one click | one click |

Nothing above the "Anonymous" column is removed from it. Signing in changes the
default and adds management; paying buys duration beyond what anonymous use has
always had.

## Stages

Each stage is independently useful and independently shippable.

### Stage 1 — retention, free, no authentication

- `POST /api/workspace?ttl=` accepts 1..168, same cap as blobs.
- The chosen TTL is stored and re-applied on every write, so editing a 7-day
  workspace does not silently demote it to 24h.
- `POST /api/workspace/:id/renew` — extends the clock without rewriting content,
  authenticated by the write token the author already holds. This is the piece
  that makes a link survivable: today the only way to push the expiry out is to
  re-upload the whole document.
- Every client prints the expiry at the moment of sharing. The pain is not only
  that documents expire, it is that nobody is told when.

This alone closes the reported bug, and it requires nothing to be provisioned.

### Stage 2 — identity

- **Origin:** `account.vnsh.dev`, separate from `vnsh.dev`. The viewer renders
  attacker-supplied content; a session cookie on that origin would be reachable
  from any XSS in it. Splitting the origin is the same reasoning that already
  moved public documents to `vnshcontent.dev`, applied to credentials instead of
  reputation.
- **Login:** magic link. `POST /api/auth/request {email}` → 32-byte token, stored
  as its SHA-256, 15-minute expiry, single use → email. Callback sets a
  `__Host-` session cookie: HttpOnly, Secure, SameSite=Lax.
- **Store:** D1. Accounts are relational (users, sessions, documents,
  subscriptions) and R2 prefix-listing is the wrong shape for "list mine,
  paginated" and "expire these sessions". KV stays retired — the 1000-writes/day
  cap took the whole site down on 2026-06-09 and is not coming back.
- **Ownership:** when a signed-in client creates a document, a row is written
  linking user to id. Anonymous creates write no row, and there is no path that
  retroactively claims one.

### Stage 3 — payment

Per ADR-004, in this order and no other: **a rail that can actually take money,
end to end, before the word `402` or the string `stripe` appears in any
response.** The `tier` column exists from stage 2 and reads `free` for everyone
until that is true.

## Provisioning the operator must do

The code for stages 2 and 3 is inert without these, and fails closed with a 501
rather than pretending — the pattern already used for `/api/stats` and for the
deploy job's missing token. Nothing here can be done from this repository.

| Needed | For | Blocking |
|---|---|---|
| D1 database + binding | sessions, ownership | stage 2 |
| `SESSION_SECRET` | cookie signing | stage 2 |
| Transactional email provider + `RESEND_API_KEY` | magic links | stage 2 |
| SPF/DKIM records on `vnsh.dev` | mail that is not spam-foldered | stage 2 |
| `account.vnsh.dev` custom domain | credential origin split | stage 2 |
| Stripe account + webhook secret | subscriptions | stage 3 |

Longer retention also lengthens the window in which an abuse report can arrive
about live content. The `vnshcontent.dev` abuse mailbox is still unconfigured
(MX and TXT empty); at 30-day retention that stops being a deferrable item.
