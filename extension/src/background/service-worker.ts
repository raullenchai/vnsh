/**
 * vnsh Extension — Background Service Worker
 *
 * Handles:
 * - Context menu registration and actions
 * - Screenshot capture
 * - AI Debug Bundle assembly
 * - Clipboard writing (via executeScript or offscreen fallback)
 * - Keyboard shortcuts
 * - Notifications
 * - Onboarding on install
 */

import {
  generateKey,
  generateIV,
  encrypt,
  encryptText,
} from '../lib/crypto';
import { uploadBlob } from '../lib/api';
import { buildVnshUrl } from '../lib/url';
import { addToHistory, saveSnippet, generateSnippetId } from '../lib/storage';
import { buildBundle, type BundleInput, type ConsoleError } from '../lib/bundle';
import {
  VNSH_HOST,
  DEFAULT_TTL,
  SCREENSHOT_QUALITY,
  AI_PROMPT_PREFIX,
  AI_PROMPT_SUFFIX,
} from '../lib/constants';

// ── Context Menu Setup ─────────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.create({
    id: 'vnsh-share-text',
    title: 'Share via vnsh',
    contexts: ['selection'],
  });

  chrome.contextMenus.create({
    id: 'vnsh-debug-bundle',
    title: 'AI Debug Bundle',
    contexts: ['selection', 'page'],
  });

  chrome.contextMenus.create({
    id: 'vnsh-share-image',
    title: 'Share image via vnsh',
    contexts: ['image'],
  });

  chrome.contextMenus.create({
    id: 'vnsh-save-snippet',
    title: 'Save to vnsh',
    contexts: ['selection'],
  });

  if (details.reason === 'install') {
    chrome.tabs.create({
      url: chrome.runtime.getURL('onboarding/onboarding.html'),
    });
  }
});

// ── Context Menu Click Handler ─────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    switch (info.menuItemId) {
      case 'vnsh-share-text':
        await handleShareText(info.selectionText || '', tab);
        break;
      case 'vnsh-debug-bundle':
        await handleDebugBundle(info.selectionText, tab);
        break;
      case 'vnsh-share-image':
        await handleShareImage(info.srcUrl || '', tab);
        break;
      case 'vnsh-save-snippet':
        await handleSaveSnippet(info.selectionText || '', tab);
        break;
    }
  } catch (err) {
    console.error('[vnsh] Context menu action failed:', err);
    showNotification('Error', (err as Error).message);
  }
});

// ── Keyboard Shortcuts ─────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  try {
    switch (command) {
      case 'debug-bundle':
        await handleDebugBundle(undefined, tab);
        break;
      case 'screenshot':
        await handleScreenshot(tab);
        break;
    }
  } catch (err) {
    console.error('[vnsh] Command failed:', err);
    showNotification('Error', (err as Error).message);
  }
});

// ── Message Handler (from popup / content scripts) ─────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'share-text') {
    handleShareText(message.text, undefined, message.ttl)
      .then((url) => sendResponse({ url }))
      .catch((err) => sendResponse({ error: (err as Error).message }));
    return true;
  }

  if (message.action === 'share-file') {
    handleShareBinary(new Uint8Array(message.data), message.filename)
      .then((url) => sendResponse({ url }))
      .catch((err) => sendResponse({ error: (err as Error).message }));
    return true;
  }

  if (message.action === 'screenshot') {
    handleScreenshot(undefined)
      .then((url) => sendResponse({ url }))
      .catch((err) => sendResponse({ error: (err as Error).message }));
    return true;
  }

  if (message.action === 'debug-bundle-from-popup') {
    handleDebugBundle(undefined, undefined, message.userNote)
      .then((url) => sendResponse({ url }))
      .catch((err) => sendResponse({ error: (err as Error).message }));
    return true;
  }
});

// ── Core Actions ───────────────────────────────────────────────────

async function handleShareText(
  text: string,
  tab?: chrome.tabs.Tab,
  ttl?: number,
): Promise<string> {
  if (!text) throw new Error('No text to share');

  const key = generateKey();
  const iv = generateIV();
  const ciphertext = await encryptText(text, key, iv);

  const { id, expires } = await uploadBlob(ciphertext, ttl || DEFAULT_TTL);
  const url = buildVnshUrl(VNSH_HOST, id, key, iv);

  await addToHistory({
    url,
    label: text.slice(0, 80),
    type: 'text',
    sharedAt: new Date().toISOString(),
    expiresAt: expires,
  });

  await copyToClipboard(url, tab);
  showNotification('Shared!', 'Link copied to clipboard');
  return url;
}

