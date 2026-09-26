/**
 * Drives one mapped feature of the DEPLOYED Patchbay and leaves evidence.
 *
 *   node .claude/skills/verify-patchbay/drive.mjs <feature> [--engine=chromium|firefox|webkit]
 *   node .claude/skills/verify-patchbay/drive.mjs all
 *
 * Features: canvas, pipelines, tools-index, tool-page, appearance
 *
 * EVERY DRIVE GOES THROUGH THE REAL USER PATH. Nothing here reaches into a
 * store, calls an exported function or uses a test-only hook - the palette is
 * clicked, the textarea is typed into, the Run button is pressed. Where a
 * result can be checked against something other than itself it is: the base64
 * and SHA-256 proofs compare the page's answer to Node's, so a screenshot of a
 * plausible-looking string is never the whole proof.
 */
import { createHash } from 'node:crypto';

import {
  DEFAULT_ENGINE,
  ORIGIN,
  openBrowser,
  gotoCanvas,
  gotoPage,
  addTool,
  setInspector,
  waitForPipelineIdle,
  readout,
  evidenceDir,
  log,
  shot,
  artefact,
  makeChecker,
  partitionConsoleErrors,
  compareWithManifest,
} from './harness.mjs';

/* ========================================================================== *
 * The three pipelines the cold open itself offers.
 *
 * Copied from the `<a class="cold-open-way">` hrefs in index.html. These are
 * the app's own published share links, which makes driving one an exercise of
 * a real entry point rather than a fixture invented here. If index.html's
 * links change, these go stale - the feature map says so.
 * ========================================================================== */
const COLD_OPEN_LINKS = {
  'decode-then-convert':
    '/?p=RY3BCsMgEAX_5Z230GhIwV8RDzYuJdCsRddCCf57kFJ6mzkMc-ANZwkC5z1kAuEeKy8zaJ4WsuZKB_acGA6J1wE9kIcYEKqWtmornC4pagTd7C-puZV1RLFpBkFjebDC4RP3JwibJBaFMz0EAv_vuemrKeh72GRICP0E',
  'fingerprint-a-csv':
    '/?p=Rc5BasMwEEDRu_z1BBI7TUBX6BGMFsIeLId2VKRRSAi-eymldPk3j__iThgFI0wTdkJoXvvsvepyWJIn5Hy6yDgc5UUrvc5KYG53BE91VSdwa8UQNlvUnHAUWqn-rs9G8Np1jzJhA0JOLSPX8U9MH2upm-dPAi2nw_B2QVCby7LZSiDrgz1GQf8PS_ev7sgvudlPxLh_Aw',
  'encode-then-compare':
    '/?p=bc5BCoMwFATQu8x6CprEFHKVkEVagxFqLE0sBfHuxVoQS3f_M7xhZjxhJJFgrEWqQVx8DlqBqtaUouKMYWwDDEK6rsfiaJEEiOhzBM9SU1SKM_ytGx99iQMMcvQn0WhwY33qYBDD68vlgSupf_jQNv-oI8K-dJzKfSrgtqZP6_NpP4ZyD93yBg',
};

/* ========================================================================== *
 * canvas - add a tool, type into it, watch it compute
 * ========================================================================== */

