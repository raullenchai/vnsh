import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock chrome.storage.local
const store: Record<string, any> = {};
const mockStorage = {
  get: vi.fn(async (key: string) => ({ [key]: store[key] })),
  set: vi.fn(async (items: Record<string, any>) => {
    Object.assign(store, items);
  }),
};

vi.stubGlobal('chrome', {
  storage: { local: mockStorage },
});

import {
  getHistory,
  addToHistory,
  pruneExpiredHistory,
  getSnippets,
  saveSnippet,
  deleteSnippet,
  generateSnippetId,
} from '../src/lib/storage';
import type { ShareRecord, SavedSnippet } from '../src/lib/storage';

beforeEach(() => {
  // Clear store
  for (const key of Object.keys(store)) {
    delete store[key];
  }
  mockStorage.get.mockClear();
  mockStorage.set.mockClear();
});

describe('history', () => {
  it('returns empty array when no history', async () => {
    const result = await getHistory();
    expect(result).toEqual([]);
  });

  it('adds a record to history', async () => {
    const record: ShareRecord = {
      url: 'https://vnsh.dev/v/abc#key',
      label: 'Test share',
      type: 'text',
      sharedAt: '2026-02-14T00:00:00Z',
    };

    await addToHistory(record);
    const history = await getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].label).toBe('Test share');
  });

  it('prepends new records (newest first)', async () => {
    await addToHistory({
      url: 'https://vnsh.dev/v/a#k', label: 'First', type: 'text', sharedAt: '2026-02-14T01:00:00Z',
    });
    await addToHistory({
      url: 'https://vnsh.dev/v/b#k', label: 'Second', type: 'text', sharedAt: '2026-02-14T02:00:00Z',
    });

    const history = await getHistory();
    expect(history[0].label).toBe('Second');
    expect(history[1].label).toBe('First');
  });

  it('trims history to MAX_HISTORY_ENTRIES', async () => {
    // Fill with 50 entries (the max)
    for (let i = 0; i < 50; i++) {
      await addToHistory({
        url: `https://vnsh.dev/v/${i}#k`, label: `Entry ${i}`, type: 'text', sharedAt: new Date().toISOString(),
      });
    }
    // Add one more
    await addToHistory({
      url: 'https://vnsh.dev/v/overflow#k', label: 'Overflow', type: 'text', sharedAt: new Date().toISOString(),
    });

    const history = await getHistory();
    expect(history.length).toBeLessThanOrEqual(50);
    expect(history[0].label).toBe('Overflow');
  });

  it('prunes expired entries', async () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    const future = new Date(Date.now() + 86400000).toISOString();

    store.vnsh_history = [
      { url: 'a', label: 'Expired', type: 'text', sharedAt: past, expiresAt: past },
      { url: 'b', label: 'Active', type: 'text', sharedAt: past, expiresAt: future },
      { url: 'c', label: 'No expiry', type: 'text', sharedAt: past },
    ];

    await pruneExpiredHistory();

    const history = await getHistory();
    expect(history).toHaveLength(2);
    expect(history.map((h: ShareRecord) => h.label)).toEqual(['Active', 'No expiry']);
  });

  it('skips set when nothing to prune', async () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    store.vnsh_history = [
      { url: 'a', label: 'Active', type: 'text', sharedAt: future, expiresAt: future },
    ];

    mockStorage.set.mockClear();
    await pruneExpiredHistory();
    expect(mockStorage.set).not.toHaveBeenCalled();
  });
});

describe('snippets', () => {
  it('returns empty array when no snippets', async () => {
    const result = await getSnippets();
    expect(result).toEqual([]);
  });

  it('saves and retrieves a snippet', async () => {
    const snippet: SavedSnippet = {
      id: 'test-1',
      content: 'console.log("hello")',
      label: 'console.log("hello")',
      savedAt: '2026-02-14T00:00:00Z',
    };

    await saveSnippet(snippet);
    const snippets = await getSnippets();
    expect(snippets).toHaveLength(1);
    expect(snippets[0].content).toBe('console.log("hello")');
  });

  it('deletes a snippet by id', async () => {
    store.vnsh_snippets = [
      { id: 'keep', content: 'a', label: 'a', savedAt: '' },
      { id: 'delete-me', content: 'b', label: 'b', savedAt: '' },
    ];

    await deleteSnippet('delete-me');
    const snippets = await getSnippets();
    expect(snippets).toHaveLength(1);
    expect(snippets[0].id).toBe('keep');
  });
});

describe('generateSnippetId', () => {
  it('returns a non-empty string', () => {
    const id = generateSnippetId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSnippetId()));
    expect(ids.size).toBe(100);
  });
});
