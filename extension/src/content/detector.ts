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

/** Only match links that include a fragment (required for decryption). */
const VNSH_LINK_RE = /vnsh\.dev\/v\/[a-zA-Z0-9-]+#\S+/;

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
    const { id, key, iv } = parseVnshUrl(url);
    const { data } = await downloadBlob(id);
    const decrypted = await decrypt(data, key, iv);
    const bytes = new Uint8Array(decrypted);

    if (isImage(bytes)) {
      const blob = new Blob([bytes]);
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

scanLinks(document);
observer.observe(document.body, { childList: true, subtree: true });
