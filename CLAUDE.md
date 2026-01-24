Project: vnsh
Identity: The Ephemeral Dropbox for AI. Philosophy: "Server-Side Blindness, Client-Side Sovereignty." Stack: Cloudflare Workers (Edge) + R2 (Storage) + MCP (Agent Integration). License: MIT.

1. Product Vision
vnsh is a trustless infrastructure designed to solve the "Context Injection" problem in LLM workflows. It allows developers to securely pipe sensitive local context (logs, diffs, configs, images) into AI Agents (Claude Code, Cursor) via ephemeral, encrypted URLs.

The "Host-Blind" Guarantee: Unlike generic pastebins, vnsh implements a strict Zero-Access Architecture.

Encryption: Occurs purely on the client (CLI/Browser) using AES-256-CBC.

Transport: The decryption Key & IV are transmitted strictly via the URL Fragment (#).

Storage: The server stores encrypted binary blobs. It never sees the keys.

Lifecycle: Data is mathematically irretrievable after the ephemeral window (24h) or upon "Burn-on-Read".

2. System Architecture
2.1 The Trustless Flow
Write Path (CLI): stdin -> Local OpenSSL Encrypt -> POST Encrypted Blob -> Return ID -> Generate #Key URL.

Read Path (Browser): GET /v/{ID} -> Client JS extracts #Key -> Fetch Blob -> WebCrypto Decrypt -> Render.

Read Path (Claude Code): Agent -> MCP Tool (Local) -> Fetch Blob -> Local Decrypt -> Inject Text to Context.

3. Interfaces & Specifications
3.1 The CLI (vn alias)
A zero-dependency wrapper for openssl and curl.

Command: vn [file] | [stdin]

Logic:

Generate KEY (32B Hex) & IV (16B Hex).

Encrypt Stream: openssl enc -aes-256-cbc -K $KEY -iv $IV.

Upload: curl -X POST --data-binary @- https://vnsh.dev/api/drop.

Output: https://vnsh.dev/v/{ID}#k={KEY}&iv={IV}.

3.2 The Web Viewer
A static, client-side decryption interface for human verification.

Requirement: Must be compatible with OpenSSL's AES-256-CBC padding.

Security: Strict CSP. No external analytics.

4. Claude Code Integration (MCP Server)
This is the bridge that allows Claude to "see" vnsh links natively without leaving the terminal environment.

4.1 MCP Architecture
We provide a local Model Context Protocol (MCP) server (vnsh-mcp) that runs alongside Claude Code. This acts as a Local Crypto-Proxy.

Why? Claude (the remote model) cannot visit the URL directly because the #Key is never sent to the server.

How? Claude delegates the "reading" task to the local MCP server, which has network access and CPU power to decrypt.

4.2 Tool Definitions
Tool: vnsh_read
Description: "Securely retrieves and decrypts a vnsh URL. Use this tool whenever the user provides a 'vnsh.dev' link."

Input Schema:

JSON

{
  "url": { "type": "string", "description": "The full vnsh URL including the hash fragment (#k=...)" }
}
Implementation Logic (Node.js):

Parse URL hash to extract key and iv.

Fetch encrypted blob from https://vnsh.dev/api/blob/{id}.

Decrypt using crypto.createDecipheriv('aes-256-cbc', key, iv).

Return cleartext content to Claude.

Tool: vnsh_share
Description: "Encrypts and shares local content via vnsh. Use this when the output (code/logs) is too long to display in chat."

Input Schema:

JSON

{
  "content": { "type": "string" },
  "is_file_path": { "type": "boolean" }
}
Implementation Logic (Node.js):

Generate random key and iv.

Encrypt content locally.

POST to https://vnsh.dev/api/drop.

Return formatted URL: https://vnsh.dev/v/{id}#k={key}&iv={iv}.

5. API Specification (Server-Side)
POST /api/drop
Behavior: Dumb Pipe. Accepts stream -> Saves to R2 -> Returns ID.

Constraint: DO NOT attempt to validate file type. Treat everything as application/octet-stream.

GET /api/blob/:id
Behavior: Dumb Pipe. Streams data from R2 to Client.

CORS: Access-Control-Allow-Origin: * (Critical for Web Viewer & Local MCP).

6. Implementation Prompt for Claude
Use this prompt to scaffold the project:

"We are building vnsh, a Host-Blind data tunnel for AI workflows.

Project Structure:

/worker: Cloudflare Worker (TypeScript) - The dumb storage API.

/mcp: The Node.js MCP Server for Claude Code integration.

Step 1 (The Core): Please write the src/index.ts for the Cloudflare Worker. It must handle POST /api/drop and GET /api/blob/:id. It connects to an R2 bucket named vnsh-store.

Step 2 (The Bridge): Please write the index.ts for the MCP Server (/mcp). It needs to use the @modelcontextprotocol/sdk. Implement the vnsh_read tool that handles AES-256-CBC decryption compatible with OpenSSL."

7. Security & Risk Disclosure
Metadata Leakage: The server knows when and how much data is uploaded, but not what.

Link Hygiene: If the user shares the full URL (w/ hash) in a public channel, the data is compromised. vnsh is safe against Server Compromise, not User Negligence.

8. Development Guidelines

**Language**: All code, comments, documentation, and commit messages MUST be in English. No exceptions.

**Repository**: https://github.com/raullenchai/vnsh

**Testing**: Maintain 70%+ test coverage. Run `npm test` before pushing.

**Commits**: Use conventional commit messages. Always include `Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>` when Claude contributes.
