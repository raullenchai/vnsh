# vnsh-mcp

MCP server for [vnsh](https://vnsh.dev) — **portable workspaces for AI agents**.

One encrypted link that Claude Code, Cursor, OpenHands and any other MCP client
can all read *and write*. Like Claude Code Artifacts, but not locked to one vendor.

Content is encrypted in the client. The key travels only in the URL fragment, which
browsers never send to a server, so **vnsh cannot read your workspaces**.

## Install

```bash
claude mcp add vnsh -- npx -y vnsh-mcp
```

Or in `.mcp.json` / any MCP client config:

```json
{
  "mcpServers": {
    "vnsh": { "command": "npx", "args": ["-y", "vnsh-mcp"] }
  }
}
```

Set `VNSH_HOST` to point at a self-hosted instance (defaults to `https://vnsh.dev`).

## Workspaces

A workspace is a stable URL whose contents can be replaced. Hand the link to
another agent or another session and it picks up where the last one left off —
the URL does not change as the document evolves.

| Tool | What it does |
|---|---|
| `vnsh_workspace_create` | Opens a workspace, returns an edit link and a view-only link |
| `vnsh_workspace_read` | Reads current contents and version |
| `vnsh_workspace_update` | Writes a new version; on a conflict returns the current contents so you can merge |
| `vnsh_workspace_open` | Renders it locally in the browser, sandboxed |

Links come in two tiers:

```
https://vnsh.dev/w/{id}#w=…   read + write
https://vnsh.dev/w/{id}#r=…   read only
```

The view-only key is a one-way derivation of the edit key, so a recipient of a
`#r=` link can decrypt every version but can never write, and can never turn it
back into an edit link. No accounts, no ACLs — holding the link *is* the permission.

Workspaces are deleted 24 hours after their last write.

## One-shot sharing

For content that will not change, the original tools still apply:

| Tool | What it does |
|---|---|
| `vnsh_read` | Decrypts a `vnsh.dev/v/` link |
| `vnsh_share` | Encrypts and uploads text, returns a link |
| `vnsh_share_file` | Same, for a local file |

## Security

- **AES-256-GCM** for workspaces, authenticated so tampering is detectable — including by the host.
- Writes are authorised by a token derived from the root secret; the server stores only its SHA-256 and can neither decrypt nor forge.
- Rendering happens in a sandboxed frame with no network access, so a workspace cannot read your key or send itself anywhere.

Handing someone a link necessarily hands the key to whatever reads it, including
that agent's model provider. vnsh cannot read your content; the 24-hour lifetime
is what bounds everything else.

MIT · [github.com/raullenchai/vnsh](https://github.com/raullenchai/vnsh)
