/**
 * vnsh Popup — Main UI logic
 * 3 tabs: Share / Saved / History
 */

import { getHistory, getSnippets, deleteSnippet, pruneExpiredHistory } from '../lib/storage';
import type { ShareRecord, SavedSnippet } from '../lib/storage';

// ── DOM Elements ───────────────────────────────────────────────────

const tabs = document.querySelectorAll<HTMLButtonElement>('.tab');
const tabContents = document.querySelectorAll<HTMLElement>('.tab-content');

const shareText = document.getElementById('share-text') as HTMLTextAreaElement;
const dropZone = document.getElementById('drop-zone') as HTMLDivElement;
const ttlSelect = document.getElementById('ttl-select') as HTMLSelectElement;
const btnShare = document.getElementById('btn-share') as HTMLButtonElement;
const btnDebugBundle = document.getElementById('btn-debug-bundle') as HTMLButtonElement;
const btnScreenshot = document.getElementById('btn-screenshot') as HTMLButtonElement;
const shareResult = document.getElementById('share-result') as HTMLDivElement;
const resultUrl = document.getElementById('result-url') as HTMLInputElement;
const btnCopy = document.getElementById('btn-copy') as HTMLButtonElement;
const shareStatus = document.getElementById('share-status') as HTMLDivElement;

const savedEmpty = document.getElementById('saved-empty') as HTMLDivElement;
const savedList = document.getElementById('saved-list') as HTMLUListElement;
const historyEmpty = document.getElementById('history-empty') as HTMLDivElement;
const historyList = document.getElementById('history-list') as HTMLUListElement;

