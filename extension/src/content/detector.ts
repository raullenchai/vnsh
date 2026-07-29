/**
 * vnsh Content Script — Link Detector
 *
 * Scans the page for vnsh.dev/v/ links, adds a visual indicator,
 * and shows a decrypted preview tooltip on hover.
 * Uses MutationObserver for dynamic content (Slack, GitHub, Discord).
 */

import { parseVnshUrl } from '../lib/url';
import { decrypt } from '../lib/crypto';
import { downloadBlob } from '../lib/api';
import { TOOLTIP_PREVIEW_LENGTH } from '../lib/constants';
import { parseWorkspaceUrl, decryptWorkspace, workspaceKind } from '../lib/workspace';

/**
 * The three shapes a vnsh link can take. Only /v/ and /w/ need a fragment,
 * because only they carry a key; a public workspace has none, so requiring one
 * would make every public link invisible to this extension.
 */
const VNSH_LINK_RE =
  /vnsh\.dev\/(?:v\/[a-zA-Z0-9-]+#\S+|w\/[a-zA-Z0-9]{12}#\S+|p\/[a-zA-Z0-9]{12})/;

const processed = new WeakSet<HTMLAnchorElement>();

// ── Bounded Preview Cache (max 50 entries, LRU eviction) ───────────

const CACHE_MAX = 50;
const previewCache = new Map<
  string,
  { type: 'text' | 'image' | 'error'; content: string }
>();

function cacheSet(
  key: string,
  value: { type: 'text' | 'image' | 'error'; content: string },
): void {
  if (previewCache.size >= CACHE_MAX) {
    // Evict oldest entry (first key in Map iteration order)
    const oldest = previewCache.keys().next().value;
    if (oldest !== undefined) {
      const evicted = previewCache.get(oldest);
      // Revoke blob URLs to free memory
      if (evicted?.type === 'image' && evicted.content.startsWith('blob:')) {
        URL.revokeObjectURL(evicted.content);
      }
      previewCache.delete(oldest);
    }
  }
  previewCache.set(key, value);
}

// ── Scanner ────────────────────────────────────────────────────────

function scanLinks(root: Node): void {
  const container = root instanceof HTMLElement ? root : document;
  const anchors = container.querySelectorAll<HTMLAnchorElement>('a[href]');

  for (const anchor of anchors) {
    if (processed.has(anchor)) continue;
    // href includes the full URL with fragment
    if (!VNSH_LINK_RE.test(anchor.href)) continue;

    processed.add(anchor);
    enhanceLink(anchor);
  }
}

function enhanceLink(anchor: HTMLAnchorElement): void {
  const indicator = document.createElement('span');
  indicator.className = 'vnsh-link-indicator';
  indicator.textContent = 'V';
  indicator.title = 'vnsh encrypted link';
  anchor.appendChild(indicator);

  let tooltip: HTMLDivElement | null = null;
  let hideTimeout: ReturnType<typeof setTimeout>;

  anchor.addEventListener('mouseenter', () => {
    clearTimeout(hideTimeout);
    if (!tooltip) {
      tooltip = createTooltip();
      document.body.appendChild(tooltip);
    }
    positionTooltip(tooltip, anchor);
    tooltip.classList.add('visible');
    loadPreview(anchor.href, tooltip);
  });

  anchor.addEventListener('mouseleave', () => {
    hideTimeout = setTimeout(() => {
      tooltip?.classList.remove('visible');
    }, 200);
  });
}

// ── Tooltip ────────────────────────────────────────────────────────

function createTooltip(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'vnsh-tooltip';
  el.innerHTML = `
    <div class="vnsh-tooltip-header">
      <span class="vnsh-tooltip-logo">vnsh</span>
      <span class="vnsh-tooltip-badge">encrypted</span>
    </div>
    <div class="vnsh-tooltip-body">
      <div class="vnsh-tooltip-loading">Decrypting...</div>
    </div>
    <div class="vnsh-tooltip-footer">
      <span>End-to-end encrypted</span>
      <a href="https://vnsh.dev" target="_blank" rel="noopener">vnsh.dev</a>
    </div>
  `;

  el.addEventListener('mouseenter', () => el.classList.add('visible'));
  el.addEventListener('mouseleave', () => el.classList.remove('visible'));

  return el;
}

function positionTooltip(
  tooltip: HTMLDivElement,
  anchor: HTMLAnchorElement,
): void {
  const rect = anchor.getBoundingClientRect();
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  tooltip.style.left = `${rect.left + scrollX}px`;
  tooltip.style.top = `${rect.bottom + scrollY + 6}px`;

  // Adjust if overflowing right edge
  requestAnimationFrame(() => {
    const tooltipRect = tooltip.getBoundingClientRect();
    if (tooltipRect.right > window.innerWidth - 8) {
      tooltip.style.left = `${window.innerWidth - tooltipRect.width - 8 + scrollX}px`;
    }
  });
}

async function loadPreview(
  url: string,
  tooltip: HTMLDivElement,
): Promise<void> {
  const body = tooltip.querySelector('.vnsh-tooltip-body')!;

  // Check cache
  const cached = previewCache.get(url);
  if (cached) {
    renderPreview(body, cached.type, cached.content);
    return;
  }

  body.innerHTML = '<div class="vnsh-tooltip-loading">Decrypting...</div>';

  try {
    const bytes = await loadContent(url);

    if (isImage(bytes)) {
      const blob = new Blob([bytes as BlobPart]);
      const blobUrl = URL.createObjectURL(blob);
      cacheSet(url, { type: 'image', content: blobUrl });
      renderPreview(body, 'image', blobUrl);
    } else {
      const text = new TextDecoder().decode(bytes);
      const preview = text.slice(0, TOOLTIP_PREVIEW_LENGTH);
      const truncated =
        text.length > TOOLTIP_PREVIEW_LENGTH ? preview + '...' : preview;
      cacheSet(url, { type: 'text', content: truncated });
      renderPreview(body, 'text', truncated);
    }
  } catch (err) {
    const msg = (err as Error).message;
    cacheSet(url, { type: 'error', content: msg });
    renderPreview(body, 'error', msg);
  }
}

/**
 * Fetch and, where required, decrypt whatever a vnsh link points at.
 *
 * Three cases, because there are three link shapes and they fail differently:
 * a v1 blob is CBC with the key and IV in the fragment; an encrypted workspace
 * is GCM with a key derived from the fragment; a public workspace has no key at
 * all and is served as an ordinary document. Treating the third as malformed is
 * what made every public link show nothing.
 */
async function loadContent(url: string): Promise<Uint8Array> {
  const kind = workspaceKind(url);

  if (kind === 'public') {
    const response = await fetch(url.split('#')[0], {
      headers: { 'X-Vnsh-Client': 'extension' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  if (kind === 'encrypted') {
    const link = await parseWorkspaceUrl(url);
    const response = await fetch(`${link.host}/api/workspace/${link.id}`, {
      headers: { 'X-Vnsh-Client': 'extension' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = new Uint8Array(await response.arrayBuffer());
    // A public workspace still has a /w/ edit link, so plaintext can arrive
    // here; decrypting it would report the author's own link as corrupt.
    if (response.headers.get('X-Vnsh-Public') === '1') return payload;
    return decryptWorkspace(payload, link.key as Uint8Array);
  }

  const { id, key, iv } = parseVnshUrl(url);
  const { data } = await downloadBlob(id);
  return new Uint8Array(await decrypt(data, key, iv));
}

function renderPreview(
  body: Element,
  type: 'text' | 'image' | 'error',
  content: string,
): void {
  if (type === 'error') {
    body.innerHTML = `<div class="vnsh-tooltip-error">${escapeHtml(content)}</div>`;
  } else if (type === 'image') {
    body.innerHTML = `<img src="${content}" alt="vnsh preview">`;
  } else {
    body.textContent = content;
  }
}

// ── Image Detection ────────────────────────────────────────────────

function isImage(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  // PNG
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  // GIF
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true;
  // WebP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return true;
  return false;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── MutationObserver for Dynamic Content ───────────────────────────

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node instanceof HTMLElement) {
        scanLinks(node);
      }
    }
  }
});

// ── Init ───────────────────────────────────────────────────────────

// Signal to the page that the extension is installed (used by vnsh.dev CTA)
document.documentElement.setAttribute('data-vnsh-ext', '1');

scanLinks(document);
observer.observe(document.body, { childList: true, subtree: true });
