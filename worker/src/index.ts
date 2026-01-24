/**
 * vnsh Worker - Host-Blind Data Tunnel API
 *
 * Endpoints:
 * - GET / - Serve unified app (landing + upload + viewer overlay)
 * - GET /v/:id - Redirect to /#v/{id} (preserves hash fragments)
 * - GET /i - Serve install script (text/plain)
 * - POST /api/drop - Upload encrypted blob
 * - GET /api/blob/:id - Download encrypted blob
 */

interface Env {
  VNSH_STORE: R2Bucket;
  VNSH_META: KVNamespace;
}

// Constants
const MAX_BLOB_SIZE = 25 * 1024 * 1024; // 25MB
const DEFAULT_TTL_HOURS = 24;
const MAX_TTL_HOURS = 168; // 7 days

// CORS headers for cross-origin access
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

// Standard error response
function errorResponse(code: string, message: string, status: number): Response {
  return new Response(
    JSON.stringify({ error: code, message }),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders,
      },
    }
  );
}

// Handle CORS preflight
function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

// POST /api/drop - Upload encrypted blob
async function handleDrop(request: Request, env: Env): Promise<Response> {
  // Check content length
  const contentLength = request.headers.get('content-length');

  // Reject empty bodies - check both content-length header and body presence
  if (contentLength === '0' || (!contentLength && !request.body)) {
    return errorResponse('EMPTY_BODY', 'Request body is required', 400);
  }

  if (contentLength && parseInt(contentLength) > MAX_BLOB_SIZE) {
    return errorResponse('PAYLOAD_TOO_LARGE', `Maximum blob size is ${MAX_BLOB_SIZE / 1024 / 1024}MB`, 413);
  }

  // Parse optional TTL from query string
  const url = new URL(request.url);
  const ttlParam = url.searchParams.get('ttl');
  let ttlHours = DEFAULT_TTL_HOURS;
  if (ttlParam) {
    const parsed = parseInt(ttlParam);
    if (!isNaN(parsed) && parsed > 0 && parsed <= MAX_TTL_HOURS) {
      ttlHours = parsed;
    }
  }

  // Check for payment metadata (for x402 support)
  const priceParam = url.searchParams.get('price');
  const hasPayment = priceParam !== null && parseFloat(priceParam) > 0;
  const priceUSD = hasPayment ? parseFloat(priceParam) : undefined;

  // Generate unique ID with collision check
  let id: string = crypto.randomUUID();
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    // Check if ID already exists
    const existing = await env.VNSH_STORE.head(id);
    if (!existing) {
      break;
    }
    id = crypto.randomUUID();
    attempts++;
  }

  if (attempts >= maxAttempts) {
    return errorResponse('ID_COLLISION', 'Failed to generate unique ID, please retry', 500);
  }

  // Stream body to R2
  const body = request.body;
  if (!body) {
    return errorResponse('EMPTY_BODY', 'Request body is required', 400);
  }

  // Calculate expiry
  const now = Date.now();
  const expiresAt = now + ttlHours * 60 * 60 * 1000;

  try {
    // Store blob in R2
    await env.VNSH_STORE.put(id, body, {
      customMetadata: {
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
      },
    });

    // Store metadata in KV for fast expiry checks
    await env.VNSH_META.put(
      `blob:${id}`,
      JSON.stringify({
        createdAt: now,
        expiresAt,
        hasPayment,
        priceUSD,
      }),
      { expirationTtl: ttlHours * 60 * 60 }
    );

    return new Response(
      JSON.stringify({
        id,
        expires: new Date(expiresAt).toISOString(),
      }),
      {
        status: 201,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
        },
      }
    );
  } catch (err) {
    console.error('Failed to store blob:', err);
    return errorResponse('STORAGE_ERROR', 'Failed to store blob', 500);
  }
}

// GET /api/blob/:id - Download encrypted blob
async function handleBlob(id: string, request: Request, env: Env): Promise<Response> {
  // Check metadata first (fast path for expiry/404)
  const metaJson = await env.VNSH_META.get(`blob:${id}`);

  if (!metaJson) {
    // Blob not found or expired (KV auto-deletes expired entries)
    return errorResponse('NOT_FOUND', 'Blob not found or expired', 404);
  }

  const meta = JSON.parse(metaJson) as {
    createdAt: number;
    expiresAt: number;
    hasPayment?: boolean;
    priceUSD?: number;
  };

  // Check expiry (belt and suspenders)
  if (Date.now() > meta.expiresAt) {
    // Clean up expired blob
    await Promise.all([
      env.VNSH_STORE.delete(id),
      env.VNSH_META.delete(`blob:${id}`),
    ]);
    return errorResponse('EXPIRED', 'Blob has expired', 410);
  }

  // Check for payment requirement
  if (meta.hasPayment) {
    const url = new URL(request.url);
    const paymentProof = url.searchParams.get('paymentProof');

    if (!paymentProof) {
      // Return 402 Payment Required with payment info
      return new Response(
        JSON.stringify({
          error: 'PAYMENT_REQUIRED',
          message: 'This blob requires payment',
          payment: {
            price: meta.priceUSD,
            currency: 'USD',
            methods: ['lightning', 'stripe'],
          },
        }),
        {
          status: 402,
          headers: {
            'Content-Type': 'application/json',
            'X-Payment-Price': String(meta.priceUSD),
            'X-Payment-Currency': 'USD',
            'X-Payment-Methods': 'lightning,stripe',
            ...corsHeaders,
          },
        }
      );
    }

    // TODO: Validate payment proof (JWT verification)
    // For now, accept any non-empty proof for testing
  }

  // Fetch from R2
  const object = await env.VNSH_STORE.get(id);

  if (!object) {
    // R2 object missing but metadata exists - inconsistent state
    await env.VNSH_META.delete(`blob:${id}`);
    return errorResponse('NOT_FOUND', 'Blob not found', 404);
  }

  // Stream response with proper headers
  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(object.size),
      'Cache-Control': 'private, no-store, no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Opaque-Expires': new Date(meta.expiresAt).toISOString(),
      ...corsHeaders,
    },
  });
}

