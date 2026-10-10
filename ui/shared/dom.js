'use strict';

/**
 * ui/shared/dom.js
 * Escaping helpers shared by the config and dashboard pages.
 *
 * Both pages build markup with template literals and assign it through
 * innerHTML. Everything interpolated into that markup originates outside this
 * app: job titles, company names and apply URLs come from Jobright and from
 * third-party ATS boards, and config values come from whatever the user typed.
 * None of it is trustworthy, so it all goes through escHtml() or safeUrl().
 *
 * Loaded as a classic script before each page's own <script>, so these are
 * plain globals.
 */

/**
 * Escape a value for insertion into HTML text or a quoted attribute.
 * Single quotes are escaped too, because the pages use both '...' and "..."
 * for attributes and for inline handler arguments.
 */
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Return url only if it is a plain http(s) link, otherwise ''.
 *
 * Apply links are scraped, so the scheme cannot be assumed. A javascript: or
 * data: URL placed in an href would run in this page's context, which is where
 * window.electronAPI lives. Anything that is not http(s) is dropped rather than
 * rewritten, and the caller renders a placeholder instead.
 *
 * The result must still be passed through escHtml() before it reaches an
 * attribute: this check is about the scheme, not about quoting.
 */
function safeUrl(url) {
  if (!url) return '';
  let parsed;
  try {
    parsed = new URL(String(url), 'about:blank');
  } catch {
    return '';
  }
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : '';
}
