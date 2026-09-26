/**
 * Shared Playwright harness for verifying the DEPLOYED Patchbay site.
 *
 * Imported by `doctor.mjs`, `drive.mjs` and `probe-search.mjs`, and importable from any one-off
 * script you write next to them. Playwright resolves out of the repo root
 * `node_modules` (Node walks up from this file), so there is nothing to
 * install as long as `pnpm install` has been run.
 *
 * NOTHING HERE WRITES TO THE LIVE SITE, and that is a property of the site
 * rather than a promise made by this file: `public/_headers` ships
 * `connect-src 'none'` and `form-action 'none'`, so application code cannot
 * issue a fetch, an XHR, a WebSocket or a form submission at all. Every piece
 * of state a drive creates (the saved graph, the cold-open flag, the chosen
 * theme) lives in localStorage inside a Playwright context that is thrown away
 * when the run ends.
 */
import {
  mkdirSync,
  appendFileSync,
  readdirSync,
  readFileSync,
  existsSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, firefox, webkit } from 'playwright';

/** This skill's own directory - where all evidence lands. */
export const SKILL_DIR = fileURLToPath(new URL('.', import.meta.url));

/**
 * The target. Overridable so a branch preview or a Netlify deploy-preview URL
 * can be driven without editing anything; it defaults to production because
 * that is the thing anybody asking "does the site work" means.
 */
export const ORIGIN = (process.env.PATCHBAY_ORIGIN ?? 'https://patchbay-tools.netlify.app').replace(
  /\/$/,
  '',
);

const ENGINES = { chromium, firefox, webkit };

/**
 * THE TOOLS THE WORKING TREE SAYS EXIST, from `src/features/registry/manifest.ts`.
 *
 * What a drive compares the live page with - never a number written here.
 * Both probes used to assert `=== 10`, and an eleventh tool broke each of them
 * in the worst direction: failing against the site that had deployed it and
 * PASSING against a stale deploy that had not. Comparing the SET of ids with
 * the manifest is the claim those counts were standing in for, needs no edit
 * when a tool is added, and fails on a deploy that is missing one by naming it.
 *
 * The manifest is TypeScript and this is plain Node, so it is read by a
 * pattern, and a pattern that silently matched nothing would make every
 * comparison against it vacuous. So the parse is checked against a second,
 * independent account - each directory under `src/tools/` with an `index.ts` -
 * and throws unless the two agree exactly. That replaces a guard that said
 * `TOOLS.length !== 10`, which fired on every new tool and caught nothing else.
 */
