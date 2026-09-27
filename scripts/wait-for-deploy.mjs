/**
 * Waits until the live site serves the build in `dist/`, or says it never did.
 *
 * WHY THIS EXISTS: the verification skill's live-site mode proves a deploy,
 * and it was run by hand after one, when somebody remembered. Netlify builds
 * `main` itself and tells GitHub nothing - no deployment, no commit status -
 * so nothing marks the moment a push is live. The build is deterministic
 * (`checkLiveAssets` holds every URL a build shares with the live site to the
 * same bytes), so the service worker is the marker: `sw.js` lists every asset
 * and carries an id derived from them, and when the live one is byte-identical
 * to this build's, the live site is this build.
 *
 * Used by .github/workflows/browsers.yml before it runs the skill against the
 * live site. A deploy that never matches fails the job by name - that is a
 * deploy that differs from its build, which is the thing worth hearing about,
 * not a reason to run the skill against whatever happens to be live.
 *
 *   node scripts/wait-for-deploy.mjs [minutes]   # default 20
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ORIGIN = (process.env.PATCHBAY_ORIGIN ?? 'https://patchbay-tools.netlify.app').replace(
  /\/$/,
  '',
);
const minutes = Number(process.argv[2] ?? 20);
const built = await readFile(join(ROOT, 'dist', 'sw.js'), 'utf8');
/** The build id `vite/plugins/service-worker.ts` writes into `const BUILD`. */
const idOf = (text) => /const BUILD = '([\w-]+)'/.exec(text)?.[1] ?? '(no build id found)';

const until = Date.now() + minutes * 60_000;
let last = 'nothing fetched yet';
for (let attempt = 1; ; attempt += 1) {
  try {
    const response = await fetch(`${ORIGIN}/sw.js`, { cache: 'no-store' });
    const live = await response.text();
    if (response.ok && live === built) {
      console.log(
        `wait-for-deploy: ${ORIGIN} serves this build (${idOf(built)}), attempt ${String(attempt)}`,
      );
      process.exit(0);
    }
    last = response.ok
      ? `serves ${idOf(live)}, not ${idOf(built)}`
      : `answered ${String(response.status)}`;
  } catch (error) {
    last = `did not answer: ${String(error)}`;
  }
  if (Date.now() > until) {
    console.error(
      `wait-for-deploy: after ${String(minutes)} minutes ${ORIGIN} still ${last}. Either the deploy failed or it differs from this build.`,
    );
    process.exit(1);
  }
  console.log(`wait-for-deploy: ${ORIGIN} ${last}; checking again in 30s`);
  await new Promise((resolve) => {
    setTimeout(resolve, 30_000);
  });
}
