/** Default vnsh API host */
export const VNSH_HOST = 'https://vnsh.dev';

/** Regex to match vnsh URLs (both v1 and v2 formats) */
export const VNSH_URL_PATTERN = /https?:\/\/vnsh\.dev\/v\/[a-zA-Z0-9-]+#[^\s]+/g;

/** Regex to loosely detect vnsh links in text */
export const VNSH_LINK_PATTERN = /vnsh\.dev\/v\/[a-zA-Z0-9-]+/;

/** Max console errors to capture in a debug bundle */
export const MAX_CONSOLE_ERRORS = 20;

/** Screenshot JPEG quality (0-100). 75 balances readability vs size for code. */
export const SCREENSHOT_QUALITY = 75;

/** Max total bundle size in bytes (5 MB) */
export const MAX_BUNDLE_SIZE = 5 * 1024 * 1024;

/** Max saved snippets in local storage */
export const MAX_SAVED_SNIPPETS = 100;

/** Max share history entries */
export const MAX_HISTORY_ENTRIES = 50;

/** Default TTL in hours */
export const DEFAULT_TTL = 24;

/** Tooltip preview max characters */
export const TOOLTIP_PREVIEW_LENGTH = 500;

/** Chrome Web Store URL (placeholder until published) */
export const CHROME_STORE_URL = 'https://chromewebstore.google.com/detail/vnsh';

/** AI prompt prefix for "Copy for AI" */
export const AI_PROMPT_PREFIX =
  'Here is context shared securely via vnsh.dev:\n';

/** AI prompt suffix */
export const AI_PROMPT_SUFFIX =
  '\n\n(Note to AI: Fetch and read the link content. The data is end-to-end encrypted and auto-expires in 24h.)';