// Main request handler
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return handleOptions();
    }

    // Route: POST /api/drop
    if (request.method === 'POST' && path === '/api/drop') {
      return handleDrop(request, env);
    }

    // Route: GET /api/blob/:id
    const blobMatch = path.match(/^\/api\/blob\/([a-f0-9-]+)$/);
    if (request.method === 'GET' && blobMatch) {
      return handleBlob(blobMatch[1], request, env);
    }

    // Route: GET /v/:id - Redirect to /#v/{id} (client-side routing)
    // Note: Hash fragments are preserved by the browser during redirect
    const viewerMatch = path.match(/^\/v\/([a-f0-9-]+)$/);
    if (request.method === 'GET' && viewerMatch) {
      const id = viewerMatch[1];
      // Use 302 redirect to root with hash-based route
      // The hash fragment from the original URL will be preserved by the browser
      return new Response(null, {
        status: 302,
        headers: {
          'Location': `/#v/${id}`,
          'Cache-Control': 'no-cache',
        },
      });
    }

    // Route: GET /i - Serve install script
    if (request.method === 'GET' && path === '/i') {
      return new Response(INSTALL_SCRIPT, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    // Route: GET / - Serve unified app
    if (request.method === 'GET' && path === '/') {
      return new Response(APP_HTML, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    // Route: GET /health - Health check
    if (request.method === 'GET' && path === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'vnsh' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // 404 for unknown routes
    return errorResponse('NOT_FOUND', 'Endpoint not found', 404);
  },
};

// Install script (returned as text/plain)
const INSTALL_SCRIPT = `#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  vnsh Installer
#  https://vnsh.dev
#  The Host-Blind Context Tunnel - Share then Vanish
#  We don't track you. Check the source.
# ═══════════════════════════════════════════════════════════════════

set -e

# Colors
RED='\\033[0;31m'
GREEN='\\033[0;32m'
CYAN='\\033[0;36m'
NC='\\033[0m' # No Color

echo -e "\${CYAN}"
echo " ██╗   ██╗███╗   ██╗███████╗██╗  ██╗"
echo " ██║   ██║████╗  ██║██╔════╝██║  ██║"
echo " ██║   ██║██╔██╗ ██║███████╗███████║"
echo " ╚██╗ ██╔╝██║╚██╗██║╚════██║██╔══██║"
echo "  ╚████╔╝ ██║ ╚████║███████║██║  ██║"
echo "   ╚═══╝  ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝"
echo -e "\${NC}"
echo "Installing 'vn' CLI..."
echo ""

# Detect shell
SHELL_NAME=\$(basename "$SHELL")
case "$SHELL_NAME" in
  zsh)  RC_FILE="$HOME/.zshrc" ;;
  bash) RC_FILE="$HOME/.bashrc" ;;
  *)    RC_FILE="$HOME/.profile" ;;
esac

# The vn function
VN_FUNCTION='
# vnsh CLI - The Host-Blind Context Tunnel
# Usage: vn [file] or echo "content" | vn
vn() {
  local HOST="https://vnsh.dev"
  local KEY=\$(openssl rand -hex 32)
  local IV=\$(openssl rand -hex 16)

  if [ -n "\$1" ] && [ -f "\$1" ]; then
    # File mode
    local BLOB=\$(cat "\$1" | openssl enc -aes-256-cbc -K "\$KEY" -iv "\$IV" 2>/dev/null | base64)
  elif [ ! -t 0 ]; then
    # Stdin mode
    local BLOB=\$(cat | openssl enc -aes-256-cbc -K "\$KEY" -iv "\$IV" 2>/dev/null | base64)
  else
    echo "Usage: vn <file> or echo \\"content\\" | vn" >&2
    return 1
  fi

  # Upload and get ID
  local RESPONSE=\$(echo "\$BLOB" | base64 -d | curl -s -X POST --data-binary @- "\$HOST/api/drop")
  local ID=\$(echo "\$RESPONSE" | grep -o '"'"'"id":"[^"]*"'"'" | cut -d'"'"'"' -f4)

  if [ -z "\$ID" ]; then
    echo "Error: Upload failed" >&2
    return 1
  fi

  echo "\$HOST/v/\$ID#k=\$KEY&iv=\$IV"
}
'

# Check if already installed
if grep -q "vn()" "$RC_FILE" 2>/dev/null; then
  echo -e "\${GREEN}✓\${NC} vn is already installed in $RC_FILE"
else
  echo "$VN_FUNCTION" >> "$RC_FILE"
  echo -e "\${GREEN}✓\${NC} Added vn function to $RC_FILE"
fi

echo ""
echo -e "\${GREEN}Installation complete!\${NC}"
echo ""
echo "Restart your terminal or run:"
echo -e "  \${CYAN}source $RC_FILE\${NC}"
echo ""
echo "Usage:"
echo -e "  \${CYAN}echo 'hello' | vn\${NC}     # Pipe content"
echo -e "  \${CYAN}vn myfile.txt\${NC}         # Upload a file"
echo ""
echo "The URL is printed to stdout. The server never sees your keys."
`;

// Unified App HTML - "Stacked Console" Tabbed Layout
const APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>vnsh</title>
  <meta name="description" content="The Host-Blind Context Tunnel. Share then vanish. End-to-end encrypted sharing that disappears. The server is blind. The keys are yours.">
  <meta name="keywords" content="vnsh, vanish, encrypted sharing, ephemeral, end-to-end encryption, claude, mcp, ai context, secure paste">
  <meta property="og:title" content="vnsh - Share then Vanish">
  <meta property="og:description" content="Host-blind encrypted sharing for AI workflows. End-to-end encrypted, auto-expiring, server never sees your data.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://vnsh.dev">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="vnsh - Share then Vanish">
  <meta name="twitter:description" content="Host-blind encrypted sharing. The server is blind. The keys are yours.">
  <link rel="canonical" href="https://vnsh.dev">
  <meta name="robots" content="index, follow">
  <meta name="author" content="vnsh">
  <meta name="theme-color" content="#22c55e">
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔐</text></svg>">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    "name": "vnsh",
    "description": "Host-blind encrypted sharing for AI workflows. End-to-end encrypted content sharing that auto-expires.",
    "url": "https://vnsh.dev",
    "applicationCategory": "SecurityApplication",
    "operatingSystem": "Any",
    "offers": {
      "@type": "Offer",
      "price": "0",
      "priceCurrency": "USD"
    },
    "featureList": [
      "End-to-end encryption (AES-256-CBC)",
      "Host-blind architecture",
      "Auto-expiring content",
      "MCP integration for Claude Code",
      "CLI tool for terminal workflows"
    ]
  }
  </script>
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self' http://localhost:* https://*.vnsh.dev https://vnsh.dev; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; img-src 'self' data: blob:">
  <link rel="preconnect" href="https://cdn.jsdelivr.net">
  <link href="https://cdn.jsdelivr.net/npm/geist@1.3.1/dist/fonts/geist-mono/style.min.css" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism-tomorrow.min.css" rel="stylesheet">
  <style>
    :root {
      --bg: #0a0a0a;
      --bg-card: #111111;
      --bg-elevated: #1a1a1a;
      --bg-terminal: #0d0d0d;
      --fg: #e5e5e5;
      --fg-muted: #a3a3a3;
      --fg-dim: #525252;
      --fg-dimmer: #3f3f3f;
      --accent: #22c55e;
      --accent-dim: rgba(34, 197, 94, 0.15);
      --accent-glow: rgba(34, 197, 94, 0.4);
      --border: #2a2a2a;
      --border-active: #3a3a3a;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      background: var(--bg);
      color: var(--fg);
      min-height: 100vh;
      line-height: 1.6;
      font-size: 14px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }

    /* Hero */
    .hero {
      text-align: center;
      margin-bottom: 3rem;
    }

    .hero-title {
      font-size: 1.4rem;
      font-weight: 400;
      color: var(--fg);
      margin-bottom: 1rem;
    }

    .hero-title .prompt { color: var(--accent); }

    .hero-title .cursor {
      display: inline-block;
      width: 0.55em;
      height: 1.1em;
      background: var(--accent);
      margin-left: 2px;
      animation: blink 1s step-end infinite;
      vertical-align: text-bottom;
      box-shadow: 0 0 10px var(--accent-glow);
    }

    @keyframes blink { 50% { opacity: 0; } }

    .hero-subtitle {
      font-size: 1rem;
      line-height: 1.5;
    }

    .hero-subtitle .dim {
      color: var(--fg-muted);
    }

    .hero-subtitle .bright {
      color: #ffffff;
      font-weight: 500;
    }

    /* Console Container */
    .console {
      width: 100%;
      max-width: 700px;
      border: 1px solid var(--border);
      background: var(--bg-card);
      border-radius: 6px;
      overflow: hidden;
    }

    /* Tab Bar */
    .tabs {
      display: flex;
      border-bottom: 1px solid var(--border);
      background: var(--bg);
    }

    .tab {
      flex: 1;
      padding: 0.875rem 1rem;
      background: transparent;
      border: none;
      color: var(--fg-dimmer);
      font-family: inherit;
      font-size: 0.75rem;
      font-weight: 500;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      cursor: pointer;
      transition: all 0.15s ease;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
    }

    .tab:hover {
      color: var(--fg-muted);
      background: var(--bg-elevated);
    }

    .tab.active {
      color: var(--accent);
      font-weight: 700;
      border-bottom-color: var(--accent);
      background: rgba(34, 197, 94, 0.08);
    }

    /* Tab Panels */
    .tab-panel {
      display: none;
      padding: 2rem;
      height: 420px;
      overflow-y: auto;
      border-top: 1px solid var(--border);
    }

    .tab-panel.active {
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
    }

    /* Upload Panel (Web) */
    .dropzone {
      border: 2px dashed var(--border);
      border-radius: 6px;
      padding: 3rem 2rem;
      text-align: center;
      cursor: pointer;
      transition: all 0.2s ease;
      background: var(--bg);
    }

    .dropzone:hover {
      border-color: var(--accent);
      background: var(--accent-dim);
    }

    .dropzone.dragover {
      border-color: var(--accent);
      background: var(--accent-dim);
      animation: pulse-border 0.8s ease-in-out infinite;
    }

    @keyframes pulse-border {
      0%, 100% { box-shadow: 0 0 0 0 var(--accent-glow); }
      50% { box-shadow: 0 0 20px 4px var(--accent-glow); }
    }

    .dropzone-icon {
      font-size: 1.2rem;
      color: var(--fg-dim);
      margin-bottom: 1rem;
      font-family: inherit;
      white-space: pre;
      line-height: 1.2;
    }

    .dropzone-text {
      font-size: 1rem;
      color: var(--fg-muted);
      margin-bottom: 0.5rem;
    }

    .dropzone-hint {
      font-size: 0.85rem;
      color: var(--accent);
      background: var(--accent-dim);
      display: inline-block;
      padding: 0.25rem 0.75rem;
      border-radius: 3px;
      margin-top: 0.5rem;
    }

    input[type="file"] { display: none; }

    /* Terminal Panel */
    .cli-section {
      text-align: left;
    }

    .section-label {
      font-size: 0.75rem;
      color: var(--fg-dim);
      margin-bottom: 0.75rem;
      font-style: italic;
    }

    .code-block {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 0.875rem 1rem;
      cursor: pointer;
      transition: all 0.15s ease;
      margin-bottom: 0.75rem;
    }

    .code-block:hover {
      border-color: var(--accent);
      box-shadow: 0 0 15px var(--accent-dim);
    }

    .code-block code {
      color: var(--accent);
      font-size: 0.9rem;
    }

    .code-block .prompt {
      color: var(--fg-dim);
    }

    .code-block .copy-btn {
      background: none;
      border: none;
      color: var(--fg-dim);
      cursor: pointer;
      padding: 0.25rem;
      font-size: 0.8rem;
      transition: color 0.15s;
    }

    .code-block .copy-btn:hover {
      color: var(--accent);
    }

    .code-block .copy-btn.copied {
      color: var(--accent);
    }

    .terminal-window {
      background: var(--bg-terminal);
      border: 1px solid var(--border);
      border-radius: 4px;
      overflow: hidden;
      margin-top: 0.5rem;
    }

    .terminal-header {
      background: var(--bg);
      padding: 0.5rem 0.75rem;
      font-size: 0.7rem;
      color: var(--fg-dim);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .terminal-dots {
      display: flex;
      gap: 0.35rem;
    }

    .terminal-dots span {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--fg-dim);
      opacity: 0.5;
    }

    .terminal-body {
      padding: 1rem;
      font-size: 0.8rem;
    }

    .terminal-body .line { margin-bottom: 0.35rem; }
    .terminal-body .prompt { color: var(--accent); }
    .terminal-body .cmd { color: var(--fg-muted); }
    .terminal-body .output { color: var(--fg-dim); font-style: italic; }

    .cli-desc {
      margin-top: 1.25rem;
      font-size: 0.8rem;
      color: var(--fg-dim);
      text-align: center;
    }

    /* Agent Panel */
    .mcp-section {
      text-align: left;
    }

    .mcp-config {
      background: var(--bg-terminal);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 1rem;
      font-size: 0.75rem;
      margin-top: 0.5rem;
    }

    .mcp-config .comment {
      color: var(--fg-dim);
      font-style: italic;
      margin-bottom: 0.5rem;
    }

    .mcp-config .line { margin-bottom: 0.2rem; }
    .mcp-config .key { color: #a78bfa; }
    .mcp-config .str { color: var(--accent); }

    .mcp-desc {
      margin-top: 1.25rem;
      font-size: 0.8rem;
      color: var(--fg-dim);
      text-align: center;
    }

    /* Progress & Result */
    .progress-container {
      margin-top: 1.5rem;
      display: none;
    }

    .progress-container.show { display: block; }

    .progress-text {
      font-size: 0.8rem;
      color: var(--fg-muted);
      margin-bottom: 0.5rem;
    }

    .progress-bar {
      height: 3px;
      background: var(--border);
      border-radius: 2px;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      background: var(--accent);
      width: 0%;
      transition: width 0.3s ease;
    }

    .result-box {
      margin-top: 1.5rem;
      padding: 1.25rem;
      background: var(--bg);
      border: 1px solid var(--accent);
      border-radius: 4px;
      display: none;
    }

    .result-box.show { display: block; }

    .result-header {
      font-size: 0.85rem;
      color: var(--accent);
      margin-bottom: 1rem;
    }

    .result-url {
      font-size: 0.75rem;
      color: var(--fg-dim);
      word-break: break-all;
      padding: 0.75rem;
      background: var(--bg-card);
      border-radius: 3px;
      margin-bottom: 1rem;
    }

    .result-actions {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }

    .btn {
      background: var(--bg-elevated);
      color: var(--fg);
      border: 1px solid var(--border);
      padding: 0.5rem 1rem;
      border-radius: 3px;
      cursor: pointer;
      font-family: inherit;
      font-size: 0.75rem;
      transition: all 0.15s ease;
    }

    .btn:hover {
      border-color: var(--accent);
      color: var(--accent);
    }

    .btn-primary {
      background: var(--accent);
      color: #000;
      border-color: var(--accent);
    }

    .btn-primary:hover {
      background: #16a34a;
      color: #000;
    }

    /* Footer */
    .footer {
      margin-top: 2rem;
      font-size: 0.75rem;
      color: var(--fg-dim);
      text-align: center;
    }

    .footer a {
      color: var(--fg-muted);
      text-decoration: none;
    }

    .footer a:hover {
      color: var(--accent);
    }

    /* Viewer Overlay */
    .overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.9);
      backdrop-filter: blur(8px);
      z-index: 100;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 1rem;
    }

    .overlay.show {
      display: flex;
    }

    .viewer {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      width: 100%;
      max-width: 900px;
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .viewer-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }

    .viewer-meta {
      font-size: 0.75rem;
      color: var(--fg-muted);
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .viewer-timer {
      color: #f59e0b;
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }

    .viewer-close {
      background: none;
      border: none;
      color: var(--fg-muted);
      font-size: 1.5rem;
      cursor: pointer;
      padding: 0.25rem;
      line-height: 1;
    }

    .viewer-close:hover {
      color: var(--fg);
    }

    .viewer-content {
      flex: 1;
      overflow: auto;
      padding: 1.25rem;
      background: var(--bg-card);
    }

    .viewer-loading {
      font-size: 0.875rem;
      color: var(--fg-muted);
    }

    .viewer-loading .step {
      margin-bottom: 0.5rem;
    }

    .viewer-loading .step.done { color: var(--accent); }
    .viewer-loading .step.active::after {
      content: '▊';
      animation: blink 0.5s step-end infinite;
    }

    .viewer-error {
      color: #ef4444;
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.2);
      padding: 1rem;
      border-radius: 4px;
    }

    .viewer-image {
      max-width: 100%;
      height: auto;
      border-radius: 4px;
    }

    .viewer-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 1.25rem;
      border-top: 1px solid var(--border);
      flex-shrink: 0;
    }

    .viewer-actions {
      display: flex;
      gap: 0.5rem;
    }

    .code-container {
      display: flex;
      font-size: 0.8rem;
      line-height: 1.7;
    }

    .line-numbers {
      user-select: none;
      text-align: right;
      padding-right: 1rem;
      color: var(--fg-dim);
      border-right: 1px solid var(--border);
      margin-right: 1rem;
      flex-shrink: 0;
    }

    .code-content {
      flex: 1;
      overflow-x: auto;
      white-space: pre;
    }

    /* Shortcuts Modal */
    .shortcuts-modal {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.85);
      z-index: 200;
      display: none;
      align-items: center;
      justify-content: center;
    }

    .shortcuts-modal.show { display: flex; }

    .shortcuts-content {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 1.5rem;
      max-width: 350px;
    }

    .shortcuts-title {
      font-size: 0.875rem;
      margin-bottom: 1rem;
      color: var(--fg);
    }

    .shortcut {
      display: flex;
      justify-content: space-between;
      font-size: 0.8rem;
      margin-bottom: 0.5rem;
      color: var(--fg-muted);
    }

    .shortcut kbd {
      background: var(--bg-elevated);
      padding: 0.15rem 0.5rem;
      border-radius: 3px;
      border: 1px solid var(--border);
      color: var(--fg);
      font-family: inherit;
    }

    /* Responsive */
    @media (max-width: 600px) {
      body { padding: 1rem; }
      .hero-title { font-size: 1.1rem; }
      .hero-subtitle { font-size: 0.9rem; }
      .console { border-radius: 4px; }
      .tab { padding: 0.75rem 0.5rem; font-size: 0.65rem; }
      .tab-panel { padding: 1.5rem; height: 380px; }
      .dropzone { padding: 2rem 1rem; }
      .dropzone-icon { font-size: 1rem; }
      .code-block { padding: 0.75rem; }
      .code-block code { font-size: 0.8rem; }
      .terminal-body { font-size: 0.75rem; }
    }
  </style>
