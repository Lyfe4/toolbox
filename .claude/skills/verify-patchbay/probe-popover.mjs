/**
 * Where does a Radix popover actually land, and what does the CSP refuse while
 * it is open?
 *
 * Written for the Category filter on /tools, where opening the select logged
 * "Applying inline style violates" style-src and the harness filed it as
 * noise on the strength of one look at 1440x900. The claim to test was that
 * the blocked styles are the popover's collision-avoidance, so a narrow
 * viewport would put it off-screen. This measures instead of assuming:
 *
 *   - every `securitypolicyviolation` event, with its directive and the first
 *     40 characters of what was refused (`sample`), so the refused style can be
 *     traced to the code that produced it rather than guessed at;
 *   - the listbox's box against the viewport, at desktop and phone widths, and
 *     with the trigger pushed to the bottom edge - the one arrangement where
 *     collision avoidance has to move the popover to keep it on screen;
 *   - what the refused styles would have done: whether the page is scroll
 *     locked behind the open list, and whether the list's scrollbar is hidden.
 *
 *   node .claude/skills/verify-patchbay/probe-popover.mjs
 *   node .claude/skills/verify-patchbay/probe-popover.mjs --engine=firefox
 *
 * Against the live site by default; PATCHBAY_ORIGIN points it elsewhere.
 */
import {
  ORIGIN,
  openBrowser,
  gotoPage,
  evidenceDir,
  log,
  shot,
  artefact,
  makeChecker,
  partitionConsoleErrors,
} from './harness.mjs';

const engineArg = process.argv.find((a) => a.startsWith('--engine='));
const ENGINES = engineArg
  ? [engineArg.slice('--engine='.length)]
  : process.env.PATCHBAY_ENGINE !== undefined
    ? [process.env.PATCHBAY_ENGINE]
    : ['chromium', 'firefox', 'webkit'];

const VIEWPORTS = [
  { width: 1440, height: 900, name: 'desktop' },
  { width: 390, height: 844, name: 'phone' },
  { width: 320, height: 568, name: 'small-phone' },
  { width: 568, height: 320, name: 'small-phone-landscape' },
];

/** Installed before any app code: records what the CSP refuses, verbatim. */
function recordViolations() {
  window.__violations = [];
  document.addEventListener('securitypolicyviolation', (event) => {
    window.__violations.push({
      directive: event.effectiveDirective,
      sample: event.sample,
      blocked: event.blockedURI,
      source: `${event.sourceFile}:${String(event.lineNumber)}`,
    });
  });
}

async function measure(page) {
  return page.evaluate(() => {
    const listbox = document.querySelector('[role="listbox"]');
    const trigger = document.querySelector('[role="combobox"][aria-expanded="true"]');
    const wrapper = document.querySelector('[data-radix-popper-content-wrapper]');
    const viewportEl = document.querySelector('[data-radix-select-viewport]');
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        width: r.width,
        height: r.height,
      };
    };
    return {
      vw: document.documentElement.clientWidth,
      vh: window.innerHeight,
      listbox: box(listbox),
      trigger: box(trigger),
      wrapperTransform: wrapper ? getComputedStyle(wrapper).transform : null,
      side: listbox?.closest('[data-side]')?.getAttribute('data-side') ?? null,
      scrollLockedAttr: document.body.hasAttribute('data-scroll-locked'),
      bodyOverflow: getComputedStyle(document.body).overflow,
      viewportScrollbarWidth: viewportEl ? getComputedStyle(viewportEl).scrollbarWidth : null,
      // Does the list fit, and if not, is there anything telling you so?
      listOverflows: viewportEl ? viewportEl.scrollHeight > viewportEl.clientHeight + 1 : null,
      listHeights: viewportEl ? [viewportEl.scrollHeight, viewportEl.clientHeight] : null,
      scrollButtons: document.querySelectorAll(
        '[data-radix-select-scroll-up-button], [data-radix-select-scroll-down-button]',
      ).length,
      scrollbarDrawn: viewportEl ? viewportEl.offsetWidth - viewportEl.clientWidth : null,
      styleElements: [...document.querySelectorAll('style')].map((s) => ({
        where: s.parentElement?.tagName ?? '?',
        rules: (() => {
          try {
            return s.sheet ? s.sheet.cssRules.length : 'no sheet';
          } catch {
            return 'unreadable';
          }
        })(),
        text: (s.textContent ?? '').replace(/\s+/g, ' ').slice(0, 60),
      })),
    };
  });
}

function onScreen(m) {
  if (!m.listbox) return 'no listbox';
  const b = m.listbox;
  const off = [];
  if (b.top < 0) off.push(`top ${b.top.toFixed(1)}`);
  if (b.left < 0) off.push(`left ${b.left.toFixed(1)}`);
  if (b.bottom > m.vh + 0.5) off.push(`bottom ${b.bottom.toFixed(1)} > ${String(m.vh)}`);
  if (b.right > m.vw + 0.5) off.push(`right ${b.right.toFixed(1)} > ${String(m.vw)}`);
  return off.length === 0 ? 'fully on screen' : `OFF SCREEN: ${off.join(', ')}`;
}

const dir = evidenceDir('popover');
log(dir, `popover probe @ ${ORIGIN} - ${ENGINES.join(', ')}`);
const check = makeChecker(dir);
const readings = [];

