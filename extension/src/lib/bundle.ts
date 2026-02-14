/**
 * AI Debug Bundle — packages page context into a structured JSON payload.
 *
 * Bundle format:
 * {
 *   version: 1,
 *   type: "debug-bundle",
 *   timestamp: ISO string,
 *   url: current page URL,
 *   title: page title,
 *   selected_text: user selection,
 *   console_errors: [{ message, source, timestamp }],
 *   screenshot_base64: JPEG data URI (optional),
 *   user_note: user-provided note (optional)
 * }
 */

import { MAX_BUNDLE_SIZE, MAX_CONSOLE_ERRORS } from './constants';

export interface ConsoleError {
  message: string;
  source?: string;
  timestamp: number;
}

export interface DebugBundle {
  version: 1;
  type: 'debug-bundle';
  timestamp: string;
  url: string;
  title: string;
  selected_text?: string;
  console_errors: ConsoleError[];
  screenshot_base64?: string;
  user_note?: string;
}

export interface BundleInput {
  url: string;
  title: string;
  selectedText?: string;
  consoleErrors?: ConsoleError[];
  screenshotDataUrl?: string;
  userNote?: string;
}

/**
 * Build a debug bundle JSON string from collected inputs.
 * Truncates data if necessary to stay under MAX_BUNDLE_SIZE.
 */
export function buildBundle(input: BundleInput): string {
  const bundle: DebugBundle = {
    version: 1,
    type: 'debug-bundle',
    timestamp: new Date().toISOString(),
    url: input.url,
    title: input.title,
    console_errors: (input.consoleErrors || []).slice(
      0,
      MAX_CONSOLE_ERRORS,
    ),
  };

  if (input.selectedText) {
    bundle.selected_text = input.selectedText;
  }

  if (input.screenshotDataUrl) {
    bundle.screenshot_base64 = input.screenshotDataUrl;
  }

  if (input.userNote) {
    bundle.user_note = input.userNote;
  }

  let json = JSON.stringify(bundle, null, 2);

  // Progressively reduce size if over limit:
  // 1. Drop screenshot (largest component)
  if (json.length > MAX_BUNDLE_SIZE && bundle.screenshot_base64) {
    bundle.screenshot_base64 = undefined;
    json = JSON.stringify(bundle, null, 2);
  }

  // 2. Truncate to 5 console errors
  if (json.length > MAX_BUNDLE_SIZE && bundle.console_errors.length > 5) {
    bundle.console_errors = bundle.console_errors.slice(0, 5);
    json = JSON.stringify(bundle, null, 2);
  }

  // 3. Minify JSON (drop pretty-printing)
  if (json.length > MAX_BUNDLE_SIZE) {
    json = JSON.stringify(bundle);
  }

  // 4. Truncate selected_text as last resort
  if (json.length > MAX_BUNDLE_SIZE && bundle.selected_text) {
    bundle.selected_text = bundle.selected_text.slice(0, 2000) + '... (truncated)';
    json = JSON.stringify(bundle);
  }

  return json;
}

/**
 * Check if decrypted content is a debug bundle.
 */
export function isDebugBundle(text: string): boolean {
  try {
    const obj = JSON.parse(text);
    return obj.type === 'debug-bundle' && obj.version === 1;
  } catch {
    return false;
  }
}

/**
 * Parse a debug bundle from decrypted text.
 */
export function parseBundle(text: string): DebugBundle {
  const obj = JSON.parse(text);
  if (obj.type !== 'debug-bundle' || obj.version !== 1) {
    throw new Error('Not a valid debug bundle');
  }
  return obj as DebugBundle;
}
