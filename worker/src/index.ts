/**
 * Opaque Worker - Host-Blind Data Tunnel API
 *
 * Endpoints:
 * - GET / - Serve unified app (landing + upload + viewer overlay)
 * - GET /v/:id - Redirect to /#v/{id} (preserves hash fragments)
 * - GET /i - Serve install script (text/plain)
 * - POST /api/drop - Upload encrypted blob
 * - GET /api/blob/:id - Download encrypted blob
 */

interface Env {
  OPAQUE_STORE: R2Bucket;
  OPAQUE_META: KVNamespace;
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
    const existing = await env.OPAQUE_STORE.head(id);
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
    await env.OPAQUE_STORE.put(id, body, {
      customMetadata: {
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
      },
    });

    // Store metadata in KV for fast expiry checks
    await env.OPAQUE_META.put(
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
  const metaJson = await env.OPAQUE_META.get(`blob:${id}`);

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
      env.OPAQUE_STORE.delete(id),
      env.OPAQUE_META.delete(`blob:${id}`),
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
  const object = await env.OPAQUE_STORE.get(id);

  if (!object) {
    // R2 object missing but metadata exists - inconsistent state
    await env.OPAQUE_META.delete(`blob:${id}`);
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
      return new Response(JSON.stringify({ status: 'ok', service: 'opaque' }), {
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
#  Opaque Installer
#  https://opaque.dev
#  The Host-Blind Context Tunnel for Vibecoding
#  We don't track you. Check the source.
# ═══════════════════════════════════════════════════════════════════

set -e

# Colors
RED='\\033[0;31m'
GREEN='\\033[0;32m'
CYAN='\\033[0;36m'
NC='\\033[0m' # No Color

echo -e "\${CYAN}"
echo "  ██████  ██████   █████   ██████  ██    ██ ███████"
echo " ██    ██ ██   ██ ██   ██ ██    ██ ██    ██ ██     "
echo " ██    ██ ██████  ███████ ██    ██ ██    ██ █████  "
echo " ██    ██ ██      ██   ██ ██ ▄▄ ██ ██    ██ ██     "
echo "  ██████  ██      ██   ██  ██████   ██████  ███████"
echo "                              ▀▀                    "
echo -e "\${NC}"
echo "Installing 'oq' CLI..."
echo ""

# Detect shell
SHELL_NAME=$(basename "\$SHELL")
case "\$SHELL_NAME" in
  zsh)  RC_FILE="\$HOME/.zshrc" ;;
  bash) RC_FILE="\$HOME/.bashrc" ;;
  *)    RC_FILE="\$HOME/.profile" ;;
esac

# The oq function
OQ_FUNCTION='
# Opaque CLI - The Host-Blind Context Tunnel
# Usage: oq [file] or echo "content" | oq
oq() {
  local HOST="https://opaque.dev"
  local KEY=$(openssl rand -hex 32)
  local IV=$(openssl rand -hex 16)

  if [ -n "$1" ] && [ -f "$1" ]; then
    # File mode
    local BLOB=$(cat "$1" | openssl enc -aes-256-cbc -K "$KEY" -iv "$IV" 2>/dev/null | base64)
  elif [ ! -t 0 ]; then
    # Stdin mode
    local BLOB=$(cat | openssl enc -aes-256-cbc -K "$KEY" -iv "$IV" 2>/dev/null | base64)
  else
    echo "Usage: oq <file> or echo \"content\" | oq" >&2
    return 1
  fi

  # Upload and get ID
  local RESPONSE=$(echo "$BLOB" | base64 -d | curl -s -X POST --data-binary @- "$HOST/api/drop")
  local ID=$(echo "$RESPONSE" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

  if [ -z "$ID" ]; then
    echo "Error: Upload failed" >&2
    return 1
  fi

  echo "$HOST/v/$ID#k=$KEY&iv=$IV"
}
'

# Check if already installed
if grep -q "oq()" "\$RC_FILE" 2>/dev/null; then
  echo -e "\${GREEN}✓\${NC} oq is already installed in \$RC_FILE"
else
  echo "\$OQ_FUNCTION" >> "\$RC_FILE"
  echo -e "\${GREEN}✓\${NC} Added oq function to \$RC_FILE"
fi

echo ""
echo -e "\${GREEN}Installation complete!\${NC}"
echo ""
echo "Restart your terminal or run:"
echo -e "  \${CYAN}source \$RC_FILE\${NC}"
echo ""
echo "Usage:"
echo -e "  \${CYAN}echo 'hello' | oq\${NC}     # Pipe content"
echo -e "  \${CYAN}oq myfile.txt\${NC}         # Upload a file"
echo ""
echo "The URL is printed to stdout. The server never sees your keys."
`;

// Unified App HTML (Landing + Upload + Viewer Overlay)
const APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Opaque</title>
  <meta name="description" content="The Host-Blind Context Tunnel. End-to-end encrypted sharing for Vibecoding.">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self' http://localhost:* https://*.opaque.dev https://opaque.dev; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net">
  <link rel="preconnect" href="https://cdn.jsdelivr.net">
  <link href="https://cdn.jsdelivr.net/npm/geist@1.3.1/dist/fonts/geist-mono/style.min.css" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism-tomorrow.min.css" rel="stylesheet">
  <style>
    :root {
      --bg: #0a0a0a;
      --bg-secondary: #111111;
      --bg-tertiary: #1a1a1a;
      --fg: #e5e5e5;
      --fg-muted: #737373;
      --fg-dim: #525252;
      --accent: #10b981;
      --accent-dim: rgba(16, 185, 129, 0.15);
      --accent-bright: #34d399;
      --error: #ef4444;
      --warning: #f59e0b;
      --border: #262626;
      --border-dim: #1f1f1f;
      --radius: 6px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      background: var(--bg);
      color: var(--fg);
      min-height: 100vh;
      line-height: 1.6;
      overflow-x: hidden;
    }

    /* Main Container */
    .container {
      max-width: 720px;
      margin: 0 auto;
      padding: 3rem 1.5rem;
    }

    /* Header */
    header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 3rem;
    }

    .logo {
      font-size: 1rem;
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      color: var(--fg);
    }

    .logo::before {
      content: '';
      width: 8px;
      height: 8px;
      background: var(--accent);
      border-radius: 50%;
      box-shadow: 0 0 8px var(--accent);
    }

    /* Hero Section */
    .hero {
      margin-bottom: 3rem;
    }

    .hero-title {
      font-size: 1.125rem;
      font-weight: 400;
      color: var(--fg);
      margin-bottom: 1rem;
      min-height: 1.8em;
    }

    .hero-title .cursor {
      display: inline-block;
      width: 0.6em;
      height: 1.1em;
      background: var(--accent);
      margin-left: 2px;
      animation: blink 1s step-end infinite;
      vertical-align: text-bottom;
    }

    @keyframes blink {
      50% { opacity: 0; }
    }

    .hero-subtitle {
      color: var(--fg-muted);
      font-size: 0.875rem;
      line-height: 1.7;
    }

    /* CLI Install Box */
    .cli-box {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 1rem 1.25rem;
      margin-top: 2rem;
      cursor: pointer;
      transition: all 0.15s ease;
      position: relative;
    }

    .cli-box:hover {
      border-color: var(--accent);
      background: var(--accent-dim);
    }

    .cli-box-header {
      color: var(--fg-dim);
      font-size: 0.75rem;
      margin-bottom: 0.5rem;
    }

    .cli-box-command {
      color: var(--fg);
      font-size: 0.875rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .cli-box-command::before {
      content: '$';
      color: var(--accent);
    }

    .cli-copied {
      position: absolute;
      right: 1rem;
      top: 50%;
      transform: translateY(-50%);
      color: var(--accent);
      font-size: 0.75rem;
      opacity: 0;
      transition: opacity 0.2s;
    }

    .cli-copied.show {
      opacity: 1;
    }

    /* Dropzone Section */
    .section {
      margin-bottom: 2rem;
    }

    .dropzone {
      border: 1px dashed var(--border);
      border-radius: var(--radius);
      padding: 2.5rem 2rem;
      text-align: center;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .dropzone:hover,
    .dropzone.dragover {
      border-color: var(--accent);
      background: var(--accent-dim);
    }

    .dropzone-text {
      color: var(--fg-muted);
      font-size: 0.875rem;
    }

    .dropzone-hint {
      color: var(--fg-dim);
      font-size: 0.75rem;
      margin-top: 0.5rem;
    }

    .dropzone-file {
      color: var(--accent);
      font-size: 0.875rem;
    }

    input[type="file"] { display: none; }

    /* Progress Bar */
    .progress-container {
      margin-top: 1rem;
      display: none;
    }

    .progress-container.show {
      display: block;
    }

    .progress-text {
      color: var(--fg-muted);
      font-size: 0.75rem;
      margin-bottom: 0.5rem;
      font-family: inherit;
    }

    .progress-bar {
      height: 4px;
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

    /* Result Box */
    .result-box {
      background: var(--bg-secondary);
      border: 1px solid var(--accent);
      border-radius: var(--radius);
      padding: 1.25rem;
      margin-top: 1.5rem;
      display: none;
    }

    .result-box.show {
      display: block;
    }

    .result-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      color: var(--accent);
      font-size: 0.875rem;
      margin-bottom: 1rem;
    }

    .result-header::before {
      content: '✓';
    }

    .result-url {
      background: var(--bg);
      padding: 0.75rem 1rem;
      border-radius: 4px;
      font-size: 0.75rem;
      color: var(--fg-muted);
      word-break: break-all;
      margin-bottom: 1rem;
      border: 1px solid var(--border-dim);
    }

    .result-actions {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }

    .btn {
      background: var(--bg-tertiary);
      color: var(--fg);
      border: 1px solid var(--border);
      padding: 0.5rem 1rem;
      border-radius: 4px;
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
      background: var(--accent-bright);
      color: #000;
    }

    /* Features Section */
    .features {
      margin-top: 3rem;
      padding-top: 2rem;
      border-top: 1px solid var(--border-dim);
    }

    .feature {
      color: var(--fg-dim);
      font-size: 0.8rem;
      margin-bottom: 0.5rem;
      padding-left: 1.5rem;
      position: relative;
    }

    .feature::before {
      content: '//';
      position: absolute;
      left: 0;
      color: var(--fg-muted);
    }

    /* Overlay */
    .overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.85);
      backdrop-filter: blur(4px);
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
      border-radius: var(--radius);
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
      color: var(--warning);
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }

    .viewer-timer::before {
      content: '🔥';
      font-size: 0.85rem;
    }

    .viewer-close {
      background: none;
      border: none;
      color: var(--fg-muted);
      font-size: 1.25rem;
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
      background: var(--bg-secondary);
    }

    .viewer-loading {
      font-size: 0.875rem;
      color: var(--fg-muted);
      font-family: inherit;
    }

    .viewer-loading .step {
      margin-bottom: 0.5rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .viewer-loading .step.done {
      color: var(--accent);
    }

    .viewer-loading .step.active::after {
      content: '▊';
      animation: blink 0.5s step-end infinite;
    }

    .viewer-text {
      font-size: 0.8rem;
      line-height: 1.7;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .viewer-text code {
      background: var(--bg);
      padding: 0.1em 0.3em;
      border-radius: 3px;
    }

    .viewer-error {
      color: var(--error);
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

    /* Line Numbers */
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

    .shortcuts-modal.show {
      display: flex;
    }

    .shortcuts-content {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 1.5rem;
      max-width: 400px;
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
      background: var(--bg-tertiary);
      padding: 0.15rem 0.5rem;
      border-radius: 3px;
      border: 1px solid var(--border);
      color: var(--fg);
      font-family: inherit;
    }

    /* Responsive */
    @media (max-width: 640px) {
      .container {
        padding: 2rem 1rem;
      }

      .hero-title {
        font-size: 1rem;
      }

      .result-actions {
        flex-direction: column;
      }

      .btn {
        width: 100%;
        text-align: center;
      }
    }
  </style>
</head>
<body>
  <div class="container" id="main">
    <header>
      <div class="logo">Opaque</div>
    </header>

    <!-- Hero Section -->
    <section class="hero">
      <h1 class="hero-title">
        <span id="typewriter"></span><span class="cursor"></span>
      </h1>
      <p class="hero-subtitle">
        End-to-end encrypted sharing for Vibecoding.<br>
        The server is blind. The keys are yours.
      </p>

      <div class="cli-box" id="cli-box">
        <div class="cli-box-header"># Install the CLI in 3 seconds</div>
        <div class="cli-box-command">curl -sL opaque.dev/i | sh</div>
        <span class="cli-copied" id="cli-copied">Copied to clipboard ✓</span>
      </div>
    </section>

    <!-- Dropzone Section -->
    <section class="section">
      <div class="dropzone" id="dropzone">
        <div class="dropzone-text" id="dropzone-text">Drop files here (if you must use a mouse)</div>
        <div class="dropzone-hint">Ctrl+V to paste • Click to browse</div>
      </div>
      <input type="file" id="file-input">

      <div class="progress-container" id="progress">
        <div class="progress-text" id="progress-text">Encrypting...</div>
        <div class="progress-bar">
          <div class="progress-fill" id="progress-fill"></div>
        </div>
      </div>

      <div class="result-box" id="result">
        <div class="result-header">Secure Link Ready</div>
        <div class="result-url" id="result-url"></div>
        <div class="result-actions">
          <button class="btn btn-primary" onclick="copyUrl()">Copy URL</button>
          <button class="btn" onclick="copyForClaude()">Copy for Claude</button>
          <button class="btn" onclick="openViewer()">Open Viewer</button>
        </div>
      </div>
    </section>

    <!-- Features Section -->
    <section class="features">
      <div class="feature">100% Client-Side Encryption (AES-256)</div>
      <div class="feature">Server sees only blobs, never keys</div>
      <div class="feature">Vaporizes in 24 hours</div>
      <div class="feature">MCP Compatible (Claude Code ready)</div>
    </section>
  </div>

  <!-- Viewer Overlay -->
  <div class="overlay" id="overlay">
    <div class="viewer">
      <div class="viewer-header">
        <div class="viewer-meta">
          <span id="viewer-blob-id">Blob: ---</span>
          <span class="viewer-timer" id="viewer-timer">Vaporizing in --h</span>
        </div>
        <button class="viewer-close" onclick="closeViewer()">&times;</button>
      </div>
      <div class="viewer-content" id="viewer-content">
        <div class="viewer-loading" id="viewer-loading">
          <div class="step" id="step-fetch">> Fetching blob...</div>
          <div class="step" id="step-extract">> Extracting hash fragment...</div>
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
      <div class="shortcut"><span>Focus CLI</span><kbd>/</kbd></div>
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
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-markdown.min.js"></script>
  <script>
    // ═══════════════════════════════════════════════════════════════
    // Console Easter Egg
    // ═══════════════════════════════════════════════════════════════
    console.log(\`
  ██████  ██████   █████   ██████  ██    ██ ███████
 ██    ██ ██   ██ ██   ██ ██    ██ ██    ██ ██
 ██    ██ ██████  ███████ ██    ██ ██    ██ █████
 ██    ██ ██      ██   ██ ██ ▄▄ ██ ██    ██ ██
  ██████  ██      ██   ██  ██████   ██████  ███████
                              ▀▀
  The Host-Blind Context Tunnel
  https://github.com/anthropics/opaque
    \`);

    // ═══════════════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════════════
    let generatedUrl = '';
    let decryptedContent = '';
    let decryptedBytes = null;
    let isRawMode = false;
    let selectedFile = null;
    let blobExpiresAt = null;

    // ═══════════════════════════════════════════════════════════════
    // Elements
    // ═══════════════════════════════════════════════════════════════
    const dropzone = document.getElementById('dropzone');
    const dropzoneText = document.getElementById('dropzone-text');
    const fileInput = document.getElementById('file-input');
    const progressEl = document.getElementById('progress');
    const progressText = document.getElementById('progress-text');
    const progressFill = document.getElementById('progress-fill');
    const resultEl = document.getElementById('result');
    const resultUrl = document.getElementById('result-url');
    const overlay = document.getElementById('overlay');
    const viewerContent = document.getElementById('viewer-content');
    const viewerLoading = document.getElementById('viewer-loading');
    const viewerResult = document.getElementById('viewer-result');
    const cliBox = document.getElementById('cli-box');
    const cliCopied = document.getElementById('cli-copied');
    const typewriter = document.getElementById('typewriter');
    const shortcutsModal = document.getElementById('shortcuts-modal');

    // ═══════════════════════════════════════════════════════════════
    // Typewriter Effect
    // ═══════════════════════════════════════════════════════════════
    const tagline = '> Opaque: The Host-Blind Context Tunnel.';
    let charIndex = 0;

    function typeNextChar() {
      if (charIndex < tagline.length) {
        typewriter.textContent += tagline[charIndex];
        charIndex++;
        setTimeout(typeNextChar, 50 + Math.random() * 30);
      }
    }

    setTimeout(typeNextChar, 500);

    // ═══════════════════════════════════════════════════════════════
    // Dynamic Title
    // ═══════════════════════════════════════════════════════════════
    let originalTitle = 'Opaque';

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        document.title = 'Waiting...';
      } else {
        document.title = originalTitle;
      }
    });

    function setTitle(title) {
      originalTitle = title;
      if (!document.hidden) {
        document.title = title;
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // CLI Copy
    // ═══════════════════════════════════════════════════════════════
    cliBox.addEventListener('click', () => {
      navigator.clipboard.writeText('curl -sL opaque.dev/i | sh').then(() => {
        cliCopied.classList.add('show');
        setTimeout(() => cliCopied.classList.remove('show'), 2000);
      });
    });

    // ═══════════════════════════════════════════════════════════════
    // Dropzone
    // ═══════════════════════════════════════════════════════════════
    dropzone.addEventListener('click', () => fileInput.click());

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });

    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('dragover');
    });

    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files.length) {
        handleFile(e.dataTransfer.files[0]);
      }
    });

    fileInput.addEventListener('change', () => {
      if (fileInput.files.length) {
        handleFile(fileInput.files[0]);
      }
    });

    // Ctrl+V paste
    document.addEventListener('paste', (e) => {
      if (overlay.classList.contains('show')) return;

      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            handleFile(file);
            return;
          }
        } else if (item.kind === 'string' && item.type === 'text/plain') {
          item.getAsString((text) => {
            if (text.trim()) {
              uploadContent(text);
            }
          });
          return;
        }
      }
    });

    function handleFile(file) {
      selectedFile = file;
      dropzoneText.innerHTML = '<span class="dropzone-file">' + escapeHtml(file.name) + '</span><br><span style="color:var(--fg-dim)">' + formatBytes(file.size) + '</span>';
      uploadFile(file);
    }

    // ═══════════════════════════════════════════════════════════════
    // Upload
    // ═══════════════════════════════════════════════════════════════
    async function uploadContent(text) {
      const bytes = new TextEncoder().encode(text);
      await upload(bytes);
    }

    async function uploadFile(file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await upload(bytes);
    }

    async function upload(plaintext) {
      setTitle('Encrypting...');
      progressEl.classList.add('show');
      resultEl.classList.remove('show');

      try {
        // Generate key and IV
        progressText.textContent = '> Generating encryption key...';
        progressFill.style.width = '10%';
        await sleep(100);

        const key = crypto.getRandomValues(new Uint8Array(32));
        const iv = crypto.getRandomValues(new Uint8Array(16));

        // Encrypt
        progressText.textContent = '> Encrypting (AES-256-CBC)...';
        progressFill.style.width = '30%';

        const cryptoKey = await crypto.subtle.importKey(
          'raw', key, { name: 'AES-CBC' }, false, ['encrypt']
        );

        const ciphertext = await crypto.subtle.encrypt(
          { name: 'AES-CBC', iv }, cryptoKey, plaintext
        );

        // Upload
        progressText.textContent = '> Uploading encrypted blob...';
        progressFill.style.width = '60%';

        const response = await fetch('/api/drop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: ciphertext
        });

        if (!response.ok) {
          throw new Error('Upload failed: ' + response.status);
        }

        progressFill.style.width = '90%';
        const { id } = await response.json();

        // Build URL
        const keyHex = Array.from(key).map(b => b.toString(16).padStart(2, '0')).join('');
        const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join('');
        generatedUrl = location.origin + '/v/' + id + '#k=' + keyHex + '&iv=' + ivHex;

        progressFill.style.width = '100%';
        progressText.textContent = '> Done!';

        await sleep(300);

        // Show result
        progressEl.classList.remove('show');
        resultEl.classList.add('show');
        resultUrl.textContent = generatedUrl;
        setTitle('✓ Secure Link Ready');

        // Play sound (optional)
        try {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.frequency.value = 880;
          gain.gain.value = 0.1;
          osc.start();
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
          osc.stop(ctx.currentTime + 0.1);
        } catch (e) {}

      } catch (err) {
        progressText.textContent = '> Error: ' + err.message;
        progressFill.style.width = '0%';
        setTitle('Opaque');
        console.error(err);
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // Result Actions
    // ═══════════════════════════════════════════════════════════════
    function copyUrl() {
      navigator.clipboard.writeText(generatedUrl).then(() => {
        const btn = event.target;
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy URL', 2000);
      });
    }

    function copyForClaude() {
      const claudeFormat = generatedUrl;
      navigator.clipboard.writeText(claudeFormat).then(() => {
        const btn = event.target;
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy for Claude', 2000);
      });
    }

    function openViewer() {
      window.location.hash = generatedUrl.split('#')[1];
      const parts = generatedUrl.match(/\\/v\\/([a-f0-9-]+)/);
      if (parts) {
        window.location.hash = 'v/' + parts[1] + '&' + generatedUrl.split('#')[1];
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // Viewer Overlay
    // ═══════════════════════════════════════════════════════════════
    function showViewer(id, keyHex, ivHex) {
      overlay.classList.add('show');
      document.body.style.overflow = 'hidden';

      // Reset state
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
      setTitle('Opaque');
    }

    async function fetchAndDecrypt(id, keyHex, ivHex) {
      try {
        // Step 1: Fetch
        document.getElementById('step-fetch').className = 'step active';
        const res = await fetch('/api/blob/' + id);

        if (res.status === 404) {
          throw new Error('Blob not found. It may have expired or been deleted.');
        }
        if (res.status === 410) {
          throw new Error('This blob has expired and is no longer available.');
        }
        if (!res.ok) {
          throw new Error('Failed to fetch: ' + res.status);
        }

        // Get expiry from header
        const expiresHeader = res.headers.get('X-Opaque-Expires');
        if (expiresHeader) {
          blobExpiresAt = new Date(expiresHeader).getTime();
          updateTimer();
        }

        const encrypted = await res.arrayBuffer();
        document.getElementById('step-fetch').className = 'step done';
        document.getElementById('step-fetch').textContent = '> Fetching blob... OK';

        // Step 2: Extract
        await sleep(200);
        document.getElementById('step-extract').className = 'step active';

        if (!keyHex || keyHex.length !== 64) {
          throw new Error('Invalid key (expected 64 hex chars)');
        }
        if (!ivHex || ivHex.length !== 32) {
          throw new Error('Invalid IV (expected 32 hex chars)');
        }

        await sleep(200);
        document.getElementById('step-extract').className = 'step done';
        document.getElementById('step-extract').textContent = '> Extracting hash fragment... OK';

        // Step 3: Decrypt
        await sleep(200);
        document.getElementById('step-decrypt').className = 'step active';

        const keyBytes = hexToBytes(keyHex);
        const ivBytes = hexToBytes(ivHex);

        const key = await crypto.subtle.importKey(
          'raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']
        );

        const decrypted = await crypto.subtle.decrypt(
          { name: 'AES-CBC', iv: ivBytes }, key, encrypted
        );

        decryptedBytes = new Uint8Array(decrypted);
        document.getElementById('step-decrypt').className = 'step done';
        document.getElementById('step-decrypt').textContent = '> Decrypting (AES-256-CBC)... OK';

        await sleep(300);

        // Detect content type and display
        viewerLoading.style.display = 'none';
        viewerResult.style.display = 'block';

        if (isImage(decryptedBytes)) {
          displayImage(decryptedBytes);
        } else if (isBinary(decryptedBytes)) {
          displayBinary(decryptedBytes);
        } else {
          decryptedContent = new TextDecoder().decode(decrypted);
          displayText(decryptedContent);
        }

        setTitle('Opaque - Viewing');

      } catch (err) {
        viewerLoading.style.display = 'none';
        viewerResult.style.display = 'block';
        viewerResult.innerHTML = '<div class="viewer-error">' + escapeHtml(err.message) + '</div>';
      }
    }

    function displayText(text) {
      const lines = text.split('\\n');
      const lineNums = lines.map((_, i) => i + 1).join('\\n');

      // Detect language for syntax highlighting
      let lang = 'plaintext';
      if (text.includes('function') || text.includes('const ') || text.includes('let ')) lang = 'javascript';
      else if (text.includes('def ') || text.includes('import ')) lang = 'python';
      else if (text.includes('#!/bin/bash') || text.includes('#!/bin/sh')) lang = 'bash';
      else if (text.trim().startsWith('{') || text.trim().startsWith('[')) lang = 'json';
      else if (text.includes('# ') && text.includes('##')) lang = 'markdown';

      let highlighted = text;
      try {
        if (Prism.languages[lang]) {
          highlighted = Prism.highlight(text, Prism.languages[lang], lang);
        }
      } catch (e) {}

      viewerResult.innerHTML = \`
        <div class="code-container">
          <div class="line-numbers">\${lineNums}</div>
          <div class="code-content">\${highlighted}</div>
        </div>
      \`;
    }

    function displayImage(bytes) {
      const blob = new Blob([bytes]);
      const url = URL.createObjectURL(blob);
      viewerResult.innerHTML = '<img class="viewer-image" src="' + url + '" alt="Decrypted image">';
    }

    function displayBinary(bytes) {
      viewerResult.innerHTML = '<div style="color:var(--fg-muted)">Binary file detected (' + formatBytes(bytes.length) + '). Use Download button.</div>';
    }

    function isImage(bytes) {
      // Check magic bytes for common image formats
      if (bytes.length < 4) return false;
      // PNG
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return true;
      // JPEG
      if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return true;
      // GIF
      if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true;
      // WebP
      if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
          bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return true;
      return false;
    }

    function isBinary(bytes) {
      // Check if content appears to be binary (has null bytes or too many non-printable chars)
      let nonPrintable = 0;
      const sampleSize = Math.min(bytes.length, 1024);
      for (let i = 0; i < sampleSize; i++) {
        if (bytes[i] === 0) return true;
        if (bytes[i] < 32 && bytes[i] !== 9 && bytes[i] !== 10 && bytes[i] !== 13) {
          nonPrintable++;
        }
      }
      return nonPrintable / sampleSize > 0.1;
    }

    function toggleRaw() {
      isRawMode = !isRawMode;
      const btn = document.getElementById('btn-raw');

      if (isRawMode) {
        btn.textContent = 'Formatted';
        viewerResult.innerHTML = '<pre class="viewer-text">' + escapeHtml(decryptedContent) + '</pre>';
      } else {
        btn.textContent = 'Raw';
        displayText(decryptedContent);
      }
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
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = selectedFile?.name || 'opaque-content.txt';
      a.click();
      URL.revokeObjectURL(url);
    }

    function updateTimer() {
      if (!blobExpiresAt) return;

      const now = Date.now();
      const remaining = blobExpiresAt - now;

      if (remaining <= 0) {
        document.getElementById('viewer-timer').textContent = 'Expired';
        return;
      }

      const hours = Math.floor(remaining / (1000 * 60 * 60));
      const mins = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));

      document.getElementById('viewer-timer').textContent = 'Vaporizing in ' + hours + 'h ' + mins + 'm';

      setTimeout(updateTimer, 60000);
    }

    // ═══════════════════════════════════════════════════════════════
    // Hash Routing
    // ═══════════════════════════════════════════════════════════════
    function handleHash() {
      const hash = location.hash.slice(1);
      if (!hash) return;

      // Check for viewer route: #v/{id}&k=...&iv=...
      // or redirect from /v/:id which becomes #v/{id} + original hash
      const viewerMatch = hash.match(/^v\\/([a-f0-9-]+)/);
      if (viewerMatch) {
        const id = viewerMatch[1];
        // Extract key and IV from the rest of the hash
        const params = new URLSearchParams(hash.replace(/^v\\/[a-f0-9-]+&?/, ''));
        const keyHex = params.get('k');
        const ivHex = params.get('iv');

        if (keyHex && ivHex) {
          showViewer(id, keyHex, ivHex);
        }
      }
    }

    window.addEventListener('hashchange', handleHash);
    handleHash();

    // ═══════════════════════════════════════════════════════════════
    // Keyboard Shortcuts
    // ═══════════════════════════════════════════════════════════════
    document.addEventListener('keydown', (e) => {
      // Don't handle if typing in an input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      switch (e.key) {
        case '/':
          e.preventDefault();
          cliBox.focus();
          cliBox.click();
          break;
        case 'u':
          if (!overlay.classList.contains('show')) {
            e.preventDefault();
            fileInput.click();
          }
          break;
        case 'Escape':
          if (shortcutsModal.classList.contains('show')) {
            closeShortcuts();
          } else if (overlay.classList.contains('show')) {
            closeViewer();
          }
          break;
        case 'r':
          if (overlay.classList.contains('show') && decryptedContent) {
            e.preventDefault();
            toggleRaw();
          }
          break;
        case '?':
          e.preventDefault();
          shortcutsModal.classList.add('show');
          break;
      }
    });

    function closeShortcuts() {
      shortcutsModal.classList.remove('show');
    }

    // Close shortcuts on outside click
    shortcutsModal.addEventListener('click', (e) => {
      if (e.target === shortcutsModal) {
        closeShortcuts();
      }
    });

    // ═══════════════════════════════════════════════════════════════
    // Utilities
    // ═══════════════════════════════════════════════════════════════
    function hexToBytes(hex) {
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
      }
      return bytes;
    }

    function formatBytes(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    }

    function escapeHtml(str) {
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function sleep(ms) {
      return new Promise(r => setTimeout(r, ms));
    }
  </script>
</body>
</html>`;
