# Plan: Portable Workspace (v2)

**Status:** Phase 0 shipped · Phases 1–3 gated on signal
**Baseline:** worker `f41332d1`, `vnsh-mcp@1.3.0`

A mutable, versioned, host-blind document so agents from different vendors can
collaborate through a single URL, instead of the user copy-pasting context
between Claude Code, Cursor, OpenHands and friends.

Category name: **Portable Workspace**. When explaining what it is, anchor to the
full name *Claude Code Artifacts* — "like Claude Code Artifacts, but not locked to
one vendor". Never shorten that to "Artifacts": plain Artifacts on claude.ai is
free on every plan, and the claim collapses.

## What carries the positioning

| Axis | Durability | Why |
|---|---|---|
| Multi-agent | **structural** | Anthropic will not let Cursor write to a claude.ai artifact |
| Model-agnostic | **structural** | Same reason — the lock-in is the point of their design |
| Host-blind | replicable | They could add client-side encryption whenever they want |
| Free | evaporates | Claude Code Artifacts is Team/Enterprise-gated *today*, not forever |

The narrative has to rest on the first two. Free is an acquisition hook, not a claim.

## Not goals

- No real-time co-editing (OT/CRDT). See [Concurrency](#concurrency).
- No per-version permissions. Permission attaches to the workspace, Google Docs style.
- No accounts, orgs or roles. Holding the link *is* the permission.
- No content moderation — the server cannot decrypt, so it cannot moderate. This
  is a governance constraint, not an oversight.
- **No monetisation in v2.** TTL is the core abuse lever; it cannot be sold away.

---

## Key schedule

```
S = random(32)                  root secret, lives only in the fragment
R = HKDF(S, "vnsh/read/v2")     reserved
K = HKDF(S, "vnsh/enc/v2")      content key — AES-256-GCM
W = HKDF(S, "vnsh/write/v2")    write token, sent as 64 hex chars
H = SHA-256(W)                  the only derived value the server stores
```

The server authorises writes without being able to decrypt: `W` is a one-way
derivation of `S`, so `H` proves write capability and reveals nothing else.

Two link tiers fall out of this for free, with no server-side state:

```
/w/{id}#w=<S>   read + write
/w/{id}#r=<K>   read only
```

A holder of `K` decrypts every version but cannot recover `S`, so cannot derive
`W`, so can never write — and cannot turn the view-only link back into an edit
link. The UI hides the "copy edit link" option on a `#r=` page rather than
disabling it, because that is a fact about the key schedule, not a policy.

**GCM, not the CBC used by v1 blobs.** Mutable content needs integrity: without an
authentication tag, anyone able to rewrite storage — *including the host* — could
flip ciphertext bits undetectably, which hollows out the entire host-blind claim.

**Nonces are random per write and prepended**, never derived from a version
number. Reusing a nonce under GCM leaks the authentication key, not just
plaintext. Random-per-write makes reuse impossible with zero bookkeeping on the
client, and keeps working unchanged when Phase 1 stores each version separately.

---

## Concurrency

**Decision: optimistic concurrency control. Not last-write-wins, and not CRDT.**

```
PUT /api/workspace/:id
  If-Match: "7"     ← absent ⇒ 428. Unconditional writes are refused.
  ↓ version compare                      ⇒ 412 on mismatch
  ↓ R2 put(onlyIf:{etagMatches})         ⇒ genuine compare-and-swap
```

All three layers are load-bearing. The metadata version check alone leaves a
TOCTOU window where two agents both read v7 and both pass; `etagMatches` closes
it at the storage layer.

Measured in production with five agents writing concurrently against v1: one
succeeded, four received 412, final content was one agent's complete work. No
silent overwrite, no interleaved garbage.

### Host-blindness costs nothing for conflict *detection*

"Is this write based on the version currently stored?" is a metadata question.
The server orders opaque bytes; it never needs to see inside them. Host-blindness
only pushes conflict *resolution* to the client — where it has to live anyway,
since only the client can read the content. There is no loss here: a generic
backend could not meaningfully merge two HTML reports even with the plaintext.

### Why not CRDT

1. **It would not help the server.** CRDT merges happen client-side too. Its value
   is converging without coordination; we already have coordination — a stable URL
   and a version counter.
2. **Wrong workload.** CRDTs pay off for character-level concurrent editing. Here,
   human-driven agents take turns and replace whole documents.
3. **Meaningless at this granularity.** CRDT-merging two versions of an HTML
   report produces garbage unless the CRDT is built over the document's real
   structure — which would mean dictating what users may write. That is the
   complexity explosion, not the decryption.

### What is actually needed — Phase 1

Append is conflict-free *by construction* and needs no CRDT:

```
POST /api/workspace/:id/append    no If-Match; the server serialises
```

Each chunk carries its own nonce; the client concatenates on read. With no
"based on which version" concept, concurrent appends cannot conflict. For the
real workload — agents accumulating findings into a shared document — append is
the natural semantic, and `PUT` is for genuine rewrites.

### Open risk in Phase 0

Nothing gets clobbered, but **Phase 0 stores no history, so a bad LLM merge is
unrecoverable.** On a 412 the MCP tool hands back the current content in the same
turn so the model can merge without a second round trip, but model merges are not
reliable. Version history (Phase 1) is the safety net; until then this is real.

---

## Measurement

The gate: **does more than one agent actually touch a workspace?**

```sql
SELECT blob3 AS workspace, count(DISTINCT blob4) AS agents
FROM vnsh_events
WHERE blob1 LIKE 'workspace%'
GROUP BY workspace
```

`blob4` exists because every MCP client — Claude Code, Cursor, OpenHands — reaches
vnsh through the same server, so `X-Vnsh-Client` reported "mcp" for all of them.
Counting client *types* would have shown 1 for three collaborating agents and 2
for a single agent using two surfaces: **wrong in both directions**. The MCP
initialize handshake carries the real client identity, so the server forwards it
as `X-Vnsh-Agent`.

**If this stays at 1, the multi-agent thesis is falsified. Do not proceed to
Phase 1 — revisit the value proposition, or accept that this is a better
pastebin.**

---

## Phases

Later phases are triggered by signal, not schedule.

### Phase 0 — validate ✅ shipped

Worker endpoints (`POST /api/workspace`, `GET`/`PUT /api/workspace/:id`), the
`/w/:id` viewer, four MCP tools, browser workspace creation on the homepage, and
agent attribution. Deliberately excluded: version history, append, retention
limits, packaging.

### Phase 1 — conflicts and history

**Trigger:** a meaningful 412 rate, or one bad merge that destroys work.

Version history (`w/{id}/{v}` layout, keep the last ~10) and the append channel
above. Because nonces travel with the ciphertext, this changes no cryptography.

### Phase 2 — sharing with people

**Trigger:** real demand to send workspaces to colleagues rather than agents.

The two link tiers and in-page rendering already shipped early, because a page
nobody can read defeats the point. What remains is **reputation isolation**: a
separately registered domain for rendering user content, so a phishing report
cannot get `vnsh.dev` blocklisted. Sandboxing already prevents key theft and
exfiltration; the domain buys something different.

### Phase 3 — distribution

**Trigger:** Phase 0's gate passes and you want people beyond yourself using it.

OpenHands microagent (`.openhands/microagents/`, with `triggers:` and
`mcp_location` — a single markdown file bootstraps the whole integration), a
Claude Code plugin, and a human-side creation entry point.

**That last item is not optional.** Agents are single-session: Claude Code has no
way to know another agent is open in a different window, so it will not
spontaneously decide to create a shared workspace. Creation must be triggered by a
human — a command, a hook, a keybinding. *Reading* is the reliable trigger,
because "a vnsh URL appeared in the conversation" is a definite, local signal.
The link propagates; agent collaboration instinct does not.

---

## Rendering

Workspace content is untrusted — it comes from whoever holds the link. Both
renderers (the `/w/` viewer and the local `file://` wrapper written by
`vnsh_workspace_open`) put it in an iframe with `sandbox="allow-scripts"` and
deliberately **no** `allow-same-origin`, so the frame runs in an opaque origin and
cannot read `location.hash` (the key), storage, or the embedding document. An
injected CSP of `default-src 'none'` removes its network access.

The CSP is placed by parsing with `DOMParser`, **not** by matching `/<head[^>]*>/`.
The regex version was exploitable: content containing an HTML comment holding a
fake head tag swallowed the `<meta>` into that comment and disabled the policy
entirely. Confirmed in Chromium before the fix.

Link clicks are forwarded to the hosting page via `postMessage` rather than
granting `allow-popups-to-escape-sandbox`. That token would also let content open
windows with no user gesture, and a URL is a fine place to smuggle plaintext out.
The receiver identifies the frame by source window, not origin — a sandboxed
frame's origin is the string `"null"` and identifies nobody — and only acts on
`http`/`https`.

---

## Boundary to state carefully

Handing someone a link hands the key to whatever reads it, **including that
agent's model provider**.

- **Can say:** vnsh cannot read the content; it is gone 24h after the last write.
- **Cannot say:** no model vendor can see it. You are deliberately authorising them.

TTL is what bounds the blast radius, not the encryption. This is why §Not goals
rules out selling permanence.
