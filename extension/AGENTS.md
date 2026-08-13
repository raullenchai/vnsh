# Extension guidance

- Run `npm test` and the extension build after changes.
- Keep URL detection compatible with encrypted workspace, one-shot, artifact, and `vnshcontent.dev` public links.
- Do not move encryption keys out of URL fragments or send them in requests, analytics, logs, or extension storage that syncs remotely.
- Browser APIs and page content are untrusted; preserve sandboxing and explicit content-size limits.