async function handleShareBinary(
  data: Uint8Array,
  filename?: string,
): Promise<string> {
  const key = generateKey();
  const iv = generateIV();
  const ciphertext = await encrypt(data, key, iv);

  const { id, expires } = await uploadBlob(ciphertext, DEFAULT_TTL);
  const url = buildVnshUrl(VNSH_HOST, id, key, iv);

  await addToHistory({
    url,
    label: filename || 'File',
    type: 'image',
    sharedAt: new Date().toISOString(),
    expiresAt: expires,
  });

  return url;
}

async function handleShareImage(
  srcUrl: string,
  tab?: chrome.tabs.Tab,
): Promise<string> {
  const response = await fetch(srcUrl);
  if (!response.ok) throw new Error('Failed to fetch image');

  const data = new Uint8Array(await response.arrayBuffer());
  const key = generateKey();
  const iv = generateIV();
  const ciphertext = await encrypt(data, key, iv);

  const { id, expires } = await uploadBlob(ciphertext, DEFAULT_TTL);
  const url = buildVnshUrl(VNSH_HOST, id, key, iv);

  await addToHistory({
    url,
    label: 'Image',
    type: 'image',
    sharedAt: new Date().toISOString(),
    expiresAt: expires,
  });

  await copyToClipboard(url, tab);
  showNotification('Image shared!', 'Link copied to clipboard');
  return url;
}

async function handleSaveSnippet(
  text: string,
  tab?: chrome.tabs.Tab,
): Promise<void> {
  if (!text) return;

  await saveSnippet({
    id: generateSnippetId(),
    content: text,
    sourceUrl: tab?.url,
    label: text.slice(0, 80),
    savedAt: new Date().toISOString(),
  });

  showNotification('Saved!', 'Snippet saved to vnsh');
}

async function handleScreenshot(
  tab?: chrome.tabs.Tab,
): Promise<string> {
  const currentTab = tab || (await getActiveTab());
  if (!currentTab?.id) throw new Error('No active tab');

  const dataUrl = await chrome.tabs.captureVisibleTab(currentTab.windowId, {
    format: 'jpeg',
    quality: SCREENSHOT_QUALITY,
  });

  // Convert data URL to binary
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  const key = generateKey();
  const iv = generateIV();
  const ciphertext = await encrypt(bytes, key, iv);

  const { id, expires } = await uploadBlob(ciphertext, DEFAULT_TTL);
  const url = buildVnshUrl(VNSH_HOST, id, key, iv);

  await addToHistory({
    url,
    label: `Screenshot: ${currentTab.title || 'Page'}`,
    type: 'image',
    sharedAt: new Date().toISOString(),
    expiresAt: expires,
  });

  await copyToClipboard(url, currentTab);
  showNotification('Screenshot shared!', 'Link copied to clipboard');
  return url;
}

