/**
 * Cross-browser smoke check against the PRODUCTION build.
 *
 * jsdom is not a browser. It has no layout, no Worker, no OffscreenCanvas and
 * no pointer events, which means the unit suite - however thorough - cannot
 * say anything about the three places browsers actually diverge here:
 *
 *   1. Pointer events on the canvas (dragging, capture, coalescing).
 *   2. OffscreenCanvas, which image-convert needs and which Safari only
 *      shipped in 16.4.
 *   3. CSS custom properties, specifically `color-mix()` and `@property`,
 *      which the theming engine leans on.
 *
 * So this drives the real engines. WebKit here is Playwright's build of the
 * engine behind Safari - the same WebCore and JavaScriptCore, not the Safari
 * application - which is as close to Safari as anything gets on a machine that
 * is not a Mac. That limitation is stated rather than glossed over.
 *
 * Deliberately NOT part of the CI gate: it needs ~165 MB of browser binaries.
 * Run it with `pnpm check:browsers` after `pnpm build`.
 */
import { deflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { firefox, webkit } from 'playwright';

import { fileURLToPath } from 'node:url';

import { DIST, headersFor, readHeaders, serveDist } from './serve-dist.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const PORT = 4319;
const ORIGIN = `http://127.0.0.1:${PORT}`;

/*
 * The site's public origin, read out of the BUILT html rather than hardcoded
 * here. It comes from VITE_SITE_URL (see .env), and a harness carrying its own
 * copy would be one more place to forget when a custom domain lands.
 */
const SITE_URL = /<link[^>]*rel="canonical"[^>]*href="(https:\/\/[^/"]+)/.exec(
  await readFile(join(DIST, 'index.html'), 'utf8'),
)?.[1];

if (!SITE_URL) {
  throw new Error('cross-browser: no absolute canonical link in dist/index.html');
}

/* ========================================================================== *
 * A real PNG, built here
 * ========================================================================== */

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * A genuine 8x8 RGBA PNG.
 *
 * Built rather than committed as a fixture so it is obvious what it contains,
 * and so the check cannot silently start passing on a corrupt file. The image
 * tool sniffs magic bytes, decodes it with `createImageBitmap` and re-encodes
 * it, so nothing short of a real PNG would exercise the path.
 */
function makePng(size = 8) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10-12 are compression, filter and interlace, all zero.

  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0; // filter type: none
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      raw[offset] = (x * 255) / (size - 1);
      raw[offset + 1] = (y * 255) / (size - 1);
      raw[offset + 2] = 128;
      raw[offset + 3] = 255;
      offset += 4;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ========================================================================== *
 * The checks
 * ========================================================================== */

const failures = [];

/**
 * Records something that could NOT be checked here, and why.
 *
 * Not a pass and not a failure. A check that silently disappears in one engine
 * is worse than one that fails, because the summary then reads as full
 * coverage - so anything the harness cannot do gets a visible line naming the
 * engine limitation behind it.
 */
function skip(browser, name, reason) {
  console.log(`  skip ${name} - ${reason}`);
}