for (const engine of ENGINES) {
  for (const vp of VIEWPORTS) {
    for (const placement of ['at rest', 'trigger at the bottom edge']) {
      const tag = `${engine} ${vp.name} ${String(vp.width)}x${String(vp.height)}, ${placement}`;
      log(dir, `\n${tag}`);
      const { browser, context, page, consoleErrors } = await openBrowser({
        engine,
        viewport: { width: vp.width, height: vp.height },
      });
      try {
        await context.addInitScript(recordViolations);
        await gotoPage(page, '/tools');
        const combo = page.getByRole('combobox', { name: 'Category' });
        await combo.waitFor();

        if (placement !== 'at rest') {
          // Put the trigger's bottom 40px above the viewport's bottom edge, so
          // a list opening downwards has nowhere to go. NOT by scrolling: the
          // filter sits near the top of the page, and at the top of a
          // document there is nothing above it to scroll away. The window is
          // made shorter instead, which is also what a phone turned sideways
          // does to the same page.
          const bottom = await combo.evaluate((el) => el.getBoundingClientRect().bottom);
          await page.setViewportSize({ width: vp.width, height: Math.ceil(bottom) + 40 });
        }
        const beforeViolations = await page.evaluate(() => window.__violations.length);
        const beforeErrors = consoleErrors.length;
        await combo.click();
        await page.getByRole('listbox').waitFor();
        await page.waitForTimeout(300);
        // Read AFTER the click: Playwright scrolls a trigger below the fold
        // into view to click it, and a reading taken before that attributes
        // the driver's scroll to the wheel below. That misreading happened.
        const scrollBefore = await page.evaluate(() => window.scrollY);
        const m = await measure(page);
        /*
         * The screenshot's own stylesheet is refused by the CSP in WebKit and
         * recorded as a violation like any other (see `shot`). Exactly one,
         * waited for by its arrival, is taken back out of this scene's list;
         * a refusal the app causes is a second entry and stays.
         */
        const beforeShot = await page.evaluate(() => window.__violations.length);
        await shot(page, dir, `${engine}-${vp.name}-${placement.replace(/\W+/g, '-')}`);
        const shotRefused =
          engine === 'webkit' &&
          (await page
            .waitForFunction((n) => window.__violations.length > n, beforeShot, { timeout: 3_000 })
            .then(() => true)
            .catch(() => false));

        // Does the page behind the open list scroll? The refused stylesheet
        // is react-remove-scroll's body lock, if the samples say so.
        await page.mouse.move(5, 5);
        await page.mouse.wheel(0, 300);
        await page.waitForTimeout(200);
        const scrollAfterWheel = await page.evaluate(() => window.scrollY);

        const violations = (await page.evaluate(() => window.__violations)).slice(beforeViolations);
        if (shotRefused) violations.splice(beforeShot - beforeViolations, 1);
        const errors = consoleErrors.slice(beforeErrors);

        // Choose Hashing and confirm the filter did its job.
        await page.getByRole('option', { name: 'Hashing', exact: true }).click();
        await page.waitForTimeout(200);
        const count = await page.getByTestId('tool-count').textContent();
        const hrefs = await page
          .locator('a[href^="/tools/"]')
          .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('href')))]);

        const verdict = onScreen(m);
        log(
          dir,
          `    listbox ${JSON.stringify(m.listbox)} side=${String(m.side)} in ${String(m.vw)}x${String(m.vh)}`,
        );
        log(dir, `    trigger ${JSON.stringify(m.trigger)}`);
        log(dir, `    ${verdict}`);
        log(
          dir,
          `    scroll-lock attr=${String(m.scrollLockedAttr)} body overflow=${m.bodyOverflow}; wheel moved page ${String(scrollBefore)} -> ${String(scrollAfterWheel)}`,
        );
        log(
          dir,
          `    list scrollbar-width=${String(m.viewportScrollbarWidth)}, overflows=${String(m.listOverflows)} ${JSON.stringify(m.listHeights)}, scrollbar drawn ${String(m.scrollbarDrawn)}px, scroll buttons ${String(m.scrollButtons)}`,
        );
        for (const s of m.styleElements)
          log(dir, `    <style> in ${s.where}: rules=${String(s.rules)} "${s.text}"`);
        for (const v of violations)
          log(dir, `    CSP ${v.directive}: "${String(v.sample)}" from ${v.source}`);
        const { known, unexpected } = partitionConsoleErrors(errors);
        log(
          dir,
          `    console errors: ${String(errors.length)} (${String(known.length)} matched KNOWN_CONSOLE_NOISE)`,
        );
        for (const e of new Set(errors.map((x) => x.slice(0, 110)))) log(dir, `      ${e}`);

        check(`${tag}: the listbox is on screen`, verdict === 'fully on screen', verdict);
        check(
          `${tag}: filtering to Hashing leaves only Hash`,
          hrefs.length === 1 && hrefs[0] === '/tools/hash',
          `${String(count)} ${hrefs.join(',')}`,
        );
        check(
          `${tag}: nothing refused by the CSP`,
          violations.length === 0,
          `${String(violations.length)} violations`,
        );
        readings.push({
          engine,
          viewport: vp,
          placement,
          measure: m,
          verdict,
          violations,
          errors,
          unexpected,
          scrollBefore,
          scrollAfterWheel,
          count,
          hrefs,
        });
      } finally {
        await browser.close();
      }
    }
  }
}

artefact(dir, 'popover', readings);
const failed = check.failed();
log(
  dir,
  `\n${failed.length === 0 ? 'PROBE OK' : `PROBE: ${String(failed.length)} failed`} - evidence in ${dir}`,
);
process.exitCode = failed.length === 0 ? 0 : 1;