async function handleDebugBundle(
  selectedText?: string,
  tab?: chrome.tabs.Tab,
  userNote?: string,
): Promise<string> {
  const currentTab = tab || (await getActiveTab());
  if (!currentTab?.id) throw new Error('No active tab');

  // Step 1: Inject error collector to capture any recent errors,
  // then collect data in parallel
  const tabId = currentTab.id;

  const [screenshotDataUrl, consoleErrors, selection] = await Promise.all([
    // Screenshot
    chrome.tabs.captureVisibleTab(currentTab.windowId, {
      format: 'jpeg',
      quality: SCREENSHOT_QUALITY,
    }).catch(() => undefined),

    // Console errors — inject a collector that reads from the page's error log.
    // We override console.error with a wrapper if not already done,
    // then return whatever errors have been captured.
    chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // If we've previously injected, read accumulated errors
        const w = window as any;
        if (Array.isArray(w.__vnsh_errors__)) {
          return w.__vnsh_errors__.slice(-20) as Array<{
            message: string;
            source?: string;
            timestamp: number;
          }>;
        }
        // First time: no errors captured yet. Return empty.
        // Also install the collector for future calls.
        w.__vnsh_errors__ = [];
        const origError = console.error;
        console.error = function (...args: any[]) {
          w.__vnsh_errors__.push({
            message: args.map(String).join(' '),
            timestamp: Date.now(),
          });
          if (w.__vnsh_errors__.length > 50) {
            w.__vnsh_errors__ = w.__vnsh_errors__.slice(-20);
          }
          origError.apply(console, args);
        };
        window.addEventListener('error', (e) => {
          w.__vnsh_errors__.push({
            message: e.message,
            source: `${e.filename}:${e.lineno}:${e.colno}`,
            timestamp: Date.now(),
          });
        });
        window.addEventListener('unhandledrejection', (e) => {
          w.__vnsh_errors__.push({
            message: `Unhandled rejection: ${e.reason}`,
            timestamp: Date.now(),
          });
        });
        return [] as Array<{
          message: string;
          source?: string;
          timestamp: number;
        }>;
      },
    }).then((results) => (results[0]?.result as ConsoleError[]) || [])
      .catch(() => [] as ConsoleError[]),

    // Get selected text if not provided
    selectedText
      ? Promise.resolve(selectedText)
      : chrome.scripting.executeScript({
          target: { tabId },
          func: () => window.getSelection()?.toString() || '',
        }).then((results) => (results[0]?.result as string) || '')
          .catch(() => ''),
  ]);

  const bundleInput: BundleInput = {
    url: currentTab.url || '',
    title: currentTab.title || '',
    selectedText: selection || undefined,
    consoleErrors: consoleErrors,
    screenshotDataUrl: screenshotDataUrl,
    userNote: userNote,
  };

  const bundleJson = buildBundle(bundleInput);
  const bundleBytes = new TextEncoder().encode(bundleJson);

  const key = generateKey();
  const iv = generateIV();
  const ciphertext = await encrypt(bundleBytes, key, iv);

  const { id, expires } = await uploadBlob(ciphertext, DEFAULT_TTL);
  const url = buildVnshUrl(VNSH_HOST, id, key, iv);

  const aiUrl = `${AI_PROMPT_PREFIX}${url}${AI_PROMPT_SUFFIX}`;

  await addToHistory({
    url,
    label: `Debug Bundle: ${currentTab.title || 'Page'}`,
    type: 'bundle',
    sharedAt: new Date().toISOString(),
    expiresAt: expires,
  });

  await copyToClipboard(aiUrl, currentTab);
  showNotification('Debug Bundle created!', 'AI-ready link copied to clipboard');
  return url;
}

// ── Helpers ────────────────────────────────────────────────────────

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');
  return tab;
}

/**
 * Copy text to clipboard.
 * Primary: executeScript in active tab (navigator.clipboard.writeText).
 * Fallback: offscreen document (for restricted pages).
 */
async function copyToClipboard(
  text: string,
  tab?: chrome.tabs.Tab,
): Promise<void> {
  // Try executeScript in the active tab first
  if (tab?.id && tab.url && isScriptableUrl(tab.url)) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (t: string) => navigator.clipboard.writeText(t),
        args: [text],
      });
      return;
    } catch {
      // Fall through to offscreen
    }
  }

  // Fallback: offscreen document
  await ensureOffscreen();
  await chrome.runtime.sendMessage({ action: 'offscreen-copy', text });
}

/** Check if a URL allows content script injection. */
function isScriptableUrl(url: string): boolean {
  return (
    !url.startsWith('chrome://') &&
    !url.startsWith('chrome-extension://') &&
    !url.startsWith('edge://') &&
    !url.startsWith('about:') &&
    !url.startsWith('chrome:') &&
    !url.startsWith('devtools://')
  );
}

/**
 * Ensure an offscreen document exists for clipboard fallback.
 * Uses a lock to prevent race conditions when called concurrently.
 */
let offscreenLock: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  if (offscreenLock) {
    await offscreenLock;
    return;
  }

  offscreenLock = (async () => {
    try {
      const existingContexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      });
      if (existingContexts.length > 0) return;

      await chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: [chrome.offscreen.Reason.CLIPBOARD],
        justification: 'Write shared URL to clipboard',
      });
    } finally {
      offscreenLock = null;
    }
  })();

  await offscreenLock;
}

function showNotification(title: string, message: string): void {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('assets/icon-128.png'),
    title: `vnsh — ${title}`,
    message,
  });
}
