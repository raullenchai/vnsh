# Contributing

Issues and pull requests are welcome, including ones that tell us we are wrong.
The most useful contribution this project has had so far was someone
reimplementing the protocol from `llms.txt` in about 200 lines and reporting
everything the document had failed to say.

## Getting set up

```bash
git clone https://github.com/raullenchai/vnsh.git
cd vnsh
npm test                      # runs every package
cd worker && npm run dev      # a local worker at :8787
```

Each package installs and tests on its own:

| Path | What it is | Test command |
|---|---|---|
| `worker/` | Cloudflare Worker: API, viewer, homepage, `llms.txt` | `cd worker && npm test` |
| `mcp/` | `vnsh-mcp`, the MCP server | `cd mcp && npm test` |
| `cli/npm/` | `vnsh`, the `vn` command | `cd cli/npm && npm test` |
| `extension/` | Chrome extension | `cd extension && npm test` |

CI runs all four plus a type-check on every one. If you are an outside
contributor, a maintainer has to approve the first run — that is a GitHub
setting for first-time contributors, not something wrong with your PR.

## Things worth knowing before you change anything

**The worker's client-side code lives inside a template literal.** Everything
the browser runs — the viewer, the markdown renderer, the homepage — is a string
in `worker/src/index.ts`. Two consequences bite regularly:

- **Backslashes must be doubled.** `/\+/g` written once becomes `/+/g` in the
  browser and throws `Nothing to repeat`, taking the page down. `tsc` cannot see
  it. `worker/test/inline-scripts.test.ts` parses every served script and will.
- **A backtick ends the string.** Even inside a comment. If the compiler starts
  reporting nonsense a hundred lines away, look for one.

**Assert structure, not substrings.** CSS, comments and markup share one file,
so `expect(html).not.toContain('allow-same-origin')` matches the comment
explaining why it is not granted. Match the element or the attribute.

**Test the code that ships.** Several suites lift a function out of the page the
worker actually serves and evaluate it, rather than importing a copy. That is
deliberate: it is the only way a template-literal mangling shows up in a test
instead of in someone's browser.

**Four packages carry their own copy of the key schedule** because they ship
independently. Each is pinned to the same test vectors. If you change a
derivation, those tests are what stops a link made by one client from silently
failing to open in another — a failure that reads as corruption, not as version
skew.

## Pull requests

- One change per PR, with the reasoning in the description. Why is harder to
  recover later than what.
- Tests for behaviour you add or fix. A test that would have caught the bug is
  worth more than one that confirms the fix.
- Comments explain decisions, not mechanics. If a line is surprising, say what
  it is defending against.
- English for code, comments and commit messages.
- Run `npm test` before pushing.

If a PR conflicts with something that landed first, say so and we will work out
which implementation is better rather than defaulting to whichever arrived
earlier. That has happened, and the newer one won on measurement.

## Reporting a security issue

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## Documentation

`docs/` covers architecture, the API, the CLI, the MCP server, self-hosting and
operations. `docs/plans/` holds design documents, including the v2 workspace
plan with its reasoning and its open risks.

<https://vnsh.dev/llms.txt> is the protocol specification, written for agents but
readable by anyone. If you find it incomplete, that is a bug worth reporting —
its whole premise is that the clients are optional.