// ── Tab Switching ──────────────────────────────────────────────────

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab!;
    tabs.forEach((t) => t.classList.remove('active'));
    tabContents.forEach((c) => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${target}`)!.classList.add('active');

    if (target === 'saved') loadSaved();
    if (target === 'history') loadHistory();
  });
});

// ── Share Tab ──────────────────────────────────────────────────────

let pendingFile: File | null = null;

btnShare.addEventListener('click', async () => {
  const text = shareText.value.trim();

  if (pendingFile) {
    await shareFile(pendingFile);
    return;
  }

  if (!text) {
    showStatus('Nothing to share', 'error');
    return;
  }

  await shareTextContent(text);
});

btnDebugBundle.addEventListener('click', async () => {
  setLoading(true);
  showStatus('Building debug bundle...', 'loading');

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'debug-bundle-from-popup',
      userNote: shareText.value.trim() || undefined,
    });

    if (response.error) throw new Error(response.error);
    showResult(response.url);
    showStatus('Debug bundle created!', 'success');
  } catch (err) {
    showStatus((err as Error).message, 'error');
  } finally {
    setLoading(false);
  }
});

btnScreenshot.addEventListener('click', async () => {
  setLoading(true);
  showStatus('Capturing screenshot...', 'loading');

  try {
    const response = await chrome.runtime.sendMessage({ action: 'screenshot' });
    if (response.error) throw new Error(response.error);
    showResult(response.url);
    showStatus('Screenshot shared!', 'success');
  } catch (err) {
    showStatus((err as Error).message, 'error');
  } finally {
    setLoading(false);
  }
});

btnCopy.addEventListener('click', () => {
  resultUrl.select();
  navigator.clipboard.writeText(resultUrl.value);
  btnCopy.textContent = 'Copied!';
  setTimeout(() => (btnCopy.textContent = 'Copy'), 1500);
});

async function shareTextContent(text: string): Promise<void> {
  setLoading(true);
  showStatus('Encrypting & uploading...', 'loading');

  try {
    const ttl = parseInt(ttlSelect.value, 10);
    const response = await chrome.runtime.sendMessage({
      action: 'share-text',
      text,
      ttl,
    });

    if (response.error) throw new Error(response.error);
    showResult(response.url);
    showStatus('Shared! Link copied.', 'success');
  } catch (err) {
    showStatus((err as Error).message, 'error');
  } finally {
    setLoading(false);
  }
}

async function shareFile(file: File): Promise<void> {
  setLoading(true);
  showStatus(`Encrypting ${file.name}...`, 'loading');

  try {
    const buffer = await file.arrayBuffer();
    const response = await chrome.runtime.sendMessage({
      action: 'share-file',
      data: Array.from(new Uint8Array(buffer)),
      filename: file.name,
    });

    if (response.error) throw new Error(response.error);
    showResult(response.url);
    showStatus('File shared!', 'success');
    pendingFile = null;
  } catch (err) {
    showStatus((err as Error).message, 'error');
  } finally {
    setLoading(false);
  }
}

// ── Drag & Drop ────────────────────────────────────────────────────

const shareInputArea = document.querySelector('.share-input-area')!;

shareInputArea.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dropZone.classList.add('active');
});

shareInputArea.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dropZone.classList.remove('active');
});

shareInputArea.addEventListener('dragover', (e) => {
  e.preventDefault();
});

shareInputArea.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('active');

  const file = (e as DragEvent).dataTransfer?.files[0];
  if (file) {
    pendingFile = file;
    shareText.value = `[File: ${file.name} (${formatBytes(file.size)})]`;
    shareText.disabled = true;
  }
});

// ── Saved Tab ──────────────────────────────────────────────────────

async function loadSaved(): Promise<void> {
  const snippets = await getSnippets();

  if (snippets.length === 0) {
    savedEmpty.classList.remove('hidden');
    savedList.innerHTML = '';
    return;
  }

  savedEmpty.classList.add('hidden');
  savedList.innerHTML = snippets.map((s) => renderSnippetItem(s)).join('');

  // Attach event listeners
  savedList.querySelectorAll('[data-action="share-snippet"]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const content = (e.currentTarget as HTMLElement).dataset.content!;
      await shareTextContent(content);
      // Switch to share tab to show result
      tabs[0].click();
    });
  });

  savedList.querySelectorAll('[data-action="delete-snippet"]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const id = (e.currentTarget as HTMLElement).dataset.id!;
      await deleteSnippet(id);
      loadSaved();
    });
  });
}

function renderSnippetItem(s: SavedSnippet): string {
  const escaped = escapeHtml(s.label);
  const date = new Date(s.savedAt).toLocaleDateString();
  return `
    <li>
      <div class="item-label">${escaped}</div>
      <div class="item-meta">
        <span>${date}</span>
        ${s.sourceUrl ? `<span>${new URL(s.sourceUrl).hostname}</span>` : ''}
      </div>
      <div class="item-actions">
        <button class="btn small" data-action="share-snippet" data-content="${escapeAttr(s.content)}">Share</button>
        <button class="btn small" data-action="delete-snippet" data-id="${s.id}">Delete</button>
      </div>
    </li>
  `;
}

// ── History Tab ────────────────────────────────────────────────────

async function loadHistory(): Promise<void> {
  await pruneExpiredHistory();
  const history = await getHistory();

  if (history.length === 0) {
    historyEmpty.classList.remove('hidden');
    historyList.innerHTML = '';
    return;
  }

  historyEmpty.classList.add('hidden');
  historyList.innerHTML = history.map((r) => renderHistoryItem(r)).join('');

  // Copy buttons
  historyList.querySelectorAll('[data-action="copy-url"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const url = (e.currentTarget as HTMLElement).dataset.url!;
      navigator.clipboard.writeText(url);
      (e.currentTarget as HTMLElement).textContent = 'Copied!';
      setTimeout(() => ((e.currentTarget as HTMLElement).textContent = 'Copy'), 1500);
    });
  });
}

function renderHistoryItem(r: ShareRecord): string {
  const escaped = escapeHtml(r.label);
  const date = new Date(r.sharedAt).toLocaleDateString();
  const typeClass = r.type;
  const expiryText = r.expiresAt ? formatExpiry(r.expiresAt) : '';
  const isExpired = r.expiresAt && new Date(r.expiresAt).getTime() < Date.now();

  return `
    <li>
      <div class="item-label">${escaped}</div>
      <div class="item-meta">
        <span class="badge ${typeClass}">${r.type}</span>
        <span>${date}</span>
        ${expiryText ? `<span class="expiry ${isExpired ? 'expired' : ''}">${expiryText}</span>` : ''}
      </div>
      <div class="item-actions">
        <button class="btn small" data-action="copy-url" data-url="${escapeAttr(r.url)}">Copy</button>
      </div>
    </li>
  `;
}

// ── Helpers ────────────────────────────────────────────────────────

function showResult(url: string): void {
  shareResult.classList.remove('hidden');
  resultUrl.value = url;
}

function showStatus(msg: string, type: 'loading' | 'error' | 'success'): void {
  shareStatus.classList.remove('hidden', 'loading', 'error', 'success');
  shareStatus.classList.add(type);
  shareStatus.textContent = msg;

  if (type === 'success') {
    setTimeout(() => shareStatus.classList.add('hidden'), 3000);
  }
}

function setLoading(loading: boolean): void {
  btnShare.disabled = loading;
  btnDebugBundle.disabled = loading;
  btnScreenshot.disabled = loading;
}

function formatExpiry(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return 'expired';
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatBytes(b: number): string {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
