import { describe, it, expect } from 'vitest';
import {
  buildBundle,
  isDebugBundle,
  parseBundle,
  type BundleInput,
} from '../src/lib/bundle';

describe('buildBundle', () => {
  it('creates a valid debug bundle JSON', () => {
    const input: BundleInput = {
      url: 'https://example.com/app',
      title: 'My App',
      selectedText: 'TypeError: null is not an object',
      consoleErrors: [
        { message: 'Uncaught TypeError: null', source: 'app.js:42', timestamp: 1000 },
      ],
      userNote: 'Happens on click',
    };

    const json = buildBundle(input);
    const parsed = JSON.parse(json);

    expect(parsed.version).toBe(1);
    expect(parsed.type).toBe('debug-bundle');
    expect(parsed.url).toBe('https://example.com/app');
    expect(parsed.title).toBe('My App');
    expect(parsed.selected_text).toBe('TypeError: null is not an object');
    expect(parsed.console_errors).toHaveLength(1);
    expect(parsed.user_note).toBe('Happens on click');
    expect(parsed.timestamp).toBeDefined();
  });

  it('omits optional fields when not provided', () => {
    const input: BundleInput = {
      url: 'https://example.com',
      title: 'Page',
    };

    const json = buildBundle(input);
    const parsed = JSON.parse(json);

    expect(parsed.selected_text).toBeUndefined();
    expect(parsed.screenshot_base64).toBeUndefined();
    expect(parsed.user_note).toBeUndefined();
    expect(parsed.console_errors).toEqual([]);
  });

  it('limits console errors to MAX_CONSOLE_ERRORS', () => {
    const errors = Array.from({ length: 30 }, (_, i) => ({
      message: `Error ${i}`,
      timestamp: i,
    }));

    const input: BundleInput = {
      url: 'https://example.com',
      title: 'Page',
      consoleErrors: errors,
    };

    const json = buildBundle(input);
    const parsed = JSON.parse(json);
    expect(parsed.console_errors.length).toBeLessThanOrEqual(20);
  });
});

describe('isDebugBundle', () => {
  it('returns true for valid bundle JSON', () => {
    const json = JSON.stringify({ version: 1, type: 'debug-bundle' });
    expect(isDebugBundle(json)).toBe(true);
  });

  it('returns false for non-bundle JSON', () => {
    expect(isDebugBundle('{"foo":"bar"}')).toBe(false);
    expect(isDebugBundle('not json')).toBe(false);
    expect(isDebugBundle('')).toBe(false);
  });
});

describe('parseBundle', () => {
  it('parses a valid bundle', () => {
    const bundle = {
      version: 1,
      type: 'debug-bundle',
      timestamp: '2026-01-01T00:00:00Z',
      url: 'https://example.com',
      title: 'Test',
      console_errors: [],
    };

    const parsed = parseBundle(JSON.stringify(bundle));
    expect(parsed.type).toBe('debug-bundle');
    expect(parsed.url).toBe('https://example.com');
  });

  it('throws on invalid bundle', () => {
    expect(() => parseBundle('{"type":"other"}')).toThrow('Not a valid debug bundle');
  });
});
