import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Plugin } from 'vite';

/**
 * Token in public/_headers that gets replaced with the real hashes at build
 * time. It is deliberately not a valid CSP source, so a build that skipped
 * this plugin produces an obviously broken policy rather than a quietly
 * permissive one.
 */
const SCRIPT_PLACEHOLDER = '{{INLINE_SCRIPT_HASHES}}';

/**
 * The same, for `style-src`.
 *
 * The preview frame needs a stylesheet and cannot fetch one: it is sandboxed
 * to an opaque origin, so `'self'` matches nothing inside it. A hash lets
 * exactly one stylesheet through and nothing else - measured, including that
 * a single changed byte is refused. See src/features/toolrunner/
 * previewDocument.ts.
 */
const STYLE_PLACEHOLDER = '{{INLINE_STYLE_HASHES}}';

/** The one stylesheet that hash covers. */
const PREVIEW_STYLESHEET = 'src/features/toolrunner/preview.css';

const sha256 = (body: string): string =>
  `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;

/** Extracts the bodies of every inline <script> (i.e. those without a src). */
function inlineScriptBodies(html: string): string[] {
  const bodies: string[] = [];
  let cursor = 0;

  for (;;) {
    const open = html.indexOf('<script', cursor);
    if (open === -1) break;
    const tagEnd = html.indexOf('>', open);
    if (tagEnd === -1) break;
    const close = html.indexOf('</script>', tagEnd);
    if (close === -1) break;

    const tag = html.slice(open, tagEnd + 1);
    if (!tag.includes(' src=')) bodies.push(html.slice(tagEnd + 1, close));
    cursor = close + '</script>'.length;
  }

  return bodies;
}

/**
 * Computes CSP hashes for the inline scripts in the built index.html and
 * writes them into the emitted _headers file.
 *
 * Hashing the BUILT html rather than the source is what makes this reliable:
 * whatever transformations Vite applies, the hash is taken from the exact
 * bytes the browser will execute.
 */
export function cspHash(): Plugin {
  let outDir = 'dist';
  let root = process.cwd();

  return {
    name: 'patchbay:csp-hash',
    apply: 'build',

    configResolved(config) {
      outDir = config.build.outDir;
      root = config.root;
    },

    closeBundle() {
      const htmlPath = join(root, outDir, 'index.html');
      const headersPath = join(root, outDir, '_headers');

      if (!existsSync(htmlPath) || !existsSync(headersPath)) {
        throw new Error('csp-hash: expected both index.html and _headers in the build output');
      }

      const html = readFileSync(htmlPath, 'utf8');
      const headers = readFileSync(headersPath, 'utf8');

      for (const placeholder of [SCRIPT_PLACEHOLDER, STYLE_PLACEHOLDER]) {
        if (!headers.includes(placeholder)) {
          throw new Error(`csp-hash: ${placeholder} is missing from public/_headers`);
        }
      }

      const scriptHashes = inlineScriptBodies(html).map(sha256);

      /*
       * The stylesheet is hashed FROM SOURCE, not from the build output,
       * because it never becomes a file: it is imported as a string and
       * written into the frame's srcdoc at runtime. Line endings are
       * normalised here and in previewDocument.ts, so a CRLF checkout cannot
       * produce a hash the browser will not match.
       */
      const stylesheetPath = join(root, PREVIEW_STYLESHEET);
      if (!existsSync(stylesheetPath)) {
        throw new Error(`csp-hash: ${PREVIEW_STYLESHEET} is missing`);
      }
      const canonical = readFileSync(stylesheetPath, 'utf8').replace(/\r\n/g, '\n');
      const styleHashes = [sha256(canonical)];

      // replaceAll, not replace: the placeholders are also named in the file's
      // own comment block, and every occurrence must be substituted.
      writeFileSync(
        headersPath,
        headers
          .replaceAll(SCRIPT_PLACEHOLDER, scriptHashes.join(' '))
          .replaceAll(STYLE_PLACEHOLDER, styleHashes.join(' ')),
        'utf8',
      );
      this.info(
        `csp-hash: injected ${scriptHashes.length.toString()} script and ${styleHashes.length.toString()} style hash(es)`,
      );
    },
  };
}
