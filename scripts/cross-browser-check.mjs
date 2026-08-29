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
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { firefox, webkit } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const PORT = 4319;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/**
 * A static server for `dist`, applying the same headers as `public/_headers`.
 *
 * Serving without the CSP would be testing a different application: a header
 * that breaks the worker or the fonts in one engine and not another is exactly
 * the kind of divergence this script exists to catch.
 */
async function serveDist() {
  const headers = await readHeaders();

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', ORIGIN);
      let filePath = normalize(join(DIST, decodeURIComponent(url.pathname)));

      if (!filePath.startsWith(DIST)) {
        response.writeHead(403).end();
        return;
      }

      let body;
      try {
        const info = await stat(filePath);
        if (info.isDirectory()) filePath = join(filePath, 'index.html');
        body = await readFile(filePath);
      } catch {
        // SPA fallback: every unknown path is a client route.
        filePath = join(DIST, 'index.html');
        body = await readFile(filePath);
      }

      response.writeHead(200, {
        'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
        ...headers,
      });
      response.end(body);
    })();
  });

  await new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', resolve);
  });

  return server;
}

/**
 * Parses the flat `_headers` file into the global header set.
 *
 * Read from `dist`, not `public`: the source copy still carries the
 * {{INLINE_SCRIPT_HASHES}} placeholder, and serving that would test a policy
 * nobody deploys - it blocks the inline theme script in every engine. The
 * built copy has the real hash written in by the csp-hash plugin.
 */
async function readHeaders() {
  const raw = await readFile(join(DIST, '_headers'), 'utf8');
  const headers = {};
  let inGlobal = false;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      inGlobal = trimmed === '/*';
      continue;
    }

    if (!inGlobal) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    headers[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim();
  }

  /*
   * CROSS-BROWSER FINDING, and why one directive is dropped here.
   *
   * `upgrade-insecure-requests` rewrites http:// subresources to https://.
   * Chromium and Gecko exempt loopback from that; WebKit does not, so every
   * asset on http://127.0.0.1 is upgraded and then fails to connect - the page
   * loads a bare HTML document and nothing else.
   *
   * In production the app is served over https, where the directive is a
   * belt-and-braces no-op. Here it would only mean testing the wrong thing, so
   * it is removed from the policy this harness serves - and named, rather than
   * quietly dropped, because it is a genuine engine difference.
   */
  const csp = headers['Content-Security-Policy'];
  if (typeof csp === 'string') {
    headers['Content-Security-Policy'] = csp
      .split(';')
      .map((directive) => directive.trim())
      .filter((directive) => directive !== 'upgrade-insecure-requests')
      .join('; ');
  }

  return headers;
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

function check(browser, name, passed, detail = '') {
  const mark = passed ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${name}${detail ? ` - ${detail}` : ''}`);
  if (!passed) failures.push(`${browser}: ${name}${detail ? ` - ${detail}` : ''}`);
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

    /* -- Pointer events: drag a node ------------------------------------ */
    await page.getByRole('button', { name: 'Add tool' }).click();
    const search = page.getByRole('combobox', { name: 'Search tools' });
    await search.fill('base64');
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
    await browser.close();
  }
}

/* ========================================================================== */

const server = await serveDist();

try {
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
