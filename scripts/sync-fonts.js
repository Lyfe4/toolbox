/**
 * Copies the exact font files we use out of the Fontsource packages and into
 * `public/fonts/`, then reports their sizes.
 *
 * Why copy instead of importing the Fontsource CSS directly? Two reasons:
 *   1. Preloading needs a stable, unhashed URL that can be written into
 *      index.html by hand. Bundled assets get content hashes we cannot predict.
 *   2. It makes the exact subset and weights we ship explicit and reviewable,
 *      rather than whatever the package's index.css happens to pull in.
 *
 * Run with `pnpm fonts:sync` after upgrading either font package.
 */
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'public', 'fonts');

/** Each entry is [source package path, destination filename]. */
const FILES = [
  [
    '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2',
    'ibm-plex-mono-400.woff2',
  ],
  [
    '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2',
    'ibm-plex-mono-500.woff2',
  ],
  [
    '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2',
    'ibm-plex-mono-600.woff2',
  ],
  ['@fontsource-variable/archivo/files/archivo-latin-wght-normal.woff2', 'archivo-variable.woff2'],
];

mkdirSync(outDir, { recursive: true });

let total = 0;
for (const [from, to] of FILES) {
  const src = join(repoRoot, 'node_modules', from);
  const dest = join(outDir, to);
  copyFileSync(src, dest);
  const { size } = statSync(dest);
  total += size;
  console.warn(`  ${to.padEnd(28)} ${(size / 1024).toFixed(1)} kB`);
}
console.warn(`  ${'total'.padEnd(28)} ${(total / 1024).toFixed(1)} kB`);