export function manifestTools() {
  const root = join(SKILL_DIR, '..', '..', '..');
  const source = readFileSync(join(root, 'src', 'features', 'registry', 'manifest.ts'), 'utf8');
  const body = source.slice(source.indexOf('export const TOOL_MANIFEST'));
  const entryRe =
    /\n {4}id: '([^']+)',\n {4}name: '([^']+)',\n {4}summary: '([^']+)',\n {4}category: '([^']+)',\n {4}keywords: \[([^\]]*)\]/g;

  const tools = [];
  for (let m = entryRe.exec(body); m !== null; m = entryRe.exec(body)) {
    tools.push({
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

  const onDisk = readdirSync(join(root, 'src', 'tools'), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(join(root, 'src', 'tools', entry.name, 'index.ts')),
    )
    .map((entry) => entry.name)
    .sort();
  const parsed = tools.map((tool) => tool.id).sort();
  if (JSON.stringify(parsed) !== JSON.stringify(onDisk)) {
    throw new Error(
      `manifestTools: the manifest parsed as [${parsed.join(', ')}] but src/tools holds [${onDisk.join(', ')}] - fix the pattern before trusting any comparison against it`,
    );
  }
  return tools;
}

/** Ids the page lacks and ids it has that the manifest does not, for a check's detail. */
export function compareWithManifest(hrefs, tools = manifestTools()) {
  const shown = new Set(hrefs.map((href) => href.replace(/^\/tools\//, '')));
  const wanted = new Set(tools.map((tool) => tool.id));
  const missing = [...wanted].filter((id) => !shown.has(id));
  const extra = [...shown].filter((id) => !wanted.has(id));
  return {
    same: missing.length === 0 && extra.length === 0,
    detail: `${String(shown.size)} cards; missing [${missing.join(' ')}], not in the manifest [${extra.join(' ')}]`,
  };
}

/**
 * Console errors that are a known, pre-existing property of the deployed site
 * rather than a fault this run found.
 *
 * NAMED AND NARROW ON PURPOSE. A console check that fails on something every
 * run hits teaches the next reader to ignore console failures, which is worse
 * than not checking. A blanket filter would do the same thing silently. So
 * each entry here is one specific message with a note on why it is tolerated
 * and what would make it stop being tolerated.
 *
 * EMPTY, AND AN ENTRY HERE NEEDS A MEASUREMENT, NOT A LOOK.
 *
 * It held one entry, `radix-inline-style`, matching every "Applying inline
 * style violates" line. The note beside it said the refused styles were the
 * Select popover's collision avoidance, verified harmless at 1440x900 and
 * likely to put the list off-screen at a narrow width. Measured on
 * 2026-09-24, in three engines at 1440, 390, 320 and 568x320 and with the
 * trigger at the bottom edge, every part of that was wrong:
 *
 *   - What was refused was two library stylesheets, traced to source by stack:
 *     react-remove-scroll-bar's page scroll lock and Radix Select's
 *     scrollbar-hiding viewport rule. Positioning is Floating UI writing
 *     through React's `style` prop - the CSSOM, which `style-src` does not
 *     govern - and the list was on screen in all 24 arrangements.
 *   - The pattern was Chromium's wording only. Gecko logs the same refusal as
 *     "The page's settings blocked an inline style", WebKit as "Refused to
 *     apply a stylesheet", so in two of the three engines the "known" noise
 *     was never matched and never known.
 *   - It matched a CATEGORY - any inline style refused on any page - so a new
 *     refusal of something that mattered would have been filed under it too.
 *
 * Both stylesheets now arrive (see vite/plugins/csp-hash.ts and
 * src/lib/styleSingleton.ts) and `checkPopovers` in
 * scripts/cross-browser-check.mjs asserts that nothing is refused while every
 * Radix component is in use. If an entry is ever added again: one message,
 * matched in every engine's wording, with the mechanism named and measured -
 * and the harm checked at the widths and states where it would show, not only
 * at the one where it was noticed.
 */
const KNOWN_CONSOLE_NOISE = [];

/** Splits console errors into genuinely new ones and known, named noise. */
export function partitionConsoleErrors(errors) {
  const known = [];
  const unexpected = [];
  for (const text of errors) {
    const hit = KNOWN_CONSOLE_NOISE.find((entry) => entry.match(text));
    (hit ? known : unexpected).push(hit ? `${hit.id}: ${text.slice(0, 80)}` : text);
  }
  return { known, unexpected };
}

/**
 * Opens a browser and a fresh context.
 *
 * FRESH IS THE POINT: every context is a first-time visitor, which is what
 * makes `/` answer with the cold open and what guarantees no graph, theme or
 * dismissal flag survives from a previous run. Reusing a profile would make
 * drives order-dependent in a way that is very hard to see afterwards.
 */
export async function openBrowser({
  engine = 'chromium',
  viewport = { width: 1440, height: 900 },
} = {}) {
  const launcher = ENGINES[engine];
  if (!launcher) throw new Error(`unknown engine "${engine}" - use chromium, firefox or webkit`);

  const browser = await launcher.launch();
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

  return { browser, context, page, consoleErrors };
}

/**
 * Takes the cold open down, if this page is showing one.
 *
 * `/` holds the app inert behind an introduction panel until a first-time
 * visitor dismisses it. That is the product's behaviour, not a test artefact,
 * so this walks through it the way a person does rather than seeding storage
 * to skip it. Silent when there is nothing to dismiss - a share link, a deep
 * link and any `/tools` URL all arrive with no panel at all.
 */
export async function dismissColdOpen(page) {
  const start = page.locator('#cold-open-start');
  if ((await start.count()) === 0) return false;
  await start.click();
  await page.locator('#cold-open').waitFor({ state: 'detached', timeout: 15_000 });
  return true;
}

/** Opens a canvas URL and leaves the introduction behind. */
export async function gotoCanvas(page, path = '/') {
  await page.goto(`${ORIGIN}${path}`, { waitUntil: 'networkidle', timeout: 60_000 });
  await dismissColdOpen(page);
  await page.getByTestId('canvas-root').waitFor({ timeout: 20_000 });
}

/** Opens any non-canvas route (`/tools`, `/tools/<id>`, `/styleguide`). */
export async function gotoPage(page, path) {
  await page.goto(`${ORIGIN}${path}`, { waitUntil: 'networkidle', timeout: 60_000 });
}

/** Adds a tool to the canvas through the palette, the way a user does. */
export async function addTool(page, toolId) {
  await page.getByRole('button', { name: 'Add tool' }).click();
  await page.locator('[role="dialog"]').first().waitFor({ timeout: 10_000 });
  await page.getByTestId(`dialog-option-${toolId}`).click();
  await page.locator('[role="dialog"]').first().waitFor({ state: 'detached', timeout: 10_000 });
}

/**
 * Opens or closes the node inspector, and waits for the slide to finish in
 * both directions. A fixed pause here would be a race against an animation
 * duration this file does not own.
 */
export async function setInspector(page, open) {
  const panel = page.getByTestId('node-inspector');
  if ((await panel.count()) > 0 === open) return;
  await page.getByRole('button', { name: 'Inspector', exact: true }).click();
  await panel.waitFor({ state: open ? 'attached' : 'detached', timeout: 10_000 });
}

/**
 * Waits for the canvas pipeline to settle.
 *
 * THERE IS NO RUN BUTTON ON THE CANVAS. Editing an input re-runs the graph
 * after a 300ms typing pause (`RERUN_DEBOUNCE_MS` in
 * src/features/execution/pipelineStore.ts), so "idle" immediately after typing
 * means "has not started yet", not "finished". This waits for the readout to
 * go busy first when it is going to, then waits for it to come back.
 */
export async function waitForPipelineIdle(page, { settleMs = 600, timeout = 60_000 } = {}) {
  const readout = page.getByTestId('canvas-readout');
  await readout.waitFor({ timeout });
  await page.waitForTimeout(settleMs);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="canvas-readout"]');
      if (el === null) return false;
      // Item by item, for the same reason `readout()` is: the spans run
      // together, so "idle100%" would satisfy a naive /idle/ and "running100%"
      // would defeat a naive /\brunning\b/.
      return [...el.children].some((child) => (child.textContent ?? '').trim() === 'idle');
    },
    undefined,
    { timeout },
  );
}

/**
 * What the canvas chrome is reporting: nodes, wires, running/idle, zoom.
 *
 * Read span by span rather than as one `textContent`. The readout items are
 * adjacent inline-flex boxes with no whitespace between them, so the flat
 * string is `0 nodes0 wiresidle100%` - which reads fine to a human and breaks
 * every word-boundary regex you would naturally write against it.
 */
export async function readout(page) {
  const parts = await page
    .getByTestId('canvas-readout')
    .evaluate((el) => [...el.children].map((child) => (child.textContent ?? '').trim()));
  return parts.filter(Boolean).join(' · ');
}

/* ========================================================================== *
 * Evidence
 * ========================================================================== */

/**
 * Creates (and returns) a run directory under `evidence/`.
 *
 * Named for the feature and stamped, so repeated runs accumulate rather than
 * overwrite and a failed run's evidence is still there next to the passing
 * one. Cleanup never touches this directory - see SKILL.md.
 */
export function evidenceDir(feature) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = join(SKILL_DIR, 'evidence', `${feature}-${stamp}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Appends a line to the run log AND to stdout, so neither is the only copy. */
export function log(dir, line) {
  console.log(line);
  appendFileSync(join(dir, 'run.log'), `${line}\n`, 'utf8');
}

/** A full-page screenshot, numbered in the order it was taken. */
let shotIndex = 0;
export async function shot(page, dir, name) {
  shotIndex += 1;
  const file = join(dir, `${String(shotIndex).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  log(dir, `    shot  ${name}.png`);
  return file;
}

/** Writes a JSON artefact (readings, oracles, verdicts) beside the shots. */
export function artefact(dir, name, value) {
  const file = join(dir, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  log(dir, `    data  ${name}.json`);
  return file;
}

/* ========================================================================== *
 * Verdicts
 * ========================================================================== */

export function makeChecker(dir) {
  const results = [];
  const check = (name, passed, detail = '') => {
    results.push({ name, passed, detail });
    log(dir, `  ${passed ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
    return passed;
  };
  check.results = results;
  check.failed = () => results.filter((r) => !r.passed);
  return check;
}
