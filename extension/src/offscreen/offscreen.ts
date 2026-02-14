/**
 * Offscreen document for clipboard operations.
 * Used as fallback when executeScript can't run in the active tab
 * (e.g., chrome:// pages, PDF viewer, etc.)
 */

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'offscreen-copy' && message.text) {
    const textarea = document.getElementById('clipboard-area') as HTMLTextAreaElement;
    textarea.value = message.text;
    textarea.select();
    document.execCommand('copy');
  }
});
