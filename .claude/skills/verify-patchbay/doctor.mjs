/**
 * Is the deployed Patchbay worth driving?
 *
 * Read-only in every sense: it issues GETs, opens one page, reads the DOM and
 * exits. Run it first whenever a drive behaves oddly - it separates "the site
 * is broken" from "my script is wrong" from "I am looking at a different build
 * than the one in my working tree".
 *
 *   node .claude/skills/verify-patchbay/doctor.mjs
 *   PATCHBAY_ORIGIN=https://deploy-preview-12--patchbay-tools.netlify.app node .claude/skills/verify-patchbay/doctor.mjs
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ORIGIN,
  SKILL_DIR,
  openBrowser,
  gotoCanvas,
  readout,
  evidenceDir,
  log,
  shot,
  artefact,
  makeChecker,
} from './harness.mjs';

const ROOT = join(SKILL_DIR, '..', '..', '..');

const dir = evidenceDir('doctor');
const check = makeChecker(dir);

log(dir, `doctor: ${ORIGIN}`);

/* -- 1. The origin answers, and answers with the app ----------------------- */

const response = await fetch(`${ORIGIN}/`, { redirect: 'follow' });
const html = await response.text();

check('the origin answers 200', response.status === 200, `status ${String(response.status)}`);
check(
  'the document is the Patchbay shell',
  html.includes('id="cold-open"') && html.includes('id="root"'),
  '',
);

/* -- 2. The zero-network policy is actually being served ------------------- */

const csp = response.headers.get('content-security-policy') ?? '';
check(
  "the CSP is present and still says connect-src 'none'",
  csp.includes("connect-src 'none'"),
  csp ? `${csp.slice(0, 60)}...` : 'no CSP header',
);
check("and form-action 'none'", csp.includes("form-action 'none'"), '');

/*
 * THIS IS WHY DRIVING THE LIVE SITE IS A READ-ONLY ACT. With these two
 * directives served, nothing the app runs can send a byte anywhere - so typing
 * into a tool and watching it compute changes nothing outside the throwaway
 * browser profile. If this check ever fails, STOP and re-read the safety note
 * in SKILL.md before driving anything.
 */

/* -- 3. Which build am I looking at? --------------------------------------- */

const deployedEntry = /<script[^>]*src="(\/assets\/index-[^"]+\.js)"/.exec(html)?.[1] ?? null;
check('the document names a hashed entry bundle', deployedEntry !== null, deployedEntry ?? 'none');

let localEntry = null;
try {
  localEntry =
    /<script[^>]*src="(\/assets\/index-[^"]+\.js)"/.exec(
      await readFile(join(ROOT, 'dist', 'index.html'), 'utf8'),
    )?.[1] ?? null;
} catch {
  /* No local build. Not a failure - it just means the comparison is skipped. */
}

if (localEntry === null) {
  log(dir, '  --   no local dist/index.html, so "deployed == working tree" was not checked');
} else {
  /*
   * A MISMATCH IS INFORMATION, NOT A FAILURE. It means the deploy is older or
   * newer than the build sitting in dist/, which is the single most common
   * reason a verified-locally change "is not on the site". Reported loudly and
   * left as the reader's call.
   */
  const same = deployedEntry === localEntry;
  log(
    dir,
    same
      ? `  ok   the deploy matches the local build (${String(deployedEntry)})`
      : `  NOTE the deploy is NOT the local build - deployed ${String(deployedEntry)}, dist/ ${String(localEntry)}`,
  );
}

/* -- 4. The routes the feature map depends on are reachable ---------------- */

for (const path of ['/tools', '/tools/base64', '/styleguide', '/sw.js', '/site.webmanifest']) {
  const res = await fetch(`${ORIGIN}${path}`);
  check(`${path} answers`, res.ok, `status ${String(res.status)}`);
}

/* -- 5. A real engine can boot it ------------------------------------------ */

const { browser, page, consoleErrors } = await openBrowser();
let chrome = '';
try {
  await gotoCanvas(page);
  await page.getByRole('button', { name: 'Add tool' }).waitFor({ timeout: 20_000 });
  chrome = await readout(page);
  check('the canvas mounts and its toolbar is usable', true, chrome);
  check('an empty canvas reports zero nodes', /\b0 nodes\b/.test(chrome), chrome);
  await shot(page, dir, 'canvas-cold');
} catch (error) {
  check('the canvas mounts and its toolbar is usable', false, String(error).split('\n')[0]);
} finally {
  await browser.close();
}

check(
  'no console errors while booting',
  consoleErrors.length === 0,
  consoleErrors.join(' | ').slice(0, 200),
);

artefact(dir, 'doctor', {
  origin: ORIGIN,
  deployedEntry,
  localEntry,
  buildsMatch: localEntry === null ? null : deployedEntry === localEntry,
  csp,
  readout: chrome,
  consoleErrors,
  checks: check.results,
});

const failed = check.failed();
log(
  dir,
  failed.length === 0
    ? `\nDOCTOR OK - evidence in ${dir}`
    : `\nDOCTOR FAILED (${String(failed.length)}) - evidence in ${dir}`,
);
process.exit(failed.length === 0 ? 0 : 1);