async function driveCanvas(page, dir, check) {
  const INPUT = 'the quick brown fox';
  const EXPECTED = createHash('sha256').update(INPUT, 'utf8').digest('hex');

  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle', timeout: 60_000 });
  check('a first visit is met by the cold open', (await page.locator('#cold-open').count()) === 1);
  await shot(page, dir, 'cold-open');

  await gotoCanvas(page);
  check(
    'dismissing it leaves a usable canvas',
    (await page.getByTestId('canvas-root').count()) === 1,
    await readout(page),
  );

  await addTool(page, 'hash');
  const afterAdd = await readout(page);
  check('the palette puts one node on the canvas', /^1 node\b/.test(afterAdd), afterAdd);
  await shot(page, dir, 'node-added');

  await setInspector(page, true);
  const editor = page.getByLabel('Hash input');
  await editor.waitFor({ timeout: 10_000 });
  await editor.fill(INPUT);
  await shot(page, dir, 'input-typed');

  /*
   * NO RUN BUTTON HERE. The canvas re-runs itself 300ms after typing stops,
   * so this waits for the readout to come back to idle rather than clicking
   * anything. See RERUN_DEBOUNCE_MS in src/features/execution/pipelineStore.ts.
   */
  await waitForPipelineIdle(page);

  const digest = (await page.getByRole('textbox', { name: 'Hash Digest' }).inputValue()).trim();
  await shot(page, dir, 'digest-shown');

  check(
    'the node computed the SHA-256 Node computes for the same text',
    digest.toLowerCase() === EXPECTED,
    `page ${digest.slice(0, 16)}... / node ${EXPECTED.slice(0, 16)}...`,
  );

  artefact(dir, 'canvas', {
    input: INPUT,
    expected: EXPECTED,
    observed: digest,
    readout: afterAdd,
  });
}

/* ========================================================================== *
 * pipelines - a share link installs a wired graph and it runs
 * ========================================================================== */

