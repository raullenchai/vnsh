# Worker guidance

- Run `npm test`, `npx tsc --noEmit`, and `npx wrangler deploy --dry-run` before deployment.
- Client JavaScript and CSS currently live in TypeScript template literals. Backslashes must survive both parsers; add browser-facing regression tests for regex or escape changes.
- In `vitest-pool-workers`, consume or cancel every R2-backed response body or the isolated-storage check can fail after the test.
- R2 custom metadata keys may be lower-cased in production. Read both forms when preserving existing metadata.
- Workspace writes must remain conditional. Never weaken `If-Match`, write-token validation, size caps, encryption boundaries, or public/encrypted visibility invariants.
- Use D1 for account indexes and R2 as the content source of truth. A D1 bookkeeping failure must not make a successful content CAS appear to have failed.
- Use bindings inside the Worker. Cloudflare REST calls are reserved for the operator-only analytics endpoint where no binding query API exists.
