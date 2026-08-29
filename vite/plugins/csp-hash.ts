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
const PLACEHOLDER = '{{INLINE_SCRIPT_HASHES}}';

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

      if (!headers.includes(PLACEHOLDER)) {
        throw new Error(`csp-hash: ${PLACEHOLDER} is missing from public/_headers`);
      }

      const hashes = inlineScriptBodies(html).map(
        (body) => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`,
      );

      // replaceAll, not replace: the placeholder is also named in the file's
      // own comment block, and both occurrences must be substituted.
      writeFileSync(headersPath, headers.replaceAll(PLACEHOLDER, hashes.join(' ')), 'utf8');
      this.info(`csp-hash: injected ${hashes.length.toString()} inline script hash(es)`);
    },
  };
}