async function drivePipelines(page, dir, check) {
  /*
   * The share link decodes to this graph (verify with `inflateRawSync` on the
   * `p` param): n1 = base64 in decode mode, n2 = structured-data targeting
   * YAML, wired n1.output -> n2.input. The node ids are in the link, which is
   * why `node-n1` and `node-n2` below are stable rather than lucky.
   */
  const SOURCE = { tool: 'patchbay', checks: 5, ok: true };
  const ENCODED = Buffer.from(JSON.stringify(SOURCE), 'utf8').toString('base64');

  await gotoCanvas(page, COLD_OPEN_LINKS['decode-then-convert']);
  await waitForPipelineIdle(page);

  const installed = await readout(page);
  await shot(page, dir, 'share-link-installed');

  /*
   * A SHARE LINK ARRIVES WITH NO COLD OPEN, which is why `gotoCanvas` is
   * silent above rather than clicking through a panel. The graph came out of
   * the URL, so the node and wire counts are the proof that the decoder ran.
   */
  const nodes = Number(/(\d+) nodes?/.exec(installed)?.[1] ?? '0');
  const wires = Number(/(\d+) wires?/.exec(installed)?.[1] ?? '0');
  check('the share link installs both nodes', nodes === 2, installed);
  check('and the wire between them', wires === 1, installed);

  const nodeLabels = await page
    .locator('[data-testid^="node-"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? '').filter(Boolean));
  check(
    'the installed graph is the Base64 -> structured-data pipeline the link names',
    nodeLabels.some((l) => /base64/i.test(l)) && nodeLabels.some((l) => /structured data/i.test(l)),
    nodeLabels.join(' | ').slice(0, 160),
  );

  /*
   * INSTALLED IS NOT THE SAME AS WORKING. Straight off the link both nodes sit
   * "blocked / Needs input" - asserting that nothing is in error at this point
   * would pass on a pipeline that never ran a line of code. So feed the head of
   * the chain and prove the value comes out the far end transformed.
   */
  check(
    'and it starts blocked, waiting for input rather than already finished',
    nodeLabels.some((l) => /needs input/i.test(l)) &&
      nodeLabels.some((l) => /waiting upstream/i.test(l)),
    nodeLabels.join(' | ').slice(0, 160),
  );

  await page.getByTestId('node-n1').click();
  await setInspector(page, true);
  await page.getByLabel('Base64 input').fill(ENCODED);
  await shot(page, dir, 'head-node-fed');
  await waitForPipelineIdle(page);

  /* Now inspect the TAIL of the chain - the only way its value got there is the wire. */
  await page.getByTestId('node-n2').click();
  const converted = page.getByLabel('Structured data Converted');
  await converted.waitFor({ timeout: 20_000 });
  const yaml = (await converted.inputValue()).trim();
  await shot(page, dir, 'tail-node-output');

  check(
    'the value typed into the first node reaches the second through the wire',
    yaml.includes('patchbay') && yaml.includes('checks'),
    yaml.replace(/\n/g, ' \\n ').slice(0, 120),
  );
  check(
    'and arrives converted to YAML rather than passed through as the JSON it started as',
    /^tool:\s*patchbay$/m.test(yaml) && !yaml.includes('{') && !yaml.includes('"tool"'),
    yaml.replace(/\n/g, ' \\n ').slice(0, 120),
  );

  const finished = await readout(page);
  check('and the graph settles with no error reported', !/error/i.test(finished), finished);

  artefact(dir, 'pipelines', {
    link: COLD_OPEN_LINKS['decode-then-convert'],
    source: SOURCE,
    encoded: ENCODED,
    readoutInstalled: installed,
    readoutFinished: finished,
    nodes,
    wires,
    nodeLabels,
    yaml,
  });
}

/* ========================================================================== *
 * tools-index - browse and search every tool
 * ========================================================================== */

async function driveToolsIndex(page, dir, check) {
  await gotoPage(page, '/tools');
  await page.getByRole('heading', { level: 1, name: 'Every tool' }).waitFor({ timeout: 20_000 });
  await shot(page, dir, 'tools-index');

  const total = (await page.getByTestId('tool-count').textContent())?.trim() ?? '';
  check('the index reports how many tools it is showing', /\d/.test(total), total);

  const links = await page
    .locator('a[href^="/tools/"]')
    .evaluateAll((els) => [...new Set(els.map((el) => el.getAttribute('href')))]);
  /*
   * The manifest's set, not a count. `=== 10` failed against the site the day
   * it deployed an eleventh tool, and would have passed against a deploy that
   * never did - the opposite of what a check on a deploy is for.
   */
  const registry = compareWithManifest(links);
  check(
    'every tool in the registry has a card, and nothing else does',
    registry.same,
    registry.detail,
  );

  /* -- Search narrows the list ------------------------------------------- */
  await page.getByLabel('Search').fill('sha');
  await page.waitForTimeout(250);
  const searched = (await page.getByTestId('tool-count').textContent())?.trim() ?? '';
  const searchedLinks = await page
    .locator('a[href^="/tools/"]')
    .evaluateAll((els) => [...new Set(els.map((el) => el.getAttribute('href')))]);
  await shot(page, dir, 'search-sha');

  check(
    'searching narrows the list',
    searchedLinks.length < links.length,
    `${String(searchedLinks.length)} of ${String(links.length)} - ${searched}`,
  );
  check(
    'and "sha" finds Hash, which matches on a keyword rather than its name',
    searchedLinks.includes('/tools/hash'),
    searchedLinks.join(' '),
  );

  /*
   * -- An empty search restores everything ---------------------------------
   * The positive partner to "searching narrows the list": without it, a filter
   * that wiped the list permanently would pass the check above.
   */
  await page.getByLabel('Search').fill('');
  await page.waitForTimeout(250);
  const restored = await page
    .locator('a[href^="/tools/"]')
    .evaluateAll((els) => [...new Set(els.map((el) => el.getAttribute('href')))]);
  check(
    'clearing the search brings every card back',
    restored.length === links.length,
    `${String(restored.length)}`,
  );

  /*
   * -- Category filter -----------------------------------------------------
   * A Radix combobox, NOT a native <select> - `selectOption()` does nothing
   * here. Click the trigger, then click the option in the popover.
   */
  await page.getByRole('combobox', { name: 'Category' }).click();
  await page.getByRole('option', { name: 'Hashing', exact: true }).click();
  await page.waitForTimeout(250);
  const filteredLinks = await page
    .locator('a[href^="/tools/"]')
    .evaluateAll((els) => [...new Set(els.map((el) => el.getAttribute('href')))]);
  const filteredCount = (await page.getByTestId('tool-count').textContent())?.trim() ?? '';
  await shot(page, dir, 'category-hashing');

  check(
    'filtering by category narrows to that category alone',
    filteredLinks.length === 1 && filteredLinks[0] === '/tools/hash',
    `${filteredCount} - ${filteredLinks.join(' ')}`,
  );

  /* -- Click through to a tool page ---------------------------------------- */
  await page.locator('a[href="/tools/hash"]').first().click();
  await page.getByRole('heading', { level: 1, name: 'Hash' }).waitFor({ timeout: 20_000 });
  check(
    'a card navigates to that tool page',
    new URL(page.url()).pathname === '/tools/hash',
    page.url(),
  );

  artefact(dir, 'tools-index', {
    total,
    links,
    searched,
    searchedLinks,
    restored: restored.length,
    filteredCount,
    filteredLinks,
    landedOn: page.url(),
  });
}

/* ========================================================================== *
 * tool-page - run one tool on its own, with an explicit Run
 * ========================================================================== */

async function driveToolPage(page, dir, check) {
  const INPUT = 'Patchbay verification run';
  const EXPECTED = Buffer.from(INPUT, 'utf8').toString('base64');

  await gotoPage(page, '/tools/base64');
  await page.getByRole('heading', { level: 1, name: 'Base64' }).waitFor({ timeout: 20_000 });
  await shot(page, dir, 'tool-page');

  await page.getByLabel('Base64 input').fill(INPUT);
  await shot(page, dir, 'input-typed');

  /*
   * THE TOOL PAGE HAS A RUN BUTTON AND THE CANVAS DOES NOT. This is the one
   * surface where output is not reactive, which makes it the deterministic
   * place to prove a tool's arithmetic.
   */
  await page.getByRole('button', { name: 'Run' }).click();

  const output = page.getByRole('textbox', { name: 'Base64 Result' });
  await output.waitFor({ timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const el = [...document.querySelectorAll('textarea')].find(
        (t) => t.getAttribute('aria-label') === 'Base64 Result',
      );
      return el !== undefined && el.value.trim().length > 0;
    },
    undefined,
    { timeout: 30_000 },
  );
  const observed = (await output.inputValue()).trim();
  await shot(page, dir, 'result');

  check(
    'Run produces the base64 Node produces for the same text',
    observed === EXPECTED,
    `page ${observed} / node ${EXPECTED}`,
  );

  artefact(dir, 'tool-page', { tool: 'base64', input: INPUT, expected: EXPECTED, observed });
}

/* ========================================================================== *
 * appearance - themes, and the styleguide that hosts them
 * ========================================================================== */

async function driveAppearance(page, dir, check) {
  await gotoPage(page, '/styleguide');
  await page.getByRole('heading', { level: 1, name: 'Styleguide' }).waitFor({ timeout: 20_000 });
  await shot(page, dir, 'styleguide');

  const before = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    surface: getComputedStyle(document.body).backgroundColor,
  }));

  /*
   * PICKED RELATIVE TO WHAT IS ALREADY ON, not hardcoded. A fresh context
   * starts on the "System" option, and headless Chromium reports a light OS
   * preference - so the document arrives as `vellum` and "switch to Vellum"
   * would assert a change that never happened. Choose anything but the
   * current one.
   */
  const target = before.theme === 'phosphor' ? 'Graphite' : 'Phosphor';

  /*
   * CLICK THE LABEL, NOT THE INPUT. Each radio is a 1x1, opacity-0 input
   * underneath a painted marker span, so `.check()` on the input never lands -
   * Playwright retries into a timeout with the marker intercepting the click.
   * The label is what a person clicks, and clicking it is what the styles were
   * built for.
   */
  await page
    .locator('label')
    .filter({ hasText: new RegExp(`^${target}`) })
    .first()
    .click();
  await page.waitForTimeout(400);

  const after = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    surface: getComputedStyle(document.body).backgroundColor,
  }));
  await shot(page, dir, `theme-${target.toLowerCase()}`);

  check(
    'choosing a theme rewrites the document theme attribute',
    after.theme === target.toLowerCase(),
    `${String(before.theme)} -> ${String(after.theme)} (asked for ${target})`,
  );
  check(
    'and the page actually repaints in it',
    after.surface !== before.surface,
    `${before.surface} -> ${after.surface}`,
  );

  /*
   * THE SIDE EFFECT, not just the visible one: the choice is persisted, which
   * is what makes it survive a reload. Checked in storage and then proved by
   * reloading rather than trusted.
   */
  const stored = await page.evaluate(() =>
    Object.fromEntries(
      Object.keys(localStorage)
        .filter((k) => /theme/i.test(k))
        .map((k) => [k, localStorage.getItem(k)]),
    ),
  );
  check(
    'the choice is written to storage',
    Object.keys(stored).length > 0,
    JSON.stringify(stored).slice(0, 120),
  );

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { level: 1, name: 'Styleguide' }).waitFor({ timeout: 20_000 });
  const reloaded = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await shot(page, dir, 'theme-after-reload');
  check(
    'and survives a reload',
    reloaded === target.toLowerCase(),
    `${String(reloaded)} after reload`,
  );

  artefact(dir, 'appearance', { before, target, after, stored, reloaded });
}

