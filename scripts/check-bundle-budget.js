/**
 * Fails the build when the initial JavaScript payload grows past its budget.
 *
 * "Initial" means what the browser must download before it can render the first
 * route: the entry module plus every chunk index.html tells it to preload. Code
 * behind a dynamic import - a lazy route, a tool - is deliberately not counted,
 * because that is the whole point of splitting it out.
 *
 * Run with `pnpm bundle:check` after a build. CI runs it too.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

/**
 * Raw (uncompressed) byte ceiling for the initial JS.
 *
 * Set from the measured value at the time of writing plus modest headroom -
 * enough that ordinary feature work does not trip it, tight enough that
 * accidentally pulling a tool or a heavy dependency into the entry chunk does.
 * Raise it deliberately, in a commit that says why.
 */
// Measured at 344.6 kB raw / 112.4 kB gzipped when this was written.
// 380 kB is roughly 10% headroom.
const BUDGET_BYTES = 380 * 1024;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'dist');

/** Pulls every URL the initial document loads eagerly out of index.html. */
function initialScriptUrls(html) {
  const urls = new Set();
  let cursor = 0;

  for (;;) {
    const tagStart = html.indexOf('<', cursor);
    if (tagStart === -1) break;
    const tagEnd = html.indexOf('>', tagStart);
    if (tagEnd === -1) break;

    const tag = html.slice(tagStart, tagEnd + 1);
    cursor = tagEnd + 1;

    const isEntryScript = tag.startsWith('<script') && tag.includes('type="module"');
    const isPreload = tag.startsWith('<link') && tag.includes('rel="modulepreload"');
    if (!isEntryScript && !isPreload) continue;

    const attribute = isEntryScript ? 'src="' : 'href="';
    const valueStart = tag.indexOf(attribute);
    if (valueStart === -1) continue;

    const from = valueStart + attribute.length;
    const to = tag.indexOf('"', from);
    if (to === -1) continue;

    const url = tag.slice(from, to);
    if (url.endsWith('.js')) urls.add(url);
  }

  return [...urls];
}

const html = readFileSync(join(distDir, 'index.html'), 'utf8');
const urls = initialScriptUrls(html);

if (urls.length === 0) {
  console.error('bundle-budget: found no initial scripts in dist/index.html');
  process.exit(1);
}

let totalRaw = 0;
let totalGzip = 0;
const rows = [];

for (const url of urls.toSorted()) {
  const file = join(distDir, url.replace(/^\//, ''));
  const raw = statSync(file).size;
  const gzip = gzipSync(readFileSync(file)).length;
  totalRaw += raw;
  totalGzip += gzip;
  rows.push([url, raw, gzip]);
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;

console.warn('Initial JavaScript payload:');
for (const [url, raw, gzip] of rows) {
  console.warn(`  ${url.padEnd(44)} ${kb(raw).padStart(10)}  ${kb(gzip).padStart(10)} gz`);
}
console.warn(
  `  ${'TOTAL'.padEnd(44)} ${kb(totalRaw).padStart(10)}  ${kb(totalGzip).padStart(10)} gz`,
);
console.warn(`  ${'BUDGET'.padEnd(44)} ${kb(BUDGET_BYTES).padStart(10)}`);

if (totalRaw > BUDGET_BYTES) {
  console.error(
    `\nbundle-budget: FAIL - initial JS is ${kb(totalRaw)}, over the ${kb(BUDGET_BYTES)} budget by ${kb(totalRaw - BUDGET_BYTES)}.`,
  );
  console.error(
    'Either move the new code behind a dynamic import, or raise the budget on purpose.',
  );
  process.exit(1);
}

console.warn(`\nbundle-budget: OK - ${kb(BUDGET_BYTES - totalRaw)} of headroom left.`);