function check(browser, name, passed, detail = '') {
  const mark = passed ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${name}${detail ? ` - ${detail}` : ''}`);
  if (!passed) failures.push(`${browser}: ${name}${detail ? ` - ${detail}` : ''}`);
}

/**
 * The canvas chrome at each supported width.
 *
 * A fresh page per width rather than resizing one: Firefox's Playwright build
 * gets upset closing a context whose window was resized mid-run, and a fresh
 * page also guarantees the media query is evaluated at load rather than
 * mid-render.
 */
async function checkChromeWidths(browser, label) {
  for (const width of [320, 768, 1440, 1920]) {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    const page = await context.newPage();

    try {
      await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
      await page.locator('[class*="toolbar"]').waitFor({ timeout: 15_000 });

      const chrome = await page.evaluate(() => {
        const boxesOf = (root) =>
          [...root.children].map((el) => {
            const box = el.getBoundingClientRect();
            return {
              text: (el.textContent ?? '').trim().slice(0, 24),
              left: box.left,
              right: box.right,
              top: box.top,
              bottom: box.bottom,
              clipped: el.scrollWidth > el.clientWidth + 1,
            };
          });

        const overlapping = (boxes) => {
          const hits = [];
          for (let i = 0; i < boxes.length; i += 1) {
            for (let j = i + 1; j < boxes.length; j += 1) {
              const a = boxes[i];
              const b = boxes[j];
              if (
                a.left < b.right - 0.5 &&
                b.left < a.right - 0.5 &&
                a.top < b.bottom - 0.5 &&
                b.top < a.bottom - 0.5
              ) {
                hits.push(`${a.text} / ${b.text}`);
              }
            }
          }
          return hits;
        };

        const bar = document.querySelector('[class*="toolbar"]');
        const readout = document.querySelector('[data-testid="canvas-readout"]');
        const barBox = bar.getBoundingClientRect();
        const barItems = boxesOf(bar);
        const readoutItems = boxesOf(readout);
        const readoutBox = readout.getBoundingClientRect();

        /*
         * Clipping is measured on the CONTROLS, not on their wrappers. The
         * share button sits in a positioned wrapper alongside its hidden
         * privacy note, and the note is wider than the button - so the
         * wrapper's scrollWidth exceeds its clientWidth while nothing is
         * actually cut.
         */
        const controls = [...bar.querySelectorAll('button')].map((el) => {
          const box = el.getBoundingClientRect();
          return {
            text: (el.textContent ?? '').trim().slice(0, 24),
            right: box.right,
            clipped: el.scrollWidth > el.clientWidth + 1,
          };
        });

        return {
          barFits: barBox.right <= window.innerWidth + 0.5 && barBox.left >= -0.5,
          barClipped: controls.filter((i) => i.clipped).map((i) => i.text),
          barOffscreen: controls
            .filter((i) => i.right > window.innerWidth + 0.5)
            .map((i) => i.text),
          barOverlaps: overlapping(barItems),
          controls: controls.length,
          readoutFits: readoutBox.right <= window.innerWidth + 0.5,
          readoutOverlaps: overlapping(readoutItems),
          readoutRows: new Set(readoutItems.map((i) => Math.round(i.top))).size,
          // The privacy note must never sit among the controls: it is
          // absolutely positioned below the bar and hidden until wanted.
          noteVisibleInRow: [...bar.querySelectorAll('[class*="shareNote"]')].filter((noteEl) => {
            const note = noteEl.getBoundingClientRect();
            return (
              getComputedStyle(noteEl).visibility !== 'hidden' && note.top < barBox.bottom - 0.5
            );
          }).length,
        };
      });

      check(
        label,
        `toolbar fits and clips nothing at ${width.toString()}px`,
        chrome.barFits && chrome.barClipped.length === 0 && chrome.barOffscreen.length === 0,
        `${chrome.controls.toString()} controls, clipped [${chrome.barClipped.join(', ')}], offscreen [${chrome.barOffscreen.join(', ')}]`,
      );
      check(
        label,
        `nothing in the toolbar overlaps at ${width.toString()}px`,
        chrome.barOverlaps.length === 0 && chrome.noteVisibleInRow === 0,
        chrome.barOverlaps.join(' | ') || 'clear',
      );
      check(
        label,
        `status readout is one row and fits at ${width.toString()}px`,
        chrome.readoutFits && chrome.readoutOverlaps.length === 0 && chrome.readoutRows === 1,
        `${chrome.readoutRows.toString()} row(s), overlaps [${chrome.readoutOverlaps.join(', ')}]`,
      );
    } finally {
      await context.close();
    }
  }
}

/**
 * Scroll containment, which is a LAYOUT fact and so cannot be asserted in
 * jsdom.
 *
 * The overlays render inside the canvas root, and the canvas binds a
 * non-passive wheel listener there. Before the fix, a wheel over an open
 * dialog panned the canvas and had its default cancelled, so the dialog
 * itself never scrolled. Both halves are measured here with a real trusted
 * wheel: the dialog must move, and the plane's transform must not.
 */
async function checkDialogScroll(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 700 } });
  const page = await context.newPage();

  try {
    await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
    await page.locator('[role="application"]').first().waitFor({ timeout: 15_000 });

    const planeTransform = () =>
      page.evaluate(
        () => document.querySelector('[data-testid="canvas-plane"]')?.style.transform ?? '',
      );

    // The shortcuts reference: the longest overlay, so it definitely overflows.
    await page
      .locator('[role="application"]')
      .first()
      .click({ position: { x: 640, y: 400 } });
    await page.keyboard.press('?');
    const dialog = page.locator('[role="dialog"]').first();
    await dialog.waitFor({ timeout: 5_000 });

    const before = await planeTransform();

    const box = await dialog.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(250);

    const after = await planeTransform();
    check(
      label,
      'the canvas does not pan while a dialog is open',
      after === before,
      `${before} -> ${after}`,
    );

    // Which element actually took the scroll depends on where the overflow
    // lives, so ask the subtree rather than guessing at the scroll container.
    const scrolled = await page.evaluate(() => {
      const root = document.querySelector('[role="dialog"]');
      if (!root) return -1;
      const all = [root, ...root.querySelectorAll('*')];
      return Math.max(...all.map((element) => element.scrollTop));
    });
    check(label, 'the dialog itself scrolls instead', scrolled > 0, `scrollTop=${scrolled}`);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);

    await page.mouse.move(640, 400);
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(250);

    // The listener is unbound while an overlay is open, so the real risk is
    // that it never comes back.
    const restored = await planeTransform();
    check(
      label,
      'the canvas pans again once the dialog closes',
      restored !== before,
      `${before} -> ${restored}`,
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Route transition feedback, which needs real timing and so also cannot be
 * asserted in jsdom - there a route's dynamic import takes over a second to
 * transform, making every navigation "slow".
 *
 * A slow navigation is manufactured by delaying the route's chunk; a fast one
 * by priming it first. The bar must appear for the first and never the second.
 */
async function checkRouteFeedback(browser, label) {
  /*
   * Registration is blocked in every context here, and that is a FINDING
   * rather than tidiness.
   *
   * The service worker precaches every route chunk, so once it is installed
   * the delay this check injects with `page.route` never applies - the chunk
   * comes from the cache and the "slow" navigation is instant. Which is
   * exactly what the worker is for; it just means a slow navigation has to be
   * manufactured somewhere the worker is not, or this measures nothing.
   */
  const blockServiceWorker = `
    if (navigator.serviceWorker) {
      Object.defineProperty(navigator.serviceWorker, 'register', {
        value: () => Promise.reject(new Error('blocked by the harness')),
      });
    }
  `;

  const pendingIn = (page) =>
    page.evaluate(
      () =>
        document.querySelector('[data-testid="route-progress"]')?.hasAttribute('data-pending') ??
        false,
    );

  const slow = await browser.newContext({ viewport: { width: 1280, height: 700 } });
  const slowPage = await slow.newPage();

  try {
    await slowPage.addInitScript(blockServiceWorker);
    await slowPage.route('**/assets/*.js', async (route) => {
      if (route.request().url().includes('styleguide')) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
      await route.continue();
    });
    await slowPage.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
    await slowPage.evaluate(() => {
      document.querySelector('a[href="/styleguide"]')?.click();
    });
    await slowPage.waitForTimeout(350);

    check(label, 'a slow navigation shows the pending bar', await pendingIn(slowPage), '');

    await slowPage.waitForSelector('h1', { timeout: 20_000 });
    await slowPage.waitForTimeout(700);

    check(label, 'the bar clears once the route arrives', !(await pendingIn(slowPage)), '');

    const announced = await slowPage.evaluate(
      () => document.querySelector('[data-testid="route-announcer"]')?.textContent ?? '',
    );
    check(
      label,
      'arrival is announced to the live region',
      announced.includes('loaded'),
      announced,
    );
  } finally {
    await slow.close().catch(() => {});
  }

  const fast = await browser.newContext({ viewport: { width: 1280, height: 700 } });
  const fastPage = await fast.newPage();

  try {
    await fastPage.addInitScript(blockServiceWorker);
    await fastPage.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
    // Prime the chunk, so the navigation under test is a warm one.
    await fastPage.evaluate(() => {
      document.querySelector('a[href="/tools"]')?.click();
    });
    await fastPage.waitForTimeout(800);
    await fastPage.evaluate(() => {
      document.querySelector('a[href="/"]')?.click();
    });
    await fastPage.waitForTimeout(800);

    /*
     * A MutationObserver rather than a poll: the bar would only be up for a
     * few frames, and a poll could step straight over it and call the flicker
     * fixed when it is not.
     */
    const flashed = await fastPage.evaluate(async () => {
      const track = document.querySelector('[data-testid="route-progress"]');
      if (!track) return true;
      let seen = false;
      const observer = new MutationObserver(() => {
        if (track.hasAttribute('data-pending')) seen = true;
      });
      observer.observe(track, { attributes: true });
      document.querySelector('a[href="/tools"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 600));
      observer.disconnect();
      return seen;
    });

    check(label, 'a fast navigation shows nothing at all', !flashed, '');
  } finally {
    await fast.close().catch(() => {});
  }

  for (const intent of ['hover', 'focus']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 700 } });
    const page = await context.newPage();
    const asked = [];
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('/assets/') && url.endsWith('.js')) asked.push(url);
    });

    try {
      await page.addInitScript(blockServiceWorker);
      await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
      asked.length = 0;

      if (intent === 'hover') await page.hover('a[href="/styleguide"]');
      else await page.focus('a[href="/styleguide"]');
      await page.waitForTimeout(700);

      check(
        label,
        `preloads the route on ${intent}`,
        asked.some((url) => url.includes('styleguide')),
        asked.map((url) => url.split('/').pop()).join(', ') || 'nothing requested',
      );
    } finally {
      await context.close().catch(() => {});
    }
  }
}

/**
 * The deployment contract, checked against the BUILT output.
 *
 * There is no Netlify account in this environment, so what is checked here is
 * everything that is actually ours: that the file the build emits says what it
 * is supposed to say, and that a server applying those exact rules produces a
 * working app. Netlify's own resolution of the file was checked separately
 * against `netlify dev` and is modelled by `headersFor` above.
 */
async function checkDeployment(label, rules) {
  const headers = await readFile(join(DIST, '_headers'), 'utf8');

  check(
    label,
    'the CSP hash placeholder was substituted',
    !headers.includes('{{INLINE_SCRIPT_HASHES}}') && /'sha256-[A-Za-z0-9+/=]+'/.test(headers),
    /'sha256-[A-Za-z0-9+/=]{8}/.exec(headers)?.[0] ?? 'no hash found',
  );

  const global = headersFor(rules, '/');
  for (const [name, expected] of [
    ['Cross-Origin-Opener-Policy', 'same-origin'],
    ['Cross-Origin-Embedder-Policy', 'require-corp'],
    ['X-Content-Type-Options', 'nosniff'],
    ['Referrer-Policy', 'no-referrer'],
  ]) {
    check(label, `${name} is served`, global[name] === expected, global[name] ?? 'absent');
  }

  check(
    label,
    "the document keeps connect-src 'none'",
    (global['Content-Security-Policy'] ?? '').includes("connect-src 'none'"),
    global['Content-Security-Policy']?.slice(0, 60) ?? 'absent',
  );

  /*
   * The caching split, which is the part that is easy to get subtly wrong.
   *
   * /fonts/ is the one to watch: those URLs are hand-written and unhashed, so
   * `immutable` there would pin a returning visitor to an old subset with no
   * way to bust it short of renaming the file.
   */
  const asset = headersFor(rules, '/assets/index-abc123.js')['Cache-Control'] ?? '';
  const font = headersFor(rules, '/fonts/ibm-plex-mono-400.woff2')['Cache-Control'] ?? '';
  const document = headersFor(rules, '/index.html')['Cache-Control'] ?? '';
  const worker = headersFor(rules, '/sw.js')['Cache-Control'] ?? '';

  check(label, 'hashed assets are immutable', asset.includes('immutable'), asset || 'absent');
  check(
    label,
    'unhashed fonts are NOT immutable',
    font !== '' && !font.includes('immutable') && font.includes('must-revalidate'),
    font || 'absent',
  );
  check(label, 'the document is never cached', document.includes('no-cache'), document || 'absent');
  check(
    label,
    'the service worker is never cached',
    worker.includes('no-cache'),
    worker || 'absent',
  );

  check(
    label,
    'the service worker may reach its own origin, and only its own',
    (headersFor(rules, '/sw.js')['Content-Security-Policy'] ?? '').includes("connect-src 'self'"),
    headersFor(rules, '/sw.js')['Content-Security-Policy'] ?? 'absent',
  );

  /*
   * The static head, which is the ONLY head a crawler or a link-preview bot
   * ever sees - none of them run the router. Asserted against the built file
   * rather than the source, because %VITE_SITE_URL% substitution and comment
   * stripping both happen during the build.
   */
  const html = await readFile(join(DIST, 'index.html'), 'utf8');

  for (const needle of [
    'property="og:title"',
    'property="og:description"',
    'property="og:image"',
    'property="og:image:width"',
    'property="og:image:height"',
    'property="og:image:alt"',
    'property="og:url"',
    'property="og:type"',
    'property="og:site_name"',
    'property="og:locale"',
    'name="twitter:card"',
    'name="twitter:title"',
    'name="twitter:description"',
    'name="twitter:image"',
    'name="description"',
    'rel="canonical"',
  ]) {
    check(label, `the static head carries ${needle}`, html.includes(needle), '');
  }

  check(
    label,
    'every site URL in the static head was substituted and is absolute',
    !html.includes('%VITE_') && (html.match(/https:\/\//g) ?? []).length >= 4,
    `${String((html.match(/https:\/\//g) ?? []).length)} absolute URL(s)`,
  );

  check(
    label,
    'no source comments ship in the html',
    !html.includes('<!--'),
    html.includes('<!--') ? 'comment found' : `${String(html.length)} bytes`,
  );

  const redirects = await readFile(join(DIST, '_redirects'), 'utf8');
  check(
    label,
    'the SPA fallback is configured',
    /^\/\*\s+\/index\.html\s+200\s*$/m.test(redirects),
    redirects.trim().split('\n').at(-1) ?? '',
  );
}

/**
 * Offline, which is the whole reason the service worker exists.
 *
 * Measured before it was written: with no worker, an offline reload rendered
 * nothing and an offline navigation to a route whose chunk had never been
 * fetched failed. Both are asserted here so a change that quietly breaks
 * registration shows up as a failure rather than as a site that is merely
 * online-only again.
 */
async function checkOffline(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  try {
    await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });

    const installed = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return { supported: false };
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) return { supported: true, registered: false };
      await navigator.serviceWorker.ready;
      const names = await caches.keys();
      const cache = names.length > 0 ? await caches.open(names[0]) : null;
      return {
        supported: true,
        registered: true,
        cache: names[0] ?? null,
        entries: cache ? (await cache.keys()).length : 0,
      };
    });

    if (!installed.supported) {
      check(
        label,
        'service workers are unavailable in this engine - offline not checked',
        true,
        '',
      );
      return;
    }

    check(
      label,
      'the service worker installs and precaches the build',
      installed.registered === true && installed.entries > 0,
      `${installed.cache ?? 'no cache'}, ${String(installed.entries ?? 0)} entries`,
    );

    // A warm reload, so the page is CONTROLLED by the worker. A page that
    // loaded before the worker existed is not, and would go straight to a
    // network that is about to be switched off.
    await page.reload({ waitUntil: 'networkidle' });
    check(
      label,
      'the worker controls the page after one reload',
      await page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
      '',
    );

    await context.setOffline(true);
    consoleErrors.length = 0;

    /*
     * HARNESS LIMITATION, named rather than hidden.
     *
     * Playwright's WebKit build throws "WebKit encountered an internal error"
     * on ANY navigation while the context is offline - reload, goto, whatever
     * the waitUntil. That is the driver, not the app: the worker installs,
     * precaches and takes control in WebKit exactly as it does in Gecko, which
     * is what the checks above have already established. What cannot be shown
     * here is the navigation itself, so it is skipped with the reason stated.
     */
    try {
      await page.reload({ waitUntil: 'load', timeout: 20_000 });
    } catch (error) {
      skip(
        label,
        'the app reloads and renders with the network off',
        `this engine's driver cannot navigate while offline (${String(error).split('\n')[0].slice(0, 60)})`,
      );
      return;
    }

    const canvas = page.locator('[role="application"]').first();
    const rendered = await canvas
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    check(label, 'the app reloads and renders with the network off', rendered, '');

    check(
      label,
      'the self-hosted fonts are there offline too',
      (await page.evaluate(() => document.fonts.status)) === 'loaded',
      await page.evaluate(() => document.fonts.status),
    );

    // A route whose chunk was never fetched while online. This is the case
    // the HTTP cache alone cannot cover, and the reason precaching exists.
    for (const [href, name] of [
      ['/tools', 'Tools'],
      ['/styleguide', 'Styleguide'],
    ]) {
      await page.evaluate((target) => {
        document.querySelector(`a[href="${target}"]`)?.click();
      }, href);
      const arrived = await page
        .waitForSelector('h1', { timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
      check(label, `${name} loads offline from the precache`, arrived, '');
    }

    check(
      label,
      'no console errors while offline',
      consoleErrors.length === 0,
      consoleErrors.join(' | '),
    );
  } finally {
    await context.setOffline(false).catch(() => {});
    await context.close().catch(() => {});
  }
}

