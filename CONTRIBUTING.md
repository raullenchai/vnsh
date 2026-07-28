# Contributing to vnsh

Thanks for helping improve vnsh. Keep changes focused and preserve the host-blind design: encryption happens on the client, keys stay in URL fragments, and the service stores encrypted data only.

## Setup

Install dependencies for every package from the repository root:

```bash
npm run install:all
```

## Tests

Run the root test command before opening a pull request:

```bash
npm test
```

Package-level suites can also be run directly when a change only affects one area:

```bash
npm run test:worker
npm run test:mcp
cd extension && npm test
```

The worker, MCP server, and extension suites use Vitest. Extension changes can also run coverage with `cd extension && npm run test:cov`.

## Deployment

Production deploys from the worker package:

```bash
cd worker
npx wrangler deploy
```

Verify production behavior after deploying. Local tests do not prove Cloudflare bindings, R2 access, browser sandbox behavior, or production CSP behavior.

## Client-side crypto compatibility

Changes to encryption, decryption, URL parsing, key handling, or secret transport must keep every supported client byte-compatible. Cover crypto changes with fixtures that exercise each client path, and do not change URL formats, key or IV encoding, padding, or ciphertext handling without documenting the migration path.

## Viewer sandbox and security changes

Viewer sandbox, CSP, extension permission, and other browser security changes need real browser verification in addition to automated checks. Include what browser or extension verification was performed in the pull request.

## Pull request checklist

- Link the issue or describe the user-visible problem.
- Keep the change scoped to one fix or feature.
- List the commands or GitHub checks used for validation.
- Call out any required setup that was not available.
- Do not include secrets, private logs, API tokens, or sensitive shared content.