/* ========================================================================== *
 * Runner
 * ========================================================================== */

const FEATURES = {
  canvas: driveCanvas,
  pipelines: drivePipelines,
  'tools-index': driveToolsIndex,
  'tool-page': driveToolPage,
  appearance: driveAppearance,
};

const args = process.argv.slice(2);
const engine = args.find((a) => a.startsWith('--engine='))?.split('=')[1] ?? DEFAULT_ENGINE;
const requested = args.filter((a) => !a.startsWith('--'));
const names = requested.length === 0 || requested[0] === 'all' ? Object.keys(FEATURES) : requested;

for (const name of names) {
  if (!FEATURES[name]) {
    console.error(`unknown feature "${name}" - one of: ${Object.keys(FEATURES).join(', ')}, all`);
    process.exit(2);
  }
}

let failures = 0;

for (const name of names) {
  const dir = evidenceDir(name);
  const check = makeChecker(dir);
  log(dir, `${name} @ ${ORIGIN} (${engine})`);

  const { browser, page, consoleErrors } = await openBrowser({ engine });
  try {
    await FEATURES[name](page, dir, check);
    const { known, unexpected } = partitionConsoleErrors(consoleErrors);
    if (known.length > 0) {
      /* Reported, never hidden - see KNOWN_CONSOLE_NOISE in harness.mjs. */
      log(
        dir,
        `  --   ${String(known.length)} known console error(s) tolerated: ${[...new Set(known.map((k) => k.split(':')[0]))].join(', ')}`,
      );
    }
    check(
      'no unexpected console errors during the drive',
      unexpected.length === 0,
      unexpected.join(' | ').slice(0, 200),
    );
  } catch (error) {
    check(`${name} ran to completion`, false, String(error).split('\n')[0]);
    /* A screenshot of the failure is worth more than the stack alone. */
    try {
      await shot(page, dir, 'failure');
    } catch {
      /* The page may be gone; the log still has the error. */
    }
  } finally {
    /* Cleanup closes what this run opened, and never touches `dir`. */
    await browser.close();
  }

  const failed = check.failed();
  failures += failed.length;
  log(
    dir,
    failed.length === 0
      ? `PASS ${name} - evidence in ${dir}\n`
      : `FAIL ${name} (${String(failed.length)}) - evidence in ${dir}\n`,
  );
}

console.log(
  failures === 0
    ? `All drives passed (${names.join(', ')}).`
    : `${String(failures)} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