</head>
<body>
  <!-- Hero -->
  <section class="hero">
    <h1 class="hero-title">
      <span class="prompt">></span> vnsh: Share then Vanish<span class="cursor"></span>
    </h1>
    <p class="hero-subtitle">
      <span class="dim">The server is blind.</span> <span class="bright">The keys are yours.</span>
    </p>
  </section>

  <!-- Console with Tabs -->
  <div class="console">
    <div class="tabs">
      <button class="tab active" data-tab="web">Web Upload</button>
      <button class="tab" data-tab="terminal">Terminal (CLI)</button>
      <button class="tab" data-tab="agent">Agent (MCP)</button>
    </div>

    <!-- Web Upload Panel -->
    <div class="tab-panel active" id="panel-web">
      <div class="dropzone" id="dropzone">
        <div class="dropzone-icon">┌──────────┐
│    ↓↓    │
└──────────┘</div>
        <div class="dropzone-text">Drop files here to encrypt & share</div>
        <div class="dropzone-hint">⌘V / Ctrl+V to paste</div>
      </div>
      <input type="file" id="file-input">

      <div class="progress-container" id="progress">
        <div class="progress-text" id="progress-text">> Encrypting...</div>
        <div class="progress-bar">
          <div class="progress-fill" id="progress-fill"></div>
        </div>
      </div>

      <div class="result-box" id="result">
        <div class="result-header">✓ Secure Link Ready</div>
        <div class="result-url" id="result-url"></div>
        <div class="result-actions">
          <button class="btn btn-primary" onclick="copyUrl()">Copy URL</button>
          <button class="btn" onclick="copyForClaude()">For Claude</button>
          <button class="btn" onclick="openViewer()">Preview</button>
        </div>
      </div>
    </div>

    <!-- Terminal Panel -->
    <div class="tab-panel" id="panel-terminal">
      <div class="cli-section">
        <div class="section-label">// 1. Install</div>
        <div class="code-block" id="cli-install" onclick="copyCommand('curl -sL vnsh.dev/i | sh', this)">
          <code><span class="prompt">$ </span>curl -sL vnsh.dev/i | sh</code>
          <button class="copy-btn" title="Copy">⧉</button>
        </div>

        <div class="section-label" style="margin-top: 1.5rem;">// 2. Usage Examples</div>
        <div class="terminal-window">
          <div class="terminal-header">
            <div class="terminal-dots"><span></span><span></span><span></span></div>
            <span>terminal</span>
          </div>
          <div class="terminal-body">
            <div class="line"><span class="prompt">$ </span><span class="cmd">cat screenshot.png | vn</span></div>
            <div class="line"><span class="output">https://vnsh.dev/v/a3f...#k=...</span></div>
            <div class="line" style="height: 0.5rem;"></div>
            <div class="line"><span class="prompt">$ </span><span class="cmd">git diff HEAD~3 | vn</span></div>
            <div class="line"><span class="output">https://vnsh.dev/v/b7c...#k=...</span></div>
            <div class="line" style="height: 0.5rem;"></div>
            <div class="line"><span class="prompt">$ </span><span class="cmd">echo "debug log" | vn</span></div>
            <div class="line"><span class="output">https://vnsh.dev/v/f9d...#k=...</span></div>
          </div>
        </div>

        <div class="code-block" style="margin-top: 1rem;" onclick="copyCommand('cat myfile.txt | vn', this)">
          <code><span class="prompt">$ </span>cat myfile.txt | vn</code>
          <button class="copy-btn" title="Copy">⧉</button>
        </div>

        <p class="cli-desc">Pipe anything to <code style="color:var(--accent)">vn</code> — share the URL with Claude.</p>
      </div>
    </div>

    <!-- Agent Panel -->
    <div class="tab-panel" id="panel-agent">
      <div class="mcp-section">
        <div class="section-label">// Quick Start</div>
        <div class="code-block" id="mcp-box" onclick="copyCommand('npx -y vnsh-mcp', this)">
          <code><span class="prompt">$ </span>npx -y vnsh-mcp</code>
          <button class="copy-btn" title="Copy">⧉</button>
        </div>

        <div class="section-label" style="margin-top: 1.5rem;">// Add to claude_desktop_config.json</div>
        <div class="mcp-config">
          <div class="comment">// ~/.config/claude/claude_desktop_config.json</div>
          <div class="line"><span class="key">"mcpServers"</span>: {</div>
          <div class="line">&nbsp;&nbsp;<span class="key">"vnsh"</span>: {</div>
          <div class="line">&nbsp;&nbsp;&nbsp;&nbsp;<span class="key">"command"</span>: <span class="str">"npx"</span>,</div>
          <div class="line">&nbsp;&nbsp;&nbsp;&nbsp;<span class="key">"args"</span>: [<span class="str">"-y"</span>, <span class="str">"vnsh-mcp"</span>]</div>
          <div class="line">&nbsp;&nbsp;}</div>
          <div class="line">}</div>
        </div>

        <p class="mcp-desc">Claude can now read vnsh.dev URLs and decrypt content locally.</p>
      </div>
    </div>
  </div>

  <!-- Footer -->
  <div class="footer">
    // AES-256-CBC · Keys stay in URL fragment · <a href="https://github.com/anthropics/vnsh">Source</a>
  </div>

  <!-- Viewer Overlay -->
  <div class="overlay" id="overlay">
    <div class="viewer">
      <div class="viewer-header">
        <div class="viewer-meta">
          <span id="viewer-blob-id">Blob: ---</span>
          <span class="viewer-timer" id="viewer-timer">🔥 --h</span>
        </div>
        <button class="viewer-close" onclick="closeViewer()">×</button>
      </div>
      <div class="viewer-content" id="viewer-content">
        <div class="viewer-loading" id="viewer-loading">
          <div class="step" id="step-fetch">> Fetching blob...</div>
          <div class="step" id="step-extract">> Extracting keys...</div>
          <div class="step" id="step-decrypt">> Decrypting (AES-256-CBC)...</div>
        </div>
        <div id="viewer-result" style="display:none;"></div>
      </div>
      <div class="viewer-footer">
        <div class="viewer-actions">
          <button class="btn btn-primary" onclick="viewerCopyForClaude()">Copy for Claude</button>
          <button class="btn" id="btn-raw" onclick="toggleRaw()">Raw</button>
          <button class="btn" onclick="downloadContent()">Download</button>
        </div>
        <button class="btn" onclick="closeViewer()">Close</button>
      </div>
    </div>
  </div>

  <!-- Shortcuts Modal -->
  <div class="shortcuts-modal" id="shortcuts-modal">
    <div class="shortcuts-content">
      <div class="shortcuts-title">Keyboard Shortcuts</div>
      <div class="shortcut"><span>Copy CLI command</span><kbd>/</kbd></div>
      <div class="shortcut"><span>Open file picker</span><kbd>u</kbd></div>
      <div class="shortcut"><span>Close overlay</span><kbd>Esc</kbd></div>
      <div class="shortcut"><span>Toggle raw mode</span><kbd>r</kbd></div>
      <div class="shortcut"><span>Show shortcuts</span><kbd>?</kbd></div>
      <div style="margin-top:1rem; text-align:right;">
        <button class="btn" onclick="closeShortcuts()">Close</button>
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-javascript.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-typescript.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-python.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-bash.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-json.min.js"></script>
  <script>
    // Console Easter Egg
    console.log(\`
 ██╗   ██╗███╗   ██╗███████╗██╗  ██╗
 ██║   ██║████╗  ██║██╔════╝██║  ██║
 ██║   ██║██╔██╗ ██║███████╗███████║
 ╚██╗ ██╔╝██║╚██╗██║╚════██║██╔══██║
  ╚████╔╝ ██║ ╚████║███████║██║  ██║
   ╚═══╝  ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝

  Share then Vanish
  https://github.com/anthropics/vnsh
    \`);

    // State
    let generatedUrl = '';
    let decryptedContent = '';
    let decryptedBytes = null;
    let isRawMode = false;
    let selectedFile = null;
    let blobExpiresAt = null;

    // Elements
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('file-input');
    const progressEl = document.getElementById('progress');
    const progressText = document.getElementById('progress-text');
    const progressFill = document.getElementById('progress-fill');
    const resultEl = document.getElementById('result');
    const resultUrl = document.getElementById('result-url');
    const overlay = document.getElementById('overlay');
    const viewerLoading = document.getElementById('viewer-loading');
    const viewerResult = document.getElementById('viewer-result');
    const shortcutsModal = document.getElementById('shortcuts-modal');
    const tabs = document.querySelectorAll('.tab');
    const tabPanels = document.querySelectorAll('.tab-panel');

    // Tab switching
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const targetTab = tab.dataset.tab;
        tabs.forEach(t => t.classList.remove('active'));
        tabPanels.forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('panel-' + targetTab).classList.add('active');
      });
    });

    // Copy command helper
    function copyCommand(cmd, el) {
      navigator.clipboard.writeText(cmd).then(() => {
        const btn = el.querySelector('.copy-btn');
        if (btn) {
          btn.textContent = '✓';
          btn.classList.add('copied');
          setTimeout(() => {
            btn.textContent = '⧉';
            btn.classList.remove('copied');
          }, 2000);
        }
      });
    }

    // Dropzone
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length) handleFile(fileInput.files[0]);
    });

    // Ctrl+V paste
    document.addEventListener('paste', (e) => {
      if (overlay.classList.contains('show')) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) { handleFile(file); return; }
        } else if (item.kind === 'string' && item.type === 'text/plain') {
          item.getAsString((text) => { if (text.trim()) uploadContent(text); });
          return;
        }
      }
    });

    function handleFile(file) {
      selectedFile = file;
      uploadFile(file);
    }

    async function uploadContent(text) {
      await upload(new TextEncoder().encode(text));
    }

    async function uploadFile(file) {
      await upload(new Uint8Array(await file.arrayBuffer()));
    }

    async function upload(plaintext) {
      document.title = 'Encrypting...';
      progressEl.classList.add('show');
      resultEl.classList.remove('show');

      try {
        progressText.textContent = '> Generating key...';
        progressFill.style.width = '10%';
        await sleep(100);

        const key = crypto.getRandomValues(new Uint8Array(32));
        const iv = crypto.getRandomValues(new Uint8Array(16));

        progressText.textContent = '> Encrypting (AES-256-CBC)...';
        progressFill.style.width = '30%';

        const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt']);
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, plaintext);

        progressText.textContent = '> Uploading encrypted blob...';
        progressFill.style.width = '60%';

        const response = await fetch('/api/drop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: ciphertext
        });

        if (!response.ok) throw new Error('Upload failed: ' + response.status);

        progressFill.style.width = '90%';
        const { id } = await response.json();

        const keyHex = Array.from(key).map(b => b.toString(16).padStart(2, '0')).join('');
        const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join('');
        generatedUrl = location.origin + '/v/' + id + '#k=' + keyHex + '&iv=' + ivHex;

        progressFill.style.width = '100%';
        progressText.textContent = '> Done!';
        await sleep(300);

        progressEl.classList.remove('show');
        resultEl.classList.add('show');
        resultUrl.textContent = generatedUrl;
        document.title = '✓ vnsh';

        // Sound
        try {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain); gain.connect(ctx.destination);
          osc.frequency.value = 880; gain.gain.value = 0.1;
          osc.start();
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
          osc.stop(ctx.currentTime + 0.1);
        } catch (e) {}

      } catch (err) {
        progressText.textContent = '> Error: ' + err.message;
        progressFill.style.width = '0%';
        document.title = 'vnsh';
        console.error(err);
      }
    }

    function copyUrl() {
      navigator.clipboard.writeText(generatedUrl).then(() => {
        const btn = event.target;
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy', 2000);
      });
    }

    function copyForClaude() {
      navigator.clipboard.writeText(generatedUrl).then(() => {
        const btn = event.target;
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'For Claude', 2000);
      });
    }

    function openViewer() {
      const parts = generatedUrl.match(/\\/v\\/([a-f0-9-]+)/);
      if (parts) {
        window.location.hash = 'v/' + parts[1] + '&' + generatedUrl.split('#')[1];
      }
    }

    // Viewer
    function showViewer(id, keyHex, ivHex) {
      overlay.classList.add('show');
      document.body.style.overflow = 'hidden';
      viewerLoading.style.display = 'block';
      viewerResult.style.display = 'none';
      document.getElementById('step-fetch').className = 'step';
      document.getElementById('step-extract').className = 'step';
      document.getElementById('step-decrypt').className = 'step';
      document.getElementById('viewer-blob-id').textContent = 'Blob: ' + id.slice(0, 8) + '...';
      fetchAndDecrypt(id, keyHex, ivHex);
    }

    function closeViewer() {
      overlay.classList.remove('show');
      document.body.style.overflow = '';
      history.pushState(null, '', location.pathname);
      document.title = 'vnsh';
    }

    async function fetchAndDecrypt(id, keyHex, ivHex) {
      try {
        document.getElementById('step-fetch').className = 'step active';
        const res = await fetch('/api/blob/' + id);
        if (res.status === 404) throw new Error('Blob not found or expired.');
        if (res.status === 410) throw new Error('Blob has expired.');
        if (!res.ok) throw new Error('Fetch failed: ' + res.status);

        const expiresHeader = res.headers.get('X-Opaque-Expires');
        if (expiresHeader) {
          blobExpiresAt = new Date(expiresHeader).getTime();
          updateTimer();
        }

        const encrypted = await res.arrayBuffer();
        document.getElementById('step-fetch').className = 'step done';
        document.getElementById('step-fetch').textContent = '> Fetching blob... OK';

        await sleep(150);
        document.getElementById('step-extract').className = 'step active';
        if (!keyHex || keyHex.length !== 64) throw new Error('Invalid key');
        if (!ivHex || ivHex.length !== 32) throw new Error('Invalid IV');
        await sleep(150);
        document.getElementById('step-extract').className = 'step done';
        document.getElementById('step-extract').textContent = '> Extracting keys... OK';

        await sleep(150);
        document.getElementById('step-decrypt').className = 'step active';
        const keyBytes = hexToBytes(keyHex);
        const ivBytes = hexToBytes(ivHex);
        const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes }, key, encrypted);

        decryptedBytes = new Uint8Array(decrypted);
        document.getElementById('step-decrypt').className = 'step done';
        document.getElementById('step-decrypt').textContent = '> Decrypting (AES-256-CBC)... OK';

        await sleep(200);
        viewerLoading.style.display = 'none';
        viewerResult.style.display = 'block';

        if (isImage(decryptedBytes)) displayImage(decryptedBytes);
        else if (isBinary(decryptedBytes)) displayBinary(decryptedBytes);
        else { decryptedContent = new TextDecoder().decode(decrypted); displayText(decryptedContent); }

        document.title = 'Opaque - Viewing';
      } catch (err) {
        viewerLoading.style.display = 'none';
        viewerResult.style.display = 'block';
        viewerResult.innerHTML = '<div class="viewer-error">' + escapeHtml(err.message) + '</div>';
      }
    }

    function displayText(text) {
      const lines = text.split('\\n');
      const lineNums = lines.map((_, i) => i + 1).join('\\n');
      let lang = 'plaintext';
      if (text.includes('function') || text.includes('const ')) lang = 'javascript';
      else if (text.includes('def ') || text.includes('import ')) lang = 'python';
      else if (text.includes('#!/bin/bash')) lang = 'bash';
      else if (text.trim().startsWith('{')) lang = 'json';

      let highlighted = escapeHtml(text);
      try { if (Prism.languages[lang]) highlighted = Prism.highlight(text, Prism.languages[lang], lang); } catch (e) {}

      viewerResult.innerHTML = '<div class="code-container"><div class="line-numbers">' + lineNums + '</div><div class="code-content">' + highlighted + '</div></div>';
    }

    function displayImage(bytes) {
      const blob = new Blob([bytes]);
      viewerResult.innerHTML = '<img class="viewer-image" src="' + URL.createObjectURL(blob) + '" alt="Decrypted">';
    }

    function displayBinary(bytes) {
      viewerResult.innerHTML = '<div style="color:var(--fg-muted)">Binary file (' + formatBytes(bytes.length) + '). Use Download.</div>';
    }

    function isImage(bytes) {
      if (bytes.length < 4) return false;
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return true;
      if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return true;
      if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true;
      return false;
    }

    function isBinary(bytes) {
      const sampleSize = Math.min(bytes.length, 1024);
      for (let i = 0; i < sampleSize; i++) if (bytes[i] === 0) return true;
      return false;
    }

    function toggleRaw() {
      isRawMode = !isRawMode;
      const btn = document.getElementById('btn-raw');
      if (isRawMode) { btn.textContent = 'Formatted'; viewerResult.innerHTML = '<pre style="font-size:0.8rem;white-space:pre-wrap;">' + escapeHtml(decryptedContent) + '</pre>'; }
      else { btn.textContent = 'Raw'; displayText(decryptedContent); }
    }

    function viewerCopyForClaude() {
      const formatted = 'Here is some context:\\n\\n\`\`\`\\n' + decryptedContent + '\\n\`\`\`';
      navigator.clipboard.writeText(formatted).then(() => {
        const btn = event.target;
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy for Claude', 2000);
      });
    }

    function downloadContent() {
      const blob = new Blob([decryptedBytes || new TextEncoder().encode(decryptedContent)]);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = selectedFile?.name || 'vnsh-content.txt';
      a.click();
    }

    function updateTimer() {
      if (!blobExpiresAt) return;
      const remaining = blobExpiresAt - Date.now();
      if (remaining <= 0) { document.getElementById('viewer-timer').textContent = 'Expired'; return; }
      const hours = Math.floor(remaining / 3600000);
      const mins = Math.floor((remaining % 3600000) / 60000);
      document.getElementById('viewer-timer').textContent = '🔥 ' + hours + 'h ' + mins + 'm';
      setTimeout(updateTimer, 60000);
    }

    // Hash routing
    function handleHash() {
      const hash = location.hash.slice(1);
      if (!hash) return;
      const viewerMatch = hash.match(/^v\\/([a-f0-9-]+)/);
      if (viewerMatch) {
        const id = viewerMatch[1];
        const params = new URLSearchParams(hash.replace(/^v\\/[a-f0-9-]+&?/, ''));
        const keyHex = params.get('k');
        const ivHex = params.get('iv');
        if (keyHex && ivHex) showViewer(id, keyHex, ivHex);
      }
    }
    window.addEventListener('hashchange', handleHash);
    handleHash();

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      switch (e.key) {
        case '/': e.preventDefault(); document.getElementById('cli-install')?.click(); break;
        case 'u': if (!overlay.classList.contains('show')) { e.preventDefault(); fileInput.click(); } break;
        case 'Escape':
          if (shortcutsModal.classList.contains('show')) closeShortcuts();
          else if (overlay.classList.contains('show')) closeViewer();
          break;
        case 'r': if (overlay.classList.contains('show') && decryptedContent) { e.preventDefault(); toggleRaw(); } break;
        case '?': e.preventDefault(); shortcutsModal.classList.add('show'); break;
      }
    });

    function closeShortcuts() { shortcutsModal.classList.remove('show'); }
    shortcutsModal.addEventListener('click', (e) => { if (e.target === shortcutsModal) closeShortcuts(); });

    // Utils
    function hexToBytes(hex) {
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
      return bytes;
    }
    function formatBytes(b) { return b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(2) + ' MB'; }
    function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  </script>
</body>
</html>`;
