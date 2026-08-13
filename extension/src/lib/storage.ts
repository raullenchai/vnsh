/**
 * Chrome storage helpers for share history and saved snippets.
 * Uses chrome.storage.local — data stays on the device.
 */

import { MAX_HISTORY_ENTRIES, MAX_SAVED_SNIPPETS } from './constants';

// ── Types ──────────────────────────────────────────────────────────

export interface ShareRecord {
  /** vnsh URL (full, with fragment) */
  url: string;
  /** Short label / first line of content */
  label: string;
  /** 'text' | 'image' | 'bundle' */
  type: 'text' | 'image' | 'bundle';
  /** ISO timestamp of share */
  sharedAt: string;
  /** ISO timestamp of expiry */
  expiresAt?: string;
}

export interface SavedSnippet {
  id: string;
  /** The plaintext content */
  content: string;
  /** Source URL where it was saved from */
  sourceUrl?: string;
  /** Short label */
  label: string;
  /** ISO timestamp */
  savedAt: string;
}

// ── History ────────────────────────────────────────────────────────

const HISTORY_KEY = 'vnsh_history';
const SNIPPETS_KEY = 'vnsh_snippets';

/** Get all share history entries (newest first). */
export async function getHistory(): Promise<ShareRecord[]> {
  const result = await chrome.storage.local.get(HISTORY_KEY);
  return (result[HISTORY_KEY] as ShareRecord[]) || [];
}

/** Add a share to history. Trims to MAX_HISTORY_ENTRIES. */
export async function addToHistory(record: ShareRecord): Promise<void> {
  const history = await getHistory();
  history.unshift(record);
  if (history.length > MAX_HISTORY_ENTRIES) {
    history.length = MAX_HISTORY_ENTRIES;
  }
  await chrome.storage.local.set({ [HISTORY_KEY]: history });
}

/** Remove expired entries from history. */
export async function pruneExpiredHistory(): Promise<void> {
  const history = await getHistory();
  const now = Date.now();
  const pruned = history.filter(
    (r) => !r.expiresAt || new Date(r.expiresAt).getTime() > now,
  );
  if (pruned.length !== history.length) {
    await chrome.storage.local.set({ [HISTORY_KEY]: pruned });
  }
}

// ── Saved Snippets ─────────────────────────────────────────────────

/** Get all saved snippets (newest first). */
export async function getSnippets(): Promise<SavedSnippet[]> {
  const result = await chrome.storage.local.get(SNIPPETS_KEY);
  return (result[SNIPPETS_KEY] as SavedSnippet[]) || [];
}

/** Save a new snippet locally. */
export async function saveSnippet(snippet: SavedSnippet): Promise<void> {
  const snippets = await getSnippets();
  snippets.unshift(snippet);
  if (snippets.length > MAX_SAVED_SNIPPETS) {
    snippets.length = MAX_SAVED_SNIPPETS;
  }
  await chrome.storage.local.set({ [SNIPPETS_KEY]: snippets });
}

/** Delete a snippet by ID. */
export async function deleteSnippet(id: string): Promise<void> {
  const snippets = await getSnippets();
  const filtered = snippets.filter((s) => s.id !== id);
  await chrome.storage.local.set({ [SNIPPETS_KEY]: filtered });
}

/** Generate a unique ID for snippets. */
export function generateSnippetId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── Retention preference ───────────────────────────────────────────

const RETENTION_KEY = 'vnsh_retention_hours';

/** Values the popup offers. 168 is the server's cap, and means seven days. */
export const RETENTION_CHOICES = [24, 72, 168] as const;

const DEFAULT_RETENTION_HOURS = 24;

/**
 * How long new shares should live, in hours.
 *
 * Stored rather than asked each time: the person who needs a week needs it for
 * every share, and a control they have to find on each one is a control they
 * will forget on the share that mattered.
 *
 * An unreadable or out-of-range stored value falls back to the default instead
 * of propagating — the server would clamp it anyway, and silently getting 24h
 * while the popup claims 168 is worse than getting 24h and being told so.
 */
export async function getRetentionHours(): Promise<number> {
  try {
    const result = await chrome.storage.local.get(RETENTION_KEY);
    const stored = result[RETENTION_KEY];
    return (RETENTION_CHOICES as readonly number[]).includes(stored)
      ? stored
      : DEFAULT_RETENTION_HOURS;
  } catch {
    return DEFAULT_RETENTION_HOURS;
  }
}

export async function setRetentionHours(hours: number): Promise<void> {
  const valid = (RETENTION_CHOICES as readonly number[]).includes(hours)
    ? hours
    : DEFAULT_RETENTION_HOURS;
  await chrome.storage.local.set({ [RETENTION_KEY]: valid });
}
