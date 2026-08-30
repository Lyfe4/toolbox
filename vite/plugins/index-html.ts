import type { Plugin } from 'vite';

/**
 * Finalises the built index.html.
 *
 * Two jobs, both about what actually reaches a visitor:
 *
 *   1. Strip HTML comments. The source file explains itself at length - why
 *      the theme bootstrap is inline, what the icons are for, which tags are
 *      the static baseline. None of that is any use to a browser, and it
 *      shipped ~1.5 kB of internal source paths to every visitor on every
 *      uncached load. The explanations live in src/app/head.ts and
 *      vite/plugins/csp-hash.ts, where someone changing the behaviour will
 *      actually be reading.
 *
 *   2. Refuse to ship a broken absolute URL. index.html uses %VITE_SITE_URL%
 *      for og:url, og:image, twitter:image and the canonical link. If that
 *      variable is missing, Vite leaves the placeholder in place and the build
 *      would happily deploy `content="%VITE_SITE_URL%/social-preview.png"` -
 *      a card that silently fails to render, which nobody notices until
 *      someone shares a link. Failing the build is the only reliable moment to
 *      catch it.
 */

/** Directives that must survive: conditional comments are not decoration. */
const KEEP = ['[if ', '[endif]'];

/**
 * Removes HTML comments, leaving anything inside <script> or <style> alone.
 *
 * Scanning rather than a regex, because `<!--` is legal inside a script's text
 * content and stripping it there would corrupt the one inline script whose
 * bytes are hashed into the CSP.
 */
export function stripHtmlComments(html: string): string {
  let out = '';
  let cursor = 0;

  while (cursor < html.length) {
    // Skip over any raw-text element wholesale.
    const raw = nextRawTextElement(html, cursor);
    const comment = html.indexOf('<!--', cursor);

    if (comment === -1) {
      out += html.slice(cursor);
      break;
    }

    if (raw && raw.start < comment) {
      out += html.slice(cursor, raw.end);
      cursor = raw.end;
      continue;
    }

    const end = html.indexOf('-->', comment + 4);
    if (end === -1) {
      out += html.slice(cursor);
      break;
    }

    const body = html.slice(comment + 4, end);
    if (KEEP.some((marker) => body.includes(marker))) {
      out += html.slice(cursor, end + 3);
    } else {
      // Keep the text before it, and collapse the blank line it leaves behind.
      out += html.slice(cursor, comment).replace(/[ \t]+$/, '');
      let after = end + 3;
      if (html.startsWith('\r\n', after)) after += 2;
      else if (html.startsWith('\n', after)) after += 1;
      cursor = after;
      continue;
    }

    cursor = end + 3;
  }

  return out;
}

/** The next `<script>`/`<style>` element at or after `from`, as a span. */
function nextRawTextElement(html: string, from: number): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null;

  for (const tag of ['script', 'style']) {
    const open = html.toLowerCase().indexOf(`<${tag}`, from);
    if (open === -1) continue;
    const close = html.toLowerCase().indexOf(`</${tag}>`, open);
    const end = close === -1 ? html.length : close + tag.length + 3;
    if (!best || open < best.start) best = { start: open, end };
  }

  return best;
}

export function indexHtml(): Plugin {
  return {
    name: 'patchbay:index-html',
    apply: 'build',

    transformIndexHtml: {
      // After Vite's own processing, so %VITE_SITE_URL% has been substituted
      // and the asset tags are in place - this sees the final markup.
      order: 'post',
      handler(html) {
        const leftover = /%VITE_[A-Z0-9_]+%/.exec(html);
        if (leftover) {
          throw new Error(
            `index-html: ${leftover[0]} was not substituted. Set it in .env or the deploy environment.`,
          );
        }

        for (const [label, pattern] of [
          ['og:image', /<meta[^>]+property="og:image"[^>]+content="([^"]*)"/],
          ['og:url', /<meta[^>]+property="og:url"[^>]+content="([^"]*)"/],
          ['canonical', /<link[^>]+rel="canonical"[^>]+href="([^"]*)"/],
        ] as const) {
          const value = pattern.exec(html)?.[1];
          if (value === undefined) throw new Error(`index-html: no ${label} tag in index.html`);
          if (!value.startsWith('https://')) {
            throw new Error(`index-html: ${label} must be an absolute https URL, got "${value}"`);
          }
        }

        return stripHtmlComments(html);
      },
    },
  };
}
