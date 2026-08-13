# CLI guidance

- Run `npm test` and `npm run build` after changes.
- Keep stdout usable as command output; progress and errors belong on stderr, and failures must exit non-zero.
- Derive the package/client version from `package.json` rather than typing a release number.
- Preserve stdin, file, Unicode, binary, public, edit-link, and read-only-link behavior when adding commands.
- Never print account bearer tokens or URL fragments except where the user explicitly requested the resulting share URL.
