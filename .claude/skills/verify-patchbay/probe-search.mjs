/**
 * Does the /tools search actually match names, summaries, categories AND
 * keywords?
 *
 * The mapped `tools-index` drive proves one query ("sha") and clearing. The
 * feature map claims four match sources, so this closes the other three.
 *
 * THE ORACLE IS THE MANIFEST, not the page. `src/features/registry/manifest.ts`
 * is the source data the index is built from; for a given query this file works
 * out which tools contain it in their name, summary, category or keywords, and
 * the page is required to return exactly that set. That is the product's stated
 * contract ("Matches names, summaries, categories and keywords" - the Search
 * field's own description), so checking against it is a proof rather than a
 * restatement of whatever the page happens to do. Until round seventeen both
 * this oracle and that description left the category out, and `searchTools`
 * has read it since the first commit - so the oracle agreed with the sentence
 * and not with the code, and a query like `data` would have shown it.
 *
 *   node .claude/skills/verify-patchbay/probe-search.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SKILL_DIR,
  openBrowser,
  gotoPage,
  evidenceDir,
  log,
  shot,
  artefact,
  makeChecker,
  partitionConsoleErrors,
} from './harness.mjs';

/* -- The oracle ------------------------------------------------------------ */

const MANIFEST = join(SKILL_DIR, '..', '..', '..', 'src', 'features', 'registry', 'manifest.ts');
const source = readFileSync(MANIFEST, 'utf8');
const body = source.slice(source.indexOf('export const TOOL_MANIFEST'));
const entryRe =
  /\n {4}id: '([^']+)',\n {4}name: '([^']+)',\n {4}summary: '([^']+)',\n {4}category: '([^']+)',\n {4}keywords: \[([^\]]*)\]/g;

const TOOLS = [];
for (let m = entryRe.exec(body); m !== null; m = entryRe.exec(body)) {
  TOOLS.push({
    id: m[1],
    name: m[2],
    summary: m[3],
    category: m[4],
    keywords: m[5]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean),
  });
}

if (TOOLS.length !== 10) {
  /* A silently-empty oracle would make every check below pass vacuously. */
  throw new Error(`probe-search: parsed ${String(TOOLS.length)} manifest entries, expected 10`);
}

/** Which tools a query should return, and via which field. */
function expected(query) {
  const q = query.toLowerCase();
  return TOOLS.filter(
    (t) =>
      t.name.toLowerCase().includes(q) ||
      t.summary.toLowerCase().includes(q) ||
      t.category.includes(q) ||
      t.keywords.some((k) => k.toLowerCase().includes(q)),
  ).map((t) => t.id);
}

function via(query) {
  const q = query.toLowerCase();
  const sources = new Set();
  for (const t of TOOLS) {
    if (t.name.toLowerCase().includes(q)) sources.add('name');
    if (t.summary.toLowerCase().includes(q)) sources.add('summary');
    if (t.category.includes(q)) sources.add('category');
    if (t.keywords.some((k) => k.toLowerCase().includes(q))) sources.add('keyword');
  }
  return [...sources].join('+') || 'nothing';
}

/*
 * Chosen so each match source is exercised in ISOLATION where possible - a
 * query that hits a tool by both name and keyword cannot tell you the keyword
 * path works. Verified isolating before being written down here.
 */
const QUERIES = [
  { q: 'structured', why: 'name only' },
  { q: 'highlighting', why: 'summary only - the word is in no name and no keyword' },
  { q: 'repackage', why: 'summary only' },
  { q: 'checksum', why: 'keyword only' },
  {
    q: 'hashing',
    why: 'category only - searchTools reads the category, which this oracle did not until round seventeen',
  },
  { q: 'jwt', why: 'keyword reaches a tool whose name and summary never say it (base64)' },
  { q: 'convert', why: 'multi-match across four tools' },
  { q: 'SHA', why: 'case-insensitivity - same set as lowercase sha' },
  { q: 'zzznope', why: 'no match at all' },
];

