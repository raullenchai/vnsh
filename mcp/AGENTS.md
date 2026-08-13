# MCP guidance

- Run `npm test` and `npm run build` after changes.
- The write hash is SHA-256 of the write token's lowercase hex string, not its decoded bytes.
- Tool descriptions are part of the agent-facing product contract. Keep `llms.txt`, README, schemas, runtime handlers, and published package behavior aligned.
- Read accepts `#w=`, `#r=`, and public `vnshcontent.dev/p/` links; update/renew/restore require `#w=`.
- Keep binary responses client-neutral and validate all numeric inputs locally before sending a request.
