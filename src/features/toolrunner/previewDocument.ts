import rawStylesheet from './preview.css?raw';

/**
 * THE PREVIEW'S STYLESHEET, and the reason it takes this route.
 *
 * MEASURED, against the real policy, in a real `sandbox=""` srcdoc frame:
 *
 *   inline <style> block, unhashed     blocked
 *   style="" attribute                 blocked
 *   <link> to this origin              blocked
 *   inline <style> block, hashed       RENDERS
 *   the same block with one byte
 *     changed                          blocked
 *
 * The first three are `style-src 'self'`: no `'unsafe-inline'` means no style
 * element and no style attribute, and a sandboxed frame has an OPAQUE ORIGIN,
 * so `'self'` matches nothing and even our own stylesheet cannot be fetched
 * into it. That is why the preview had no styling at all - not malformed
 * markup, not a missing rule, no stylesheet reaching it by any route.
 *
 * A hash is the way through, and it is not a weakening. `script-src` already
 * carries the hash of the theme bootstrap for the same reason; adding one to
 * `style-src` permits exactly one byte sequence and nothing else. The fifth
 * line above is the proof: change a byte and the browser refuses it.
 *
 * NORMALISED LINE ENDINGS on both sides. `vite/plugins/csp-hash.ts` hashes
 * this file from disk and this module imports it, and on a machine that checks
 * out CRLF those two byte sequences would differ - which would present as a
 * preview that is unstyled on Windows and fine everywhere else. Both sides
 * collapse CRLF first, so the hash is over a canonical form.
 */
export const PREVIEW_STYLESHEET = rawStylesheet.replace(/\r\n/g, '\n');

/**
 * Wraps sanitised HTML in a self-contained document for the preview frame.
 *
 * No `<html>` or `<head>`: the parser supplies both, and writing them would
 * only add bytes to something already inside an iframe. The charset is
 * declared because a `srcdoc` document inherits its parent's encoding in most
 * engines but not by specification, and the cost of saying so is one tag.
 */
export function previewDocument(html: string): string {
  return `<meta charset="utf-8"><style>${PREVIEW_STYLESHEET}</style>${html}`;
}
