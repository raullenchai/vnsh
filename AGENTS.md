# Repository guidance

- Run the tests for every package you touch; the root test workflow covers Worker, CLI, MCP, and extension independently.
- Preserve host-blind encryption: URL fragments and derived content keys must never be sent to or stored by vnsh.
- Keep CLI, MCP, extension, and browser implementations byte-compatible. Update the shared crypto vectors when the protocol changes.
- Do not hand-edit release versions in runtime code. Derive them from `package.json` and keep registry metadata covered by tests.
- Use `apply_patch` for source edits and keep unrelated working-tree changes intact.

Read the nearest nested `AGENTS.md` before editing a package.
