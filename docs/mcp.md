# MCP server reference

`vnsh-mcp` is a local crypto client for any Model Context Protocol host. It
encrypts and decrypts before content crosses the vnsh service boundary.

## Install

Pin the reviewed release:

```bash
claude mcp add vnsh -- npx -y vnsh-mcp@1.6.0
```

For Cursor, OpenHands, Cline, Windsurf, or another MCP client, use this server
entry in the client's project configuration:

```json
{"vnsh":{"command":"npx","args":["-y","vnsh-mcp@1.6.0"]}}
```

An unpinned `npx -y vnsh-mcp` tracks new releases. That is convenient, but the
MCP process handles plaintext, so pin or build from source if you review it.

## Tools

| Tool | Purpose |
|---|---|
| `vnsh_workspace_create` | Create an encrypted or explicitly public mutable workspace; accepts `ttl` up to 168 hours |
| `vnsh_workspace_read` | Read encrypted `#w`/`#r` links or public `/p/` links and return the current version |
| `vnsh_workspace_update` | Conditionally replace content; conflicts include the current version and content for merging |
| `vnsh_workspace_renew` | Extend expiry using an edit link without changing content or version |
| `vnsh_workspace_open` | Save locally and open untrusted content inside a network-disabled sandbox |
| `vnsh_share` | Create an encrypted, immutable text blob |
| `vnsh_share_file` | Create an encrypted, immutable binary/file blob |
| `vnsh_read` | Read legacy encrypted blobs and public workspace URLs |

Workspace content is accepted as a string document. For images and other binary
files use `vnsh_share_file`; reads save binary bytes to a mode-0600 temporary file
and return a client-neutral local path.

To retain newly created workspaces and artifacts until deletion, sign in at
`https://account.vnsh.dev`, create a CLI / agent token, and expose it to the MCP
process as `VNSH_TOKEN`. Set `artifact: true` on `vnsh_workspace_create` for a
rendered `/artifact/` URL. The account stores ownership metadata but never the
URL fragment, so retain the returned link.

## Permissions and URLs

```text
https://vnsh.dev/w/{id}#w=...       encrypted; read and write
https://vnsh.dev/w/{id}#r=...       encrypted; read only
https://vnshcontent.dev/p/{id}      plaintext; readable by ordinary HTTP
```

Both encrypted links can be passed to `vnsh_workspace_read` and
`vnsh_workspace_open`. Only `#w=` can update or renew. Public creation returns a
shareable `/p/` URL and a separate `#w=` URL that the author must retain to edit.

## Version-safe updates

Read returns a numeric version. Pass it as `base_version` to update. If another
writer lands first, the tool does not overwrite it: it returns the current
version and content so the caller can merge and retry.

## Self-hosting and development

`VNSH_HOST` overrides the API host. To build locally:

```bash
cd mcp
npm ci
npm run build
npm test
```

The server reports the package version during MCP initialization, making it
possible to verify that a client restarted onto the intended release.