/* -- The drive ------------------------------------------------------------- */

const dir = evidenceDir('search');
const check = makeChecker(dir);
log(dir, `search probe - oracle built from ${String(TOOLS.length)} manifest entries`);

const { browser, page, consoleErrors } = await openBrowser();
const readings = [];

try {
  await gotoPage(page, '/tools');
  await page.getByRole('heading', { level: 1, name: 'Every tool' }).waitFor({ timeout: 20_000 });

  const search = page.getByLabel('Search');

  const shown = async () =>
    (
      await page
        .locator('a[href^="/tools/"]')
        .evaluateAll((els) => [...new Set(els.map((el) => el.getAttribute('href')))])
    )
      .map((href) => href.replace('/tools/', ''))
      .sort();

  const baseline = await shown();
  check('the unfiltered index shows all ten tools', baseline.length === 10, baseline.join(' '));

  for (const { q, why } of QUERIES) {
    await search.fill(q);
    /* Search is debounced in the UI; assert after the pause, not synchronously. */
    await page.waitForTimeout(300);

    const got = await shown();
    const want = expected(q).sort();
    const count = (await page.getByTestId('tool-count').textContent())?.trim() ?? '';

    readings.push({ query: q, why, via: via(q), want, got, count });

    check(
      `"${q}" (${why}) returns exactly the tools the manifest says it should`,
      JSON.stringify(got) === JSON.stringify(want),
      `via ${via(q)} - want [${want.join(' ')}] got [${got.join(' ')}] - ${count}`,
    );

    if (q === 'highlighting' || q === 'jwt' || q === 'zzznope') await shot(page, dir, `q-${q}`);
  }

  /* -- Case-insensitivity, stated as a relation rather than two separate sets */
  await search.fill('sha');
  await page.waitForTimeout(300);
  const lower = await shown();
  const upper = readings.find((r) => r.query === 'SHA')?.got ?? [];
  check(
    'upper and lower case of the same query return the same set',
    JSON.stringify(lower) === JSON.stringify(upper),
    `sha [${lower.join(' ')}] vs SHA [${upper.join(' ')}]`,
  );

  /*
   * -- The positive partner to the zero-match case -------------------------
   * "zzznope shows nothing" passes just as happily on a search box that has
   * wedged itself empty. Clearing has to bring everything back.
   */
  await search.fill('zzznope');
  await page.waitForTimeout(300);
  const empty = await shown();
  const emptyCount = (await page.getByTestId('tool-count').textContent())?.trim() ?? '';
  check('a no-match query empties the list', empty.length === 0, emptyCount);

  await search.fill('');
  await page.waitForTimeout(300);
  const restored = await shown();
  await shot(page, dir, 'restored');
  check(
    'and clearing it brings all ten back, so the empty state is recoverable',
    restored.length === 10 && JSON.stringify(restored) === JSON.stringify(baseline),
    restored.join(' '),
  );

  const { known, unexpected } = partitionConsoleErrors(consoleErrors);
  if (known.length > 0) {
    log(dir, `  --   ${String(known.length)} known console error(s) tolerated`);
  }
  check(
    'no unexpected console errors',
    unexpected.length === 0,
    unexpected.join(' | ').slice(0, 200),
  );

  artefact(dir, 'search', { baseline, readings, lower, upper, empty, emptyCount, restored });
} catch (error) {
  check('the probe ran to completion', false, String(error).split('\n')[0]);
  try {
    await shot(page, dir, 'failure');
  } catch {
    /* page may be gone; the log has the error */
  }
} finally {
  await browser.close();
}

const failed = check.failed();
log(
  dir,
  failed.length === 0
    ? `\nSEARCH OK - evidence in ${dir}`
    : `\nSEARCH FAILED (${String(failed.length)}) - evidence in ${dir}`,
);
process.exit(failed.length === 0 ? 0 : 1);
