# vnsh CLI

One mutable workspace that people and AI agents can share. The default command
encrypts locally with AES-256-GCM and returns two URLs: an edit link and a
cryptographically view-only link.

```bash
echo "handoff notes" | npx vnsh
vn ./report.html
vn read "https://vnsh.dev/w/<id>#r=<key>"
vn write "https://vnsh.dev/w/<id>#w=<secret>" ./revised.html
vn renew -t 168 "https://vnsh.dev/w/<id>#w=<secret>"
vn history "https://vnsh.dev/w/<id>#r=<key>"
vn restore "https://vnsh.dev/w/<id>#w=<secret>" 3
vn init .
```

`vn init` adds a small, managed vnsh section to the project's existing
`AGENTS.md` and/or `CLAUDE.md` (creating `AGENTS.md` when neither exists). It is
safe to run again: surrounding project instructions are preserved and the vnsh
section is refreshed in place. This gives agents a standing rule for when to
create a handoff and how to open a complete encrypted URL.

Workspaces expire 24 hours after their latest write by default. Use `--ttl 168`
when creating one for a seven-day lifetime; writes preserve the chosen lifetime.
`vn renew` extends expiry without changing content or its version.
The current version plus the latest 19 previous versions are retained. Restoring
an old version creates a new latest version, so concurrent-edit protection stays
monotonic.

Run `vn login` to connect your account through a browser. Once signed in, new
workspaces and artifacts are kept until you delete them. `vn whoami` shows the
active account and `vn logout` revokes the saved credential. Automation can use
`VNSH_TOKEN` instead.

## Link permissions

| Link | Read | Write |
|---|---:|---:|
| `vnsh.dev/w/{id}#w=...` | yes | yes |
| `vnsh.dev/w/{id}#r=...` | yes | no |
| `vnshcontent.dev/p/{id}` | public HTTP | only through the separate edit link |

`--public` deliberately stores plaintext and returns both the public URL and a
private edit URL. vnsh can read public content; encrypted remains the default.

## One-shot blobs

Use `--blob` for the legacy immutable `/v/` format. It uses AES-256-CBC for
compatibility with every previously issued link:

```bash
git diff | vn --blob --ttl 2
vn read "https://vnsh.dev/v/<id>#k=<key>&iv=<iv>"
```

## Options

```text
-t, --ttl <hours>  Lifetime from 1 to 168 hours
-H, --host <url>   Override the API host
-l, --local        Produce an encrypted payload without uploading
-b, --blob         Create an immutable legacy blob
    --public       Store a public workspace without encryption
-v, --version      Print the CLI version
```

Input can come from a file or stdin. Binary output is byte-for-byte when
redirected; when writing to a terminal the CLI saves recognized binary content
to a temporary file instead of printing mojibake. Maximum upload size is 25 MiB.

Install globally with `npm install -g vnsh`, or run without installation using
`npx vnsh`. Set `VNSH_HOST` for a self-hosted instance.

MIT · [vnsh.dev](https://vnsh.dev) · [source](https://github.com/raullenchai/vnsh)