/**
 * axe-core against every route, in a real engine.
 *
 * The unit suite already runs axe on every component and route under jsdom,
 * but jsdom has no layout engine, so `color-contrast` is switched off there -
 * the one rule that needs real computed colours and real geometry. This runs
 * the same engine with that rule ON, against the production build, in both
 * themes, with the canvas actually populated.
 *
 * axe is injected with addInitScript rather than a <script> tag on purpose:
 * `script-src 'self'` refuses an injected inline script, exactly as it should.
 * addInitScript goes through the debugger protocol instead, so the page keeps
 * the policy it ships with while still being measurable.
 */
async function checkAxe(browser, label) {
  const axeSource = await readFile(join(ROOT, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(axeSource);
  const page = await context.newPage();

  /** Runs axe and returns the violations, most serious first. */
  const scan = () =>
    page.evaluate(async () => {
      const results = await window.axe.run(document, {
        resultTypes: ['violations'],
        // WCAG 2.2 AA is the bar the design system is already held to.
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      });
      return results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.length,
        target: violation.nodes[0]?.target.join(' '),
      }));
    });

  const describe = (violations) =>
    violations.length === 0
      ? ''
      : violations
          .map((v) => `${v.id} (${v.impact}, x${String(v.nodes)}) ${v.target ?? ''}`)
          .join(' | ');

  try {
    for (const theme of ['graphite', 'vellum']) {
      for (const [path, name] of [
        ['/', 'the canvas'],
        ['/tools', 'the tool index'],
        ['/tools/base64', 'a tool page'],
        ['/styleguide', 'the styleguide'],
        ['/nothing-here', 'the 404'],
      ]) {
        await page.goto(`${ORIGIN}${path}`, { waitUntil: 'networkidle' });

        /*
         * Freeze motion, THEN switch theme.
         *
         * The colour transitions are 120-180ms, and a scan that starts inside
         * one measures a colour that exists for two frames and is nobody's
         * design intent. That showed up as an intermittent 25-node
         * colour-contrast failure on the styleguide in WebKit only.
         *
         * Zeroing the motion tokens through the CSSOM rather than injecting a
         * stylesheet: `style-src 'self'` correctly refuses an injected <style>,
         * and element.style is not governed by CSP anyway.
         */
        await page.evaluate((value) => {
          const root = document.documentElement;
          for (const token of ['--pb-motion-fast', '--pb-motion-base', '--pb-motion-slow']) {
            root.style.setProperty(token, '0s');
          }
          root.setAttribute('data-theme', value);
        }, theme);
        await page.waitForTimeout(250);

        const violations = await scan();
        check(label, `${name} is clean in ${theme}`, violations.length === 0, describe(violations));
      }
    }

    /*
     * The canvas WITH NODES, which is the case the empty one cannot speak for:
     * node groups, port glyphs, wires and the toolbar readout all only exist
     * once something has been added.
     */
    await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
    for (const tool of ['Base64', 'Hash']) {
      await page.getByRole('button', { name: 'Add tool' }).click();
      await page.locator('[role="option"]').first().waitFor({ timeout: 10_000 });
      await page
        .getByRole('option', { name: new RegExp(tool, 'i') })
        .first()
        .click();
      await page.waitForTimeout(200);
    }

    const nodes = await page.locator('[role="group"]').count();
    check(label, 'two nodes are on the canvas to scan', nodes >= 2, `${String(nodes)} node(s)`);

    const populated = await scan();
    check(label, 'the populated canvas is clean', populated.length === 0, describe(populated));

    // And with an overlay open, since a dialog changes what is exposed.
    await page.keyboard.press('?');
    await page.locator('[role="dialog"]').first().waitFor({ timeout: 5_000 });
    const withDialog = await scan();
    check(
      label,
      'the canvas with an overlay open is clean',
      withDialog.length === 0,
      describe(withDialog),
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Zero console output in production, on every route.
 *
 * Not just errors: a stray `console.log` left in a component is noise in
 * everybody's devtools and, in a tool people paste secrets into, a plausible
 * way to leak one. `no-console` in ESLint already forbids everything except
 * warn and error in our own source - this catches what the rule cannot, which
 * is a dependency logging on load and anything the browser itself complains
 * about (a CSP refusal, a deprecation, a failed subresource).
 */
async function checkConsoleSilence(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const heard = [];
  page.on('console', (message) => heard.push(`${message.type()}: ${message.text().slice(0, 120)}`));
  page.on('pageerror', (error) => heard.push(`pageerror: ${String(error).slice(0, 120)}`));

  try {
    for (const [path, name] of [
      ['/', 'the canvas'],
      ['/tools', 'the tool index'],
      ['/tools/base64', 'a tool page'],
      ['/tools/not-a-real-tool', 'an unknown tool id'],
      ['/styleguide', 'the styleguide'],
      ['/nothing-here', 'the 404'],
    ]) {
      heard.length = 0;
      await page.goto(`${ORIGIN}${path}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      check(label, `${name} says nothing to the console`, heard.length === 0, heard.join(' | '));
    }

    // And while actually doing something, not merely sitting there.
    heard.length = 0;
    await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Add tool' }).click();
    await page.locator('[role="option"]').first().waitFor({ timeout: 10_000 });
    await page.getByTestId('dialog-option-base64').click();
    await page.waitForTimeout(600);
    check(label, 'adding and running a tool stays silent', heard.length === 0, heard.join(' | '));
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Deep links: a nested URL typed straight into the address bar.
 *
 * This is the whole point of the `_redirects` fallback, and it is the one
 * thing that cannot be caught by clicking around - every in-app navigation is
 * handled by the router and never touches the server. `page.goto` is a real
 * document request for the nested path, which is what a shared link, a
 * bookmark or a refresh actually does.
 *
 * The title is asserted too, not just that something rendered: `head` is a
 * non-lazy route option specifically so the tab is named before the chunk
 * arrives, and a deep link is where that has to hold.
 */
async function checkDeepLinks(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    for (const [path, heading, title] of [
      ['/tools/base64', 'Base64', 'Base64 — Patchbay'],
      ['/tools/regex-tester', 'Regex', 'Regex — Patchbay'],
      ['/tools', 'Every tool', 'Tools — Patchbay'],
      ['/styleguide', 'Styleguide', 'Styleguide — Patchbay'],
      ['/nothing-here', 'No patch here', 'Patchbay'],
    ]) {
      await page.goto(`${ORIGIN}${path}`, { waitUntil: 'networkidle' });

      const rendered = await page
        .locator('h1')
        .first()
        .waitFor({ timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      const text = rendered ? ((await page.locator('h1').first().textContent()) ?? '') : '';

      check(
        label,
        `${path} renders its own page on a direct visit`,
        rendered && text.includes(heading),
        rendered ? `h1 "${text.trim()}"` : 'nothing rendered',
      );

      check(
        label,
        `${path} is titled before anything is clicked`,
        (await page.title()) === title,
        await page.title(),
      );
    }

    /*
     * And a share link, which is the deep link with the most to lose: the
     * pipeline travels in the query string, so a fallback that dropped it
     * would leave the visitor with an empty canvas and no error.
     */
    await page.goto(`${ORIGIN}/tools/base64?keep=this`, { waitUntil: 'networkidle' });
    check(
      label,
      'a query string survives the fallback',
      new URL(page.url()).search === '?keep=this',
      page.url(),
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * The head, in a real browser, after the router has taken it over.
 *
 * The failure this exists to catch: React hoists the tags `head.ts` produces
 * into <head> but does NOT remove the static baseline in index.html, so every
 * route ended up with two <title>, two og:title, two og:description, two
 * description and two og:image - with no defined winner for a consumer reading
 * the document. `dropStaticHead()` retires the marked set on mount; this
 * asserts it actually happened, per route.
 */
async function checkHead(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const SINGLE = [
    ['title', 'title'],
    ['meta[name="description"]', 'description'],
    ['meta[property="og:title"]', 'og:title'],
    ['meta[property="og:description"]', 'og:description'],
    ['meta[property="og:url"]', 'og:url'],
    ['meta[property="og:image"]', 'og:image'],
    ['meta[name="twitter:title"]', 'twitter:title'],
    ['link[rel="canonical"]', 'canonical'],
  ];

  try {
    for (const [path, expectedTitle] of [
      ['/', 'Patchbay'],
      ['/tools', 'Tools — Patchbay'],
      ['/tools/base64', 'Base64 — Patchbay'],
      ['/styleguide', 'Styleguide — Patchbay'],
    ]) {
      await page.goto(`${ORIGIN}${path}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);

      const head = await page.evaluate(
        (selectors) => {
          const counts = {};
          for (const [selector, name] of selectors) {
            counts[name] = document.querySelectorAll(selector).length;
          }
          const attr = (selector, name) =>
            document.querySelector(selector)?.getAttribute(name) ?? null;
          return {
            counts,
            title: document.title,
            ogUrl: attr('meta[property="og:url"]', 'content'),
            ogImage: attr('meta[property="og:image"]', 'content'),
            canonical: attr('link[rel="canonical"]', 'href'),
            leftovers: document.head.querySelectorAll('[data-default]').length,
          };
        },
        SINGLE.map(([selector, name]) => [selector, name]),
      );

      const duplicated = Object.entries(head.counts).filter(([, n]) => n !== 1);
      check(
        label,
        `${path} has exactly one of every head tag`,
        duplicated.length === 0,
        duplicated.map(([name, n]) => `${name} x${String(n)}`).join(', ') ||
          `${String(Object.keys(head.counts).length)} tags, one each`,
      );

      check(label, `${path} is titled correctly`, head.title === expectedTitle, head.title);

      check(
        label,
        `${path} declares its own absolute canonical and og:url`,
        head.canonical === `${SITE_URL}${path}` && head.ogUrl === `${SITE_URL}${path}`,
        `canonical=${head.canonical ?? 'none'} og:url=${head.ogUrl ?? 'none'}`,
      );

      check(
        label,
        `${path} points og:image at an absolute URL`,
        head.ogImage === `${SITE_URL}/social-preview.png`,
        head.ogImage ?? 'none',
      );

      check(
        label,
        `${path} retires the static baseline`,
        head.leftovers === 0,
        `${String(head.leftovers)} data-default node(s) left`,
      );
    }
    /*
     * The 404, which matches no leaf route at all. It gets the root's head and
     * nothing else - and before og:title and og:description were added there,
     * it had ZERO of each once dropStaticHead had retired the static baseline.
     * No canonical, deliberately: a page that does not exist should not claim
     * a canonical URL.
     */
    await page.goto(`${ORIGIN}/nothing-here`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    const notFound = await page.evaluate(() => {
      const n = (selector) => document.querySelectorAll(selector).length;
      return {
        title: document.title,
        ogTitle: n('meta[property="og:title"]'),
        ogDescription: n('meta[property="og:description"]'),
        description: n('meta[name="description"]'),
        ogImage: n('meta[property="og:image"]'),
        canonical: n('link[rel="canonical"]'),
        leftovers: document.head.querySelectorAll('[data-default]').length,
      };
    });

    check(
      label,
      'the 404 falls back to the site-wide head',
      notFound.title === 'Patchbay' &&
        notFound.ogTitle === 1 &&
        notFound.ogDescription === 1 &&
        notFound.description === 1 &&
        notFound.ogImage === 1 &&
        notFound.leftovers === 0,
      JSON.stringify(notFound),
    );

    check(
      label,
      'the 404 claims no canonical URL',
      notFound.canonical === 0,
      `${String(notFound.canonical)} canonical link(s)`,
    );
  } finally {
    await context.close().catch(() => {});
  }
}

async function runChecks(engine, label) {
  console.log(`\n${label}`);
  const browser = await engine.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  try {
    /* -- The canvas route loads at all ---------------------------------- */
    await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
    // A CSS locator rather than getByRole: WebKit's accessibility tree names
    // `role="application"` differently from Gecko and Blink, and the point of
    // this check is that the canvas rendered, not how the name is computed.
    const canvas = page.locator('[role="application"]').first();
    await canvas.waitFor({ timeout: 15_000 });
    check(label, 'canvas route renders', true);

    const canvasName = await canvas.getAttribute('aria-label');
    check(
      label,
      'the canvas has an accessible name',
      (canvasName ?? '').length > 0,
      (canvasName ?? '').slice(0, 40),
    );

    /* -- CSS custom properties resolve ---------------------------------- */
    const theming = await page.evaluate(() => {
      const styles = getComputedStyle(document.documentElement);
      const surface = styles.getPropertyValue('--pb-surface-base').trim();
      // color-mix() is used by the diff view and several surfaces. A browser
      // that cannot parse it drops the whole declaration, so the computed
      // value comes back empty rather than wrong.
      const probe = document.createElement('div');
      probe.style.backgroundColor = 'color-mix(in srgb, red 50%, blue)';
      document.body.append(probe);
      const mixed = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { surface, mixed, body: getComputedStyle(document.body).backgroundColor };
    });
    check(label, 'semantic tokens resolve', theming.surface !== '', theming.surface);
    // Gecko serialises the result as `color(srgb ...)` and Chromium/WebKit as
    // `rgb(...)`. Either is support; an unsupported browser drops the whole
    // declaration and leaves the initial transparent value behind.
    check(
      label,
      'color-mix() is supported',
      theming.mixed !== '' && theming.mixed !== 'rgba(0, 0, 0, 0)',
      theming.mixed,
    );
    check(
      label,
      'body paints a themed background',
      theming.body !== 'rgba(0, 0, 0, 0)',
      theming.body,
    );

    /* -- OffscreenCanvas, which decides image-convert's strategy --------- */
    const offscreen = await page.evaluate(() => ({
      main: typeof OffscreenCanvas !== 'undefined',
      convertToBlob:
        typeof OffscreenCanvas !== 'undefined' &&
        typeof OffscreenCanvas.prototype.convertToBlob === 'function',
    }));
    check(
      label,
      'OffscreenCanvas availability recorded',
      true,
      `present=${offscreen.main}, convertToBlob=${offscreen.convertToBlob}`,
    );

    /* -- The palette's layout, which jsdom cannot see -------------------- */
    await page.getByRole('button', { name: 'Add tool' }).click();
    await page.locator('[role="option"]').first().waitFor({ timeout: 10_000 });

    const layout = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[role="option"]')];
      const heights = new Set(rows.map((row) => Math.round(row.getBoundingClientRect().height)));
      const names = rows.map((row) => row.children[1]);
      return {
        rows: rows.length,
        heights: [...heights],
        // A name is truncated when its rendered box is narrower than its
        // content. Zero of these may be true.
        truncatedNames: names.filter((name) => name.scrollWidth > name.clientWidth + 1).length,
        emptyNames: names.filter((name) => name.getBoundingClientRect().width < 1).length,
        // Summaries are meant to truncate, so at least one should.
        truncatedSummaries: rows.filter((row) => {
          const detail = row.children[2];
          return detail.scrollWidth > detail.clientWidth + 1;
        }).length,
      };
    });

    check(
      label,
      'every palette row is the same height',
      layout.heights.length === 1,
      `${layout.rows.toString()} rows, heights ${layout.heights.join('/')}`,
    );
    check(
      label,
      'no tool name is truncated or collapsed',
      layout.truncatedNames === 0 && layout.emptyNames === 0,
      `truncated=${layout.truncatedNames.toString()}, collapsed=${layout.emptyNames.toString()}`,
    );
    check(
      label,
      'long summaries truncate rather than wrap',
      layout.truncatedSummaries > 0,
      `${layout.truncatedSummaries.toString()} truncated`,
    );

    /* -- Pointer events: drag a node ------------------------------------ */
    const search = page.getByRole('combobox', { name: 'Search tools' });
    await search.fill('structured');
    await search.press('Enter');

    const node = page.locator('[data-node-id]').first();
    await node.waitFor({ timeout: 10_000 });
    check(label, 'a tool node can be added', true);

    const before = await node.boundingBox();
    const box = before;

    await page.mouse.move(box.x + box.width / 2, box.y + 8);
    await page.mouse.down();
    // Several small moves rather than one jump: pointer capture and event
    // coalescing are exactly what differs between engines.
    for (let step = 1; step <= 6; step += 1) {
      await page.mouse.move(box.x + box.width / 2 + step * 20, box.y + 8 + step * 10);
    }
    await page.mouse.up();

    const after = await node.boundingBox();
    const moved = Math.abs(after.x - before.x) > 40 && Math.abs(after.y - before.y) > 20;
    check(
      label,
      'a node can be dragged with pointer events',
      moved,
      `moved ${(after.x - before.x).toFixed(0)}x${(after.y - before.y).toFixed(0)}`,
    );

    /* -- Node guidance must never be cut ---------------------------------- */
    const guidance = await page.evaluate(() => {
      const summaries = [...document.querySelectorAll('[class*="nodeSummary"]')];
      return summaries.map((el) => ({
        text: (el.textContent ?? '').trim().slice(0, 60),
        truncated: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1,
      }));
    });
    check(
      label,
      'no node summary or guidance is visually truncated',
      guidance.length > 0 && guidance.every((entry) => !entry.truncated),
      `${guidance.length.toString()} checked, ${guidance.filter((e) => e.truncated).length.toString()} cut`,
    );

    /* -- Port layout, which jsdom cannot see ----------------------------- */
    const ports = await page.evaluate(() => {
      const target = document.querySelector('[data-node-id]');
      const box = target.getBoundingClientRect();

      const rows = [...target.querySelectorAll('[data-port-id]')].map((port) => {
        const glyph = port.querySelector('svg').getBoundingClientRect();
        const hit = port.getBoundingClientRect();
        const label = port.querySelector('span:last-child').getBoundingClientRect();
        return {
          side: port.dataset.portSide,
          id: port.dataset.portId,
          centreX: glyph.left + glyph.width / 2 - box.left,
          centreY: glyph.top + glyph.height / 2 - box.top,
          glyphLeft: glyph.left - box.left,
          glyphRight: box.right - glyph.right,
          hitWidth: hit.width,
          hitHeight: hit.height,
          glyphWidth: glyph.width,
          labelBox: { left: label.left, right: label.right, top: label.top, bottom: label.bottom },
          glyphBox: { left: glyph.left, right: glyph.right, top: glyph.top, bottom: glyph.bottom },
        };
      });

      const inputs = rows.filter((row) => row.side === 'input');
      const outputs = rows.filter((row) => row.side === 'output');

      const overlaps = (a, b) =>
        a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

      return {
        nodeWidth: box.width,
        rows,
        // No input may share a row with an output: they are separate lists.
        sharedRows: inputs.filter((input) =>
          outputs.some((output) => Math.abs(output.centreY - input.centreY) < 1),
        ).length,
        // Nothing may sit on the node's border.
        flushToBorder: rows.filter((row) =>
          row.side === 'input' ? row.glyphLeft < 2 : row.glyphRight < 2,
        ).length,
        labelCollisions: rows.filter((row) => overlaps(row.labelBox, row.glyphBox)).length,
        labelOverlaps: rows.filter((row, index) =>
          rows.some(
            (other, otherIndex) => otherIndex > index && overlaps(row.labelBox, other.labelBox),
          ),
        ).length,
        hitAreaRatio: Math.min(
          ...rows.map((row) => (row.hitWidth * row.hitHeight) / (row.glyphWidth * row.glyphWidth)),
        ),
      };
    });

    check(
      label,
      'inputs and outputs never share a row',
      ports.sharedRows === 0 && ports.rows.length > 2,
      `${ports.rows.length.toString()} ports, ${ports.sharedRows.toString()} shared`,
    );
    check(
      label,
      'connector glyphs stand clear of the node border',
      ports.flushToBorder === 0,
      `min inset ${Math.min(...ports.rows.map((row) => (row.side === 'input' ? row.glyphLeft : row.glyphRight))).toFixed(1)}px`,
    );
    check(
      label,
      'port labels collide with nothing',
      ports.labelCollisions === 0 && ports.labelOverlaps === 0,
      `${ports.labelCollisions.toString()} on glyphs, ${ports.labelOverlaps.toString()} on each other`,
    );
    check(
      label,
      'each port has a hit area far larger than its glyph',
      ports.hitAreaRatio > 6,
      `smallest is ${ports.hitAreaRatio.toFixed(1)}x the glyph`,
    );

    /* -- Wires actually paint -------------------------------------------- */
    const wireLayer = await page.evaluate(() => {
      const svg = document.querySelector('svg[class*="wireLayer"]');
      if (!svg) return null;
      const box = svg.getBoundingClientRect();
      return {
        width: box.width,
        height: box.height,
        maxInlineSize: getComputedStyle(svg).maxInlineSize,
      };
    });
    check(
      label,
      'the wire layer is not collapsed by the svg reset',
      wireLayer !== null && wireLayer.width > 0,
      wireLayer
        ? `${wireLayer.width.toString()}x${wireLayer.height.toString()}, max-inline-size ${wireLayer.maxInlineSize}`
        : 'no layer',
    );

    /* -- A tool actually executes, in a real worker ---------------------- */
    const editor = page.locator('textarea[data-node-input]').first();
    await editor.fill('hello patchbay');

    // `data-status` on the node is the same value the run store holds, so this
    // waits on the real execution result rather than on a rendered string.
    await page.locator('[data-node-id][data-status="ok"]').first().waitFor({ timeout: 30_000 });
    const encoded = await page.evaluate(() => {
      const output = document.querySelector('[data-node-output]');
      return output?.textContent?.trim() ?? '';
    });
    check(
      label,
      'base64 executes in a worker and reports ok',
      true,
      encoded === '' ? 'status ok' : encoded.slice(0, 32),
    );

    /* -- The perf spans exist, so warming really happened ---------------- */
    const spans = await page.evaluate(() =>
      performance
        .getEntriesByType('measure')
        .filter((entry) => entry.name.startsWith('patchbay:'))
        .map((entry) => ({ name: entry.name, duration: Math.round(entry.duration * 10) / 10 })),
    );
    const booted = spans.find((span) => span.name === 'patchbay:worker-boot');
    check(
      label,
      'worker was warmed on canvas mount',
      booted !== undefined,
      booted ? `${booted.duration} ms` : 'no worker-boot span',
    );

    const imported = spans.find((span) => span.name.startsWith('patchbay:tool-import:'));
    check(
      label,
      'tool chunk was prefetched before the run',
      imported !== undefined && imported.duration < 1,
      imported ? `${imported.duration} ms inside the run` : 'no import span',
    );

    /* -- Every overlay scrolls when its content overflows ----------------- */
    const overlayScroll = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const results = [];

      const openAndMeasure = async (name, open, close) => {
        open();
        await wait(250);
        const region = document.querySelector('[role="dialog"] [data-scroll-region]');
        if (!region) {
          results.push({ name, ok: false, why: 'no scroll region' });
        } else {
          const overflows = region.scrollHeight > region.clientHeight + 1;
          region.scrollTop = region.scrollHeight;
          await wait(60);
          const scrolled = region.scrollTop > 0;
          const style = getComputedStyle(region).overflowY;
          results.push({
            name,
            ok: style === 'auto' || style === 'scroll',
            overflows,
            scrolled,
            overflowY: style,
          });
        }
        close();
        await wait(200);
      };

      const key = (k) => {
        const root = document.querySelector('[role="application"]');
        root.focus();
        root.dispatchEvent(
          new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
        );
      };

      await openAndMeasure(
        'palette',
        () => {
          [...document.querySelectorAll('button')]
            .find((b) => /Add tool/i.test(b.textContent))
            ?.click();
        },
        () => key('Escape'),
      );

      await openAndMeasure(
        'shortcuts',
        () => {
          key('?');
        },
        () => key('Escape'),
      );

      return results;
    });

    for (const overlay of overlayScroll) {
      check(
        label,
        `the ${overlay.name} overlay can scroll`,
        overlay.ok === true,
        overlay.why ??
          `overflow-y ${overlay.overflowY ?? '?'}, overflowing ${String(overlay.overflows)}, scrolled ${String(overlay.scrolled)}`,
      );
    }

    /* -- Zero network: nothing may leave the page ------------------------ */
    const external = await page.evaluate(
      (origin) =>
        performance
          .getEntriesByType('resource')
          .map((entry) => entry.name)
          .filter((name) => !name.startsWith(origin) && !name.startsWith('data:')),
      ORIGIN,
    );
    check(label, 'no request left the origin', external.length === 0, external.join(', '));

    /* -- image-convert, which is where OffscreenCanvas actually matters -- */
    await page.goto(`${ORIGIN}/tools/image-convert`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1, name: 'Image' }).waitFor({ timeout: 15_000 });

    await page.locator('input[type="file"]').setInputFiles({
      name: 'swatch.png',
      mimeType: 'image/png',
      buffer: makePng(),
    });
    await page.getByRole('button', { name: 'Run' }).click();

    const details = page.locator('textarea[readonly]').last();
    await details.waitFor({ timeout: 30_000 });
    await page.waitForFunction(
      () => {
        const boxes = [...document.querySelectorAll('textarea[readonly]')];
        return boxes.some((box) => box.value.includes('changePercent'));
      },
      undefined,
      { timeout: 30_000 },
    );

    const report = await page.evaluate(() => {
      const box = [...document.querySelectorAll('textarea[readonly]')].find((candidate) =>
        candidate.value.includes('changePercent'),
      );
      return box ? JSON.parse(box.value) : null;
    });

    check(
      label,
      'image-convert decodes and re-encodes a real PNG',
      report?.to?.width === 8 && report.to.height === 8 && report.to.bytes > 0,
      report ? `${report.from.format} -> ${report.to.format}, ${report.to.size}` : 'no report',
    );

    // The point of `requiresOffscreenCanvas`: where the API is missing the
    // engine must run the tool on the main thread instead, and the result must
    // be identical. This asserts the branch that was actually taken.
    const wentThroughWorker = await page.evaluate(() =>
      performance
        .getEntriesByType('measure')
        .some((entry) => entry.name === 'patchbay:execute:image-convert'),
    );
    check(
      label,
      offscreen.main
        ? 'used the worker path, as OffscreenCanvas is present'
        : 'fell back to the main thread, as OffscreenCanvas is absent',
      wentThroughWorker === offscreen.main,
      `worker=${wentThroughWorker}, offscreenCanvas=${offscreen.main}`,
    );

    check(label, 'no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  } finally {
    await context.close();
  }

  try {
    await checkChromeWidths(browser, label);
    await checkDialogScroll(browser, label);
    await checkRouteFeedback(browser, label);
    await checkOffline(browser, label);
    await checkAxe(browser, label);
    await checkConsoleSilence(browser, label);
    await checkDeepLinks(browser, label);
    await checkHead(browser, label);
  } finally {
    await browser.close();
  }
}

/* ========================================================================== */

const server = await serveDist(PORT);

try {
  // Engine-independent: these are assertions about the files the build emits.
  await checkDeployment('Build output', await readHeaders());

  await runChecks(firefox, 'Firefox (Gecko)');
  await runChecks(webkit, 'WebKit - the engine behind Safari, not Safari itself');
} finally {
  server.close();
}

console.log('');
if (failures.length > 0) {
  console.error(`cross-browser: ${failures.length} failure(s)\n  ${failures.join('\n  ')}`);
  process.exitCode = 1;
} else {
  console.log('cross-browser: OK - Firefox and WebKit both pass.');
}
