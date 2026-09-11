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
import { deflateRawSync, deflateSync } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

/**
 * A genuine RGBA PNG of any size, from a pixel function.
 *
 * `makePng` above is the 8x8 gradient the original smoke check uses; this is
 * the same encoder generalised, because the visual checks below need images
 * with specific, known content: an alpha channel, a hard edge, a stripe
 * pattern fine enough to alias.
 */
function makeRgbaPng(width, height, pixel) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const raw = Buffer.alloc(height * (width * 4 + 1));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
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

/**
 * Sixteen flat 4x4 blocks of known colour.
 *
 * Flat blocks rather than a gradient, because JPEG is a frequency codec: it
 * reproduces a flat area almost exactly and mangles a hard edge, so sampling
 * block centres measures the CODEC rather than measuring ringing.
 */
const SWATCH_COLOURS = [
  [0, 0, 0],
  [255, 255, 255],
  [230, 30, 30],
  [30, 190, 60],
  [40, 70, 220],
  [240, 200, 20],
  [120, 120, 120],
  [200, 90, 160],
  [10, 140, 150],
  [250, 130, 40],
  [60, 60, 60],
  [190, 190, 190],
  [90, 20, 130],
  [20, 90, 30],
  [220, 220, 160],
  [35, 35, 90],
];

function makeSwatchPng() {
  return makeRgbaPng(16, 16, (x, y) => {
    const index = Math.floor(y / 4) * 4 + Math.floor(x / 4);
    const [r, g, b] = SWATCH_COLOURS[index];
    return [r, g, b, 255];
  });
}

/** Left half opaque red, right half fully transparent. */
function makeTransparentPng() {
  return makeRgbaPng(8, 8, (x) => (x < 4 ? [230, 30, 30, 255] : [0, 0, 0, 0]));
}

/**
 * One-pixel vertical stripes.
 *
 * The classic downscale probe: averaged correctly, an 8x reduction of this is
 * uniform mid-grey. Point-sampled, it is stripes, moire, or solid black -
 * which is a plausible-looking image and a wrong one.
 */
function makeStripesPng() {
  return makeRgbaPng(512, 64, (x) => (x % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
}

/**
 * A decompression bomb: 1-bit greyscale, so 20000x20000 costs 48 kB on disk
 * and 1.6 GB decoded. Measured here: both engines decode it SUCCESSFULLY in
 * about two seconds, which is why the tool's size guard reads the header
 * rather than the decoded bitmap.
 */
function makeBombPng(size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 1;
  ihdr[9] = 0;
  const rowBytes = Math.ceil(size / 8) + 1;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(rowBytes * size), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A two-frame animated GIF: frame one red, frame two blue. */
function makeAnimatedGif(size = 8) {
  const parts = [Buffer.from('GIF89a', 'ascii')];
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(size, 0);
  screen.writeUInt16LE(size, 2);
  screen[4] = 0x80; // global colour table, two entries
  parts.push(screen, Buffer.from([230, 30, 30, 40, 70, 220]));
  parts.push(Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('NETSCAPE2.0', 'ascii'));
  parts.push(Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]));

  for (const index of [0, 1]) {
    parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x32, 0x00, 0x00, 0x00]));
    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(size, 5);
    descriptor.writeUInt16LE(size, 7);
    parts.push(descriptor);

    // LZW with a minimum code size of 2: clear, one index per pixel, end.
    const codes = [4, ...Array.from({ length: size * size }, () => index), 5];
    let bits = 0;
    let accumulator = 0;
    const packed = [];
    for (const code of codes) {
      accumulator |= code << bits;
      bits += 3;
      while (bits >= 8) {
        packed.push(accumulator & 0xff);
        accumulator >>= 8;
        bits -= 8;
      }
    }
    if (bits > 0) packed.push(accumulator & 0xff);

    parts.push(Buffer.from([0x02]));
    for (let at = 0; at < packed.length; at += 255) {
      const slice = packed.slice(at, at + 255);
      parts.push(Buffer.from([slice.length]), Buffer.from(slice));
    }
    parts.push(Buffer.from([0x00]));
  }

  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

/**
 * Splices an EXIF APP1 - orientation, a GPS pointer and a comment - into a
 * JPEG that a real encoder produced.
 *
 * There is no JPEG encoder in this file and writing one would be absurd, so
 * the pixels come from a canvas in the page and the metadata is added here.
 * The result is a file shaped exactly like a photograph off a phone: upright
 * pixels, a flag saying to rotate them, and coordinates nobody asked for.
 */
function withExif(jpegBytes, orientation) {
  const tiff = [];
  const u16 = (value) => {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16BE(value);
    return buffer;
  };
  const u32 = (value) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value);
    return buffer;
  };

  tiff.push(Buffer.from('MM', 'ascii'), u16(42), u32(8), u16(2));
  tiff.push(u16(0x0112), u16(3), u32(1), u16(orientation), u16(0));
  // A GPS IFD pointer. Tag 0x8825 is what makes a holiday snap a location log.
  tiff.push(u16(0x8825), u16(4), u32(1), u32(8 + 2 + 24 + 4));
  tiff.push(u32(0), u16(0), u32(0));

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), Buffer.concat(tiff)]);
  const app1 = Buffer.alloc(4);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(payload.length + 2, 2);

  const comment = Buffer.from('patchbay-secret-comment', 'ascii');
  const com = Buffer.alloc(4);
  com[0] = 0xff;
  com[1] = 0xfe;
  com.writeUInt16BE(comment.length + 2, 2);

  return Buffer.concat([
    jpegBytes.subarray(0, 2),
    app1,
    payload,
    com,
    comment,
    jpegBytes.subarray(2),
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

/**
 * A share payload, encoded exactly as the app encodes one.
 *
 * Installing a graph by driving the palette would be forty interactions per
 * check; a link is the app's own supported way to be handed a whole pipeline,
 * and using it exercises the decoder into the bargain. `deflate-raw` matches
 * the CompressionStream the encoder uses - see share.ts.
 */
function shareParam(payload) {
  return deflateRawSync(Buffer.from(JSON.stringify(payload), 'utf8'))
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

/**
 * Takes the cold open down, if this page is showing one.
 *
 * EVERY CONTEXT HERE IS FRESH, which makes every context a first-time visitor,
 * which makes `/` answer with the introduction panel and hold the app inert
 * behind it. That is the product's behaviour rather than a test artefact - so
 * the harness walks through it the way a person does instead of seeding
 * storage to skip it, and `checkColdOpen` below is where the panel itself is
 * the subject rather than the obstacle.
 *
 * Silent when there is nothing to dismiss: a share link, a deep link and a
 * reload after the flag has been written all arrive with no panel at all, and
 * a helper that threw on those would have to be guarded at every call site.
 */
async function dismissColdOpen(page) {
  const start = page.locator('#cold-open-start');
  if ((await start.count()) === 0) return;
  await start.click();
  await page.locator('#cold-open').waitFor({ state: 'detached', timeout: 15_000 });
}

/** Opens a canvas URL and leaves the introduction behind. */
async function gotoCanvas(page, path = '/') {
  await page.goto(`${ORIGIN}${path}`, { waitUntil: 'networkidle' });
  await dismissColdOpen(page);
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
      await gotoCanvas(page);
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
          barLabels: controls.map((i) => i.text),
          // The document, not the bar: the header sets the page's minimum
          // width, and every toolbar check can pass while the whole page is
          // 4px too wide and scrolling sideways.
          scrollsSideways:
            document.documentElement.scrollWidth > document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
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
        `Fit is on the bar at ${width.toString()}px, not behind the overflow menu`,
        chrome.barLabels.some((name) => name === 'Fit'),
        chrome.barLabels.join(', '),
      );

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
      /*
       * The whole document, not just the toolbar.
       *
       * The header is a flex row inside a grid whose items default to
       * `min-inline-size: auto`, so ITS min-content width sets the page's -
       * at 320px that came to 324px and scrolled the entire document sideways
       * by 4px. The toolbar checks above all passed while that was true,
       * which is exactly why this one exists.
       */
      check(
        label,
        `the page does not scroll sideways at ${width.toString()}px`,
        !chrome.scrollsSideways,
        `scrollWidth ${chrome.scrollWidth.toString()} vs ${width.toString()}`,
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
 * Opens or closes the node inspector, whatever state it is already in.
 *
 * The toggle's state depends on the viewport - the panel is a docked rail
 * above 1000px and open by default there, a sheet below it and closed - so a
 * blind click means "open" at one width and "close" at another. Every caller
 * wants a STATE rather than a press.
 *
 * `exact: true` on the name because "Close the inspector" contains "Inspector"
 * and Playwright's accessible-name matching is a substring by default.
 */
/**
 * Selects the first node and opens the inspector on it, from the KEYBOARD.
 *
 * Deliberately not a click on the node. Below the breakpoint the inspector is
 * a sheet over the canvas, so a node can be behind it - Playwright correctly
 * refuses to click through an intercepting element, and it is right to: a user
 * cannot click it either. Enter on a focused node is the documented route and
 * it works at every width.
 */
async function inspectFirstNode(page) {
  await page.locator('[data-node-id]').first().focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('node-inspector').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
}

/**
 * How many wires are on the canvas, counted by EDGE ID.
 *
 * Not by path: every port draws its glyph as SVG inside the plane, so counting
 * paths reported ten on a canvas with no wires at all. `data-edge-id` is the
 * wire layer's own hook, and each wire draws two paths under one id - hence the
 * set.
 */
async function countWires(page) {
  return page.evaluate(
    () =>
      new Set(
        [...document.querySelectorAll('[data-edge-id]')].map(
          (element) => element.getAttribute('data-edge-id') ?? '',
        ),
      ).size,
  );
}

async function setInspector(page, open) {
  const panel = page.getByTestId('node-inspector');
  const showing = (await panel.count()) > 0;
  if (showing === open) return;

  await page.getByRole('button', { name: 'Inspector', exact: true }).click();
  /*
   * Waited for in BOTH directions now, because closing is a slide: the panel
   * stays on screen for the length of its own animation and leaves when that
   * finishes. A fixed pause would be a race against a duration this file does
   * not own.
   */
  await panel.waitFor({ state: open ? 'attached' : 'detached', timeout: 10_000 });
  await page.waitForTimeout(200);
}

/* ========================================================================== *
 * THE NODE INSPECTOR
 * ========================================================================== */

/**
 * WHERE THE INSPECTOR SITS, MEASURED RATHER THAN DESCRIBED.
 *
 * The panel makes two geometric claims and jsdom can check neither, because
 * every box there is zero by zero:
 *
 *   1. ABOVE 1000px IT DOES NOT COVER THE CANVAS. It is a grid track, so the
 *      canvas gets narrower rather than being obscured - which is the whole
 *      reason it is allowed to be open by default at that width. A panel that
 *      overlapped would be one people close, and a closed inspector is the bug
 *      this feature exists to fix.
 *
 *   2. BELOW IT, IT IS A SHEET AND THE CANVAS KEEPS ITS FULL SIZE UNDERNEATH.
 *      At 390px a rail and a canvas cannot both have the screen, so the panel
 *      takes the other axis - and the canvas has to stay pannable in the strip
 *      above it rather than being shrunk to a sliver.
 *
 * The resize handle is measured too, because "the rail can be resized" is only
 * true if moving it actually moves the boundary between the two.
 */
async function checkInspector(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const geometry = () =>
    page.evaluate(() => {
      const box = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          left: Math.round(r.left),
          right: Math.round(r.right),
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      };
      const body = document.querySelector('[data-testid="inspector-body"]');
      return {
        canvas: box('[data-testid="canvas-root"]'),
        panel: box('[data-testid="node-inspector"]'),
        handle: box('[data-testid="inspector-handle"]'),
        scrolls: body ? body.scrollHeight > body.clientHeight + 1 : null,
        overflowY: body ? getComputedStyle(body).overflowY : null,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        docScrollsSideways:
          document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });

  try {
    await gotoCanvas(page);
    await page.getByRole('button', { name: 'Add tool' }).click();
    await page.locator('[role="dialog"]').first().waitFor({ timeout: 10_000 });
    await page.getByTestId('dialog-option-regex-tester').click();

    /*
     * FOCUS FOLLOWS THE TOOL THE PALETTE JUST ADDED, IN A REAL ENGINE.
     *
     * The node is created in the store, so it is not in the DOM when the
     * palette's handler returns - which is why the move used to be deferred to
     * an animation frame, and why deferring it was the same defect already
     * written up against `Enter` into the inspector: a late frame lands in the
     * middle of whatever the user did next and takes focus off the node they
     * had chosen. It is a layout effect now, which runs after the commit that
     * mounted the node and before the task ends.
     *
     * The interleaving is asserted in the unit suite, where the choice can be
     * driven synchronously; a harness that round-trips between every step
     * cannot hold that window open on demand. What this adds is that the
     * element really is mounted by the time the effect looks for it - a
     * question about React's commit in an engine, where a miss would leave
     * focus on the canvas root and no error anywhere.
     */
    const afterAdd = await page.evaluate(() => ({
      node: document.activeElement?.getAttribute('data-node-id') ?? null,
      what:
        document.activeElement?.getAttribute('aria-label') ??
        document.activeElement?.tagName ??
        'nothing',
    }));
    check(
      label,
      'choosing a tool in the palette leaves focus on the node it added',
      afterAdd.node !== null,
      afterAdd.what,
    );

    await page.waitForTimeout(500);

    /*
     * OPENED, RATHER THAN FOUND OPEN. The panel used to default to open at this
     * width; it starts closed on a first visit now, because an empty panel
     * explaining that there is nothing to inspect is not a useful first screen.
     * `checkInspectorState` below asserts that starting point and the memory
     * behind it; everything here is about the rail once it is showing.
     */
    check(
      label,
      'the inspector is closed on a first load, even where the rail would fit',
      (await page.getByTestId('node-inspector').count()) === 0,
      '',
    );

    await setInspector(page, true);
    const docked = await geometry();
    check(
      label,
      'the inspector is a docked rail above the breakpoint',
      docked.panel !== null && docked.handle !== null,
      docked.panel === null ? 'no panel' : 'panel and handle present',
    );
    check(
      label,
      'the rail does not overlap the canvas: the canvas narrows instead',
      docked.panel.left >= docked.canvas.right - 1,
      `canvas ends ${String(docked.canvas.right)}, panel starts ${String(docked.panel.left)}`,
    );
    check(
      label,
      'the rail and the canvas together fill the viewport without a sideways scroll',
      docked.panel.right <= docked.innerWidth + 1 && !docked.docScrollsSideways,
      `panel right ${String(docked.panel.right)} in ${String(docked.innerWidth)}px`,
    );

    /* -- Enter lands in the editor, in a real engine ---------------------- */

    /*
     * WHERE FOCUS ACTUALLY IS, WHICH JSDOM CANNOT SETTLE ON ITS OWN.
     *
     * The unit suite asserts the same thing, and has to: this is the key's
     * entire purpose, and it was landing on the close button because
     * `querySelector` with a list returns the first match in DOCUMENT order
     * and the header comes before the body. What only a real engine adds is
     * that the move happens in the same task as the keystroke - there is no
     * frame in between for anything else's focus to be taken away in, which is
     * what made this an intermittent failure in checkPipeline rather than a
     * permanent one here.
     */
    await page.locator('[data-node-id]').first().focus();
    await page.keyboard.press('Enter');
    const landed = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        editor: active?.hasAttribute('data-inspector-input') ?? false,
        label: active?.getAttribute('aria-label') ?? active?.tagName ?? 'nothing',
      };
    });
    check(
      label,
      'Enter on a node puts focus in its input editor, not on the button that closes the panel',
      landed.editor,
      landed.label,
    );

    // And typing straight away arrives, which is the thing the user notices.
    await page.keyboard.type('abc');
    const typed = await page.locator('[data-inspector-input]').first().inputValue();
    check(
      label,
      'and typing immediately afterwards reaches the editor',
      typed === 'abc',
      JSON.stringify(typed),
    );
    await page.locator('[data-inspector-input]').first().fill('');

    /* -- The divider is a hairline, and its target is not ----------------- */

    /*
     * A 1px RULE INSIDE A GENEROUS HIT AREA, WHICH ARE TWO SEPARATE BOXES.
     *
     * The handle used to paint its own hit area: a 4px sunken box with a border
     * down each side, three visible edges where the instrument wants one. It is
     * a transparent 8px column now with a `::before` that is the rule and an
     * `::after` that is the target.
     *
     * jsdom can see neither half. `::before`'s used width is a computed style,
     * which needs a layout engine; the hit area is only knowable by asking what
     * is actually under a point, which needs one too.
     */
    const divider = await page.evaluate(() => {
      const handle = document.querySelector('[data-testid="inspector-handle"]');
      if (!handle) return null;
      const box = handle.getBoundingClientRect();
      const rule = getComputedStyle(handle, '::before');
      const own = getComputedStyle(handle);

      /*
       * Probed rather than read: the grab area is a pseudo-element, so there is
       * no box to measure through the DOM. Walking outwards from the centre and
       * asking `elementFromPoint` what is there is what a pointer would find.
       */
      const midY = Math.round(box.top + box.height / 2);
      const centre = Math.round(box.left + box.width / 2);
      let left = centre;
      while (document.elementFromPoint(left - 1, midY) === handle && centre - left < 120) left -= 1;
      let right = centre;
      while (document.elementFromPoint(right + 1, midY) === handle && right - centre < 120)
        right += 1;

      return {
        box: Math.round(box.width),
        rule: rule.inlineSize || rule.width,
        ruleColour: rule.backgroundColor,
        background: own.backgroundColor,
        borders: `${own.borderLeftWidth}/${own.borderRightWidth}`,
        hit: right - left + 1,
      };
    });

    check(
      label,
      'the divider paints a one-pixel rule and nothing else',
      divider !== null && divider.rule === '1px',
      divider === null ? 'no handle' : `rule ${divider.rule} of a ${String(divider.box)}px column`,
    );
    check(
      label,
      'the divider paints no background and no border of its own',
      divider !== null &&
        /rgba\(0, 0, 0, 0\)|transparent/.test(divider.background) &&
        divider.borders === '0px/0px',
      divider === null
        ? 'no handle'
        : `background ${divider.background}, borders ${divider.borders}`,
    );
    /*
     * The hit area has to be BIGGER than the rule, which is the whole point of
     * separating them - and bigger than the column too, since the overhang is
     * what costs the canvas nothing.
     */
    check(
      label,
      'the divider is easier to grab than a one-pixel line',
      divider !== null && divider.hit > divider.box,
      divider === null ? 'no handle' : `${String(divider.hit)}px target around a 1px rule`,
    );

    /* -- The handle really moves the boundary ---------------------------- */
    const before = docked.canvas.width;
    await page.getByTestId('inspector-handle').focus();
    for (let press = 0; press < 5; press += 1) await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(200);
    const widened = await geometry();
    check(
      label,
      'resizing the rail takes width from the canvas rather than from the window',
      widened.panel.width > docked.panel.width &&
        widened.canvas.width < before &&
        !widened.docScrollsSideways,
      `panel ${String(docked.panel.width)} -> ${String(widened.panel.width)}, canvas ${String(before)} -> ${String(widened.canvas.width)}`,
    );

    /* -- A long output scrolls the panel, not the page -------------------- */
    /*
     * Each output view caps its own height, so what is asserted here is the
     * stacking case: three sections plus a capped result is taller than the
     * rail, and the PANEL is what scrolls. A canvas route that grew a document
     * scrollbar would be a different bug entirely - the route is a fixed
     * 100dvh shell and has nothing to scroll.
     */
    await inspectFirstNode(page);
    /*
     * A pattern AND a subject, so the node really produces a match table
     * rather than an empty result. Filled through the DOM setter React
     * listens to, because `locator.fill` on a controlled field is slow at this
     * size and this is a geometry check rather than an input one.
     */
    await page.evaluate(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      const field = document.querySelector('[data-inspector-input]');
      setter.call(field, 'lorem ipsum dolor sit amet 42\n'.repeat(400));
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.evaluate(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const pattern = [...document.querySelectorAll('[data-testid="node-inspector"] input')].find(
        (el) => el.type === 'text',
      );
      if (pattern) {
        setter.call(pattern, '\\w+');
        pattern.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await page.waitForTimeout(1500);

    const long = await geometry();
    check(
      label,
      'a very large output scrolls inside the panel, not the document',
      long.overflowY === 'auto' && long.scrolls === true && !long.docScrollsSideways,
      `overflow-y ${String(long.overflowY)}, scrolls ${String(long.scrolls)}`,
    );
    check(
      label,
      'the panel never grows past the viewport, however large the result',
      long.panel.bottom <= long.innerHeight + 1 && long.panel.top >= -1,
      `${String(long.panel.top)}..${String(long.panel.bottom)} in ${String(long.innerHeight)}px`,
    );
  } finally {
    await context.close().catch(() => {});
  }

  /* -- And the sheet, where a rail and a canvas cannot share the screen --- */
  const narrow = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const narrowPage = await narrow.newPage();

  try {
    await gotoCanvas(narrowPage);
    await narrowPage.getByRole('button', { name: 'Add tool' }).click();
    await narrowPage.locator('[role="dialog"]').first().waitFor({ timeout: 10_000 });
    await narrowPage.getByTestId('dialog-option-base64').click();
    await narrowPage.waitForTimeout(400);

    // Closed on arrival here too, and here it always was: the sheet covers the
    // thing it is describing.
    check(
      label,
      'the inspector is closed by default where it would cover the canvas',
      (await narrowPage.getByTestId('node-inspector').count()) === 0,
      '',
    );

    await setInspector(narrowPage, true);

    const sheet = await narrowPage.evaluate(() => {
      const panel = document.querySelector('[data-testid="node-inspector"]');
      const canvas = document.querySelector('[data-testid="canvas-root"]');
      const p = panel.getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      return {
        panelTop: Math.round(p.top),
        panelBottom: Math.round(p.bottom),
        panelLeft: Math.round(p.left),
        panelRight: Math.round(p.right),
        canvasHeight: Math.round(c.height),
        canvasWidth: Math.round(c.width),
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        // The strip of canvas still visible above the sheet.
        visibleCanvas: Math.round(p.top - c.top),
      };
    });

    check(
      label,
      'the sheet spans the width and sits on the bottom edge',
      sheet.panelLeft <= 0.5 &&
        sheet.panelRight >= sheet.innerWidth - 0.5 &&
        Math.abs(sheet.panelBottom - sheet.innerHeight) <= 1,
      `${String(sheet.panelLeft)}..${String(sheet.panelRight)} of ${String(sheet.innerWidth)}, bottom ${String(sheet.panelBottom)} vs ${String(sheet.innerHeight)}`,
    );
    check(
      label,
      'the canvas keeps its full size behind the sheet',
      sheet.canvasHeight >= sheet.innerHeight - 60 && sheet.canvasWidth >= sheet.innerWidth - 1,
      `canvas ${String(sheet.canvasWidth)}x${String(sheet.canvasHeight)} in ${String(sheet.innerWidth)}x${String(sheet.innerHeight)}`,
    );
    check(
      label,
      'the sheet leaves a usable strip of canvas above it',
      sheet.visibleCanvas >= 200,
      `${String(sheet.visibleCanvas)}px of canvas above the sheet`,
    );
    check(
      label,
      'there is no size handle where there is no rail to size',
      (await narrowPage.getByTestId('inspector-handle').count()) === 0,
      '',
    );
  } finally {
    await narrow.close().catch(() => {});
  }
}

/* ========================================================================== *
 * THE TOOL RUNNER'S LAYOUT
 * ========================================================================== */

/**
 * The four regions of a tool page, in source order, with their geometry.
 *
 * Serialised into the page, so it has to be self-contained. It reports the DOM
 * index alongside the box because the assertion that matters is a comparison
 * between the two orders - which is a thing jsdom cannot express at all, since
 * every box there is zero by zero and every order therefore agrees.
 */
const RUNNER_PROBE = () => {
  const layout = document.querySelector('[class*="layout"]');
  if (!layout) return null;

  const box = (el) => {
    const r = el.getBoundingClientRect();
    return {
      top: Math.round(r.top + window.scrollY),
      bottom: Math.round(r.bottom + window.scrollY),
      left: Math.round(r.left),
      right: Math.round(r.right),
      height: Math.round(r.height),
    };
  };

  /*
   * THE FOUR REGIONS, FOUND BY THEIR HEADINGS RATHER THAN AS THE GRID'S
   * CHILDREN.
   *
   * They used to be `layout.children`, which stopped being the same list: the
   * Ports footnote is a sibling of that grid now, deliberately, because a
   * sticky box's travel is bounded by its containing block and for a grid item
   * that containing block is the grid CONTAINER. A full-bleed row inside the
   * grid was therefore a row inside the rail's travel range.
   *
   * Asking the page for its named regions is also the better question. The
   * reading-order assertion below is about what a person reads down the page,
   * which was never a fact about one element's child list.
   */
  const WANTED = ['Input', 'Options', 'Output', 'Ports'];
  const regions = [...document.querySelectorAll('section')]
    .filter((el) => WANTED.includes((el.querySelector('h2')?.textContent ?? '').trim()))
    .map((el, index) => {
      const heading = el.querySelector('h2');
      return {
        index,
        name: (heading?.textContent ?? '(unnamed)').trim(),
        ...box(el),
      };
    });

  const run = [...document.querySelectorAll('button')].find(
    (el) => (el.textContent ?? '').trim() === 'Run',
  );
  const scroller = document.querySelector('[class*="optionsScroll"]');
  const rail = document.querySelector('[class*="controls"]');

  /*
   * EVERY SECTION THE RAIL COULD LAND ON, in viewport coordinates.
   *
   * Not just the four named ones: the assertion this feeds is that the rail
   * overlaps NOTHING, and "nothing" has to include the Privacy panel the route
   * renders after the runner and whatever a future page puts beside it.
   *
   * BOTH DIRECTIONS OF CONTAINMENT ARE SKIPPED. A box cannot meaningfully
   * overlap its own ancestor, and it certainly cannot overlap its own
   * descendants - the rail holds the Options panel and the run card, and the
   * first version of this reported the rail overlapping both of them by their
   * full width, which is true and is not what the question means.
   */
  const railRect = rail?.getBoundingClientRect() ?? null;
  const overlaps =
    railRect === null
      ? []
      : [...document.querySelectorAll('section')]
          .filter((el) => !el.contains(rail) && !rail.contains(el))
          .map((el) => {
            const r = el.getBoundingClientRect();
            const name = (el.querySelector('h2')?.textContent ?? '(untitled)').trim();
            const vertical = Math.min(railRect.bottom, r.bottom) - Math.max(railRect.top, r.top);
            const horizontal = Math.min(railRect.right, r.right) - Math.max(railRect.left, r.left);
            return { name, overlap: Math.round(Math.min(vertical, horizontal)) };
          })
          .filter((entry) => entry.overlap > 1);

  return {
    regions,
    overlaps,
    runInRail: run !== undefined && rail !== null && rail.contains(run),
    run: run ? { ...box(run), viewportTop: Math.round(run.getBoundingClientRect().top) } : null,
    rail: rail
      ? {
          position: getComputedStyle(rail).position,
          viewportTop: Math.round(rail.getBoundingClientRect().top),
          viewportBottom: Math.round(rail.getBoundingClientRect().bottom),
          // Where the rail sits in the DOCUMENT. A sticky box that is actually
          // sticking moves down the document as the page scrolls; one that is
          // merely in view does not.
          documentTop: Math.round(rail.getBoundingClientRect().top + window.scrollY),
          height: Math.round(rail.getBoundingClientRect().height),
        }
      : null,
    scroller: scroller
      ? {
          scrolls: scroller.scrollHeight > scroller.clientHeight + 1,
          overflowY: getComputedStyle(scroller).overflowY,
          focusableInside: scroller.querySelectorAll(
            'button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
          ).length,
          /*
           * The scroller's own height against the height of the ONE panel
           * inside it. These used to differ by 392px on hash - a 694px box
           * around 302px of options - because the rail was `block-size: 100%`
           * of a region held open to a whole viewport. That gap is the void
           * that made the run button look unmoored from the settings it
           * applies, and it is the thing that must stay at zero.
           */
          height: Math.round(scroller.getBoundingClientRect().height),
          contentHeight: Math.round(
            scroller.firstElementChild?.getBoundingClientRect().height ?? 0,
          ),
          /*
           * THE SCROLLPORT'S BOTTOM, WHICH IS NOT THE PANEL'S. Once the
           * options scroll, the Options panel's own rect runs past the box
           * clipping it - so "how far below the options is Run" measured
           * against the panel reads -162px on text-convert's Markdown layout,
           * where the truth is that Run is one gap below the visible end of
           * the options. This is the edge a person sees.
           */
          bottom: Math.round(scroller.getBoundingClientRect().bottom + window.scrollY),
        }
      : null,
    layoutHeight: Math.round(layout.getBoundingClientRect().height),
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    docScrollWidth: document.documentElement.scrollWidth,
    docClientWidth: document.documentElement.clientWidth,
    docHeight: document.documentElement.scrollHeight,
  };
};

/**
 * A PATTERN THAT REALLY DOES WEDGE A WORKER, IN BOTH ENGINES.
 *
 * WHY NOT (a+)+$, AND WHY THE ALTERNATION IS SO WIDE.
 *
 * The two engines disagree about catastrophic backtracking, and the
 * disagreement decides whether the wedge check tests anything at all.
 * SpiderMonkey runs the backtracking until it exhausts its stack and then
 * throws. JavaScriptCore instead bounds the backtracking COUNT and gives up
 * quietly, which for (a+)+$ over 32 characters lands at roughly 0.9s -
 * comfortably inside the tool's 2s deadline, so the worker was never wedged
 * and the check passed while proving nothing.
 *
 * LENGTHENING THE SUBJECT DOES NOT HELP. JSC's budget is a count of
 * backtracks, not a time, and it is spent inside a single `exec` however long
 * the subject is: 40 characters and 200 characters both give up at ~1.9s. What
 * raises the cost is making each backtrack step more expensive, which means
 * widening the ALTERNATION - every branch is another comparison at every step.
 *
 * SO THE WIDTH IS THE DIAL, AND IT IS MEASURED. In JSC the cost is close to
 * linear in the branch count, on one machine, steady state:
 *
 *     26 branches  1.5s      62 branches  3.5s     110 branches  ~8s
 *     52 branches  2.9s      78 branches  4.8s     138 branches  9.0s
 *
 * SpiderMonkey throws on stack exhaustion at ~5s at every width past 52, so
 * IT is the tighter of the two margins and widening does nothing for it.
 *
 * 138 branches gives 4.5x the deadline in JSC and 2.5x in SpiderMonkey. The
 * previous fixture was the 26-branch version, which had been measured at 6.8s
 * in JSC and was down to 1.5s by the time this was written - so it reported
 * `ok` for n1 and the whole assertion inverted. A faster engine is what breaks
 * this, so the number to raise when it happens is the width.
 *
 * Costing nine seconds is free, incidentally: the tool's deadline terminates
 * the worker at 2s, so the regex never gets to finish. The nine seconds is
 * what it WOULD take, which is the only thing that matters here.
 */
const WEDGE_BRANCHES = [
  ...'abcdefghijklmnopqrstuvwxyz',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'0123456789',
  // No `!`: the pattern ends in `!!` and the subject ends in one `!`, which is
  // what denies the match and forces the backtracking.
  ...`@#%&=~:;,<>/"'-_`,
  // Two-character branches to widen past the printable set without reaching
  // for non-ASCII. They fail on their first character, like the rest.
  ...[...'zyxwvu'].flatMap((head) => [...'0123456789'].map((tail) => head + tail)),
];

const WEDGE_PATTERN = `((${WEDGE_BRANCHES.join('|')})*)*!!`;

/**
 * A DELIBERATELY TALL OPTIONS PANEL, APPLIED TO A REAL PAGE.
 *
 * Every claim about the rail has to hold for a tool nobody has written yet,
 * and a tool declares its own options - so no real tool's option count is the
 * right thing to measure against. Regex declares the most today, at eight
 * fields, and that number is not a promise.
 *
 * So the height is imposed here instead: a `min-block-size` on the Options
 * panel, set through `element.style` (which CSP does not govern - the theme
 * checks in this file rely on the same thing). It is a fixture rather than a
 * measurement, and it keeps saying "taller than the rail" when the real tools
 * change.
 *
 * Returns whether it applied, so a check cannot silently pass against a panel
 * that was never made tall.
 */
const TALL_OPTIONS_FIXTURE = (height) => {
  const panel = [...document.querySelectorAll('section')].find(
    (el) => (el.querySelector('h2')?.textContent ?? '').trim() === 'Options',
  );
  if (!panel) return false;
  panel.style.minBlockSize = `${String(height)}px`;
  return true;
};

/** Undoes it, so later checks measure the page the application actually draws. */
const CLEAR_TALL_OPTIONS = () => {
  const panel = [...document.querySelectorAll('section')].find(
    (el) => (el.querySelector('h2')?.textContent ?? '').trim() === 'Options',
  );
  if (panel) panel.style.minBlockSize = '';
};

/**
 * THE LAYOUT DECISION, MEASURED RATHER THAN DESCRIBED.
 *
 * The tool runner used to draw two stacked columns - [Input, Output] beside
 * [Options, Ports] - which meant the options panel came after the output in
 * source order. Below the two-column breakpoint that put the whole options
 * panel BELOW the result, so changing one flag meant scrolling past an
 * arbitrarily long output and back; above it, the eye read Input, Options,
 * Output while Tab and a screen reader went Input, Output, Options.
 *
 * The DOM is now in reading order and the CSS only decides where the columns
 * break. Two of the three claims that makes are geometric, so they can only
 * be checked here:
 *
 *   1. VISUAL ORDER EQUALS SOURCE ORDER, at every width. Sorting the four
 *      regions by (top, left) - which is how a language read left to right
 *      and top to bottom is read - must reproduce their DOM order. This is the
 *      assertion an `order: -1` would fail, and it is the reason a CSS-only
 *      fix was rejected.
 *   2. THE OPTIONS ARE CO-VISIBLE WITH THE OUTPUT once there is room for a
 *      rail, and stay so however far down a long result you scroll - which is
 *      the entire point of the change.
 *
 * jsdom sees none of it: it has no layout engine, so every box is 0x0, every
 * region shares a position, and any order agrees with any other.
 */
async function checkRunnerLayout(browser, label) {
  /*
   * 999 and 1000 pin the breakpoint from both sides. The number is arithmetic
   * rather than a device - a 300px rail plus gutters leaves the main column
   * about 600px, which is what the regex match table and the side-by-side diff
   * want - and a breakpoint nobody asserts is a breakpoint that drifts.
   */
  const widths = [320, 390, 768, 999, 1000, 1280, 1920];

  for (const width of widths) {
    // A fresh context per width rather than a resize, for the reason
    // `checkChromeWidths` gives about Firefox's driver and media queries.
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    const page = await context.newPage();
    const at = `${String(width)}px`;

    try {
      await page.goto(`${ORIGIN}/tools/regex-tester`, { waitUntil: 'networkidle' });
      await page.getByRole('heading', { level: 1, name: 'Regex' }).waitFor({ timeout: 15_000 });
      // The options come from the tool's own lazily-imported module, so the
      // rail is not its final height until that has landed.
      await page
        .getByLabel(/pattern/i)
        .first()
        .waitFor({ timeout: 15_000 });

      await page
        .locator('textarea:not([readonly])')
        .first()
        .fill(Array.from({ length: 60 }, (_, i) => `user${String(i)}@example.com`).join('\n'));
      await page
        .getByLabel(/pattern/i)
        .first()
        .fill('(?<user>[\\w.]+)@(?<host>[\\w.]+)');
      await page.getByRole('button', { name: 'Run' }).click();
      await page.locator('[aria-label="Match listing"]').waitFor({ timeout: 20_000 });
      await page.waitForTimeout(250);

      /*
       * PROBED AT REST, which this always meant and never said.
       *
       * `box()` reports document coordinates, and a STUCK sticky box's
       * document position is its offset one - so every comparison below
       * between the rail and the content column only holds while the rail is
       * unstuck. Playwright scrolls an element into view before interacting
       * with it, so filling the pattern and pressing Run can leave the page a
       * few hundred pixels down; the reading-order check then read the rail as
       * being below the output, which is where a stuck rail's document box
       * genuinely is.
       */
      await page.evaluate(() => {
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(150);

      const probe = await page.evaluate(RUNNER_PROBE);
      check(label, `the tool runner has a measurable layout at ${at}`, probe !== null, '');
      if (!probe) continue;

      const names = probe.regions.map((region) => region.name);
      check(
        label,
        `the four regions are in reading order in the DOM at ${at}`,
        names.join(' > ') === 'Input > Options > Output > Ports',
        names.join(' > '),
      );

      /* -- 1. Visual order is source order ------------------------------- */
      const visual = [...probe.regions].sort((a, b) =>
        Math.abs(a.top - b.top) > 4 ? a.top - b.top : a.left - b.left,
      );
      check(
        label,
        `nothing is reordered on screen at ${at}: the eye and the DOM agree`,
        visual.every((region, position) => region.index === position),
        `DOM ${probe.regions.map((r) => r.name).join(',')} / screen ${visual
          .map((r) => r.name)
          .join(',')}`,
      );

      const [input, options, output, ports] = probe.regions;

      check(
        label,
        `the page does not scroll sideways at ${at}`,
        probe.docScrollWidth <= probe.docClientWidth,
        `${String(probe.docScrollWidth)} in ${String(probe.docClientWidth)}`,
      );

      /* -- 2. Run sits after the options, inside the rail ---------------- */
      /*
       * `options` is the Options PANEL now rather than the whole rail, because
       * the rail's other row is the run card and naming the rail after the
       * panel inside it stopped being unambiguous once there were two. So the
       * assertion is stated as what it actually means: Run comes after the
       * options and is part of the rail.
       */
      check(
        label,
        `Run is after the options and inside the rail at ${at}`,
        probe.run !== null && probe.runInRail && probe.run.top >= options.bottom,
        probe.run === null
          ? 'no Run button'
          : `run ${String(probe.run.top)} against options ending ${String(
              options.bottom,
            )}, inRail=${String(probe.runInRail)}`,
      );

      /*
       * AND ON SCREEN BEFORE ANYTHING HAS BEEN SCROLLED.
       *
       * This used to be bought with a `position: sticky` on the run card, back
       * when the rail was held open to a full viewport and its last row was
       * therefore below the fold on every page - the card sat at 901..959 in
       * an 800px window and the sticky pushed it up to the fold. Both are gone:
       * the rail is as tall as its options, so on every tool in the set the
       * card's own resting place is already on screen. Regex declares the most
       * options of any of them and ends at 755 in an 800px window.
       *
       * The assertion is unchanged and is now met by the layout rather than by
       * a rescue, which is why it is worth keeping - it is what would notice a
       * rail that grew past the fold again.
       */
      if (width >= 1000) {
        check(
          label,
          `Run is on screen before anything is scrolled at ${at}`,
          probe.run !== null &&
            probe.run.viewportTop >= 0 &&
            probe.run.viewportTop < probe.innerHeight,
          probe.run === null
            ? 'no Run button'
            : `run at ${String(probe.run.viewportTop)} in ${String(probe.innerHeight)}px`,
        );
      }

      /* -- THE OVERLAP, WHICH IS THE DEFECT THIS SECTION EXISTS FOR ------ */
      /*
       * The rail is `position: sticky`, and a sticky box's travel is bounded by
       * its containing block - which for a grid item is the grid CONTAINER, not
       * the grid area it was placed in. The Ports footnote used to be a third,
       * full-bleed row of that grid, so it was inside the rail's travel range:
       * at the foot of a JWT page the rail covered 52px of it. The fix is that
       * the grid holds only the regions the rail travels beside; this asserts
       * the consequence against EVERY section on the page rather than against
       * the one that happened to be reported.
       */
      check(
        label,
        `the rail overlaps nothing at rest at ${at}`,
        probe.overlaps.length === 0,
        probe.overlaps.map((entry) => `${entry.name} by ${String(entry.overlap)}px`).join(', '),
      );

      if (width < 1000) {
        /* -- Stacked ---------------------------------------------------- */
        check(
          label,
          `the options are above the output, not below it, at ${at}`,
          options.bottom <= output.top,
          `options end ${String(options.bottom)}, output starts ${String(output.top)}`,
        );
        check(
          label,
          `everything is one column at ${at}`,
          input.left === options.left &&
            options.left === output.left &&
            output.left === ports.left &&
            input.right === output.right,
          `lefts ${[input.left, options.left, output.left, ports.left].join(',')}`,
        );
        /*
         * Not a scroller and not pinned below the breakpoint. A nested
         * scrollbar inside a document that already scrolls is the defect the
         * mobile audit found in the theme editor's contrast list, and a pinned
         * rail on a phone spends viewport the result needs.
         */
        check(
          label,
          `the options rail is neither pinned nor its own scroller at ${at}`,
          probe.rail?.position === 'static' && probe.scroller?.scrolls === false,
          `${String(probe.rail?.position)}, scrolls=${String(probe.scroller?.scrolls)}`,
        );
      } else {
        /* -- Two columns ------------------------------------------------ */
        check(
          label,
          `the options sit in a rail beside the input at ${at}`,
          options.left >= input.right && Math.abs(options.top - input.top) <= 2,
          `input ends ${String(input.right)}, options start ${String(options.left)} at ${String(
            options.top,
          )} against ${String(input.top)}`,
        );
        /*
         * THE ROW HEIGHTS ARE NOT COUPLED, which is what the rail spanning
         * both content rows buys. The regex options panel is taller than the
         * input, and a plain two-row auto-flow grid would have pushed the
         * output down to clear it - leaving a few hundred pixels of nothing
         * under the input on the busiest tool in the set.
         */
        check(
          label,
          `the output starts under the input rather than under the rail at ${at}`,
          output.top < options.bottom,
          `output starts ${String(output.top)}, rail ends ${String(options.bottom)}`,
        );
        check(
          label,
          `the ports footnote spans both columns at ${at}`,
          ports.left === input.left && ports.right >= options.right - 1 && ports.top >= output.top,
          `ports ${String(ports.left)}..${String(ports.right)} against ${String(
            input.left,
          )}..${String(options.right)}`,
        );

        /* -- THE HEIGHT NOBODY ASKED FOR -------------------------------- */
        /*
         * `.layout` used to carry `min-block-size: calc(100dvh - lg * 2)` and
         * the rail `block-size: 100%`, so every tool page was a viewport tall
         * whether or not it had anything in it. The purpose was to hold Run
         * still and it worked; the price was the shape of the page. Measured
         * in the production build at 1280x800 with nothing run: a 768px grid
         * on every tool, a 694px options scroller around 302px of options, and
         * a 416px Output panel around one sentence - 600px on image.
         *
         * Both assertions below are the same claim from two sides: the page is
         * as tall as the things on it and no taller. Neither is expressible in
         * jsdom, where every box is zero by zero, and the declarations that
         * would bring the height back are two lines that read as tidying up -
         * so `ToolRunner.layout.test.tsx` guards the source text and this
         * guards the result.
         */
        const column = output.bottom - input.top;
        const railHeight = probe.rail?.height ?? 0;
        check(
          label,
          `the grid is as tall as its tallest column and no taller at ${at}`,
          Math.abs(probe.layoutHeight - Math.max(column, railHeight)) <= 2,
          `grid ${String(probe.layoutHeight)}, content column ${String(column)}, rail ${String(
            railHeight,
          )}`,
        );

        /*
         * AND THE RAIL RESERVES NOTHING AROUND THE OPTIONS. When the options
         * fit - which is every real tool at this height - the scroller is
         * exactly its content, so the run card sits one gap below the last
         * option instead of several hundred pixels below it.
         */
        check(
          label,
          `the options scroller is exactly its content when it fits at ${at}`,
          probe.scroller !== null &&
            (probe.scroller.scrolls ||
              Math.abs(probe.scroller.height - probe.scroller.contentHeight) <= 1),
          probe.scroller === null
            ? 'no scroller'
            : `${String(probe.scroller.height)} around ${String(
                probe.scroller.contentHeight,
              )}, scrolls=${String(probe.scroller.scrolls)}`,
        );
      }
    } finally {
      await context.close().catch(() => {});
    }
  }

  /* -- 3. The rail stays with the output while the output scrolls -------- */
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  try {
    await page.goto(`${ORIGIN}/tools/diff`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1, name: 'Diff' }).waitFor({ timeout: 15_000 });

    const boxes = page.locator('textarea:not([readonly])');
    await boxes.nth(0).fill(Array.from({ length: 300 }, (_, i) => `line ${String(i)}`).join('\n'));
    await boxes
      .nth(1)
      .fill(Array.from({ length: 300 }, (_, i) => `line ${String(i * 2)}`).join('\n'));
    await page.getByRole('button', { name: 'Run' }).click();
    // The patch output rather than the notes list: these two inputs differ on
    // almost every line and agree about line endings, so the tool has no notes
    // to draw and waiting for them would wait forever.
    await page.getByRole('textbox', { name: 'Diff Unified patch' }).waitFor({ timeout: 20_000 });
    await page.waitForTimeout(300);

    /*
     * A 600-ROW DIFF MUST NOT GIVE THE PAGE 7,600px OF NOTHING TO SCROLL.
     *
     * Found while measuring the sticky rail against the page height, which is
     * the only reason anybody looked. Every diff row carries a visually hidden
     * `<span>` naming the change - "removed, original line 12" - and the
     * recipe for that is `position: absolute` with a 1px clip. An absolutely
     * positioned box is clipped by an ancestor's `overflow` only when that
     * ancestor is its containing block, and the row list was not positioned,
     * so the containing block was the document. Four hundred and fifty hidden
     * spans therefore escaped the row scroller, laid themselves out down the
     * page, and contributed their positions to the document's scrollable
     * overflow. Nothing painted there. The scrollbar simply said the page was
     * five times longer than it is, and dragging it landed you in blank space.
     *
     * `position: relative` on the scroller is the whole fix, and it is
     * invisible to every other check here: the boxes were never painted, the
     * document never scrolled sideways, and jsdom has no layout at all.
     */
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollHeight,
      body: Math.round(document.body.getBoundingClientRect().height),
    }));
    check(
      label,
      'a long diff adds no empty scrollable height to the page',
      overflow.doc - overflow.body <= 32,
      `document ${String(overflow.doc)} against body ${String(overflow.body)}`,
    );

    const before = await page.evaluate(RUNNER_PROBE);
    check(
      label,
      'a long diff scrolls the page at all, so the rail has something to survive',
      before !== null && before.docHeight > before.innerHeight,
      before === null
        ? 'no layout'
        : `${String(before.docHeight)} against ${String(before.innerHeight)}`,
    );

    /*
     * Scrolled so the OUTPUT fills the viewport, which is the moment the whole
     * change exists for: the option that produced the result and the button
     * that re-runs it are both still on screen. The rail deliberately stops
     * travelling at the bottom of the output - below that you are reading the
     * ports footnote, not the result - so this scrolls to the output rather
     * than to the end of the document.
     */
    const outputTop = before?.regions[2]?.top ?? 0;
    await page.evaluate((top) => {
      window.scrollTo(0, top);
    }, outputTop);
    await page.waitForTimeout(300);
    const after = await page.evaluate(RUNNER_PROBE);

    check(
      label,
      'the options rail is still on screen with the output scrolled under it',
      after?.rail != null &&
        after.rail.position === 'sticky' &&
        after.rail.viewportTop >= 0 &&
        after.rail.viewportBottom <= after.innerHeight,
      after?.rail == null
        ? 'no rail'
        : `${after.rail.position} at ${String(after.rail.viewportTop)}..${String(
            after.rail.viewportBottom,
          )} in ${String(after.innerHeight)}px`,
    );
    /*
     * And it is on screen because it MOVED, not because the page happened to
     * be short. Without the sticky the rail's document position is fixed, so
     * this is the assertion that would have caught `<main>`'s
     * `overflow: hidden` - which made it a scroll container that never
     * scrolls, inside which nothing sticky ever moves.
     */
    check(
      label,
      'the rail is on screen because it stuck, not because the page is short',
      after?.rail != null &&
        before?.rail != null &&
        after.rail.documentTop > before.rail.documentTop + 50,
      `${String(before?.rail?.documentTop)} -> ${String(after?.rail?.documentTop)}`,
    );
    check(
      label,
      'Run is still on screen with the output scrolled under it',
      after?.run != null && after.run.viewportTop >= 0 && after.run.viewportTop < after.innerHeight,
      after?.run == null
        ? 'no Run button'
        : `${String(after.run.viewportTop)} in ${String(after.innerHeight)}px`,
    );
  } finally {
    await context.close().catch(() => {});
  }

  /* -- 4. A rail taller than a short window scrolls itself --------------- */
  const shortContext = await browser.newContext({ viewport: { width: 1280, height: 460 } });
  const shortPage = await shortContext.newPage();

  try {
    await shortPage.goto(`${ORIGIN}/tools/regex-tester`, { waitUntil: 'networkidle' });
    await shortPage.getByRole('heading', { level: 1, name: 'Regex' }).waitFor({ timeout: 15_000 });
    await shortPage
      .getByLabel(/pattern/i)
      .first()
      .waitFor({ timeout: 15_000 });
    /*
     * Run first, and scroll to the result. The rail can only be measured
     * against the viewport while it is actually pinned, and it stops
     * travelling at the bottom of the output - so on an unrun page, whose
     * output is the one line "No output yet. Results appear here.", there is
     * nothing for it to be pinned over.
     */
    await shortPage
      .locator('textarea:not([readonly])')
      .first()
      .fill(Array.from({ length: 60 }, (_, i) => `user${String(i)}@example.com`).join('\n'));
    await shortPage
      .getByLabel(/pattern/i)
      .first()
      .fill('(?<user>[\\w.]+)@(?<host>[\\w.]+)');
    await shortPage.getByRole('button', { name: 'Run' }).click();
    await shortPage.locator('[aria-label="Match listing"]').waitFor({ timeout: 20_000 });
    await shortPage.waitForTimeout(250);

    const resting = await shortPage.evaluate(RUNNER_PROBE);
    await shortPage.evaluate((top) => {
      window.scrollTo(0, top);
    }, resting?.regions[2]?.top ?? 400);
    await shortPage.waitForTimeout(300);

    const probe = await shortPage.evaluate(RUNNER_PROBE);

    /*
     * Regex declares the most options of any tool here - a pattern, a mode, a
     * replacement and five flags - and in a 460px window that rail is taller
     * than the viewport. Capping it and letting the OPTIONS take the scroll
     * (rather than the whole rail) is what keeps Run reachable:
     * `minmax(0, 1fr) auto` gives row one permission to shrink and row two
     * none.
     */
    check(
      label,
      'a rail taller than the window is capped rather than running off the bottom',
      probe?.rail != null &&
        probe.rail.viewportTop >= 0 &&
        probe.rail.viewportBottom <= probe.innerHeight + 1,
      probe?.rail == null
        ? 'no rail'
        : `rail ${String(probe.rail.viewportTop)}..${String(probe.rail.viewportBottom)} in ${String(
            probe.innerHeight,
          )}px`,
    );
    check(
      label,
      'the options take that scroll, and Run stays on screen',
      probe?.scroller != null &&
        probe.scroller.scrolls &&
        probe.run != null &&
        probe.run.viewportTop >= 0 &&
        probe.run.viewportTop < probe.innerHeight,
      probe?.scroller == null
        ? 'no scroller'
        : `scrolls=${String(probe.scroller.scrolls)}, run at ${String(probe.run?.viewportTop)}`,
    );
    /*
     * A scrollable region has to be reachable from a keyboard - the defect
     * this project already found once in its shortcuts dialog, where a box
     * scrolled and nothing inside it could be focused. Here the controls
     * themselves are the focus targets, so scrolling follows from tabbing;
     * asserted rather than assumed, because a tool with only static option
     * descriptions would need its own tabindex.
     */
    check(
      label,
      'the options scroller is reachable by keyboard through the controls inside it',
      (probe?.scroller?.focusableInside ?? 0) > 0,
      `${String(probe?.scroller?.focusableInside)} focusable`,
    );

    /* -- 5. The rail cannot overlap anything, at any scroll position ------- */

    /*
     * THE DEFECT, MEASURED THE WAY IT WAS FOUND.
     *
     * The rail is sticky, and a sticky box's travel is bounded by its containing
     * block - which for a grid item is the grid CONTAINER, not the grid area it
     * was placed in. That is the opposite of the intuitive reading, and it is
     * why spanning "only" the two content rows never constrained the rail to
     * them. With the Ports footnote still a third, full-bleed row of the same
     * grid, the rail's bottom edge tracked the grid's bottom edge from the
     * moment it came unstuck and ended 52px over that panel.
     *
     * Three things make this the check that would have caught it:
     *
     *   IT SWEEPS. The overlap does not exist at rest - it appears only once you
     *   have scrolled far enough for the rail to run out of travel - so a probe
     *   at one scroll position is a probe that agrees with the bug.
     *
     *   IT USES A FIXTURE, not a tool. The taller the options panel, the sooner
     *   the rail runs out of travel; JWT failed sooner than regex only because
     *   its panel is taller. A number imposed here holds for tools that do not
     *   exist.
     *
     *   IT ASKS ABOUT EVERY SECTION. The original report named Ports and
     *   Privacy; what has to be true is that the rail reaches none of them.
     */
    const sweepContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const sweepPage = await sweepContext.newPage();

    try {
      await sweepPage.goto(`${ORIGIN}/tools/jwt-decode`, { waitUntil: 'networkidle' });
      await sweepPage.getByRole('heading', { level: 1, name: 'JWT' }).waitFor({ timeout: 15_000 });
      // The options arrive with the tool's own lazily-imported module.
      await sweepPage
        .locator('[class*="optionsScroll"] select, [class*="optionsScroll"] button')
        .first()
        .waitFor({ timeout: 15_000 });

      const applied = await sweepPage.evaluate(TALL_OPTIONS_FIXTURE, 2400);
      check(label, 'the tall-options fixture applied', applied, '');

      const worst = { overlap: 0, at: 0, what: '' };
      const height = await sweepPage.evaluate(() => document.documentElement.scrollHeight);
      const stops = [0, 200, 400, 800, 1600, height];

      for (const y of stops) {
        await sweepPage.evaluate((top) => {
          window.scrollTo(0, top);
        }, y);
        await sweepPage.waitForTimeout(120);
        const probe = await sweepPage.evaluate(RUNNER_PROBE);
        for (const entry of probe?.overlaps ?? []) {
          if (entry.overlap > worst.overlap) {
            worst.overlap = entry.overlap;
            worst.at = y;
            worst.what = entry.name;
          }
        }
      }

      check(
        label,
        'a rail beside a 2400px options panel overlaps nothing at any scroll position',
        worst.overlap === 0,
        worst.overlap === 0
          ? `${String(stops.length)} scroll positions clean`
          : `${worst.what} by ${String(worst.overlap)}px at scroll ${String(worst.at)}`,
      );

      /*
       * AND THE CAP IS WHAT BOUNDS IT.
       *
       * This asserted "Run does not move when the option count changes under
       * it", and that was true: `.layout` reserved a viewport of height and the
       * rail filled it, so the rail's last row was in the same place whatever
       * the options did. The reserved height is gone - it made every tool page
       * a screen tall around nothing - and Run moves with the options again,
       * deliberately. See the note on `.controls` in runner.module.css.
       *
       * What Run may NOT do is keep moving, and what the page may NOT do is
       * keep growing. The rail is capped at the viewport and the options take
       * the rest by scrolling, so past that cap a taller options panel changes
       * nothing whatsoever. That is the claim worth holding for a tool nobody
       * has written, and doubling an already absurd panel is how to state it:
       * 2400px against 4800px is a bigger step than the entire tool set spans,
       * and both must draw the identical page.
       */
      await sweepPage.evaluate(() => {
        window.scrollTo(0, 0);
      });
      await sweepPage.waitForTimeout(150);
      const withTall = await sweepPage.evaluate(RUNNER_PROBE);
      await sweepPage.evaluate(TALL_OPTIONS_FIXTURE, 4800);
      await sweepPage.waitForTimeout(150);
      const withTaller = await sweepPage.evaluate(RUNNER_PROBE);
      await sweepPage.evaluate(CLEAR_TALL_OPTIONS);
      await sweepPage.waitForTimeout(150);
      const withDeclared = await sweepPage.evaluate(RUNNER_PROBE);

      check(
        label,
        'past the rail cap, a taller options panel cannot move Run any further',
        withTall?.run != null &&
          withTaller?.run != null &&
          withTall.run.top === withTaller.run.top &&
          withTall.run.bottom === withTaller.run.bottom,
        `${String(withTall?.run?.top)}..${String(withTall?.run?.bottom)} at 2400px against ${String(
          withTaller?.run?.top,
        )}..${String(withTaller?.run?.bottom)} at 4800px`,
      );

      /*
       * And the difference went to the SCROLLER rather than to the page. A rail
       * that simply grew would have been stable too - by pushing everything below
       * it down the document, which is the same defect wearing a different coat.
       */
      check(
        label,
        'and cannot grow the page any further either',
        withTall?.scroller?.scrolls === true &&
          withDeclared?.scroller?.scrolls === false &&
          withTall.docHeight === withTaller?.docHeight,
        `scrolls ${String(withTall?.scroller?.scrolls)} against ${String(
          withDeclared?.scroller?.scrolls,
        )}, page ${String(withTall?.docHeight)} at 2400px against ${String(
          withTaller?.docHeight,
        )} at 4800px`,
      );

      /*
       * STATED IN ABSOLUTE TERMS TOO, because "the two absurd panels agree"
       * would still pass if the cap itself were enormous. What a tall options
       * panel costs the page is the rail growing to its cap and no more, so the
       * whole cost is bounded by one viewport.
       */
      check(
        label,
        'and the whole cost of a tall options panel is under one viewport',
        withTall != null &&
          withDeclared != null &&
          withTall.docHeight - withDeclared.docHeight <= withTall.innerHeight,
        `${String(withDeclared?.docHeight)} to ${String(withTall?.docHeight)} in ${String(
          withTall?.innerHeight,
        )}px`,
      );
    } finally {
      await sweepContext.close().catch(() => {});
    }

    /* -- 6. Stacked, the rail is never over the input ---------------------- */

    /*
     * Below the breakpoint the rail is in normal flow and nothing about it is
     * pinned, which the width sweep above already asserts through
     * `position: static`. This asserts the consequence rather than the
     * declaration, and it asserts it while SCROLLED: a `sticky` that came back
     * by accident - or a `min-block-size` that leaked out of the media query and
     * made the region a viewport tall on a phone - would show up here as the rail
     * standing still over the input.
     */
    const stackedContext = await browser.newContext({ viewport: { width: 390, height: 800 } });
    const stackedPage = await stackedContext.newPage();

    try {
      await stackedPage.goto(`${ORIGIN}/tools/jwt-decode`, { waitUntil: 'networkidle' });
      await stackedPage
        .getByRole('heading', { level: 1, name: 'JWT' })
        .waitFor({ timeout: 15_000 });
      await stackedPage.locator('[class*="optionsScroll"]').first().waitFor({ timeout: 15_000 });
      await stackedPage.evaluate(TALL_OPTIONS_FIXTURE, 1600);

      let pinned = '';
      for (const y of [0, 300, 900, 1800]) {
        await stackedPage.evaluate((top) => {
          window.scrollTo(0, top);
        }, y);
        await stackedPage.waitForTimeout(120);
        const probe = await stackedPage.evaluate(RUNNER_PROBE);
        if (probe?.rail?.position !== 'static')
          pinned = `position ${String(probe?.rail?.position)}`;
        for (const entry of probe?.overlaps ?? []) {
          if (entry.overlap > 1)
            pinned = `${entry.name} by ${String(entry.overlap)}px at ${String(y)}`;
        }
      }

      check(
        label,
        'the stacked rail stays in flow and never covers the input',
        pinned === '',
        pinned,
      );
    } finally {
      await stackedContext.close().catch(() => {});
    }
  } finally {
    await shortContext.close().catch(() => {});
  }

  /* -- 6. Run travels with the options, and stays reachable -------------- */

  /*
   * THE PROPERTY THAT REPLACED "RUN DOES NOT MOVE".
   *
   * It used to not move, and the mechanism was a reserved viewport: `.layout`
   * held every tool page open to a full screen so the rail's last row was
   * always in the same place. That bought stillness for one button on one tool
   * and charged every page of every tool a screen of empty height for it -
   * and it left the button 200-400px of bare background away from the options,
   * which is its own defect.
   *
   * The rail is now as tall as what is in it, so the card is one gap below the
   * last option and travels with it. `text-convert` is the only tool that
   * moves it: its conditional fields make three different option panels, and
   * this walks all three and asserts what actually matters about each - the
   * button is ON SCREEN, and it is attached to the options rather than adrift
   * from them.
   *
   * Markdown is the one layout in the whole set whose options are tall enough
   * to push the card past the fold, so it is where the third assertion looks:
   * the card must not be lifted back over the options to fix that. A
   * `position: sticky` on the card used to do exactly that, and because the
   * card is opaque and the box below it is a SCROLLING options list, it hid
   * the last 159px of one - three fields you could scroll to and not see.
   */
  const targetContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const targetPage = await targetContext.newPage();

  try {
    await targetPage.goto(`${ORIGIN}/tools/text-convert`, { waitUntil: 'networkidle' });
    await targetPage
      .getByRole('heading', { level: 1, name: 'Text convert' })
      .waitFor({ timeout: 15_000 });
    await targetPage.getByRole('combobox', { name: 'Target format' }).waitFor({ timeout: 15_000 });

    const seen = [];
    for (const target of ['HTML', 'Markdown', 'Plain text (strip formatting)']) {
      await targetPage.getByRole('combobox', { name: 'Target format' }).click();
      await targetPage.getByRole('option', { name: target }).click();
      await targetPage.evaluate(() => {
        window.scrollTo(0, 0);
      });
      await targetPage.waitForTimeout(200);

      const probe = await targetPage.evaluate(RUNNER_PROBE);
      seen.push({
        target,
        run: probe?.run?.viewportTop ?? null,
        /*
         * Against the SCROLLPORT's bottom rather than the Options panel's, and
         * in document coordinates so a stuck rail cannot flatter it. The
         * Markdown layout is the one that makes the difference matter: its
         * options are taller than the cap, so the panel's rect runs past the
         * box clipping it and the panel-relative answer is -162.
         */
        gap:
          probe?.run != null && probe.scroller != null
            ? probe.run.top - probe.scroller.bottom
            : null,
        height: probe?.innerHeight ?? 0,
      });
    }

    /*
     * NOT "ON SCREEN AT REST", WHICH WOULD BE FALSE AND SHOULD BE.
     *
     * Two of the three layouts put Run on screen without scrolling; Markdown's
     * options are tall enough that it rests at 914 in an 800px window. That is
     * the documented consequence of taking the run card's sticky away, and a
     * check that demanded otherwise would be demanding the defect back - the
     * sticky is what put an opaque card over a scrolling options list.
     *
     * What is worth holding is that the button is never stranded: one screen of
     * scrolling reaches it in the worst layout the tool set can produce.
     */
    check(
      label,
      'Run is at most one screen below the fold in any of text-convert’s layouts',
      seen.every((entry) => entry.run !== null && entry.run >= 0 && entry.run < entry.height * 2),
      seen.map((entry) => `${entry.target} at ${String(entry.run)}`).join(', '),
    );
    /*
     * AND IT IS ATTACHED TO THEM. One grid gap plus the card's own border and
     * padding separates the visible end of the options from the button, and it
     * is the SAME distance in all three layouts - which is the whole difference
     * between a control that travels with its panel and one adrift in reserved
     * space. Measured at 29px; asserted as a bound and an agreement rather than
     * as that number, because the chrome is a border and a padding rather than
     * a token this script can read.
     */
    const gaps = seen.map((entry) => entry.gap);
    check(
      label,
      'and it stays attached to the options rather than adrift below them',
      gaps.every((gap) => gap !== null && gap > 0 && gap < 64) &&
        Math.max(...gaps) - Math.min(...gaps) <= 2,
      gaps.join(', '),
    );
    /*
     * A POSITIVE GAP IS ALSO THE NO-OVERLAP CLAIM, and it is the half that
     * caught a defect rather than confirming one. Measured against the
     * SCROLLPORT's bottom edge, a negative gap means the card is sitting on top
     * of the options - which is what the card's old `position: sticky` did on
     * this exact layout, by -159px, over a list that scrolls. Stated separately
     * from the bound above so a failure says which of the two things went
     * wrong.
     */
    check(
      label,
      'and never on top of them, however tall the options are',
      gaps.every((gap) => gap !== null && gap > 0),
      gaps.join(', '),
    );
  } finally {
    await targetContext.close().catch(() => {});
  }

  /* -- 7. A short result is drawn in a short box ------------------------- */

  /*
   * THE OUTPUT TEXTAREA USED TO HAVE THE INPUT EDITOR'S FLOOR.
   *
   * Both were `.editor`, and `.editor` is 200px because an input is a place to
   * put something that is not there yet. An output already knows how much of
   * it there is, so hash's sixty-four-character digest and colour's seven-
   * character `#3366cc` were each drawn in a 200px box - on the two tools
   * whose entire result is one short string, the box around it was the
   * largest thing on the page.
   *
   * `.result` asks for `field-sizing: content` and clamps it, with a `rows`
   * count as the fallback for an engine that does not have it. Which of the
   * two answered is not the point and is not asserted; that the box is the
   * size of the text is. jsdom cannot see either - it has no layout engine -
   * so `OutputPanel.test.tsx` holds the `rows` arithmetic and this holds the
   * height.
   *
   * The bound is stated against the OLD floor rather than as a pixel target,
   * because the exact height is a font metric and this is not a screenshot
   * test. Anything at or above 200px means the floor is back.
   */
  const resultContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const resultPage = await resultContext.newPage();

  try {
    await resultPage.goto(`${ORIGIN}/tools/hash`, { waitUntil: 'networkidle' });
    await resultPage.getByRole('heading', { level: 1, name: 'Hash' }).waitFor({ timeout: 15_000 });
    await resultPage.locator('textarea:not([readonly])').first().fill('hello world');
    await resultPage.getByRole('button', { name: 'Run' }).click();
    await resultPage.getByRole('textbox', { name: 'Hash Digest' }).waitFor({ timeout: 20_000 });
    await resultPage.waitForTimeout(200);

    const result = await resultPage.evaluate(() => {
      const box = document.querySelector('textarea[readonly]');
      const editor = document.querySelector('textarea:not([readonly])');
      const output = document.querySelector('[class*="_output_"]');
      if (!box || !editor || !output) return null;
      return {
        text: box.value.length,
        boxHeight: Math.round(box.getBoundingClientRect().height),
        editorHeight: Math.round(editor.getBoundingClientRect().height),
        panelHeight: Math.round(output.getBoundingClientRect().height),
      };
    });

    check(
      label,
      'a one-line digest is not drawn in the 200px box the input editor uses',
      result !== null && result.text === 64 && result.boxHeight < 120,
      result === null
        ? 'no result box'
        : `${String(result.text)} characters in ${String(result.boxHeight)}px`,
    );
    /*
     * And the panel around it followed. It was 416px on this page - a whole
     * viewport's surplus handed to the one region set to stretch into it.
     */
    check(
      label,
      'and the Output panel around it is the size of the result',
      result !== null && result.panelHeight < 220,
      result === null ? 'no output panel' : `${String(result.panelHeight)}px`,
    );
    /*
     * THE OTHER HALF OF THE SAME RULE, because the two floors are decided by
     * document order rather than by specificity and one gate should notice if
     * that order ever flips. `.editor` and `.result` are each one class deep,
     * exactly like `.textarea` in TextInput.module.css whose own floor they
     * override - the build links the runner's chunk last and they win.
     *
     * `pnpm dev` injects them the other way round, where `.textarea`'s 80px
     * beats both and every box on the page is the wrong size. Nothing in the
     * unit suite can see it, and it is convincing enough to have been read as
     * dead code. So the input's floor is asserted against the build here,
     * beside the output's.
     */
    check(
      label,
      'while the input editor keeps the 200px floor written for it',
      result !== null && result.editorHeight >= 200,
      result === null ? 'no input editor' : `${String(result.editorHeight)}px`,
    );
  } finally {
    await resultContext.close().catch(() => {});
  }
}

/* ========================================================================== *
 * THE INSPECTOR'S DIVIDER, ITS MOTION AND ITS STARTING STATE
 * ========================================================================== */

/**
 * A DIVIDER UNDER A FINGER.
 *
 * Takes the ENGINE rather than a browser, because a coarse pointer needs
 * `launchTouchBrowser` - Gecko only reports one when the prefs were set at
 * launch, for the cross-origin-isolation reason written down above it.
 *
 * `checkMobileLayout` measures every target against WCAG 2.5.5 at 320-430px and
 * never sees this one: below the breakpoint the panel is a sheet and there is
 * nothing to resize. A touchscreen at 1000px or more is the one place this
 * control exists under a finger, and it was a 4px column there.
 */
async function checkInspectorTouch(engine, label) {
  const browser = await launchTouchBrowser(engine);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    hasTouch: true,
  });
  const page = await context.newPage();

  try {
    await gotoCanvas(page);
    await page.getByRole('button', { name: 'Add tool' }).click();
    await page.locator('[role="dialog"]').first().waitFor({ timeout: 10_000 });
    await page.getByTestId('dialog-option-hash').click();
    await page.waitForTimeout(400);
    await setInspector(page, true);
    await page.getByTestId('inspector-handle').waitFor({ timeout: 10_000 });

    const coarse = await page.evaluate(() => {
      const handle = document.querySelector('[data-testid="inspector-handle"]');
      const box = handle.getBoundingClientRect();
      const midY = Math.round(box.top + box.height / 2);
      const centre = Math.round(box.left + box.width / 2);
      let left = centre;
      while (document.elementFromPoint(left - 1, midY) === handle && centre - left < 120) left -= 1;
      let right = centre;
      while (document.elementFromPoint(right + 1, midY) === handle && right - centre < 120)
        right += 1;
      return {
        coarsePointer: window.matchMedia('(pointer: coarse)').matches,
        rule: getComputedStyle(handle, '::before').inlineSize,
        hit: right - left + 1,
        box: Math.round(box.width),
      };
    });

    check(
      label,
      'the emulated pointer really is coarse, so the 44px rule applies',
      coarse.coarsePointer,
      `pointer: coarse is ${String(coarse.coarsePointer)}`,
    );
    /*
     * 44px is WCAG 2.5.5, and the tolerance is one pixel because the grid track
     * boundary the probe walks out from is not always on a whole pixel.
     */
    check(
      label,
      'the divider meets the 44px touch minimum on a coarse pointer',
      coarse.hit >= 43,
      `${String(coarse.hit)}px target`,
    );
    /* And the rule itself does NOT grow with the target - that is the point. */
    check(
      label,
      'and the visible rule is still a hairline under a finger',
      coarse.rule === '1px',
      `rule ${coarse.rule} inside a ${String(coarse.hit)}px target`,
    );

    /* -- And it survives forced colours ---------------------------------- */

    /*
     * THE COST OF PAINTING THE RULE AS A BACKGROUND, PAID BACK EXPLICITLY.
     *
     * In forced-colors mode the OS replaces every author background with its
     * own Canvas, so a one-pixel strip of `--pb-border-hairline` would become a
     * one-pixel strip of the surface behind it and the divider would vanish.
     * The version this replaced used `border-inline`, which the UA repaints in
     * `CanvasText` for free - so the regression would have been silent, and
     * silent for exactly the users who need a boundary most.
     *
     * Asserted rather than trusted, because the fix is one media query and the
     * failure is invisible in every other mode.
     */
    const forced = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      forcedColors: 'active',
    });
    const forcedPage = await forced.newPage();
    try {
      await gotoCanvas(forcedPage);
      await forcedPage.locator('[role="application"]').first().waitFor({ timeout: 15_000 });
      await setInspector(forcedPage, true);
      await forcedPage.getByTestId('inspector-handle').waitFor({ timeout: 10_000 });

      const painted = await forcedPage.evaluate(() => {
        const handle = document.querySelector('[data-testid="inspector-handle"]');
        const rule = getComputedStyle(handle, '::before');
        const surface = getComputedStyle(
          document.querySelector('[data-testid="node-inspector"]'),
        ).backgroundColor;
        return { rule: rule.backgroundColor, width: rule.inlineSize, surface };
      });

      check(
        label,
        'the divider is still visible under forced colours',
        painted.rule !== painted.surface && painted.width === '1px',
        `rule ${painted.rule} against a ${painted.surface} panel`,
      );
    } finally {
      await forced.close().catch(() => {});
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/**
 * THE SLIDE, AND THE STATE THE PANEL STARTS IN.
 *
 * Both are things jsdom cannot see. It runs no animations at all - so the unit
 * suite can assert the state machine and not one pixel of movement - and it has
 * no layout, so "the canvas narrowed with the panel" is not a question it can
 * answer.
 *
 * WHY THE WIDTH IS WHAT ANIMATES. The rail is a grid track and the canvas is
 * meant to narrow with it, so a transform would slide the panel over a canvas
 * that had already snapped to its new size. Measured on a 48-node canvas with a
 * match table in the panel, against an idle baseline in the same page: the
 * width animation's worst frame is within about 2ms of no animation at all in
 * Gecko and indistinguishable from it in JavaScriptCore, because nothing inside
 * the canvas depends on the root's width - the nodes and wires sit on a 0x0
 * transformed plane and the grid is a repeating background image. What is NOT
 * free is letting the panel's contents re-wrap at every intermediate width:
 * that doubled the worst frame in JavaScriptCore (72ms against 36ms) and halved
 * the number of frames actually painted, which is why the content column is
 * pinned at the resting width. This asserts the pin is in place.
 */
async function checkInspectorMotion(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  try {
    await gotoCanvas(page);
    await page.getByRole('button', { name: 'Add tool' }).click();
    await page.locator('[role="dialog"]').first().waitFor({ timeout: 10_000 });
    await page.getByTestId('dialog-option-hash').click();
    await page.waitForTimeout(400);

    /* -- It starts closed, and remembers ---------------------------------- */
    check(
      label,
      'the inspector is closed on a first load rather than explaining itself',
      (await page.getByTestId('node-inspector').count()) === 0,
      '',
    );

    await setInspector(page, true);
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('[role="application"]').first().waitFor({ timeout: 15_000 });
    /*
     * A REAL RELOAD, which is the only way to test this: the panel is closed on
     * a FIRST visit and remembered after that, so "closed on first load" and
     * "the user's choice survives" are two claims and this is the second one.
     */
    check(
      label,
      'and it comes back open after a reload once the user has opened it',
      (await page.getByTestId('node-inspector').count()) === 1,
      '',
    );

    /* -- The slide -------------------------------------------------------- */

    /*
     * Sampled per frame across one close and one open. What is asserted is that
     * the panel passed through intermediate widths rather than jumping, and
     * that the canvas's right edge tracked the panel's left edge the whole way
     * - which is the difference between animating the width and animating a
     * transform over a canvas that has already resized.
     */
    const slide = await page.evaluate(async () => {
      const canvas = document.querySelector('[data-testid="canvas-root"]');
      const samples = [];
      let stop = false;

      const tick = () => {
        const panel = document.querySelector('[data-testid="node-inspector"]');
        samples.push({
          panel: panel ? panel.getBoundingClientRect() : null,
          canvasRight: canvas.getBoundingClientRect().right,
        });
        if (!stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);

      const root = document.querySelector('[data-testid="canvas-root"]');
      const press = () => {
        root.focus();
        root.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true }));
      };
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      press();
      await wait(400);
      press();
      await wait(400);
      stop = true;
      await wait(50);

      const withPanel = samples.filter((sample) => sample.panel !== null);
      const widths = withPanel.map((sample) => Math.round(sample.panel.width));
      /* Intermediate: on screen, but not yet at rest. */
      const partial = new Set(widths.filter((width) => width > 0 && width < 335));
      /*
       * The gap between the canvas's right edge and the panel's left edge. It
       * is the resize handle's own column and must stay that width throughout,
       * which is what "they moved together" means.
       */
      const gaps = withPanel
        .filter((sample) => sample.panel.width > 0)
        .map((sample) => Math.round(sample.panel.left - sample.canvasRight));

      return {
        frames: samples.length,
        steps: partial.size,
        worstGap: gaps.length > 0 ? Math.max(...gaps) : null,
        bestGap: gaps.length > 0 ? Math.min(...gaps) : null,
      };
    });

    check(
      label,
      'the panel slides through intermediate widths rather than appearing',
      slide.steps >= 3,
      `${String(slide.steps)} intermediate widths painted over ${String(slide.frames)} frames`,
    );
    check(
      label,
      'the canvas narrows in step with it, never overlapping and never gapping',
      slide.worstGap !== null && slide.worstGap <= 9 && slide.bestGap >= -1,
      `gap between canvas and panel stayed ${String(slide.bestGap)}..${String(slide.worstGap)}px`,
    );

    /*
     * THE CONTENT COLUMN IS PINNED, which is the measured half of the design:
     * an unpinned panel re-wraps every label and table row at every
     * intermediate width, and that is what turns a free animation into a
     * stutter. Asserted as a computed style rather than as a frame timing,
     * because a timing assertion in this harness would be flaky and this is the
     * thing that actually has to stay true.
     */
    const pinned = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="node-inspector"]');
      return {
        columns: getComputedStyle(panel).gridTemplateColumns,
        width: Math.round(panel.getBoundingClientRect().width),
      };
    });
    check(
      label,
      "the panel's content column is pinned to its resting width, so nothing re-wraps mid-slide",
      Math.abs(Number.parseFloat(pinned.columns) - pinned.width) <= 1,
      `column ${pinned.columns} against a ${String(pinned.width)}px panel`,
    );

    /* -- Reduced motion ends it rather than shortening it ----------------- */

    /*
     * `global.css` collapses every duration to 1ms rather than to 0, precisely
     * so `animationend` still fires and the phase machine cannot stall. This
     * asserts the outcome a user of that preference gets: the panel arrives
     * without a slide, and it does arrive.
     */
    const reduced = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    });
    const reducedPage = await reduced.newPage();
    try {
      await gotoCanvas(reducedPage);
      await reducedPage.locator('[role="application"]').first().waitFor({ timeout: 15_000 });
      await setInspector(reducedPage, false);

      const instant = await reducedPage.evaluate(async () => {
        const root = document.querySelector('[data-testid="canvas-root"]');
        root.focus();
        root.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true }));
        // Two frames: enough for the panel to be laid out, far less than a slide.
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const panel = document.querySelector('[data-testid="node-inspector"]');
        return {
          duration: panel ? getComputedStyle(panel).animationDuration : null,
          width: panel ? Math.round(panel.getBoundingClientRect().width) : null,
        };
      });

      check(
        label,
        'reduced motion ends the slide rather than merely shortening it',
        instant.duration === '0.001s' && instant.width >= 335,
        `duration ${String(instant.duration)}, panel ${String(instant.width)}px two frames in`,
      );
    } finally {
      await reduced.close().catch(() => {});
    }
  } finally {
    await context.close().catch(() => {});
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
    await gotoCanvas(page);
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
 * THE HALF OF THE THEME EDITOR jsdom CANNOT SEE.
 *
 * The unit suite proves the editor writes `--pb-accent` onto <html> and that
 * the primary button's stylesheet reads `var(--pb-accent)`. It cannot prove
 * the two meet, because jsdom has no layout engine: it cascades custom
 * properties but does not SUBSTITUTE `var()`, so asking a button for its
 * computed background there returns the literal string rather than a colour.
 *
 * This asks a real engine. Change one token in the editor and the button that
 * was orange has to be green - which is the whole claim the feature makes.
 */
async function checkThemeEditor(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();

  try {
    await page.goto(`${ORIGIN}/styleguide`, { waitUntil: 'networkidle' });

    const primary = page.getByRole('button', { name: 'Default' }).first();
    await primary.waitFor({ timeout: 15_000 });
    const backgroundOf = (locator) =>
      locator.evaluate((element) => getComputedStyle(element).backgroundColor);

    const before = await backgroundOf(primary);

    await page.getByRole('button', { name: 'Create theme' }).click();
    await page.getByRole('tab', { name: 'Accent' }).click();
    await page.getByRole('textbox', { name: 'accent', exact: true }).fill('oklch(0.72 0.19 145)');
    await page.waitForTimeout(300);

    const after = await backgroundOf(primary);
    check(
      label,
      'a token edited in the editor repaints a real component',
      before !== after && after === 'rgb(67, 194, 81)',
      `${before} -> ${after}`,
    );

    // The value that reached the stylesheet is the CANONICAL one, not the
    // oklch() that was typed. That is the security boundary doing its job:
    // only a hex literal is ever written into a custom property.
    const applied = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--pb-accent'),
    );
    check(
      label,
      'only a canonical hex literal reaches the stylesheet',
      /^#[0-9a-f]{6}$/.test(applied),
      applied || 'absent',
    );

    /*
     * A value that is a legal custom property but not a colour. `url(...)`
     * used as a background is a NETWORK REQUEST out of an application that
     * makes none, so the editor must refuse it outright rather than store it.
     */
    await page
      .getByRole('textbox', { name: 'accent', exact: true })
      .fill('url(https://example.com/pixel.png)');
    await page.waitForTimeout(200);

    const afterHostile = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--pb-accent'),
    );
    check(
      label,
      'a url() is refused rather than written into a custom property',
      afterHostile === applied,
      afterHostile || 'absent',
    );

    // And the failure is reported to the user, not swallowed.
    check(
      label,
      'the rejected colour is announced as an error',
      await page.getByRole('alert').filter({ hasText: 'Not a colour' }).first().isVisible(),
    );

    /*
     * Live contrast, measured in the engine that is doing the painting. The
     * editor resolves tokens from the stylesheet text rather than from
     * getComputedStyle - see lib/cssTokens.ts - so this is the check that the
     * two agree about what the page actually looks like.
     */
    await page.getByRole('tab', { name: 'Ink' }).click();
    await page.getByRole('textbox', { name: 'ink-primary', exact: true }).fill('#0c0d12');
    await page.waitForTimeout(300);

    const summary = await page
      .getByText(/pairs? fail WCAG AA/)
      .first()
      .textContent();
    /*
     * The TOTAL is not asserted here, and the 33 that used to be written into
     * this pattern is why: the list in `contrast.ts` grew by five pairs and
     * this line then failed in both engines over a change that had nothing to
     * do with what it is checking. The count is held to the real list by
     * `editor.test.tsx`, which can import it. What this check is for is that
     * the number the ENGINE renders is a real measurement of the colours the
     * engine is painting - which is the next assertion's other half.
     */
    check(
      label,
      'the contrast readout reports a theme the user has just broken',
      /\d+ of \d+ pairs fail WCAG AA/.test(summary ?? ''),
      summary ?? 'absent',
    );

    const measured = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        ink: style.getPropertyValue('--pb-ink-primary').trim(),
        surface: style.getPropertyValue('--pb-surface-base').trim(),
      };
    });
    check(
      label,
      'the page really is wearing the colours the readout measured',
      measured.ink === '#0c0d12',
      JSON.stringify(measured),
    );

    // Live preview off puts the page back without discarding the work.
    await page.getByRole('switch', { name: 'Live preview' }).click();
    await page.waitForTimeout(200);
    const restored = await backgroundOf(primary);
    check(
      label,
      'turning live preview off restores the selected theme',
      restored === before,
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
    await gotoCanvas(slowPage);
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
    await gotoCanvas(fastPage);
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
      await gotoCanvas(page);
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
  /*
   * COOP and COEP are kept for reasons that are NOT the reason they were set -
   * multi-threaded WASM, which the feasibility investigation measured as
   * unusable and which this app now ships none of. The reasoning is written
   * out in public/_headers; this loop is what stops the decision being
   * reversed by accident, in either direction.
   */
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
   * NO EVAL-LIKE SOURCE, of any kind, in script-src.
   *
   * `'unsafe-eval'` has never been there. `'wasm-unsafe-eval'` was, set "for
   * the WASM-backed tools to come", and nothing ever compiled a module - the
   * video tool parses containers in TypeScript. A relaxation carried for a
   * consumer that never arrived is the same defect as an affordance for
   * behaviour that does not exist, and this one sat in the security policy,
   * where the cost of the habit is highest. Asserting the absence is what
   * makes the removal a decision rather than a thing that drifts back in with
   * the first dependency that wants it.
   */
  const scriptSrc = /script-src ([^;]*)/.exec(global['Content-Security-Policy'] ?? '')?.[1] ?? '';
  check(
    label,
    'script-src grants no eval-like source, wasm included',
    scriptSrc !== '' && !scriptSrc.includes('unsafe-eval'),
    scriptSrc.slice(0, 70) || 'no script-src found',
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
    await gotoCanvas(page);

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
        ['/', 'the cold open'],
        ['/tools', 'the tool index'],
        ['/tools/base64', 'a tool page'],
        ['/tools/text-convert', 'the text conversion tool'],
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

        /*
         * `/` ANSWERS TWICE, because a first-time visitor and a returning one
         * are not looking at the same document. The scan above covered the
         * introduction panel - a landmark, a heading, five controls and a
         * background this loop has just re-themed - and the empty canvas is
         * underneath it, reachable only by taking it down.
         *
         * The flag is then cleared, so the second pass round this loop sees
         * the panel again rather than silently scanning the canvas twice in
         * vellum and the panel never.
         */
        if (path === '/') {
          await dismissColdOpen(page);
          const behind = await scan();
          check(
            label,
            `the empty canvas is clean in ${theme}`,
            behind.length === 0,
            describe(behind),
          );
          await page.evaluate(() => {
            window.localStorage.removeItem('patchbay:cold-open:v1');
          });
        }
      }
    }

    /*
     * The canvas WITH NODES, which is the case the empty one cannot speak for:
     * node groups, port glyphs, wires and the toolbar readout all only exist
     * once something has been added.
     */
    await gotoCanvas(page);
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

    /*
     * AND WITH A SELECTION, which is the only state the selection bar exists
     * in - a `role="group"` of three controls, one of them the application's
     * single `danger` button, that no scan above can reach because chrome that
     * appears with the selection does not exist on an idle canvas.
     *
     * `color-contrast` is the rule this really buys, and it is the one jsdom
     * cannot run at all: the bar's count line is `--pb-ink-secondary` on
     * `--pb-surface-raised` and the Delete button is a red on the same ground,
     * and both are theme-dependent. The unit suite asserts the structure; only
     * this can say the words are legible.
     */
    await page.locator('[data-node-id]').first().click();
    await page.getByTestId('canvas-selection-bar').waitFor({ timeout: 5_000 });
    const withSelection = await scan();
    check(
      label,
      'the canvas with a selection is clean',
      withSelection.length === 0,
      describe(withSelection),
    );

    /*
     * And with the inspector open on a node, which is a landmark, three
     * headings, a form and an output view that none of the scans above reach.
     *
     * Opened EXPLICITLY, which matters more than it used to: the panel starts
     * closed now, so a scan that assumed it was open by default would silently
     * stop covering it. `inspectFirstNode` presses Enter on a node, which is
     * the route that both selects and opens - the comment here used to claim
     * the toolbar toggle, which is not what the line below does.
     */
    await inspectFirstNode(page);
    await page.waitForTimeout(400);
    const withInspector = await scan();
    check(
      label,
      'the canvas with the inspector open is clean',
      withInspector.length === 0,
      describe(withInspector),
    );
    await setInspector(page, false);

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
    await gotoCanvas(page);
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
 * Structured data through a real worker, with a hostile column name.
 *
 * Two things here are structurally invisible to the unit suite, and both are
 * about the boundary rather than the parser:
 *
 *   1. The parsed document crosses `postMessage`, so it is re-created by the
 *      engine's own STRUCTURED CLONE. A CSV column called `__proto__` is stored
 *      as a real own property with `Object.defineProperty` - and whether an own
 *      `__proto__` survives a clone, or is turned back into a prototype
 *      assignment on the way out, is a question about the engine. jsdom answers
 *      it with its own implementation, which is not the one that ships.
 *   2. Nothing may pollute `Object.prototype` on the main thread as a result.
 *
 * The value is the same shape the property tests use, run through the whole
 * product: tool page, worker, clone, render.
 */
async function checkStructuredData(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    await page.goto(`${ORIGIN}/tools/structured-data`, { waitUntil: 'networkidle' });

    await page.getByLabel('Structured data input').fill('__proto__,note\npolluted,ok');
    await page.getByRole('button', { name: 'Run' }).click();

    const converted = page.getByLabel('Structured data Converted');
    await converted.waitFor({ timeout: 30_000 });
    await expectValue(converted, '__proto__');

    const text = await converted.inputValue();
    check(
      label,
      'a __proto__ column survives the worker boundary as data',
      text.includes('"__proto__": "polluted"'),
      text.replace(/\s+/g, ' ').slice(0, 80),
    );

    const clean = await page.evaluate(() => {
      const probe = {};
      return {
        untouched: Object.getPrototypeOf(probe) === Object.prototype,
        noStrayKey: !('note' in probe) && !('polluted' in probe),
      };
    });
    check(
      label,
      'nothing reached Object.prototype on the way through',
      clean.untouched && clean.noStrayKey,
      JSON.stringify(clean),
    );

    // And the parsed structure on the second port agrees with the rendered one,
    // which is the half a canvas node would wire onward.
    const parsedPort = page.getByLabel('Structured data Parsed data');
    const parsedText = await parsedPort.inputValue();
    check(
      label,
      'both output ports describe the same document',
      parsedText.includes('__proto__'),
      parsedText.replace(/\s+/g, ' ').slice(0, 80),
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * The diff view in a real engine, where its non-colour signals actually exist.
 *
 * Everything here is structurally invisible to the unit suite, and every item
 * is a claim the tool makes about how it renders:
 *
 *   1. `<ins>` and `<del>` are used BECAUSE they are underlined and struck
 *      through by default, which is the intra-line signal that is not colour.
 *      Most CSS resets remove that decoration; ours must not. jsdom has no
 *      computed `text-decoration-line` at all, so nothing could check it.
 *   2. A row's text is `unicode-bidi: isolate` so a right-to-left override
 *      cannot reorder the sign column and the gutters around it. That is a
 *      layout property, and jsdom has no layout.
 *   3. A single very long line must scroll inside the row list rather than
 *      widening the page.
 *   4. A dropped FILE keeps its carriage returns, where a textarea does not -
 *      so this is the only place the line-ending path can be exercised
 *      end-to-end, through a real worker.
 */
async function checkDiff(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    await page.goto(`${ORIGIN}/tools/diff`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1, name: 'Diff' }).waitFor({ timeout: 15_000 });

    await page.getByLabel('Diff Original input').fill('keep me\nthe quick brown fox\nkeep me too');
    await page.getByLabel('Diff Changed input').fill('keep me\nthe quick red fox\nkeep me too');
    await page.getByRole('button', { name: 'Run' }).click();

    await page.locator('del').first().waitFor({ timeout: 30_000 });

    const decoration = await page.evaluate(() => {
      const read = (selector) => {
        const node = document.querySelector(selector);
        return node ? getComputedStyle(node).textDecorationLine : null;
      };
      return { del: read('del'), ins: read('ins') };
    });
    check(
      label,
      'ins and del keep a decoration, so the word signal is not colour alone',
      decoration.del?.includes('line-through') === true &&
        decoration.ins?.includes('underline') === true,
      JSON.stringify(decoration),
    );

    const isolated = await page.evaluate(() => {
      const row = document.querySelector('ol li');
      const text = row?.lastElementChild;
      return text ? getComputedStyle(text).unicodeBidi : null;
    });
    check(
      label,
      'a diff row isolates its own bidi, so an override cannot move the gutters',
      isolated === 'isolate',
      String(isolated),
    );

    /* -- One very long line must not widen the page ---------------------- */
    const long = `x${'abcdefghij'.repeat(400)}`;
    await page.getByLabel('Diff Original input').fill(long);
    await page.getByLabel('Diff Changed input').fill(`y${'abcdefghij'.repeat(400)}`);
    await page.getByRole('button', { name: 'Run' }).click();
    await page.waitForTimeout(500);

    const overflow = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    check(
      label,
      'a 4,000-character line does not make the page scroll sideways',
      overflow.document <= 1,
      `${String(overflow.document)}px`,
    );

    /* -- A dropped file keeps its CRLF, which a textarea would have eaten - */
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1, name: 'Diff' }).waitFor({ timeout: 15_000 });
    await page.getByLabel('Diff Changed input').fill('alpha\nbeta\ngamma\n');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'original.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('alpha\r\nbeta\r\ngamma\r\n', 'utf8'),
    });
    await page.getByRole('button', { name: 'Run' }).click();

    const note = page.getByText(/uses CRLF, the changed text uses LF/);
    await note.waitFor({ timeout: 30_000 }).catch(() => {});
    check(
      label,
      'a CRLF file against an LF one is one note, not every line rewritten',
      (await note.count()) === 1,
      `${String(await page.locator('ol li').count())} diff rows rendered, ${String(await note.count())} note(s)`,
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/** Waits for a readonly textarea to hold something, then for it to match. */
async function expectValue(locator, needle) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const value = await locator.inputValue().catch(() => '');
    if (value.includes(needle)) return;
    await locator.page().waitForTimeout(250);
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

/**
 * A BROWSER WHOSE POINTER REALLY IS COARSE, UNDER THE REAL HEADERS.
 *
 * Playwright's per-context `hasTouch` sets Gecko's pointer-capability prefs in
 * the content process it happens to be talking to. `_headers` sets COOP and
 * COEP, so the built app is cross-origin isolated - and Gecko moves an isolated
 * document into a FRESH content process, which the emulation never reaches. The
 * measurable result is that `(pointer: coarse)` is true for the dev server and
 * false for the production build in the same context, and stays false for every
 * later navigation in it.
 *
 * That is not "Firefox cannot emulate a touch pointer", which is what this
 * harness recorded for as long as it had a skip branch here. Setting the two
 * prefs at LAUNCH survives the process switch, so both engines can be held to
 * the same 44px bar. WebKit needs nothing and would reject the option.
 *
 * The bitmask is Gecko's own: 1 coarse, 2 fine, 4 hover.
 */
async function launchTouchBrowser(engine) {
  if (engine.name() !== 'firefox') return engine.launch();
  return engine.launch({
    firefoxUserPrefs: { 'ui.primaryPointerCapabilities': 1, 'ui.allPointerCapabilities': 1 },
  });
}

/**
 * Touch.
 *
 * The canvas could not be panned or pinched with fingers at all: panning was
 * reachable only by space+drag, middle-drag and the wheel, and pinch was
 * implemented as ctrl+wheel. A touchscreen has none of those. `touch-action:
 * none` was already set, so the browser was never the problem - the handlers
 * had no branch a finger could reach.
 *
 * Driven with constructed PointerEvents carrying pointerType 'touch' rather
 * than Playwright's touchscreen API, because that is what the canvas listens
 * for and it lets a second and third finger be placed precisely.
 */
async function checkTouch(engine, label) {
  const browser = await launchTouchBrowser(engine);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();

  /** Dispatches a sequence of touch pointer events on the canvas root. */
  const touch = (steps) =>
    page.evaluate((sequence) => {
      const root = document.querySelector('[role="application"]');
      if (!root) return;
      for (const [type, id, x, y] of sequence) {
        root.dispatchEvent(
          new PointerEvent(type, {
            pointerId: id,
            pointerType: 'touch',
            isPrimary: id === 1,
            clientX: x,
            clientY: y,
            button: type === 'pointerup' || type === 'pointercancel' ? -1 : 0,
            buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    }, steps);

  const plane = () =>
    page.evaluate(
      () => document.querySelector('[data-testid="canvas-plane"]')?.style.transform ?? '',
    );

  try {
    await gotoCanvas(page);
    await page.locator('[role="application"]').first().waitFor({ timeout: 15_000 });

    check(
      label,
      'the canvas root takes the gesture rather than the browser',
      (await page.evaluate(
        () => getComputedStyle(document.querySelector('[role="application"]')).touchAction,
      )) === 'none',
      '',
    );

    /* -- One finger pans ------------------------------------------------- */
    const beforePan = await plane();
    await touch([
      ['pointerdown', 1, 200, 400],
      ['pointermove', 1, 240, 340],
      ['pointermove', 1, 260, 300],
      ['pointerup', 1, 260, 300],
    ]);
    await page.waitForTimeout(200);
    const afterPan = await plane();
    check(
      label,
      'one finger drags the canvas',
      afterPan !== beforePan,
      `${beforePan} -> ${afterPan}`,
    );

    /* -- Two fingers pinch ----------------------------------------------- */
    const zoom = () =>
      page.evaluate(() => {
        const t = document.querySelector('[data-testid="canvas-plane"]')?.style.transform ?? '';
        return Number(/scale\(([\d.]+)\)/.exec(t)?.[1] ?? '1');
      });

    const beforeZoom = await zoom();
    await touch([
      ['pointerdown', 1, 150, 400],
      ['pointerdown', 2, 250, 400],
      ['pointermove', 1, 100, 400],
      ['pointermove', 2, 300, 400],
      ['pointermove', 1, 50, 400],
      ['pointermove', 2, 350, 400],
      ['pointerup', 1, 50, 400],
      ['pointerup', 2, 350, 400],
    ]);
    await page.waitForTimeout(200);
    const afterZoom = await zoom();
    check(
      label,
      'two fingers pinch to zoom',
      afterZoom > beforeZoom * 1.5,
      `${String(beforeZoom)} -> ${String(afterZoom)}`,
    );

    /* -- A gesture the browser takes away -------------------------------- */
    await touch([
      ['pointerdown', 1, 150, 400],
      ['pointerdown', 2, 250, 400],
      ['pointermove', 1, 120, 400],
      ['pointercancel', 1, 120, 400],
      ['pointercancel', 2, 250, 400],
    ]);
    await page.waitForTimeout(150);

    const strandedFrom = await plane();
    await touch([
      ['pointerdown', 3, 200, 400],
      ['pointermove', 3, 240, 400],
      ['pointerup', 3, 240, 400],
    ]);
    await page.waitForTimeout(200);
    check(
      label,
      'the canvas still pans after a cancelled gesture',
      (await plane()) !== strandedFrom,
      `${strandedFrom} -> ${await plane()}`,
    );

    /* -- Nothing moves while a dialog is open ---------------------------- */
    await page.getByRole('button', { name: 'Add tool' }).click();
    await page.locator('[role="dialog"]').first().waitFor({ timeout: 10_000 });

    const duringDialog = await plane();
    await touch([
      ['pointerdown', 1, 195, 400],
      ['pointermove', 1, 260, 300],
      ['pointerup', 1, 260, 300],
    ]);
    await touch([
      ['pointerdown', 1, 150, 400],
      ['pointerdown', 2, 250, 400],
      ['pointermove', 1, 50, 400],
      ['pointermove', 2, 350, 400],
      ['pointerup', 1, 50, 400],
      ['pointerup', 2, 350, 400],
    ]);
    await page.waitForTimeout(200);
    check(
      label,
      'touch cannot pan or pinch the canvas while a dialog is open',
      (await plane()) === duringDialog,
      `${duringDialog} -> ${await plane()}`,
    );

    /* -- Tapping a row in a chooser -------------------------------------- */

    /*
     * THE TAP THAT NOTHING WAS TESTING.
     *
     * A dialog row commits through a delegated `click`, and `pointerdown` on
     * it was cancelled unconditionally to keep focus in the search field.
     * WebKit routes a cancelled `pointerdown` down the same path as a
     * cancelled `touchstart` and suppresses the synthesised click - so every
     * tap on a tool in the palette, or on a port in the connect flow, would do
     * nothing at all. The whole of the touch route into connecting depends on
     * this one behaviour.
     *
     * `page.touchscreen.tap` rather than a dispatched PointerEvent, and
     * deliberately so: a synthesised `click` would bypass the engine's own
     * click suppression, which is the exact thing under test. This is the one
     * place in this function where the ENGINE has to decide whether a click
     * follows the press.
     */
    const tapCentre = async (locator) => {
      /*
       * Scrolled into view FIRST. A tap goes to a viewport coordinate, and the
       * option list is its own scroll container - so a row below the fold has
       * a bounding box outside the visible area and the tap lands on whatever
       * is really there. Observed as the palette staying open and every later
       * check failing on a scrim intercepting its clicks.
       */
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      /*
       * A SHORT TIMEOUT, AND A CATCH, because the default is thirty seconds
       * and a throw - and a throw here is not a failing check, it is the
       * script dying and taking every check after it with it.
       *
       * The case that does it is a toast: the Undo offered after a wire is
       * deleted lives six seconds, `count()` and `boundingBox()` are two round
       * trips, and a slow run puts the dismissal between them. Observed once
       * in WebKit, where it aborted the run two hundred checks early and
       * reported a Playwright timeout rather than anything about the app.
       * Returning false instead makes it the named failure it always was.
       */
      const box = await locator.boundingBox({ timeout: 2000 }).catch(() => null);
      if (!box) return false;
      await page.touchscreen.tap(
        Math.round(box.x + box.width / 2),
        Math.round(box.y + box.height / 2),
      );
      return true;
    };

    const tapped = await tapCentre(page.getByTestId('dialog-option-base64'));
    await page.waitForTimeout(400);

    check(
      label,
      'a finger can tap a row in the tool palette',
      tapped && (await page.locator('[data-node-id]').count()) === 1,
      `tapped=${String(tapped)}, nodes=${String(await page.locator('[data-node-id]').count())}`,
    );

    /* -- Fit, on the bar rather than behind the overflow menu ------------- */

    /*
     * The most useful control on a small screen, so it is not behind a tap.
     * A node is 224px wide and this viewport is 390px, so panning away from
     * the graph is easy and Fit is how it is found again. Driven with a real
     * touch tap rather than .click(), because a control promoted for touch
     * that only responds to a mouse would be worse than leaving it buried.
     */
    const fit = page.getByRole('button', { name: 'Fit' });
    check(label, 'Fit is on the toolbar, not in the overflow menu', (await fit.count()) === 1, '');

    // Pan the graph well out of view first.
    await touch([
      ['pointerdown', 1, 60, 700],
      ['pointermove', 1, 340, 200],
      ['pointerup', 1, 340, 200],
    ]);
    await page.waitForTimeout(200);
    const lost = await plane();

    const box = await fit.boundingBox();
    await touch([]);
    await page.evaluate(
      (point) => {
        const button = [...document.querySelectorAll('button')].find(
          (candidate) => (candidate.textContent ?? '').trim() === 'Fit',
        );
        if (!button) return;
        for (const type of ['pointerdown', 'pointerup', 'click']) {
          button.dispatchEvent(
            new PointerEvent(type, {
              pointerId: 9,
              pointerType: 'touch',
              isPrimary: true,
              clientX: point.x,
              clientY: point.y,
              button: type === 'pointerup' ? -1 : 0,
              buttons: type === 'pointerdown' ? 1 : 0,
              bubbles: true,
              cancelable: true,
            }),
          );
        }
      },
      {
        x: Math.round((box?.x ?? 0) + (box?.width ?? 0) / 2),
        y: Math.round((box?.y ?? 0) + (box?.height ?? 0) / 2),
      },
    );
    await page.waitForTimeout(300);

    check(
      label,
      'tapping Fit brings a graph panned off-screen back',
      (await plane()) !== lost,
      `${lost} -> ${await plane()}`,
    );

    /* -- Touch target sizes ---------------------------------------------- */

    /*
     * Asserted rather than skipped past. Every 44px rule in the application is
     * inside `@media (pointer: coarse)`, so a harness that does not report one
     * measures the dense desktop layout and calls it a touch audit. This used
     * to be a `skip` in Firefox, which meant the target sizes below had never
     * actually been checked in Gecko - see `launchTouchBrowser`.
     */
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
    check(label, 'the harness reports a coarse pointer', coarse, '');

    const targets = await page.evaluate(() => {
      const selector = 'button, a[href], input, textarea, [role="option"], [role="menuitem"]';
      const small = [];
      for (const element of document.querySelectorAll(selector)) {
        // Ports are <button>s, and they are the documented exception: they sit
        // on a 32px pitch, so a 44px box overlaps its neighbour. Asserted
        // separately, below, rather than quietly folded in here.
        if (element.hasAttribute('data-port-id')) continue;

        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.height >= 44) continue;
        const name = (element.getAttribute('aria-label') ?? element.textContent ?? element.tagName)
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 24);
        small.push(`${name} ${String(Math.round(rect.height))}px`);
      }
      return [...new Set(small)];
    });

    check(
      label,
      'every interactive target is at least 44px tall on a coarse pointer',
      targets.length === 0,
      targets.join(', '),
    );

    /*
     * Ports are the known exception, asserted rather than ignored: they stay
     * on their 24px pitch because a 44px box would overlap its neighbour and
     * connect the wrong port. This pins the current state so the trade-off is
     * a decision in the repo rather than an oversight - see the comment in
     * canvas.module.css.
     */
    const port = await page.evaluate(() => {
      const element = document.querySelector('[data-port-id]');
      // Computed style, not a bounding rect: the canvas may be zoomed, and a
      // rect would report 24px x whatever the zoom happens to be.
      return element ? parseFloat(getComputedStyle(element).blockSize) : 0;
    });
    check(
      label,
      'ports are still on their pitch, not inflated into each other',
      port > 0 && port <= 32,
      `${String(port)}px`,
    );

    /*
     * The field moved from the node to the inspector, and the 16px floor moved
     * with it - it is the only typeable thing on this route now, so it is the
     * only one that can trigger the zoom.
     */
    await inspectFirstNode(page);
    const field = await page.evaluate(() => {
      const element = document.querySelector('[data-inspector-input]');
      return element ? parseFloat(getComputedStyle(element).fontSize) : 0;
    });
    // Below 16px, iOS Safari zooms the viewport on focus and never zooms back.
    check(label, 'an inspector field will not make iOS zoom in', field >= 16, `${String(field)}px`);

    /*
     * LAST IN THIS FUNCTION, AND THAT IS DELIBERATE.
     *
     * It is the only block here that leaves the graph changed - a second node
     * and a wire - and the first version of it sat in the middle, where the
     * inspector-field check above then found a node whose only input was
     * occupied and reported 0px. A new check that quietly rearranges the
     * fixture for the checks after it is worse than no check.
     *
     * The inspector is closed first: at 390px it is a sheet across the bottom
     * of the workspace, which is exactly where a node sits after a Fit.
     */
    await setInspector(page, false);
    /* -- Wiring two tools together with nothing but a finger ------------- */

    /*
     * THE ROUTE THIS SECTION EXISTS FOR.
     *
     * The connect dialog is reached by pressing `C` on a focused node, and `C`
     * was also the documented way to read a port label the node had truncated.
     * A phone has no `C`. Dragging a wire from a port does work with a finger,
     * so nothing was blocked - but the documented escape hatch did not exist
     * on the one device where labels truncate most.
     *
     * A selected node now carries a Connect button, and every claim about it
     * needs a real engine:
     *
     *   The button is drawn OUTSIDE the node's box, below it, because it grows
     *   to 44px on a coarse pointer and the node's header and footer are 24px
     *   bands that `nodeHeight` adds up to place the wire anchors. Whether it
     *   then lands inside the canvas is layout, which jsdom has none of.
     *
     *   A press inside a node captures the pointer on the canvas root, and a
     *   captured pointer retargets its own pointerup AND its click to the
     *   capture element. jsdom implements no capture retargeting, so "the
     *   button's click actually arrives" is only answerable here.
     *
     *   And the press must not be read as the start of a node drag.
     */
    await page.getByRole('button', { name: 'Add tool' }).click();
    await page.locator('[role="dialog"]').first().waitFor({ timeout: 10_000 });
    await tapCentre(page.getByTestId('dialog-option-hash'));
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: 'Fit' }).click();
    await page.waitForTimeout(300);

    /*
     * WHICHEVER NODE IS ACTUALLY UNDER THE FINGER, and it is worth being
     * careful here rather than assuming. `freeSpot` cascades a new node by
     * 32px down and right, so the second node covers the first one's centre
     * - a tap aimed at the centre of the first box lands on the second,
     * which paints on top. The first version of this called the locator
     * `base64Node` and then reported a chooser full of Hash's ports.
     *
     * So the node under test is read back FROM the button, which is the only
     * thing that knows which node the selection landed on.
     */
    await tapCentre(page.locator('[data-node-id]').first());
    await page.waitForTimeout(300);

    const connect = page.getByRole('button', { name: /^Connect from/ });
    check(
      label,
      'selecting a node with a finger reveals its Connect button',
      (await connect.count()) === 1,
      `${String(await connect.count())} buttons`,
    );

    /*
     * Big enough for a finger AND on screen. The first half the generic scan
     * below would catch; the second it would not - the button hangs below the
     * node and the canvas root clips (`overflow: hidden`, load-bearing for the
     * plane), so a node near the bottom edge would have its control cut off.
     * Measured after Fit, which is where a graph actually sits.
     */
    const connectBox = await connect.boundingBox();
    const frame = page.viewportSize();
    check(
      label,
      'the node Connect button is finger-sized and inside the canvas',
      connectBox !== null &&
        connectBox.height >= 44 &&
        connectBox.y >= 0 &&
        connectBox.y + connectBox.height <= (frame?.height ?? 0) + 1,
      connectBox
        ? `${String(Math.round(connectBox.height))}px tall at y ${String(Math.round(connectBox.y))} in ${String(frame?.height ?? 0)}px`
        : 'no box',
    );

    /**
     * The accessible name of the node the Connect button belongs to.
     *
     * A node's name carries its position - "Base64, at 16, 408, ..." - which
     * is how a move that should not have happened shows up. Resolved through
     * the button rather than by index, so it is the node the press was
     * actually about.
     */
    const nodeName = async () =>
      page.evaluate(
        () =>
          document
            .querySelector('[data-node-action]')
            ?.closest('[data-node-id]')
            ?.getAttribute('aria-label') ?? '',
      );
    const beforeTap = await nodeName();

    await tapCentre(connect);
    await page.waitForTimeout(400);

    const chooser = page.getByRole('dialog', { name: /Connect from which port/ });
    check(
      label,
      'tapping it opens the chooser rather than being eaten by the pointer capture',
      (await chooser.count()) === 1,
      `${String(await chooser.count())} dialogs`,
    );

    check(
      label,
      'tapping it does not drag the node it belongs to',
      (await nodeName()) === beforeTap,
      `${beforeTap} -> ${await nodeName()}`,
    );

    /*
     * And through to a wire, by tap alone. The port rows in this dialog carry
     * each port's FULL label, which is the truncation fallback the button was
     * built to make reachable - so a tap has to be able to get here and read
     * them, not merely open the box.
     */
    const portRows = page.locator('[role="dialog"] [role="option"]');
    const firstPort = await portRows.first().textContent();
    await tapCentre(portRows.first());
    await page.waitForTimeout(400);

    const partners = page.locator('[role="dialog"] [role="option"]');
    const tappedPartner = (await partners.count()) > 0 && (await tapCentre(partners.first()));
    await page.waitForTimeout(500);

    /*
     * COUNTED BY EDGE ID. Every path in the plane was the first version, and
     * it is not a wire count at all: each port draws its glyph as SVG inside
     * the plane, so it read 10 with no wires on the canvas and the check
     * would have passed having connected nothing. `data-edge-id` is the wire
     * layer's own hook - the one its click delegation uses - and each wire
     * draws two paths under one id, hence the set.
     */
    const wires = await page.evaluate(
      () =>
        new Set(
          [...document.querySelectorAll('[data-edge-id]')].map(
            (element) => element.getAttribute('data-edge-id') ?? '',
          ),
        ).size,
    );
    check(
      label,
      'a finger can wire two tools together end to end',
      tappedPartner && wires === 1,
      `from "${(firstPort ?? '').trim().slice(0, 40)}", ${String(wires)} wire(s)`,
    );

    /* -- Deleting a node and a wire with nothing but a finger ------------- */

    /*
     * THE OTHER HALF OF THE TOUCH MODEL, AND THE HALF THAT WAS BLOCKING.
     *
     * Delete, Duplicate and Select-all were keyboard-only, and once connecting
     * became tappable that stopped being merely incomplete: an occupied input
     * refuses a second wire and says to remove the existing one first, so a
     * finger could build a graph in three taps and be unable to rewire it.
     *
     * Every claim below needs a real engine:
     *
     *   A wire is a curve, not a box. Its grab band is a fat transparent
     *   stroke inside the plane's `scale()`, and `vector-effect:
     *   non-scaling-stroke` - which is exactly the property for keeping that
     *   band a constant size on screen - turns out to govern PAINTING only:
     *   hit-testing walks the untransformed geometry. So the zoom is divided
     *   out in CSS instead, and whether the band really is finger-sized at 36%
     *   AND at 196% is a question only a hit test in a real engine can answer.
     *   It found two things a perfect Chromium build was hiding: a resolved
     *   press measured against an `overflow: visible` SVG root's own client
     *   rect, which Gecko and WebKit compute differently, and a `calc()`
     *   dividing a unitless number in a length context, which both of them
     *   reject outright - leaving `stroke-width: 1`, a one-pixel target.
     *
     *   The selection bar is chrome inside a root that clips, on a screen
     *   where the inspector is a SHEET covering the bottom 60% of that root.
     *   The bar was built at the bottom first and measured there: it sat
     *   underneath the sheet, present in the DOM and unreachable, in the state
     *   a phone is most likely to be in since the inspector is remembered.
     *
     *   And the taps are real taps. The harness used to press rows with
     *   `locator.click()`, which is a mouse even in a `hasTouch` context, and
     *   that hid two real touch bugs - so everything here goes through
     *   `page.touchscreen`, where the engine decides whether a click follows.
     */

    /*
     * THE TWO NODES ARE PULLED APART FIRST, and the first version of this
     * block did not do it - which cost two of the four checks below and taught
     * something worth writing down.
     *
     * `freeSpot` cascades a new node 32px down and right of the last, so the
     * palette leaves two nodes almost on top of each other. The wire between
     * them is then a few dozen pixels long and runs UNDER both of them, since
     * the wire layer paints beneath the nodes. Every measurement here read the
     * node instead: `elementFromPoint` at the wire's midpoint returned a node,
     * so the grab band measured as absent, the tap selected a node, and the
     * hunt for a wired input kept landing on whichever node paints on top.
     * None of that was a defect in the application.
     *
     * Moved with the keyboard rather than a finger, deliberately. This is
     * fixture setup, not a claim: `Shift`+arrow is exactly 64px, so the
     * separation is deterministic and cannot finish with a node off the edge
     * of a 390px screen the way a drag to a fixed coordinate can. What is
     * under test below is the tap, and every tap below is a real one.
     */
    await page.locator('[data-node-id]').last().focus();
    for (let step = 0; step < 8; step += 1) await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    await page.waitForTimeout(300);

    /**
     * A world point on the plane, in viewport coordinates.
     *
     * FROM THE ROOT'S RECT AND THE PLANE'S TRANSFORM, not from the wire
     * layer's own client rect - which was the first version and is the bug
     * this whole block found in the application itself. That layer is a 1x1
     * `<svg>` pinned to the plane's origin with `overflow: visible`, so its
     * rect looks like world (0, 0): Chromium reports it that way, and Gecko
     * and WebKit report the union with the overflowing wires instead. The
     * plane's transform is the coordinate system, and reading it is the one
     * answer all three agree on.
     */
    const wireMidpoint = () =>
      page.evaluate(() => {
        const path = document.querySelector('[data-edge-id] path');
        const plane = document.querySelector('[data-testid="canvas-plane"]');
        const root = document.querySelector('[data-testid="canvas-root"]');
        if (!path || !plane || !root) return null;

        const transform = plane.style.transform;
        const zoom = Number(/scale\(([\d.]+)\)/.exec(transform)?.[1] ?? '1');
        const pan = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(transform);
        const panX = Number(pan?.[1] ?? '0');
        const panY = Number(pan?.[2] ?? '0');

        const mid = path.getPointAtLength(path.getTotalLength() / 2);
        const rect = root.getBoundingClientRect();
        return {
          x: rect.left + panX + mid.x * zoom,
          y: rect.top + panY + mid.y * zoom,
          zoom,
        };
      });

    /**
     * How far from the wire's centreline a press still lands on the wire, in
     * SCREEN pixels, measured by hit-testing the real document.
     *
     * `elementFromPoint` rather than a computed `stroke-width`, deliberately.
     * The reason this check exists is that the declared width and the hittable
     * width came apart: `vector-effect: non-scaling-stroke` is exactly the
     * property for holding a stroke at a constant screen size, it computes,
     * and it governs painting only - hit-testing walks the untransformed
     * geometry. Only the hit test knows.
     *
     * `-1` means the centreline itself was not on the wire, which is a broken
     * fixture rather than a narrow band, and is reported as such.
     */
    const grabBandHalfWidth = async () => {
      const centre = await wireMidpoint();
      if (!centre) return -1;
      return page.evaluate(({ x, y }) => {
        const onWire = (dy) =>
          Boolean(document.elementFromPoint(x, y + dy)?.closest?.('[data-edge-id]'));
        if (!onWire(0)) return -1;

        // Downward only: the two sides are symmetric, and going both ways
        // doubles the chance of running into a node that overlaps on one.
        let reach = 0;
        while (reach < 120 && onWire(reach + 1)) reach += 1;
        return reach;
      }, centre);
    };

    /*
     * FITTED FIRST, which is where a phone actually sits: two 224px nodes do
     * not both fit on a 390px screen, so the zoom is well under 1 for most of
     * the time anybody is looking at a graph. It is also the zoom at which the
     * old band was narrowest - it was declared in plane units, so 44px became
     * 17px at 40% - and therefore the case worth measuring first.
     */
    await page.getByRole('button', { name: 'Fit' }).click();
    await page.waitForTimeout(350);

    const fitted = await wireMidpoint();
    const bandWhenZoomedOut = await grabBandHalfWidth();
    check(
      label,
      'a wire is finger-sized to press when the canvas is zoomed out',
      (fitted?.zoom ?? 1) < 0.9 && bandWhenZoomedOut * 2 >= 44,
      `${String(bandWhenZoomedOut * 2)}px across at ${String(Math.round((fitted?.zoom ?? 1) * 100))}%`,
    );

    /*
     * AND ZOOMED IN, about the wire itself.
     *
     * Two fingers spreading around the midpoint, which keeps that point where
     * it is by construction: `zoomAt` solves for "the world point under here
     * must not move", so the thing being measured stays under the measurement.
     * A band that scaled with the plane would be measured as far too WIDE
     * here, which is the other half of the same defect and the half that never
     * looks broken.
     */
    if (fitted) {
      const cx = Math.round(fitted.x);
      const cy = Math.round(fitted.y);
      await touch([
        ['pointerdown', 1, cx - 20, cy],
        ['pointerdown', 2, cx + 20, cy],
        ['pointermove', 1, cx - 60, cy],
        ['pointermove', 2, cx + 60, cy],
        ['pointermove', 1, cx - 110, cy],
        ['pointermove', 2, cx + 110, cy],
        ['pointerup', 1, cx - 110, cy],
        ['pointerup', 2, cx + 110, cy],
      ]);
      await page.waitForTimeout(300);
    }

    const zoomedIn = await wireMidpoint();
    const bandWhenZoomedIn = await grabBandHalfWidth();
    check(
      label,
      'the wire grab band is the same size on screen at a very different zoom',
      (zoomedIn?.zoom ?? 0) > (fitted?.zoom ?? 1) * 1.5 && bandWhenZoomedIn * 2 >= 44,
      `${String(bandWhenZoomedIn * 2)}px across at ${String(Math.round((zoomedIn?.zoom ?? 0) * 100))}%, against ${String(bandWhenZoomedOut * 2)}px at ${String(Math.round((fitted?.zoom ?? 1) * 100))}%`,
    );

    await page.getByRole('button', { name: 'Fit' }).click();
    await page.waitForTimeout(350);

    /* -- A real tap on the wire ------------------------------------------- */

    const midpoint = await wireMidpoint();
    if (midpoint) {
      await page.touchscreen.tap(Math.round(midpoint.x), Math.round(midpoint.y));
      await page.waitForTimeout(300);
    }

    const bar = page.getByTestId('canvas-selection-bar');
    /*
     * READ ONCE AND REPORTED, so a failure says what WAS selected rather than
     * only that a wire was not.
     *
     * That detail earned its place twice. It reported `HASH SELECTED` for two
     * different reasons in two runs: first because the application resolved
     * the press against the wire layer's own client rect, which Gecko and
     * WebKit measure differently from Chromium, and then because this fixture
     * left two nodes 32px apart with the wire running underneath them. A bare
     * pass/fail would have looked like the same failure both times.
     */
    const barText = (await bar.count()) > 0 ? (await bar.innerText()).replace(/\s+/g, ' ') : '';
    const wireSelected = /1 wire/i.test(barText);
    check(
      label,
      'a finger can select a wire',
      midpoint !== null && wireSelected,
      midpoint === null ? 'no wire midpoint' : `selection bar says "${barText}"`,
    );

    /*
     * ON SCREEN, FINGER-SIZED, AND NOT BEHIND THE SHEET.
     *
     * The last of those is the one that moved this bar from the bottom of the
     * canvas to the top. Measured with the inspector OPEN, because that is the
     * state where it was unreachable and the state a returning phone user
     * arrives in.
     */
    const measureBar = () =>
      page.evaluate(() => {
        const element = document.querySelector('[data-testid="canvas-selection-bar"]');
        if (!element) return null;
        const box = element.getBoundingClientRect();
        const panel = document.querySelector('[data-testid="node-inspector"]');
        const sheet = panel?.getBoundingClientRect() ?? null;
        return {
          box: { x: box.x, y: box.y, right: box.right, bottom: box.bottom },
          clipped: element.scrollWidth > element.clientWidth + 1,
          shortest: Math.min(
            ...[...element.querySelectorAll('button')].map(
              (button) => button.getBoundingClientRect().height,
            ),
          ),
          coveredBySheet: sheet !== null && box.bottom > sheet.top,
        };
      });

    const barBox = await measureBar();
    const frameSize = page.viewportSize();
    check(
      label,
      'the selection bar is inside the canvas and finger-sized',
      barBox !== null &&
        !barBox.clipped &&
        barBox.shortest >= 44 &&
        barBox.box.x >= 0 &&
        barBox.box.right <= (frameSize?.width ?? 0) + 1 &&
        barBox.box.y >= 0 &&
        barBox.box.bottom <= (frameSize?.height ?? 0) + 1,
      barBox
        ? `${String(Math.round(barBox.box.x))},${String(Math.round(barBox.box.y))} to ${String(Math.round(barBox.box.right))},${String(Math.round(barBox.box.bottom))}, shortest control ${String(Math.round(barBox.shortest))}px, clipped=${String(barBox.clipped)}`
        : 'no bar',
    );

    await setInspector(page, true);
    await page.waitForTimeout(400);
    const barUnderSheet = await measureBar();
    check(
      label,
      'the selection bar is not buried under the inspector sheet',
      barUnderSheet !== null && !barUnderSheet.coveredBySheet,
      barUnderSheet
        ? `bar bottom ${String(Math.round(barUnderSheet.box.bottom))}, covered=${String(barUnderSheet.coveredBySheet)}`
        : 'no bar',
    );
    await setInspector(page, false);
    await page.waitForTimeout(300);

    /* -- Deleting it, and taking it back, by tap alone -------------------- */

    const nodesBeforeWireDelete = await page.locator('[data-node-id]').count();
    const tappedDelete =
      wireSelected && (await tapCentre(page.getByRole('button', { name: /^Delete / })));
    await page.waitForTimeout(400);

    const wiresAfterDelete = await countWires(page);
    const nodesAfterWireDelete = await page.locator('[data-node-id]').count();
    check(
      label,
      'a finger can delete the wire it selected, and only the wire',
      tappedDelete && wiresAfterDelete === 0 && nodesAfterWireDelete === nodesBeforeWireDelete,
      `tapped=${String(tappedDelete)}, ${String(wiresAfterDelete)} wire(s) left, ${String(nodesAfterWireDelete)}/${String(nodesBeforeWireDelete)} node(s)`,
    );

    /*
     * THE UNDO, IN THE NOTIFICATION.
     *
     * On this viewport the toolbar has collapsed, so the toolbar's own Undo is
     * behind the overflow menu - which is why a destructive action reachable by
     * finger reports itself with its reversal attached. Tapped, not clicked:
     * the whole point is that a thumb can reach it.
     */
    const undo = page
      .getByRole('region', { name: /notifications/i })
      .getByRole('button', { name: 'Undo' });
    const tappedUndo = (await undo.count()) > 0 && (await tapCentre(undo));
    await page.waitForTimeout(500);

    const wiresAfterUndo = await countWires(page);
    check(
      label,
      'the notification offers an Undo a finger can reach, and it works',
      tappedUndo && wiresAfterUndo === 1,
      `tapped=${String(tappedUndo)}, ${String(wiresAfterUndo)} wire(s) back`,
    );

    /* -- And a node, which is the gap that was reported ------------------- */

    await tapCentre(page.locator('[data-node-id]').first());
    await page.waitForTimeout(300);

    const nodesBefore = await page.locator('[data-node-id]').count();
    const tappedNodeDelete = await tapCentre(page.getByRole('button', { name: /^Delete / }));
    await page.waitForTimeout(400);
    const nodesAfter = await page.locator('[data-node-id]').count();

    check(
      label,
      'a finger can delete a node, which it could not do at all before',
      tappedNodeDelete && nodesAfter === nodesBefore - 1,
      `${String(nodesBefore)} -> ${String(nodesAfter)} node(s)`,
    );

    /*
     * THE INSPECTOR'S DISCONNECT, which is the route with no aiming in it and
     * the only one a keyboard could ever reach - nothing on the keyboard puts
     * an edge in the selection, so before this a wire could only be removed by
     * a pointer hitting a curve.
     */
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: 'Fit' }).click();
    await page.waitForTimeout(300);

    /*
     * Asserted before the panel is opened, so a failure below says whether the
     * wire was missing or the button was.
     */
    const wiresRestored = await countWires(page);
    check(
      label,
      'undoing the node deletion brings its wire back with it',
      wiresRestored === 1,
      `${String(wiresRestored)} wire(s)`,
    );

    /*
     * WHICHEVER NODE THE WIRE ARRIVES AT, found by asking rather than assumed.
     * Nodes are rendered in spatial order and `freeSpot` cascades, so "the
     * second one" is not a fact this file can rely on - the same care the
     * Connect block above takes about which node a tap actually landed on.
     *
     * THE SHEET IS CLOSED FOR EACH TAP. At this width the inspector covers the
     * bottom 60% of the canvas root, so a node after a Fit can sit underneath
     * it and the tap aimed at that node lands on the panel instead - which is
     * how the first version of this reported "not present" for a button that
     * was working.
     */
    const disconnect = page.getByRole('button', { name: /^Disconnect / });
    let hasDisconnect = false;
    const nodeCount = await page.locator('[data-node-id]').count();
    for (let index = 0; index < nodeCount; index += 1) {
      await setInspector(page, false);
      await tapCentre(page.locator('[data-node-id]').nth(index));
      await page.waitForTimeout(300);
      await setInspector(page, true);
      if ((await disconnect.count()) > 0) {
        hasDisconnect = true;
        break;
      }
    }

    check(
      label,
      'the inspector offers Disconnect beside a wired input',
      hasDisconnect,
      hasDisconnect ? ((await disconnect.first().getAttribute('aria-label')) ?? '') : 'not present',
    );
    await setInspector(page, false);
  } finally {
    await context.close().catch(() => {});
    // This function owns its browser: it needs Gecko prefs the shared one does
    // not have. See `launchTouchBrowser`.
    await browser.close().catch(() => {});
  }
}

/* ========================================================================== *
 * MOBILE LAYOUT
 * ========================================================================== */

/**
 * The phone widths this application claims to support.
 *
 * 320 is the narrowest viewport still in use (an iPhone SE in landscape-locked
 * apps, and the floor every responsive audit uses); 430 is an iPhone Pro Max.
 * 360 and 390 are the two commonest Android and iPhone widths respectively, and
 * they are here because the interesting breakpoints sit between them - the
 * regex match table stops needing its horizontal scroller between 360 and 390.
 */
const MOBILE_WIDTHS = [320, 360, 390, 430];

/** Every route, including the one nobody navigates to on purpose. */
const MOBILE_ROUTES = [
  ['/', 'the canvas'],
  ['/tools', 'the tool index'],
  ['/styleguide', 'the styleguide'],
  ['/tools/base64', 'base64'],
  ['/tools/structured-data', 'structured data'],
  ['/tools/hash', 'hash'],
  ['/tools/jwt-decode', 'jwt-decode'],
  ['/tools/diff', 'diff'],
  ['/tools/regex-tester', 'the regex tester'],
  ['/tools/color-convert', 'colour convert'],
  ['/tools/image-convert', 'image convert'],
  ['/tools/text-convert', 'text convert'],
  ['/tools/video-remux', 'video remux'],
  ['/nothing-here', 'the 404'],
];

/**
 * EVERY GEOMETRIC COMPLAINT THE PAGE CAN MAKE ABOUT ITSELF.
 *
 * Serialised into the page, so it has to be self-contained. It returns raw
 * findings rather than verdicts - deciding which of them is a failure is the
 * harness's job, and keeping the two apart is what lets one probe serve a
 * sweep over every route and a handful of named regression checks.
 *
 * The exclusions are all load-bearing, and each is an exception somebody
 * decided rather than a case the probe could not handle:
 *
 *   - The route-progress bar is translated off-canvas until a route changes.
 *   - Visually hidden text is measured at its static position, which is often
 *     outside the viewport; it is not painted, so it is not a layout fact.
 *   - Anything inside a deliberate horizontal scroller. The regex match table
 *     is five columns of data and scrolls sideways at 320px on purpose.
 *   - `<input>` reports scrollWidth > clientWidth whenever its value is longer
 *     than its box. That is a caret scrolling, not a clip.
 *   - An inline box's rect is its line box, which padded inline-block children
 *     legitimately stick out of. `<kbd>` inside a `<span>` does exactly that.
 */
const MOBILE_PROBE = () => {
  const vw = window.innerWidth;
  const root = document.documentElement;

  const describe = (el) => {
    const aria = el.getAttribute?.('aria-label');
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 28);
    const cls = (typeof el.className === 'string' ? el.className : '')
      .split(' ')
      .map((one) => one.replace(/^_/, '').replace(/_[a-z0-9]{5,}_?\d*$/i, ''))
      .filter(Boolean)
      .join('.');
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${aria ? `[${aria}]` : ''}${
      text ? ` "${text}"` : ''
    }`;
  };

  const painted = (el) => {
    for (let node = el; node && node !== root; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
        return false;
      }
      // The visually-hidden recipe: a 1px box clipped away but still in the
      // accessibility tree.
      if (style.clipPath !== 'none' && style.position === 'absolute') return false;
      if (node.dataset?.testid === 'route-progress') return false;
    }
    const box = el.getBoundingClientRect();
    return box.width > 2 && box.height > 2;
  };

  const insideScroller = (el) => {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowX;
      if (overflow === 'auto' || overflow === 'scroll') return true;
    }
    return false;
  };

  const everything = [...document.querySelectorAll('body *')];

  const offscreen = [];
  const clipped = [];
  const escaping = [];

  for (const el of everything) {
    if (!painted(el)) continue;
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);

    if ((box.right > vw + 0.5 || box.left < -0.5) && !insideScroller(el)) {
      offscreen.push(`${describe(el)} @ ${Math.round(box.left)}..${Math.round(box.right)}`);
    }

    if (
      el.scrollWidth > el.clientWidth + 1 &&
      el.tagName !== 'INPUT' &&
      (style.overflowX === 'hidden' || style.overflowX === 'clip') &&
      style.textOverflow !== 'ellipsis' &&
      style.webkitLineClamp === 'none'
    ) {
      clipped.push(`${describe(el)} ${String(el.scrollWidth)} in ${String(el.clientWidth)}`);
    }

    /*
     * A child drawn outside a parent that has a definite height. Nothing is
     * clipped and nothing overflows the viewport, so no other measurement sees
     * it - it simply looks wrong. This is how 44px buttons inside a 24px panel
     * title bar drew across the panel's own border unnoticed.
     */
    if (style.overflowY === 'visible' && style.display !== 'inline' && box.height > 0) {
      for (const child of el.children) {
        const childStyle = getComputedStyle(child);
        if (childStyle.position === 'absolute' || childStyle.position === 'fixed') continue;
        if (!painted(child)) continue;
        const childBox = child.getBoundingClientRect();
        const over = Math.max(box.top - childBox.top, childBox.bottom - box.bottom);
        if (over > 1) {
          escaping.push(
            `${describe(child)} out of ${describe(el)} by ${String(Math.round(over))}px`,
          );
        }
      }
    }
  }

  /* -- Targets ---------------------------------------------------------- */

  const TARGETS =
    'button, a[href], input, textarea, select, [role="option"], [role="menuitem"], [role="tab"], [role="switch"], [role="combobox"], summary';
  const small = [];
  const smallType = [];

  for (const el of document.querySelectorAll(TARGETS)) {
    if (!painted(el)) continue;
    // Ports sit on a 32px pitch and are the documented exception; see the
    // comment in canvas.module.css and the assertion in checkTouch.
    if (el.hasAttribute('data-port-id')) continue;

    const box = el.getBoundingClientRect();
    // WCAG 2.5.8's inline exception: a link inside a run of text cannot be
    // grown without breaking the line it sits in. The tool breadcrumb is one.
    const isInlineLink = el.tagName === 'A' && getComputedStyle(el).display === 'inline';
    if (box.height < 44 && !isInlineLink) {
      small.push(`${describe(el)} ${String(Math.round(box.height))}px`);
    }

    /*
     * Below 16px, iOS Safari zooms the viewport when the field is focused and
     * never zooms back. Only fields you can type into: a checkbox or a colour
     * well has no text to zoom towards.
     */
    const typed = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
    const inert = ['checkbox', 'radio', 'color', 'file', 'range', 'submit', 'button'];
    if (typed && !inert.includes(el.type)) {
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 16) smallType.push(`${describe(el)} ${String(size)}px`);
    }
  }

  return {
    scrollWidth: root.scrollWidth,
    clientWidth: root.clientWidth,
    offscreen: [...new Set(offscreen)].slice(0, 8),
    clipped: [...new Set(clipped)].slice(0, 8),
    escaping: [...new Set(escaping)].slice(0, 8),
    small: [...new Set(small)].slice(0, 12),
    smallType: [...new Set(smallType)].slice(0, 8),
  };
};

/**
 * EVERY ROUTE AND EVERY OVERLAY AT FOUR PHONE WIDTHS, WITH A TOUCH POINTER.
 *
 * `checkTouch` above proves the canvas responds to fingers. This proves the
 * application FITS on the thing the fingers belong to, which is a different
 * claim and was never made: the touch pass predates the theme editor, the
 * conditional option panels and the notes output, and none of those had ever
 * been looked at below 640px.
 *
 * What it found, in order of how badly it broke:
 *
 *   The theme editor made the whole document 487px wide inside a 320px window.
 *   The token column carried `styles.tokens`, a class that was never written,
 *   so its `min-inline-size: 0` never applied - and a grid item defaults to
 *   `min-inline-size: auto`, so the tab strip's min-content width (seven
 *   nowrap tabs, ~490px) travelled up through every ancestor to the page.
 *
 *   The toolbar's overflow menu opened rightwards off the screen, putting
 *   Undo, Redo, Share and Shortcuts where no finger could reach them - on the
 *   only layout where that menu exists at all.
 *
 *   The Panel title bar is 24px and holds real Buttons, which grow to 44px on
 *   a coarse pointer. They drew straight through the panel's top border.
 *
 *   Six kinds of control were below 44px on a coarse pointer: the Select
 *   trigger and its list rows, tabs, the Toggle's rocker, the command
 *   palette's rows, the file-drop label, the 404's two links and the theme
 *   editor's colour wells.
 *
 * jsdom can see NONE of this. It has no layout engine, so every box is zero
 * wide, every element fits, and every target is 0px tall - which passes.
 */
async function checkMobileLayout(engine, label) {
  // Its own browser, for the pointer prefs. See `launchTouchBrowser`.
  const browser = await launchTouchBrowser(engine);

  /** Turns one probe result into pass/fail lines under a scene's name. */
  const assess = (width, scene, probe) => {
    const at = `${scene} at ${String(width)}px`;
    check(
      label,
      `${at}: the document does not scroll sideways`,
      probe.scrollWidth <= probe.clientWidth,
      `scrollWidth ${String(probe.scrollWidth)} vs ${String(probe.clientWidth)}`,
    );
    check(
      label,
      `${at}: nothing is drawn outside the viewport`,
      probe.offscreen.length === 0,
      probe.offscreen.join(' | '),
    );
    check(
      label,
      `${at}: nothing is clipped by an ancestor`,
      probe.clipped.length === 0,
      probe.clipped.join(' | '),
    );
    check(
      label,
      `${at}: nothing overlaps out of its container`,
      probe.escaping.length === 0,
      probe.escaping.join(' | '),
    );
    check(
      label,
      `${at}: every target reaches 44px`,
      probe.small.length === 0,
      probe.small.join(' | '),
    );
    check(
      label,
      `${at}: no typeable field is under 16px`,
      probe.smallType.length === 0,
      probe.smallType.join(' | '),
    );
  };

  try {
    for (const width of MOBILE_WIDTHS) {
      /*
       * A fresh context per width rather than a resize, for the reason
       * `checkChromeWidths` gives: Firefox's driver dislikes closing a context
       * whose window was resized mid-run, and a fresh page guarantees every
       * media query is evaluated at load.
       */
      const context = await browser.newContext({
        viewport: { width, height: 780 },
        hasTouch: true,
      });
      const page = await context.newPage();

      try {
        await gotoCanvas(page);
        await page.locator('[role="application"]').first().waitFor({ timeout: 15_000 });

        /*
         * WITHOUT THIS EVERYTHING BELOW IS THEATRE.
         *
         * Every 44px rule in the application is inside `@media (pointer: coarse)`.
         * If the driver does not report a coarse pointer, none of them applies,
         * the measured heights are the desktop ones, and the target assertions
         * either fail for the wrong reason or - worse - a future harness that
         * reports `fine` turns them into a check of the dense layout that nobody
         * notices has stopped testing touch. So it is asserted, not assumed.
         */
        const pointer = await page.evaluate(() => ({
          coarse: matchMedia('(pointer: coarse)').matches,
          hover: matchMedia('(hover: hover)').matches,
        }));
        check(
          label,
          `the harness reports a touch pointer at ${String(width)}px`,
          pointer.coarse && !pointer.hover,
          `coarse=${String(pointer.coarse)}, hover=${String(pointer.hover)}`,
        );

        /* -- Every route --------------------------------------------------- */
        for (const [path, name] of MOBILE_ROUTES) {
          await page.goto(`${ORIGIN}${path}`, { waitUntil: 'networkidle' });
          await page.waitForTimeout(250);
          assess(width, name, await page.evaluate(MOBILE_PROBE));
        }

        /* -- Every overlay ------------------------------------------------- */
        await gotoCanvas(page);
        await page.locator('[role="application"]').first().waitFor({ timeout: 15_000 });

        await page.getByRole('button', { name: 'Add tool' }).click();
        await page.locator('[role="dialog"]').first().waitFor({ timeout: 10_000 });
        await page.waitForTimeout(200);
        const palette = await page.evaluate(MOBILE_PROBE);
        assess(width, 'the command palette', palette);
        await page.keyboard.press('Escape');

        await page
          .locator('[role="application"]')
          .first()
          .click({ position: { x: 30, y: 300 } });
        await page.keyboard.press('?');
        await page.locator('[role="dialog"]').first().waitFor({ timeout: 10_000 });
        await page.waitForTimeout(200);
        assess(width, 'the shortcuts reference', await page.evaluate(MOBILE_PROBE));
        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);

        /*
         * THE OVERFLOW MENU, which is the one overlay that exists ONLY at these
         * widths - so nothing wider than a phone has ever rendered it. It hung
         * off its own trigger, the last control in a ~190px bar, and there was no
         * room on either side: opening from the trigger's leading edge put it off
         * the right of the screen and from its trailing edge off the left. It is
         * anchored to the toolbar now, which has a definite position and a
         * definite width.
         */
        const more = page.getByRole('button', { name: 'More' });
        check(
          label,
          `the toolbar collapses into an overflow menu at ${String(width)}px`,
          (await more.count()) === 1,
          '',
        );
        await more.click();
        await page.locator('[role="menuitem"]').first().waitFor({ timeout: 5_000 });
        await page.waitForTimeout(200);

        const menu = await page.evaluate(MOBILE_PROBE);
        assess(width, 'the overflow menu', menu);

        const items = await page.evaluate(() =>
          [...document.querySelectorAll('[role="menuitem"]')].map((el) => {
            const box = el.getBoundingClientRect();
            return {
              name: (el.textContent ?? '').trim().slice(0, 16),
              inside: box.left >= -0.5 && box.right <= window.innerWidth + 0.5,
            };
          }),
        );
        check(
          label,
          `every overflow-menu item is reachable at ${String(width)}px`,
          items.length >= 4 && items.every((item) => item.inside),
          `${String(items.length)} items, outside [${items
            .filter((item) => !item.inside)
            .map((item) => item.name)
            .join(', ')}]`,
        );
        await page.keyboard.press('Escape');

        /* -- A node on the canvas ------------------------------------------ */
        await page.getByRole('button', { name: 'Add tool' }).click();
        await page.locator('[role="dialog"]').first().waitFor({ timeout: 10_000 });
        await page.getByTestId('dialog-option-diff').click();
        await page.waitForTimeout(500);
        assess(width, 'the canvas with a node', await page.evaluate(MOBILE_PROBE));

        /*
         * THE INSPECTOR SHEET, which is the one region of this app that
         * deliberately covers another. Every measurement `assess` makes still
         * has to hold: a panel that overflows the viewport sideways, clips a
         * control, or puts a 30px tap target on a phone is a defect whether it
         * is a sheet or not - and this one holds a whole options form and an
         * output view inside 65% of a 780px screen.
         */
        await inspectFirstNode(page);
        assess(width, 'the inspector sheet', await page.evaluate(MOBILE_PROBE));
        await setInspector(page, false);

        /*
         * The connect dialog, which is the one overlay a phone cannot open by
         * itself: it is reached by pressing C on a focused node, and a
         * touchscreen has no C. That is a gap in the touch model rather than a
         * layout defect - wiring by dragging from a port does work, and the
         * port's full label is only otherwise available through this dialog -
         * so it is recorded here rather than papered over. The dialog is
         * measured anyway, because a phone with a keyboard attached reaches it.
         */
        await page.locator('[data-node-id]').first().focus();
        await page.keyboard.press('c');
        await page.waitForTimeout(300);
        if ((await page.locator('[role="dialog"]').count()) > 0) {
          assess(width, 'the connect dialog', await page.evaluate(MOBILE_PROBE));
          await page.keyboard.press('Escape');
          await page.waitForTimeout(150);
        } else {
          skip(label, `the connect dialog at ${String(width)}px`, 'it did not open from the C key');
        }

        /* -- The theme editor ---------------------------------------------- */
        await page.goto(`${ORIGIN}/styleguide`, { waitUntil: 'networkidle' });
        await page.getByRole('button', { name: 'Create theme' }).click();
        await page.waitForTimeout(400);
        assess(width, 'the theme editor', await page.evaluate(MOBILE_PROBE));

        /*
         * The two controls named in the original report, asserted by name so a
         * regression says which one came back rather than "something is 490px".
         */
        const editor = await page.evaluate(() => {
          const fits = (el) => {
            const box = el.getBoundingClientRect();
            return box.left >= -0.5 && box.right <= window.innerWidth + 0.5;
          };
          const tabs = [...document.querySelectorAll('[role="tab"]')].filter((el) =>
            el.closest('[aria-label="Token groups"]'),
          );
          const toggle = document.querySelector('[role="switch"]');
          const list = document.querySelector('[class*="contrastList"]');
          return {
            tabs: tabs.length,
            tabsOutside: tabs.filter((el) => !fits(el)).map((el) => (el.textContent ?? '').trim()),
            // Wrapping is the fix, so a strip that fits must be using more than
            // one row at these widths - if it is one row, it is one row because
            // something removed the tabs, not because they got smaller.
            tabRows: new Set(tabs.map((el) => Math.round(el.getBoundingClientRect().top))).size,
            toggleFits: toggle !== null && fits(toggle),
            toggleClipped:
              toggle !== null &&
              (toggle.parentElement?.scrollWidth ?? 0) >
                (toggle.parentElement?.clientWidth ?? 0) + 1,
            contrastScrolls: list !== null && list.scrollHeight > list.clientHeight + 1,
          };
        });

        check(
          label,
          `every token-group tab is on screen at ${String(width)}px`,
          editor.tabs === 7 && editor.tabsOutside.length === 0,
          `${String(editor.tabs)} tabs over ${String(editor.tabRows)} row(s), outside [${editor.tabsOutside.join(', ')}]`,
        );
        check(
          label,
          `the token-group strip wraps rather than overflowing at ${String(width)}px`,
          editor.tabRows > 1,
          `${String(editor.tabRows)} row(s)`,
        );
        check(
          label,
          `the live-preview toggle is whole at ${String(width)}px`,
          editor.toggleFits && !editor.toggleClipped,
          `fits=${String(editor.toggleFits)}, clipped=${String(editor.toggleClipped)}`,
        );
        /*
         * Stacked, the contrast readout is a block in the page's own flow. It
         * used to keep the 420px cap and the scroller it has beside the tokens,
         * which on a phone is a small window with its own scrollbar inside a page
         * that already scrolls - the "nested scrollbar" in the bug report.
         */
        check(
          label,
          `the contrast list is not its own scroller at ${String(width)}px`,
          !editor.contrastScrolls,
          '',
        );

        /* -- A tool with output, including the notes ----------------------- */
        await page.goto(`${ORIGIN}/tools/diff`, { waitUntil: 'networkidle' });
        const boxes = page.locator('textarea:not([readonly])');
        await boxes
          .nth(0)
          .fill('alpha\r\nbravo\r\ncharlie is quite a long line of text here\r\ndelta');
        await boxes
          .nth(1)
          .fill('alpha\nbravo\ncharlie is quite a long line of prose here\nepsilon\n');
        await page.getByRole('button', { name: 'Run' }).click();
        // The notes list, by its own accessible name rather than a hashed class.
        await page
          .locator('[aria-label="What this comparison ignored"]')
          .waitFor({ timeout: 20_000 });
        await page.waitForTimeout(300);
        assess(width, 'the diff output and its notes', await page.evaluate(MOBILE_PROBE));

        await page.goto(`${ORIGIN}/tools/regex-tester`, { waitUntil: 'networkidle' });
        await page
          .locator('textarea:not([readonly])')
          .first()
          .fill('ada@example.com\nbob@example.org');
        await page
          .getByLabel(/pattern/i)
          .first()
          .fill('(?<user>[\\w.]+)@(?<host>[\\w.]+)');
        await page.getByRole('button', { name: 'Run' }).click();
        await page.locator('[aria-label="Match listing"]').waitFor({ timeout: 20_000 });
        await page.waitForTimeout(300);
        assess(width, 'the regex match table', await page.evaluate(MOBILE_PROBE));

        /*
         * The match table is five columns of data and DOES scroll sideways on the
         * narrower phones. That is the deliberate exception the probe skips, so
         * it is asserted here instead: a scroller a finger can reach and a
         * keyboard can focus, with a name, rather than data quietly cut off.
         */
        const table = await page.evaluate(() => {
          const wrap = document.querySelector('[aria-label="Match listing"]');
          if (!wrap) return null;
          return {
            scrolls: wrap.scrollWidth > wrap.clientWidth + 1,
            focusable: wrap.tabIndex >= 0,
            named: (wrap.getAttribute('aria-label') ?? '') !== '',
            overflow: getComputedStyle(wrap).overflowX,
          };
        });
        check(
          label,
          `the regex match table stays a reachable scroller at ${String(width)}px`,
          table !== null &&
            table.focusable &&
            table.named &&
            (table.overflow === 'auto' || table.overflow === 'scroll'),
          table === null ? 'no table' : `scrolls=${String(table.scrolls)}, ${table.overflow}`,
        );

        /* -- The options panel, whose selects were the worst targets -------- */
        const trigger = page.locator('[role="combobox"]').first();
        await trigger.click();
        await page.locator('[role="option"]').first().waitFor({ timeout: 5_000 });
        await page.waitForTimeout(200);
        assess(width, 'an open select', await page.evaluate(MOBILE_PROBE));
        await page.keyboard.press('Escape');
      } finally {
        await context.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * THE ON-SCREEN KEYBOARD, AND EXACTLY HOW MUCH OF IT CAN BE CHECKED.
 *
 * Neither engine Playwright drives can open a soft keyboard. There is no API
 * for it, and no way to shrink the VISUAL viewport while leaving the layout
 * viewport alone - which is the whole of what a keyboard does on iOS. So the
 * one thing everybody wants asserted here, "the keyboard does not cover the
 * field you are typing into", cannot be asserted by this harness at all, and
 * a check that claimed to would be lying.
 *
 * What CAN be established, and is:
 *
 *   1. Whether the app leaves the browser anything to work with. Every route
 *      except the canvas is an ordinary scrolling document, so the engine's own
 *      scroll-into-view has somewhere to put the field and no application code
 *      is involved. The canvas is not: its root is `overflow: hidden` over a
 *      0x0 transformed plane, so `scrollHeight` equals `clientHeight` however
 *      far the graph extends and there is nothing to scroll. That is a fact
 *      about the DOM, and it is why the canvas has to move the field itself.
 *
 *   2. That the canvas actually does move it, driven by shrinking the window.
 *      Same code, same branch, same numbers - a different event. Stated rather
 *      than glossed, because the distinction is the entire caveat.
 *
 *   3. That a mouse never sees any of it. This is the half most likely to
 *      regress into an annoyance: a canvas that jumped whenever a field was
 *      clicked would be worse than the bug being fixed.
 */
/**
 * FAKING THE ONE THING A KEYBOARD DOES THAT A WINDOW RESIZE DOES NOT.
 *
 * `visualViewport.height` is an accessor on the prototype, so an own property
 * defined on the instance shadows it - and the app reads the instance. Setting
 * one and firing the real `resize` event on the real `visualViewport` object
 * puts the page in the state a keyboard puts it in: a visual viewport shorter
 * than the layout viewport, which stays exactly where it was.
 *
 * That divergence is the whole point, and it is the one thing
 * `page.setViewportSize` cannot produce. Shrinking the window moves BOTH
 * viewports, so `innerHeight - visualViewport.bottom` is zero and the inset
 * arithmetic computes nothing however far the window shrinks - the check that
 * drove it that way was running the code down a branch that always returned 0.
 *
 * This is a simulation and is labelled as one: the geometry is real, the event
 * is real, the code path is real, and the KEYBOARD is not. What it can prove
 * that nothing here could before is that the sheet moves for the visual
 * viewport specifically. An implementation reading `window.innerHeight` - the
 * obvious wrong answer, and the one this file's arithmetic exists to avoid -
 * passes a window-resize check and fails this one.
 */
async function openFakeKeyboard(page, coveredPx) {
  await page.evaluate((covered) => {
    const view = window.visualViewport;
    if (!view) throw new Error('No visualViewport in this engine.');

    const layout = window.innerHeight;
    // Own properties shadow the prototype accessors. The layout viewport is
    // deliberately left alone: that IS the difference being simulated.
    Object.defineProperty(view, 'height', { configurable: true, get: () => layout - covered });
    Object.defineProperty(view, 'offsetTop', { configurable: true, get: () => 0 });
    view.dispatchEvent(new Event('resize'));
  }, coveredPx);
  await page.waitForTimeout(300);
}

async function closeFakeKeyboard(page) {
  await page.evaluate(() => {
    const view = window.visualViewport;
    if (!view) return;
    delete view.height;
    delete view.offsetTop;
    view.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(300);
}

async function checkSoftKeyboard(engine, label) {
  skip(
    label,
    'a real on-screen keyboard, opened by a real engine',
    'neither engine Playwright drives can open one. The geometry a keyboard produces is simulated below by shadowing visualViewport.height and firing its real resize event, which is a different thing from a keyboard and proves strictly more than the window resize it replaced',
  );

  const browser = await launchTouchBrowser(engine);
  const context = await browser.newContext({
    viewport: { width: 390, height: 780 },
    hasTouch: true,
  });
  const page = await context.newPage();

  try {
    /* -- The canvas has nothing for the browser to scroll ---------------- */
    await gotoCanvas(page);
    await page.getByRole('button', { name: 'Add tool' }).click();
    await page.locator('[role="dialog"]').first().waitFor({ timeout: 10_000 });
    await page.getByTestId('dialog-option-base64').click();
    await page.waitForTimeout(600);

    const canvasScroll = await page.evaluate(() => {
      const root = document.querySelector('[role="application"]');
      const doc = document.scrollingElement;
      return {
        rootScrollable: root.scrollHeight > root.clientHeight,
        docScrollable: doc.scrollHeight > doc.clientHeight,
      };
    });
    check(
      label,
      'the canvas gives the browser nothing to scroll, so it must reveal fields itself',
      !canvasScroll.rootScrollable && !canvasScroll.docScrollable,
      `root=${String(canvasScroll.rootScrollable)}, document=${String(canvasScroll.docScrollable)}`,
    );

    /* -- The inspector is a scroller, which is what the plane never was --- */
    /*
     * THE SHAPE OF THIS CHANGED WITH THE INSPECTOR, and the change is the
     * point. There used to be a textarea on every node - on the transformed
     * plane, inside an `overflow: hidden` root, with nothing for a browser to
     * scroll - so the canvas panned its own viewport to lift a focused field
     * clear of the keyboard.
     *
     * Input is entered in the inspector now, and the inspector is an ordinary
     * scroll container: the engine's own scroll-into-view has somewhere to put
     * a focused field, exactly as on a tool page, and no application code is
     * involved in that half any more.
     */
    await inspectFirstNode(page);

    const panel = await page.evaluate(() => {
      const body = document.querySelector('[data-testid="inspector-body"]');
      return {
        overflowY: getComputedStyle(body).overflowY,
        field: document.querySelector('[data-inspector-input]') !== null,
      };
    });
    check(
      label,
      'the inspector is a scroll container, so the engine can reveal a field inside it',
      panel.overflowY === 'auto' && panel.field,
      `overflow-y ${panel.overflowY}, field present ${String(panel.field)}`,
    );

    /* -- And the sheet itself lifts clear of the keyboard ----------------- */
    /*
     * The half no browser can do for us. The sheet is anchored to the bottom
     * of the LAYOUT viewport and a keyboard shrinks the VISUAL one, so the
     * whole panel would sit behind the keyboard and its internal scrolling
     * could not help. `useKeyboardInset` measures the difference and the sheet
     * sits that far up.
     *
     * WHY THIS IS NOT A WINDOW RESIZE ANY MORE. It used to be, and a window
     * resize cannot see this: `page.setViewportSize` moves the layout viewport
     * AND the visual one together, so `innerHeight - visualViewport.bottom` is
     * zero and the inset is zero however small the window gets. The sheet
     * stayed on screen because the bottom of the layout viewport had moved up
     * with it, which is true of a sheet with no keyboard handling at all - so
     * the check passed on an app that had never had this feature. Measured
     * both ways below, so that is a number in the log rather than a claim.
     */
    await page.evaluate(() => {
      document.querySelector('[data-inspector-input]')?.focus();
    });

    const readInset = () =>
      page.evaluate(() => {
        const panel = document.querySelector('[data-testid="node-inspector"]');
        const workspace = document.querySelector('[data-testid="canvas-workspace"]');
        const box = panel.getBoundingClientRect();
        const active = document.activeElement.getBoundingClientRect();
        /*
         * Measured on the CLOSE BUTTON rather than on the sheet's top edge,
         * because that is the thing that actually goes missing. The body
         * scrolls, so anything in it can be scrolled back to; the head does
         * not, so a sheet whose top is off-screen has taken the node's name
         * and the only way to dismiss the panel with it.
         */
        const header =
          panel.querySelector('[aria-label="Close the inspector"]')?.getBoundingClientRect() ??
          null;
        return {
          inset: getComputedStyle(workspace).getPropertyValue('--keyboard-inset').trim(),
          top: Math.round(box.top),
          bottom: Math.round(box.bottom),
          headerTop: header === null ? null : Math.round(header.top),
          tag: document.activeElement.tagName,
          activeTop: Math.round(active.top),
          activeBottom: Math.round(active.bottom),
          layout: window.innerHeight,
          visual: Math.round(window.visualViewport.height),
        };
      });

    const KEYBOARD_PX = 336;

    // What the window resize this replaced was really producing.
    await page.setViewportSize({ width: 390, height: 780 - KEYBOARD_PX });
    await page.waitForTimeout(400);
    const resized = await readInset();
    check(
      label,
      'shrinking the WINDOW leaves the keyboard inset at zero, which is why it proved nothing',
      resized.inset === '0px',
      `inset ${resized.inset}, layout ${String(resized.layout)}px, visual ${String(resized.visual)}px`,
    );

    await page.setViewportSize({ width: 390, height: 780 });
    await page.waitForTimeout(400);

    // And what a keyboard produces: a short visual viewport inside a layout
    // viewport that has not moved.
    await openFakeKeyboard(page, KEYBOARD_PX);
    const covered = await readInset();

    check(
      label,
      'a visual viewport shorter than the layout one lifts the sheet by exactly the covered height',
      covered.inset === `${String(KEYBOARD_PX)}px` &&
        covered.layout === 780 &&
        covered.visual === 780 - KEYBOARD_PX,
      `inset ${covered.inset}, layout ${String(covered.layout)}px, visual ${String(covered.visual)}px`,
    );

    check(
      label,
      'the sheet and its focused field both sit above the keyboard',
      covered.bottom <= covered.visual + 1 &&
        covered.tag === 'TEXTAREA' &&
        covered.activeTop >= -1 &&
        covered.activeBottom <= covered.visual + 1,
      `sheet ${String(covered.top)}..${String(covered.bottom)}, field ${String(covered.activeTop)}..${String(covered.activeBottom)} above ${String(covered.visual)}px`,
    );

    /*
     * AND IS CAPPED TO THE ROOM LEFT, RATHER THAN MERELY MOVED INTO IT.
     *
     * This is the assertion that found the bug. Lifting a sheet taller than
     * the space above the keyboard pushes its TOP off-screen, and the top is
     * its header - the node name and the Close button. The body scrolls, so
     * anything there can be scrolled back to; the header cannot, so it is the
     * one part whose loss is permanent for as long as the keyboard is open.
     */
    check(
      label,
      'and the sheet is capped to the space left, so Close does not go off the top',
      covered.top >= -1 && covered.headerTop !== null && covered.headerTop >= -1,
      `sheet top ${String(covered.top)}, Close at ${String(covered.headerTop)}, band 0..${String(covered.visual)}px`,
    );

    /*
     * AND IT GOES BACK. A sheet that stays lifted after the keyboard closes
     * leaves a 336px gap under the panel for the rest of the session, which is
     * the failure mode of writing an inset and forgetting to clear it - and it
     * is invisible in a test that only ever opens one.
     */
    await closeFakeKeyboard(page);
    const dismissed = await readInset();
    check(
      label,
      'and drops back flush when the keyboard closes',
      dismissed.inset === '0px' && dismissed.bottom <= dismissed.layout + 1,
      `inset ${dismissed.inset}, sheet bottom ${String(dismissed.bottom)} in ${String(dismissed.layout)}px`,
    );

    /* -- And a dialog stays above it too --------------------------------- */

    /*
     * THE OTHER THING A KEYBOARD COVERS.
     *
     * Every dialog on this route focuses its search field on open, which on a
     * phone raises the keyboard - and the scrim is `position: fixed` against
     * the LAYOUT viewport, which a keyboard does not shrink. So the bottom of
     * the list sat behind the keyboard, and because the list is the one
     * scrolling region, scrolling to its end scrolled rows into the covered
     * space. On the connect flow that is the port you were reaching for.
     *
     * DRIVEN THROUGH THE WHOLE CHAIN, not by writing the property. This used
     * to set `--keyboard-inset` by hand, which proved the scrim subtracts it
     * and left the step before - that anything ever WRITES it - to a separate
     * check. Shrinking the visual viewport instead exercises
     * `visualViewport` -> `useKeyboardInset` -> the property -> the dialog's
     * geometry as one thing, which is how it has to work on a phone.
     */
    await page.setViewportSize({ width: 390, height: 780 });
    await gotoCanvas(page);
    await page.getByRole('button', { name: 'Add tool' }).click();
    await page.locator('[role="dialog"]').first().waitFor({ timeout: 10_000 });

    const dialogBox = async () =>
      page.evaluate(() => {
        const box = document.querySelector('[role="dialog"]')?.getBoundingClientRect();
        return box ? { top: Math.round(box.top), bottom: Math.round(box.bottom) } : null;
      });

    const unshrunk = await dialogBox();

    await openFakeKeyboard(page, 336);
    const shrunk = await dialogBox();
    await closeFakeKeyboard(page);

    check(
      label,
      'a dialog is measured against the space a keyboard leaves, not the layout viewport',
      unshrunk !== null &&
        shrunk !== null &&
        shrunk.bottom <= 780 - 336 + 1 &&
        shrunk.bottom < unshrunk.bottom,
      unshrunk && shrunk
        ? `${String(unshrunk.bottom)}px -> ${String(shrunk.bottom)}px, keyboard starts at 444px`
        : 'no dialog',
    );

    /* -- A tool page needs none of this ---------------------------------- */
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto(`${ORIGIN}/tools/regex-tester`, { waitUntil: 'networkidle' });
    const documentScrolls = await page.evaluate(() => {
      const doc = document.scrollingElement;
      return doc.scrollHeight > doc.clientHeight;
    });
    /*
     * Deliberately the weaker claim. Whether the field ends up visible is the
     * ENGINE's business once there is a scroll to perform, and the resize this
     * harness can produce does not trigger the same scroll-into-view a keyboard
     * does - WebKit leaves the field 12px low here and would not on a device.
     * What matters, and what is asserted, is that the document can scroll at
     * all: a tool page laid out inside a fixed 100dvh shell would leave the
     * engine as helpless as the canvas was.
     */
    check(
      label,
      'a tool page scrolls, so the engine can reveal a focused field itself',
      documentScrolls,
      '',
    );
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  /* -- Nothing of the above happens with a mouse ------------------------- */
  const fine = await engine.launch();
  const fineContext = await fine.newContext({ viewport: { width: 390, height: 780 } });
  const finePage = await fineContext.newPage();

  try {
    await gotoCanvas(finePage);
    await finePage.getByRole('button', { name: 'Add tool' }).click();
    await finePage.locator('[role="dialog"]').first().waitFor({ timeout: 10_000 });
    await finePage.getByTestId('dialog-option-base64').click();
    await finePage.waitForTimeout(600);

    const plane = () =>
      finePage.evaluate(
        () => document.querySelector('[data-testid="canvas-plane"]')?.style.transform ?? '',
      );

    await inspectFirstNode(finePage);

    const settled = await plane();
    await finePage.evaluate(() => {
      document.querySelector('[data-inspector-input]')?.focus();
    });
    /*
     * The same shrink a coarse pointer gets, so the two differ only in the
     * pointer. A window resize would have proved nothing here for the reason
     * given above: it produces a zero inset whatever the pointer.
     */
    await openFakeKeyboard(finePage, 336);

    /*
     * THE HALF MOST LIKELY TO REGRESS INTO AN ANNOYANCE. With a mouse there is
     * no keyboard to hide behind, so neither the canvas nor the sheet may move
     * because a field was clicked or a window was resized. Both are asserted:
     * the plane's transform, and the inset property the sheet is positioned by.
     */
    const inset = await finePage.evaluate(
      () =>
        document
          .querySelector('[data-testid="canvas-workspace"]')
          ?.style.getPropertyValue('--keyboard-inset') ?? '',
    );

    check(
      label,
      'a fine pointer never has the canvas move under a focused field',
      (await plane()) === settled,
      `${settled} -> ${await plane()}`,
    );
    check(
      label,
      'a fine pointer never has the inspector lift off the bottom of the screen',
      inset === '0px',
      `--keyboard-inset ${inset || '(unset)'}`,
    );
  } finally {
    await fineContext.close().catch(() => {});
    await fine.close().catch(() => {});
  }
}

/**
 * TRUNCATION, which is the one thing the unit tests genuinely cannot know.
 *
 * `scrollWidth > clientWidth` is a layout fact, and jsdom has no layout: every
 * box there is zero, so every label "fits" and no tooltip is ever attached.
 * The unit tests stub the two widths to reach the branch; this measures the
 * real thing, in real engines, at the real font.
 *
 * Three claims, and each fails in a different direction:
 *
 *   Some port labels really are cut off. If this stops being true the feature
 *   is dead code and the stubs are testing a fiction.
 *
 *   A cut-off label has a tooltip, and one that fits does not. The second half
 *   is the one worth defending: a tooltip on every port is noise, and noise is
 *   what teaches people to ignore tooltips.
 *
 *   The node summary shows exactly two lines and ends in an ellipsis. That one
 *   depends on `-webkit-line-clamp` behaving the same way in three engines,
 *   which is not something to take on trust.
 */
/**
 * A BACKGROUNDED TAB, WHICH IS TO SAY A CLAMPED CLOCK.
 *
 * Every deadline in the engine is a `window.setTimeout`, and browsers clamp
 * those in a hidden tab - to a 1000ms floor, and after a few minutes to
 * something far coarser. Leaving a run and switching away is therefore a
 * timing case the app has and nothing had ever produced.
 *
 * PLAYWRIGHT CANNOT BACKGROUND A TAB. Bringing another page in the same
 * context to the front leaves `document.visibilityState` at `visible` in both
 * headless engines, with 300ms timers still arriving at ~310ms intervals -
 * measured, both engines. That is a real limit, and it is not the end of the
 * story, because what the app is exposed to is not hiddenness itself. It is
 * LATE TIMERS. And a late timer can be produced exactly, in a real engine,
 * against the real worker: replace `setTimeout` with one that will not fire
 * before a floor, which is what the browser does and all that it does.
 *
 * So this check simulates the CAUSE and measures the real consequence. The
 * floor is 3000ms rather than the browser's 1000ms so the ordering under test
 * is unambiguous rather than a race: base64 finishes in single-digit
 * milliseconds and its own 15s deadline is never reached, so every deadline
 * that fires during this check fires LATE, after the result it was guarding
 * has already arrived.
 *
 * WHAT IS BEING PROVED. The reasoning in the architecture notes is that
 * clamping can only make a deadline late, and that a late deadline is a no-op
 * because a settled request has already been removed from `pending` and its
 * timer cleared. That is reasoning about code. Here it is a measurement:
 *
 *  1. A healthy node beside a wedging one still reports its own real result,
 *     and is not blamed by a deadline that arrived late.
 *  2. A wedged node still fails, rather than hanging forever because its
 *     deadline was pushed past the point anyone was waiting.
 *  3. Nothing throws while the clock is being stretched.
 *
 * `visibilityState` is shadowed as well, so any code reading it takes the
 * hidden branch too. Nothing in the app currently does, and asserting that the
 * override took is what stops this check quietly becoming a no-op.
 */
async function checkBackgroundedTab(browser, label) {
  skip(
    label,
    'a genuinely hidden tab',
    'neither headless engine reports one - visibilityState stays `visible` with another page fronted, and timers keep their requested interval. The clamped clock a hidden tab produces is simulated below, on the real worker',
  );

  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  try {
    /*
     * INSTALLED BEFORE ANY APPLICATION CODE RUNS. `addInitScript` lands in the
     * page ahead of the bundle, so the engine picks up the clamped timer when
     * it arms its first deadline rather than partway through a run.
     */
    await page.addInitScript(() => {
      const FLOOR = 3000;
      /*
       * ANYTHING THE APP WOULD USE AS A DEADLINE, and nothing shorter.
       *
       * A real hidden tab clamps every timer including the very short ones,
       * and clamping those here would take Playwright's own injected polling
       * down with it - a harness that cannot drive the page proves nothing
       * about the page. Every timer this check is about is far above the
       * threshold: the regex deadline is 2000ms, base64's is 15000ms, and the
       * pipeline's re-run debounce is 500ms. Sub-100ms timers are the
       * harness's, not the engine's.
       */
      const real = window.setTimeout.bind(window);
      window.setTimeout = (handler, delay, ...rest) => {
        const requested = Number(delay) || 0;
        return real(handler, requested >= 100 ? Math.max(FLOOR, requested) : requested, ...rest);
      };

      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    });

    /*
     * A base64 node beside a regex node given the alphabet-alternating pattern
     * this file uses elsewhere - about 6.8s in WebKit and 7.0s in Firefox,
     * better than three times the regex tool's 2s deadline in both. See the
     * note on catastrophic backtracking in the limitations.
     */
    await page.goto(
      `${ORIGIN}/?p=${shareParam({
        v: 3,
        n: [
          ['n1', 'regex-tester', 0, 0, { pattern: WEDGE_PATTERN, mode: 'match' }],
          ['n2', 'base64', 0, 320, { mode: 'decode' }],
        ],
        e: [],
      })}`,
      { waitUntil: 'networkidle' },
    );
    await page.locator('[data-testid="node-n2"]').waitFor({ timeout: 20_000 });

    const hidden = await page.evaluate(() => document.visibilityState);
    check(
      label,
      'the page reports itself hidden, so anything reading visibility is on that branch',
      hidden === 'hidden',
      hidden,
    );

    const clamped = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const started = performance.now();
          window.setTimeout(() => {
            resolve(Math.round(performance.now() - started));
          }, 200);
        }),
    );
    check(
      label,
      'a deadline-sized timer arrives no sooner than the clamp, as it would in a hidden tab',
      clamped >= 2900,
      `${String(clamped)} ms for a 200 ms request`,
    );

    /*
     * Typed through the inspector, which is where input lives - the same route
     * checkPipeline uses, and the only one that reaches a node the rail may be
     * covering.
     */
    const typeInto = async (id, value) => {
      await page.locator(`[data-testid="node-${id}"]`).focus();
      await page.keyboard.press('Enter');
      const field = page.locator('[data-inspector-input]').first();
      await field.waitFor({ timeout: 20_000 });
      await field.fill(value);
      await page.waitForTimeout(200);
    };

    // `data-status` carries the same value the run store holds.
    const stateOf = (id) =>
      page.locator(`[data-testid="node-${id}"]`).first().getAttribute('data-status');

    const untilStatus = async (id, wanted, timeout) => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const status = await stateOf(id);
        if (status === wanted || Date.now() > deadline) return status;
        await page.waitForTimeout(150);
      }
    };

    await typeInto('n1', `${'a'.repeat(40)}!`);
    await typeInto('n2', 'eyJuYW1lIjoiYWRhIn0=');

    /*
     * Generous, and deliberately so: on a clamped clock every debounce and
     * every deadline in the chain is stretched to the 3s floor, so the whole
     * sequence takes several times what checkPipeline's equivalent does. That
     * IS the condition under test.
     */
    const wedged = await untilStatus('n1', 'error', 90_000);
    check(
      label,
      'a wedged node still fails on a clamped clock rather than hanging',
      wedged === 'error',
      `n1 is ${String(wedged)}`,
    );

    /*
     * THE ONE THAT MATTERS. The healthy node's result arrives in a few
     * milliseconds and its own 15s deadline is never reached - so if a late
     * deadline could settle a request that had already answered, this is where
     * it would show, as an `error` on a node that plainly succeeded. It is
     * also the node the worker teardown takes down as a casualty, so it has to
     * survive being replayed onto a fresh worker with every timer clamped.
     */
    const bystander = await untilStatus('n2', 'ok', 90_000);
    check(
      label,
      'a healthy node beside it keeps its own result and is not blamed by a late deadline',
      bystander === 'ok',
      `n2 is ${String(bystander)}`,
    );

    check(
      label,
      'nothing throws while the clock is stretched',
      consoleErrors.length === 0,
      consoleErrors.slice(0, 2).join(' | '),
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * TWO TABS OVER ONE localStorage KEY.
 *
 * The saved graph is a single key with no cross-tab coordination and nothing
 * listening for `storage`, so the last tab to write wins and the other's work
 * is gone on its next reload. That is documented as a known limitation and it
 * is NOT fixed here: which tab should win, and what the other should be told,
 * is a product decision rather than a defect to repair.
 *
 * What was missing is that it had never been reproduced. Two tabs are two
 * pages in one browser context - which is exactly the scope localStorage has -
 * so it was always reachable, and appears to have gone unreached because it
 * was filed under "decided" rather than under "untested".
 *
 * Asserting the CURRENT behaviour is the point. An unmeasured limitation
 * drifts: someone adds a `storage` listener, or moves the save, or changes the
 * debounce, and the documented paragraph quietly stops describing the app.
 * This goes red when that happens, which makes the change deliberate rather
 * than silent - and if it is ever fixed on purpose, this is the check that
 * says what the fix has to replace.
 */
async function checkTwoTabs(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  try {
    const first = await context.newPage();
    const second = await context.newPage();

    const addTool = async (page, testId) => {
      await page.getByRole('button', { name: 'Add tool' }).click();
      await page.locator('[role="dialog"]').first().waitFor({ timeout: 10_000 });
      await page.getByTestId(testId).click();
      // Past the 500ms save debounce, so the write has actually happened.
      await page.waitForTimeout(1200);
    };

    /*
     * By the node's TITLE rather than by an id: ids are allocated per tab, so
     * both tabs call their one node `n1` and comparing ids would find them
     * identical no matter which graph had won.
     */
    const toolsOn = (page) =>
      page.evaluate(() =>
        [...document.querySelectorAll('[data-node-id]')]
          .map((node) => node.querySelector('[class*="nodeTitle"]')?.textContent ?? '')
          .sort()
          .join(','),
      );

    const savedTools = () =>
      first.evaluate(() => {
        const raw = window.localStorage.getItem('patchbay:graph:v3');
        if (raw === null) return '';
        const nodes = JSON.parse(raw).nodes ?? [];
        return nodes
          .map((node) => node.toolId ?? '')
          .sort()
          .join(',');
      });

    await gotoCanvas(first);
    await gotoCanvas(second);

    await addTool(first, 'dialog-option-base64');
    await addTool(second, 'dialog-option-hash');

    /*
     * BOTH TABS ARE STILL RIGHT ABOUT THEMSELVES. Neither is told about the
     * other and neither loses anything while it is open; the divergence is
     * entirely in what was persisted.
     */
    check(
      label,
      'each tab still shows its own node, because nothing listens for `storage`',
      (await toolsOn(first)) === 'Base64' && (await toolsOn(second)) === 'Hash',
      `first [${await toolsOn(first)}], second [${await toolsOn(second)}]`,
    );

    check(
      label,
      'and the one saved key holds only the tab that wrote last',
      (await savedTools()) === 'hash',
      `[${await savedTools()}]`,
    );

    /*
     * THE LOSS, MADE VISIBLE. The first tab reloads and comes back as the
     * second tab's canvas. Its own node is not merged, not flagged and not
     * recoverable - it is simply not there.
     */
    await first.reload({ waitUntil: 'networkidle' });
    await first.locator('[data-node-id]').first().waitFor({ timeout: 10_000 });

    check(
      label,
      'reloading the first tab silently replaces its canvas with the other one',
      (await toolsOn(first)) === 'Hash',
      `first added Base64 and came back as [${await toolsOn(first)}]`,
    );

    check(
      label,
      'and says nothing about it, which is the limitation rather than a bug',
      (await first.getByText(/changed elsewhere|another tab/i).count()) === 0,
      '',
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * WHAT ACTUALLY GOES ON THE CLIPBOARD, WRITTEN BY A REAL ENGINE.
 *
 * "It pastes into Word with the formatting intact" is a claim about three
 * applications none of this can open, and that half stays manual - see
 * `src/tools/text-convert/clipboard-check.md`, which is the ten-minute version.
 *
 * But the claim has a lower half that had never been checked anywhere, and it
 * is the half every past bug here lived in:
 *
 *  - The HTML flavour was once the tool's sanitised output verbatim - a bare
 *    `<table>` with no attributes - which is the borderless paste people
 *    complain about. Nothing would notice it coming back.
 *  - The plain flavour was once the HTML SOURCE, so every application that
 *    asked for `text/plain` got a wall of angle brackets.
 *  - `richTextDocument` runs on `DOMParser`, and the unit suite runs it on
 *    jsdom's. The serialisation that reaches Word is the one a browser
 *    produced, and it had never been read.
 *  - `ClipboardItem` with two flavours at once is refused or restricted by
 *    some builds. Firefox shipped it late and accepts a short list of types.
 *
 * All four are answerable here. The write is a REAL write - `navigator.
 * clipboard.write`, wrapped so the payload can be read on its way past rather
 * than replaced - so the engine either accepts the item or the check fails,
 * and what is asserted afterwards is the bytes that actually went.
 */
async function checkRichTextClipboard(browser, label) {
  skip(
    label,
    'pasting into Word, Google Docs and Outlook',
    'no harness can open them. The payload they receive is asserted below, and the paste itself is the ten-minute manual pass in src/tools/text-convert/clipboard-check.md',
  );

  /*
   * NO `permissions: ['clipboard-write']`. Firefox's Playwright build does not
   * know that permission name and throws on the context rather than ignoring
   * it. The write below is made from a real click, which is a trusted user
   * gesture, over a 127.0.0.1 origin, which is a secure context - so it should
   * be allowed on its merits; and where an engine refuses anyway, that is said
   * as a skip rather than counted against the app.
   */
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    await page.goto(`${ORIGIN}/tools/text-convert`, { waitUntil: 'networkidle' });
    await page.getByRole('combobox', { name: 'Target format' }).waitFor({ timeout: 15_000 });

    /*
     * A WRAPPER, NOT A STUB. It forwards to the engine's own implementation
     * and records what went past, so a browser that refuses the item still
     * fails the check - which a stub would hide, and which is one of the four
     * things worth knowing here.
     */
    await page.evaluate(() => {
      const real = navigator.clipboard.write.bind(navigator.clipboard);
      window.__clipboard = null;
      navigator.clipboard.write = async (items) => {
        const item = items[0];
        const read = async (type) => {
          if (!item.types.includes(type)) return null;
          return (await item.getType(type)).text();
        };
        const captured = {
          types: [...item.types],
          html: await read('text/html'),
          plain: await read('text/plain'),
        };

        /*
         * Recorded BEFORE forwarding, and the forward's outcome recorded
         * beside it. The payload is the app's, whatever the engine does with
         * it - so a headless refusal costs the acceptance line and not the
         * eight assertions about what was built. The error is re-thrown so
         * the app takes its own failure path and the toast stays truthful.
         */
        window.__clipboard = captured;
        try {
          const result = await real(items);
          window.__clipboard = { ...captured, refusal: null };
          return result;
        } catch (error) {
          window.__clipboard = { ...captured, refusal: String(error) };
          throw error;
        }
      };
    });

    /*
     * The smallest document that exercises every past bug at once: a table
     * with an aligned column (borders, header shading, alignment), a fenced
     * block (background and monospace), and an em dash (the charset
     * declaration).
     */
    const source = [
      '| Tool | Cost |',
      '| :--- | ---: |',
      '| Hash | O(1) |',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      'An em dash — and a [link](https://example.org/).',
      '',
    ].join('\n');

    await page.getByRole('combobox', { name: 'Target format' }).click();
    await page.getByRole('option', { name: 'HTML' }).click();
    await page.locator('textarea').first().fill(source);
    await page.getByRole('button', { name: 'Run' }).click();

    const richCopy = page.getByRole('button', { name: 'Copy as rich text' });
    await richCopy.waitFor({ timeout: 20_000 });
    await richCopy.click();

    const written = await page.evaluate(() => window.__clipboard);

    /*
     * WHETHER THE ENGINE TOOK IT. A headless build that refuses clipboard
     * access is a fact about the harness rather than about the app, so it is a
     * skip - but a build that ACCEPTS the item has proved something worth
     * having, because `ClipboardItem` with two flavours at once is exactly
     * what older builds restricted.
     */
    if (written?.refusal) {
      skip(
        label,
        'the engine accepting a two-flavour ClipboardItem',
        `this build refused the write (${String(written.refusal).slice(0, 80)}); the payload it was given is still asserted below`,
      );
    } else {
      check(label, 'the engine accepts a two-flavour ClipboardItem', written !== null, '');
    }

    check(
      label,
      'both flavours are written in one item, so one paste can choose',
      written !== null &&
        written.types.includes('text/html') &&
        written.types.includes('text/plain'),
      written === null ? 'nothing reached navigator.clipboard.write' : written.types.join(', '),
    );

    const html = written?.html ?? '';

    /*
     * A WHOLE DOCUMENT WITH A CHARSET. Word and Outlook read the payload as a
     * document and guess an encoding when none is declared, which is how an em
     * dash becomes three characters of mojibake.
     */
    check(
      label,
      'the HTML flavour is a document declaring its encoding, not a fragment',
      html.startsWith('<!DOCTYPE html>') && html.includes('<meta charset="utf-8">'),
      html.slice(0, 60),
    );

    /*
     * INLINE STYLES, WHICH IS THE WHOLE REASON THIS MODULE EXISTS. A `<style>`
     * block is discarded outright by Google Docs, so a stylesheet would arrive
     * as nothing; the one thing all three targets honour is a `style`
     * attribute on the element itself.
     */
    check(
      label,
      'the table carries borders as declarations AND as the legacy attribute',
      /<table[^>]*border-collapse:collapse/.test(html) &&
        /<table[^>]*border="1"/.test(html) &&
        /<td[^>]*style="[^"]*border:1px solid/.test(html),
      /<table[^>]*>/.exec(html)?.[0].slice(0, 90) ?? 'no table',
    );

    check(
      label,
      'the right-aligned column is aligned by declaration, which Google Docs needs',
      /<td[^>]*style="[^"]*text-align:right/.test(html),
      /<td[^>]*text-align:right[^>]*>/.exec(html)?.[0].slice(0, 90) ?? 'no aligned cell',
    );

    check(
      label,
      'the code block carries its own background and monospace font',
      /<pre[^>]*style="[^"]*background-color:#f6f8fa/.test(html) &&
        /<pre[^>]*style="[^"]*monospace/.test(html),
      /<pre[^>]*>/.exec(html)?.[0].slice(0, 90) ?? 'no pre',
    );

    check(
      label,
      'no <style> element, which Google Docs discards, and no stylesheet link',
      !/<style[\s>]/i.test(html) && !/<link[^>]*stylesheet/i.test(html),
      '',
    );

    /*
     * The em dash is written as a character rather than an entity, and the
     * charset above is what carries it. An entity would survive too, so this
     * asserts only that it is not mangled.
     */
    check(
      label,
      'an em dash survives the round trip through the engine serialiser',
      html.includes('—') || html.includes('&mdash;'),
      '',
    );

    /* -- And the plain flavour is text, not markup ------------------------ */

    const plain = written?.plain ?? '';
    check(
      label,
      'the plain flavour is readable text rather than the HTML source',
      plain !== '' && !plain.includes('<td') && !plain.includes('<!DOCTYPE'),
      plain.slice(0, 60).replace(/\n/g, '\\n'),
    );
    check(
      label,
      'and keeps the structure a reader needs - table rows and the link target',
      plain.includes('Hash | O(1)') && plain.includes('https://example.org/'),
      plain.slice(0, 120).replace(/\n/g, '\\n'),
    );
  } finally {
    await context.close().catch(() => {});
  }
}

async function checkTruncation(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    await gotoCanvas(page);

    /*
     * Text convert has both kinds: 'Document', 'Converted' and 'Detected' fit,
     * 'Rendered HTML' does not. The port audit renamed every label that did
     * not fit except that one - `HTML` is information the port's `text` type
     * cannot carry - so it is now the only cut-off label on either node, which
     * is what the first check below is asserting is still true of something.
     */
    for (const tool of ['Text convert', 'Colour']) {
      await page.getByRole('button', { name: 'Add tool' }).click();
      await page.locator('[role="option"]').first().waitFor({ timeout: 10_000 });
      await page
        .getByRole('option', { name: new RegExp(tool, 'i') })
        .first()
        .click();
      await page.waitForTimeout(300);
    }

    // Fonts change glyph advances, and this measurement is entirely about
    // glyph advances.
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);

    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('[data-port-id]')].map((button) => {
        const text = button.querySelector('[class*="portLabel"]');
        return {
          label: text ? (text.textContent ?? '') : '',
          cut: text ? text.scrollWidth - text.clientWidth > 1 : false,
          // Radix stamps its trigger; nothing else on the page does.
          tooltip: button.hasAttribute('data-state'),
          name: button.getAttribute('aria-label') ?? '',
        };
      }),
    );

    const cut = labels.filter((entry) => entry.cut);
    const fits = labels.filter((entry) => !entry.cut);

    check(
      label,
      'some port labels really are cut off at this width',
      cut.length > 0,
      cut.map((entry) => entry.label).join(', '),
    );

    check(
      label,
      'every cut-off label has a tooltip',
      cut.length > 0 && cut.every((entry) => entry.tooltip),
      cut
        .filter((entry) => !entry.tooltip)
        .map((entry) => entry.label)
        .join(', ') || 'all',
    );

    check(
      label,
      'no label that fits has one',
      fits.length > 0 && fits.every((entry) => !entry.tooltip),
      fits
        .filter((entry) => entry.tooltip)
        .map((entry) => entry.label)
        .join(', ') || 'none',
    );

    // Whatever the box does, the name is the name.
    check(
      label,
      'the accessible name carries the full label either way',
      labels.every((entry) => entry.label !== '' && entry.name.includes(entry.label)),
      `${String(labels.length)} port(s)`,
    );

    // Focus, not hover: the tooltip must not be a pointer-only affordance.
    const focused = await page.evaluate(async () => {
      const button = [...document.querySelectorAll('[data-port-id]')].find((element) =>
        element.hasAttribute('data-state'),
      );
      if (!button) return { opened: false, described: false };
      button.focus();
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
      return {
        opened: document.querySelectorAll('[role="tooltip"]').length > 0,
        described: button.hasAttribute('aria-describedby'),
      };
    });
    check(
      label,
      'focus opens the tooltip, and announces it',
      focused.opened && focused.described,
      JSON.stringify(focused),
    );

    /*
     * TOUCH: the port's primary gesture must win.
     *
     * There is no hover on a touch screen, and Radix deliberately does not
     * open a tooltip on tap - which is the behaviour we want here rather than
     * a limitation to work around. A port exists to have a wire dragged out of
     * it, and a card appearing under the finger that starts the drag would be
     * in the way of the one thing the control is for.
     *
     * So this asserts both halves: nothing pops up, and the wire still starts.
     * The full label stays reachable on touch through the connect dialog,
     * which lists every port by name.
     */
    const touchContext = await browser.newContext({
      viewport: { width: 900, height: 800 },
      hasTouch: true,
    });
    const touchPage = await touchContext.newPage();

    try {
      await gotoCanvas(touchPage);
      await touchPage.getByRole('button', { name: 'Add tool' }).click();
      await touchPage.locator('[role="option"]').first().waitFor({ timeout: 10_000 });
      await touchPage
        .getByRole('option', { name: /Text convert/i })
        .first()
        .click();
      await touchPage.waitForTimeout(400);

      const dragged = await touchPage.evaluate(async () => {
        const button = [...document.querySelectorAll('[data-port-id]')].find((element) =>
          element.hasAttribute('data-state'),
        );
        if (!button) return { found: false };

        const box = button.querySelector('svg').getBoundingClientRect();
        const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        const root = document.querySelector('[role="application"]');

        const send = (target, type, x, y) => {
          target.dispatchEvent(
            new PointerEvent(type, {
              pointerId: 1,
              pointerType: 'touch',
              isPrimary: true,
              clientX: x,
              clientY: y,
              button: type === 'pointerup' ? -1 : 0,
              buttons: type === 'pointerup' ? 0 : 1,
              bubbles: true,
              cancelable: true,
            }),
          );
        };

        send(button, 'pointerdown', at.x, at.y);
        send(root, 'pointermove', at.x + 90, at.y + 70);
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });

        const result = {
          found: true,
          held: button.getAttribute('data-port-state') === 'held',
          drafting: document.querySelector('svg path[class*="wireDraft"]') !== null,
          tooltips: document.querySelectorAll('[role="tooltip"]').length,
        };

        send(root, 'pointerup', at.x + 90, at.y + 70);
        return result;
      });

      check(
        label,
        'tapping a truncated port still starts a wire, and pops nothing up',
        dragged.found === true && dragged.held && dragged.drafting && dragged.tooltips === 0,
        JSON.stringify(dragged),
      );
    } finally {
      await touchContext.close().catch(() => {});
    }

    /*
     * The summary clamp. Two lines and an ellipsis, measured rather than
     * trusted: `-webkit-line-clamp` only truncates when it is free to size the
     * box, which is why the clamped element is an inner span inside the
     * fixed-height summary rather than the summary itself.
     */
    const summary = await page.evaluate(() => {
      const inner = document.querySelector('[class*="nodeSummaryText"]');
      if (!inner) return null;
      const line = parseFloat(getComputedStyle(inner).lineHeight);
      const outer = inner.parentElement;
      return {
        lines: Math.round(inner.getBoundingClientRect().height / line),
        // The inner box must not spill past the space the geometry reserves.
        fits: inner.getBoundingClientRect().height <= outer.getBoundingClientRect().height + 0.5,
        clamped: inner.scrollHeight - inner.clientHeight > 1,
      };
    });
    check(
      label,
      'a node summary is clamped to two lines inside its reserved box',
      summary !== null && summary.lines === 2 && summary.fits,
      JSON.stringify(summary),
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * THE REGEX HIGHLIGHT, WHICH IS A LAYOUT PROBLEM
 *
 * Everything interesting about drawing regex matches is geometry, and jsdom
 * has none. Four things the unit suite asserts the DOM shape of and cannot
 * assert the appearance of:
 *
 *  1. A ZERO-LENGTH MATCH has no text to colour. It is drawn as a 2px
 *     inline-block caret, and "is that caret actually painted" is a question
 *     about computed size - which is exactly what `reset.css` has broken
 *     before, twice, in this repo.
 *  2. TWO ADJACENT MATCHES must remain two boxes. In the DOM they are always
 *     two <mark>s; on screen they can be one continuous tint.
 *  3. THE SIGNAL IS NOT COLOUR ALONE. The underline and the outline have to
 *     survive whatever the reset and the theme do to them.
 *  4. THE HIGHLIGHT SCROLLS, so it has to be focusable - and whether a box
 *     scrolls is a layout fact.
 *
 * The axe pass at the end runs with `color-contrast` ENABLED, which is the
 * rule jsdom can never evaluate, over a result that actually has marks, notes
 * and a table in it.
 */
async function checkRegex(browser, label) {
  const axeSource = await readFile(join(ROOT, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(axeSource);
  const page = await context.newPage();

  const run = async (subject, pattern) => {
    await page.getByLabel('Regex input').fill(subject);
    await page.getByLabel('Pattern').fill(pattern);
    await page.getByRole('button', { name: 'Run' }).click();
    await page.locator('mark').first().waitFor({ timeout: 30_000 });
  };

  /** Painted size and decoration of every mark, straight from the CSSOM. */
  const marks = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('mark')].map((node) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          width: Math.round(box.width * 100) / 100,
          height: Math.round(box.height * 100) / 100,
          left: Math.round(box.left * 100) / 100,
          right: Math.round(box.right * 100) / 100,
          underline: style.textDecorationLine,
          outline: style.outlineWidth,
        };
      }),
    );

  try {
    await page.goto(`${ORIGIN}/tools/regex-tester`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1, name: 'Regex' }).waitFor({ timeout: 15_000 });

    /* -- The tool ran in a real worker and drew a real highlight ---------- */
    await run('a1 bb22 c333', '\\d+');
    const found = await marks();
    check(
      label,
      'a pattern run in a real worker marks every match',
      found.length === 3,
      `${String(found.length)} mark(s)`,
    );
    check(
      label,
      'a match carries an underline and an outline, so the tint is not the only signal',
      found.every((mark) => mark.underline.includes('underline') && mark.outline !== '0px'),
      JSON.stringify(found[0] ?? null),
    );

    /* -- Adjacent matches stay two boxes ---------------------------------- */
    await run('abab', 'ab');
    const adjacent = await marks();
    check(
      label,
      'two adjacent matches are drawn as two boxes, not one long one',
      adjacent.length === 2 &&
        adjacent[0] !== undefined &&
        adjacent[1] !== undefined &&
        adjacent[1].left >= adjacent[0].right - 1 &&
        adjacent[0].width > 0,
      JSON.stringify(adjacent),
    );

    /* -- A zero-length match is painted at all ---------------------------- */
    await run('abc', 'x*');
    const empty = await marks();
    check(
      label,
      'a zero-length match is painted as a caret rather than as nothing',
      empty.length === 4 && empty.every((mark) => mark.width > 0 && mark.height > 0),
      JSON.stringify(empty[0] ?? null),
    );

    /* -- The highlight scrolls, so it has to be reachable ----------------- */
    await run(Array.from({ length: 200 }, (_, i) => `line ${String(i)} value`).join('\n'), 'value');
    const scroller = await page.evaluate(() => {
      const region = document.querySelector('[aria-label="Subject text with matches highlighted"]');
      if (!region) return null;
      return {
        scrolls: region.scrollHeight > region.clientHeight + 1,
        tabindex: region.getAttribute('tabindex'),
      };
    });
    check(
      label,
      'the highlight box scrolls and can be focused',
      scroller?.scrolls === true && scroller.tabindex === '0',
      JSON.stringify(scroller),
    );

    /* -- One enormous line must not widen the page ------------------------ */
    await run(`x${'abcdefghij'.repeat(400)}`, '[a-e]+');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check(
      label,
      'a 4,000-character subject does not make the page scroll sideways',
      overflow <= 1,
      `${String(overflow)}px`,
    );

    /* -- axe, with colour contrast, over a populated result --------------- */
    await run('ada@example.com\nbob@example.org', '(?<user>[\\w.]+)@(?<host>[\\w.]+)');
    for (const theme of ['graphite', 'vellum']) {
      await page.evaluate((value) => {
        const root = document.documentElement;
        for (const token of ['--pb-motion-fast', '--pb-motion-base', '--pb-motion-slow']) {
          root.style.setProperty(token, '0s');
        }
        root.setAttribute('data-theme', value);
      }, theme);
      await page.waitForTimeout(250);

      const violations = await page.evaluate(async () => {
        const results = await window.axe.run(document, {
          resultTypes: ['violations'],
          runOnly: {
            type: 'tag',
            values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
          },
        });
        return results.violations.map(
          (violation) =>
            `${violation.id} (${violation.impact ?? '?'}, x${String(violation.nodes.length)}) ${violation.nodes[0]?.target.join(' ') ?? ''}`,
        );
      });
      check(
        label,
        `a populated regex result is clean in ${theme}`,
        violations.length === 0,
        violations.join(' | '),
      );
    }
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * THE TWO OUTPUT VIEWS jsdom CANNOT SEE.
 *
 * Both of the things these views promise are claims about a real engine:
 *
 *  1. THE IMAGE ACTUALLY DECODES. `img-src 'self' data: blob:` is in the real
 *     `_headers`, and an `<img>` pointed at a blob: URL either paints or is
 *     refused with nothing in the DOM to say so - a CSP refusal produces no
 *     error the page can see and an image of zero width. jsdom loads no
 *     images at all, so `naturalWidth > 0` is a fact that exists only here.
 *
 *  2. "NOT VERIFIED" IS NOT QUIETER THAN THE CLAIMS. That is a sentence about
 *     computed font size, computed colour and box position - none of which
 *     jsdom has an opinion about, because it has no layout engine. Asserting
 *     the markup order in a unit test proves the reading order and nothing
 *     about whether the verdict is the loudest thing on screen.
 *
 * The axe passes here run with `color-contrast` ENABLED over populated
 * results, which is the rule jsdom can never evaluate and the one most likely
 * to be broken by a coloured verdict banner.
 */
async function checkOutputViews(browser, label) {
  const axeSource = await readFile(join(ROOT, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(axeSource);
  const page = await context.newPage();

  const violations = () =>
    page.evaluate(async () => {
      const results = await window.axe.run(document, {
        resultTypes: ['violations'],
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
        },
      });
      return results.violations.map(
        (violation) =>
          `${violation.id} (${violation.impact ?? '?'}, x${String(violation.nodes.length)}) ${violation.nodes[0]?.target.join(' ') ?? ''}`,
      );
    });

  /** Runs axe in both presets, with colour contrast on. */
  const axeInBothThemes = async (what) => {
    for (const theme of ['graphite', 'vellum']) {
      await page.evaluate((value) => {
        const root = document.documentElement;
        for (const token of ['--pb-motion-fast', '--pb-motion-base', '--pb-motion-slow']) {
          root.style.setProperty(token, '0s');
        }
        root.setAttribute('data-theme', value);
      }, theme);
      await page.waitForTimeout(250);

      const found = await violations();
      check(label, `${what} is clean in ${theme}`, found.length === 0, found.join(' | '));
    }

    await page.evaluate(() => {
      document.documentElement.removeAttribute('data-theme');
    });
  };

  try {
    /* ================================================================== *
     * JWT: the verdict has to dominate
     * ================================================================== */

    /*
     * An HS256 token with a signature nobody can check, and no key supplied.
     * This is the common case - most people paste a token simply to read it -
     * and it is exactly the case a decoder is most tempted to draw as an
     * absence. An absence is what makes a forged token look ordinary.
     */
    const token = [
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'eyJzdWIiOiJhZGEiLCJpc3MiOiJodHRwczovL2V4YW1wbGUudGVzdCIsImV4cCI6MTAwMDAwMDAwMH0',
      'bm90LWEtcmVhbC1zaWduYXR1cmU',
    ].join('.');

    await page.goto(`${ORIGIN}/tools/jwt-decode`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1, name: 'JWT' }).waitFor({ timeout: 15_000 });
    await page.getByLabel('JWT input').fill(token);
    await page.getByRole('button', { name: 'Run' }).click();
    await page.locator('[data-trust]').waitFor({ timeout: 30_000 });

    const verdict = await page.evaluate(() => {
      const banner = document.querySelector('[data-trust]');
      const payload = document.querySelector('textarea[aria-label$="payload"]');
      if (!banner || !payload) return null;

      const word = banner.querySelector('span');
      const bannerBox = banner.getBoundingClientRect();
      const payloadBox = payload.getBoundingClientRect();

      return {
        trust: banner.getAttribute('data-trust'),
        // The size of the verdict word against the size of the claims it
        // qualifies. "Not quieter than" is literally this comparison.
        wordSize: word === null ? 0 : parseFloat(getComputedStyle(word).fontSize),
        payloadSize: parseFloat(getComputedStyle(payload).fontSize),
        above: bannerBox.bottom <= payloadBox.top + 1,
        // A neutral surface is what makes an unchecked token look ordinary.
        background: getComputedStyle(banner).backgroundColor,
        pageBackground: getComputedStyle(document.body).backgroundColor,
      };
    });

    check(
      label,
      'an unchecked JWT signature is reported as unverified',
      verdict?.trust === 'unverified',
      JSON.stringify(verdict?.trust ?? null),
    );
    check(
      label,
      'the JWT verdict is painted above the claims it qualifies',
      verdict?.above === true,
      JSON.stringify(verdict),
    );
    check(
      label,
      'the JWT verdict is not smaller than the claims below it',
      (verdict?.wordSize ?? 0) > (verdict?.payloadSize ?? Number.POSITIVE_INFINITY),
      `verdict ${String(verdict?.wordSize)}px, payload ${String(verdict?.payloadSize)}px`,
    );
    check(
      label,
      'an unverified verdict does not sit on the page background',
      verdict !== null && verdict.background !== verdict.pageBackground,
      `${String(verdict?.background)} vs ${String(verdict?.pageBackground)}`,
    );

    await axeInBothThemes('an unverified JWT');

    /* -- The verdict survives the Raw toggle ---------------------------- */
    await page.getByRole('button', { name: 'Raw' }).click();
    const stillThere = await page.locator('[data-trust]').count();
    check(
      label,
      'the JWT verdict stays on screen in the raw view',
      stillThere === 1,
      `${String(stillThere)} banner(s)`,
    );

    /* -- alg: none is drawn differently, not merely worded differently -- */
    const unsigned = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhZGEifQ.';
    await page.getByLabel('JWT input').fill(unsigned);
    await page.getByRole('button', { name: 'Run' }).click();
    await page.locator('[data-trust="broken"]').waitFor({ timeout: 30_000 });

    const rejected = await page.evaluate(() => {
      const banner = document.querySelector('[data-trust]');
      return banner === null ? null : getComputedStyle(banner).backgroundColor;
    });
    check(
      label,
      'a rejected token is painted differently from an unchecked one',
      rejected !== null && rejected !== verdict?.background,
      `${String(rejected)} vs ${String(verdict?.background)}`,
    );

    await axeInBothThemes('a rejected JWT');

    /* ================================================================== *
     * Image: the preview has to actually paint
     * ================================================================== */

    await page.goto(`${ORIGIN}/tools/image-convert`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1, name: 'Image' }).waitFor({ timeout: 15_000 });

    await page.locator('input[type="file"]').setInputFiles({
      name: 'swatch.png',
      mimeType: 'image/png',
      buffer: makeSwatchPng(),
    });

    /*
     * THE FRAME THE RESULT APPEARS ON, WATCHED FROM BEFORE IT HAPPENS.
     *
     * An `<img>` whose src has not decoded has no intrinsic size, and this one
     * is laid out `inline-size: 100%` with its height left to the picture - so
     * the panel used to be zero pixels tall and then up to 420px tall on the
     * frame the decode landed, moving everything below it under the cursor at
     * the moment somebody was reaching for it. `previewAspectRatio` reads the
     * ratio out of the file header, before any decode, so the box is the right
     * size from the first frame.
     *
     * This is the only place that can be checked. jsdom has no layout engine,
     * so the height it reports is zero both before and after - which is a pass
     * for the wrong reason. The observer fires on the mutation that ADDS the
     * element and calls `getBoundingClientRect`, which forces layout while the
     * decode is still outstanding.
     */
    await page.evaluate(() => {
      window.__imageJump = null;
      const observer = new MutationObserver(() => {
        const image = document.querySelector('img[src^="blob:"]');
        if (!image || window.__imageJump !== null) return;

        observer.disconnect();
        const before = image.getBoundingClientRect().height;
        const ratio = getComputedStyle(image).aspectRatio;
        void image
          .decode()
          .catch(() => undefined)
          .then(() => {
            window.__imageJump = {
              ratio,
              complete: image.complete,
              before: Math.round(before),
              after: Math.round(image.getBoundingClientRect().height),
            };
          });
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });

    await page.getByRole('button', { name: 'Run' }).click();
    await page.locator('img[src^="blob:"]').first().waitFor({ timeout: 30_000 });

    await page.waitForFunction(() => window.__imageJump !== null, undefined, { timeout: 30_000 });
    const jump = await page.evaluate(() => window.__imageJump);

    check(
      label,
      'the preview box is the right height before the image has decoded, so nothing jumps',
      jump !== null && jump.before > 0 && Math.abs(jump.after - jump.before) <= 1,
      `${String(jump?.before)}px before the decode, ${String(jump?.after)}px after`,
    );
    check(
      label,
      'and it is the header that reserved it, not the loaded bitmap',
      jump !== null && jump.ratio !== 'auto' && jump.ratio !== '',
      `aspect-ratio ${String(jump?.ratio)}`,
    );

    /** Every preview image, with the size the engine actually decoded. */
    const painted = () =>
      page.evaluate(async () => {
        const images = [...document.querySelectorAll('img')];
        await Promise.all(
          images.map((image) =>
            image.complete
              ? Promise.resolve()
              : new Promise((resolve) => {
                  image.addEventListener('load', resolve, { once: true });
                  image.addEventListener('error', resolve, { once: true });
                }),
          ),
        );
        return images.map((image) => ({
          blob: image.currentSrc.startsWith('blob:'),
          naturalWidth: image.naturalWidth,
          width: Math.round(image.getBoundingClientRect().width),
        }));
      });

    const result = await painted();
    check(
      label,
      'the converted image is drawn from a blob: URL the real CSP permits',
      result.length === 1 && result[0]?.blob === true && (result[0]?.naturalWidth ?? 0) > 0,
      JSON.stringify(result),
    );

    /* -- Before and after, both decoded --------------------------------- */
    await page.getByRole('button', { name: 'Compare' }).click();
    await page.waitForFunction(() => document.querySelectorAll('img').length === 2, undefined, {
      timeout: 15_000,
    });

    const compared = await painted();
    check(
      label,
      'the comparison paints both the original and the result',
      compared.length === 2 && compared.every((image) => image.naturalWidth > 0),
      JSON.stringify(compared),
    );

    /* -- And it releases the source when closed ------------------------- */
    await page.getByRole('button', { name: 'Result' }).click();
    await page.waitForFunction(() => document.querySelectorAll('img').length === 1, undefined, {
      timeout: 15_000,
    });
    const back = await painted();
    check(
      label,
      'closing the comparison leaves one painted image behind',
      back.length === 1 && (back[0]?.naturalWidth ?? 0) > 0,
      JSON.stringify(back),
    );

    await axeInBothThemes('a populated image result');

    /* -- A preview must not widen the page on a phone ------------------- */
    await page.setViewportSize({ width: 320, height: 720 });
    await page.waitForTimeout(150);
    const narrow = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      image: Math.round(document.querySelector('img')?.getBoundingClientRect().width ?? 0),
      viewport: document.documentElement.clientWidth,
    }));
    check(
      label,
      'an image preview stays inside a 320px viewport',
      narrow.overflow <= 1 && narrow.image <= narrow.viewport,
      JSON.stringify(narrow),
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * The Markdown preview's sandboxed iframe.
 *
 * TWO INDEPENDENT LAYERS, and the second one was verified rather than assumed
 * because the brief for these tools was right to be suspicious of it: a frame
 * with no `allow-same-origin` has an OPAQUE origin, and it is reasonable to
 * wonder whether a page's Content-Security-Policy reaches inside one.
 *
 * It does. Measured here, in both engines:
 *
 *   sandbox=""               inline script blocked
 *   sandbox="allow-scripts"  inline script blocked  <- the interesting one
 *   no sandbox attribute     inline script blocked
 *
 * The middle row is the finding. The sandbox explicitly PERMITS scripts there,
 * and the script still does not run - so what stopped it is the inherited
 * `script-src 'self'`. The preview therefore survives someone removing the
 * sandbox attribute, and survives someone weakening the CSP, but not both.
 */
async function checkPreviewSandbox(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    await page.goto(`${ORIGIN}/tools/text-convert`, { waitUntil: 'networkidle' });

    const results = await page.evaluate(async () => {
      /** Frames a script that reports back, and says whether it ever did. */
      const probe = (sandbox) =>
        new Promise((resolve) => {
          const token = `t${String(Math.floor(performance.now() * 1000))}`;
          let settled = false;

          const onMessage = (event) => {
            if (event.data === token) {
              settled = true;
              finish('ran');
            }
          };
          const finish = (verdict) => {
            window.removeEventListener('message', onMessage);
            frame.remove();
            resolve(verdict);
          };

          window.addEventListener('message', onMessage);

          const frame = document.createElement('iframe');
          if (sandbox !== null) frame.setAttribute('sandbox', sandbox);
          // postMessage rather than reading the frame: an opaque origin cannot
          // be read from out here, but it can still talk back.
          frame.srcdoc = `<!doctype html><html><body><script>parent.postMessage(${JSON.stringify(
            token,
          )},'*')<\/script></body></html>`;
          document.body.appendChild(frame);

          setTimeout(() => {
            if (!settled) finish('blocked');
          }, 800);
        });

      return {
        sealed: await probe(''),
        scriptsAllowed: await probe('allow-scripts'),
        noSandbox: await probe(null),
      };
    });

    check(
      label,
      'a sealed sandbox runs nothing in the preview frame',
      results.sealed === 'blocked',
      results.sealed,
    );

    check(
      label,
      "the page's CSP reaches inside the frame, even where the sandbox allows scripts",
      results.scriptsAllowed === 'blocked',
      results.scriptsAllowed,
    );

    check(
      label,
      'an inline script in a srcdoc frame is refused with no sandbox at all',
      results.noSandbox === 'blocked',
      results.noSandbox,
    );

    /* -- And the real preview, as the tool renders it ---------------------- */
    await page.getByRole('textbox', { name: /Input/i }).first().fill('# Hi\n\nSome **text**.\n');
    await page.getByRole('button', { name: /^Run/ }).first().click();
    await page.getByRole('button', { name: 'Preview' }).first().waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Preview' }).first().click();
    await page.waitForTimeout(300);

    const frame = await page.evaluate(() => {
      const element = document.querySelector('iframe[srcdoc]');
      return element
        ? {
            sandbox: element.getAttribute('sandbox'),
            title: element.getAttribute('title'),
            hasSrc: element.hasAttribute('src'),
            rendersHeading: (element.getAttribute('srcdoc') ?? '').includes('<h1'),
          }
        : null;
    });

    check(
      label,
      'the preview frame is sealed, named and populated by srcdoc',
      frame !== null &&
        frame.sandbox === '' &&
        !frame.hasSrc &&
        (frame.title ?? '').includes('preview') &&
        frame.rendersHeading,
      JSON.stringify(frame),
    );

    /*
     * DOES THE STYLESHEET ACTUALLY APPLY?
     *
     * This is the one thing no unit test can answer. The preview's styling
     * arrives as an inline <style> block whose sha256 is pinned in
     * `style-src`, so it renders only if THREE things line up: the hash the
     * build computed, the bytes the runtime emitted, and the browser's
     * willingness to honour a hash inside a sandboxed frame at an opaque
     * origin. Measured here rather than assumed, because a mismatch in any of
     * them presents as a preview that is silently unstyled.
     *
     * The frame is same-origin only under `allow-same-origin`, which the real
     * one deliberately does not have - so the measurement is taken from a
     * probe frame carrying the same policy, and the assertion that the REAL
     * frame carries the same stylesheet is made on its srcdoc.
     */
    const styling = await page.evaluate(async () => {
      const element = document.querySelector('iframe[srcdoc]');
      const srcdoc = element?.getAttribute('srcdoc') ?? '';
      const styleBlock = /<style>([\s\S]*?)<\/style>/.exec(srcdoc);

      if (!styleBlock) return { hasStyle: false };

      // Same bytes, same policy, but readable - so the computed style can be
      // asked whether the hash was honoured.
      const probe = document.createElement('iframe');
      probe.setAttribute('sandbox', 'allow-same-origin');
      probe.srcdoc = `<style>${styleBlock[1]}</style><table><tr><td id="c">x</td></tr></table>`;
      probe.style.cssText = 'position:fixed;left:-9999px;width:300px;height:100px';

      const applied = await new Promise((resolve) => {
        probe.addEventListener('load', () => {
          const cell = probe.contentDocument?.getElementById('c');
          resolve(cell ? getComputedStyle(cell).borderTopWidth : 'no cell');
        });
        document.body.appendChild(probe);
      });
      probe.remove();

      return {
        hasStyle: true,
        // The rule the preview was missing entirely before this existed.
        cellBorder: applied,
        declaresTableBorders: styleBlock[1].includes('border-collapse'),
        honoursAlignment: styleBlock[1].includes("[align='right']"),
      };
    });

    /*
     * THE BUG REPORT, DRIVEN END TO END IN A REAL ENGINE.
     *
     * "Blank lines are dropped inside fenced code blocks" was reported against
     * Markdown to HTML, and the pipeline turned out to be right - so the only
     * places left for the loss to have been were the output textarea and the
     * rendered preview, neither of which a unit test can see. jsdom has no
     * layout engine, so it cannot say how many lines a <pre> actually draws.
     *
     * This types the reported document into the real tool, reads the real
     * output, and counts the line boxes the real preview lays out. Three lines
     * for two statements is the blank line between them.
     */
    const input = page.getByRole('textbox', { name: /Input/i }).first();
    await input.fill('```ts\nconst a = 1;\n\nconst b = 2;\n```\n');
    await page.getByRole('button', { name: /^Run/ }).first().click();
    await page.getByRole('button', { name: 'Source' }).first().click();
    await page.waitForTimeout(400);

    const codeFidelity = await page.evaluate(async () => {
      const source = [...document.querySelectorAll('textarea')]
        .map((area) => area.value)
        .find((value) => value.includes('<pre>'));

      if (source === undefined) return { found: false };

      // The same document the preview frame is given, in a frame that can be
      // read, so the laid-out result can be measured rather than assumed.
      const style = /<style>([\s\S]*?)<\/style>/.exec(
        document.querySelector('iframe[srcdoc]')?.getAttribute('srcdoc') ?? '',
      );
      const probe = document.createElement('iframe');
      probe.setAttribute('sandbox', 'allow-same-origin');
      probe.srcdoc = `<style>${style ? style[1] : ''}</style>${source}`;
      probe.style.cssText = 'position:fixed;left:-9999px;width:600px;height:400px';

      const lines = await new Promise((resolve) => {
        probe.addEventListener('load', () => {
          const code = probe.contentDocument?.querySelector('pre code');
          resolve(code ? code.getClientRects().length : -1);
        });
        document.body.appendChild(probe);
      });
      probe.remove();

      return {
        found: true,
        keepsBlankLine: source.includes('const a = 1;\n\nconst b = 2;'),
        renderedLines: lines,
      };
    });

    check(
      label,
      'a blank line inside a fenced code block survives to the output and the preview',
      codeFidelity.found === true &&
        codeFidelity.keepsBlankLine === true &&
        codeFidelity.renderedLines === 3,
      JSON.stringify(codeFidelity),
    );

    check(
      label,
      'the preview stylesheet survives style-src and actually applies',
      styling.hasStyle === true &&
        styling.cellBorder === '1px' &&
        styling.declaresTableBorders === true &&
        styling.honoursAlignment === true,
      JSON.stringify(styling),
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * THE COLD OPEN.
 *
 * The first screen at `/` is hand-written markup in index.html rather than
 * anything the app renders, which buys three things nothing in a component
 * could - it exists for a crawler, it paints before the canvas chunk has been
 * asked for, and it costs the JavaScript payload nothing - at the price of
 * being invisible to the type system. `coldOpen.test.ts` ties the markup to
 * the code it names; this is the half that needs a real browser.
 *
 * Four things only an engine can answer:
 *
 *   1. IT IS THERE WITH SCRIPTING OFF. That is the whole claim about crawlers
 *      and link previews, and a jsdom render of a React tree cannot make it -
 *      the assertion has to be made against the served bytes in a browser that
 *      will not run a line of our code;
 *   2. THE APP BEHIND IT IS NOT REACHABLE. `inert` is a browser behaviour;
 *      jsdom exposes the property and enforces nothing;
 *   3. AN EXAMPLE LINK IS A WORKING PIPELINE. The links are encoded by hand
 *      and decoded by CompressionStream, so this is the only place the whole
 *      chain runs end to end;
 *   4. NOBODY WHO HAS ALREADY ARRIVED SEES IT. A reload, a share link and a
 *      saved graph each have to answer with the canvas - and "the panel is
 *      gone by the time the load finished" is not the assertion, because the
 *      failure being ruled out is a FLASH. The removal happens in a
 *      parser-blocking script, so `domcontentloaded` is the earliest moment at
 *      which a paint could have happened, and that is where it is checked.
 */
/**
 * THE CANVAS GRID AND THE ZOOM, IN A REAL ENGINE.
 *
 * Every defect this exists for was invisible to the whole gate until somebody
 * photographed it, and invisible for one structural reason: jsdom resolves no
 * colour, rasterises nothing and runs no `requestAnimationFrame`, so the unit
 * suite can check where `grid.ts` says a rule goes and nothing about what any
 * of it looks like.
 *
 * WHAT IS ASSERTED HERE, AND WHY THESE AND NOT THE SYMPTOM.
 *
 * The symptom was banding: bands of lighter and darker grid at a period with no
 * relation to the grid's spacing. Measuring band amplitude directly turns out
 * to be a poor gate - a grid legitimately puts a large periodic component into
 * any profile of it, and separating that from the banding needs more sample
 * than a screenshot of bare canvas gives. So what is measured is the CAUSE,
 * which is sharp:
 *
 *   1. CRISPNESS, as the number of distinct shades a bare strip of canvas is
 *      made of. A rule rounded to a device pixel paints one colour; a rule at a
 *      fractional position is antialiased into two pixels whose shades depend
 *      on its subpixel offset, and across a canvas that offset takes every
 *      value - a continuum of shades, which is what the banding was made of. A
 *      handful of shades is proof there is no antialiasing to alias.
 *
 *   2. COVERAGE, against the geometry's own answer. For one-pixel rules at
 *      pitch p the fraction of pixels away from the backdrop is
 *      `1 - ((p-1)/p)^2`. The gradient build measured about twice that at every
 *      zoom, because every rule was two pixels wide. It should now be exact.
 *
 *   3. DENSITY, as the mean ink over a bare strip across the range. This is
 *      "the surface must not get lighter or heavier as you zoom", and it is the
 *      one thing here that cannot be checked without rendering, because the
 *      arithmetic answer is in `grid.test.ts` and what the eye gets is the
 *      arithmetic after rasterisation.
 *
 *   4. A WHEEL DETENT IS ONE NOTCH. `deltaMode` and the detent size are the
 *      engine's business, and Firefox's answer differs from Chromium's - three
 *      LINES rather than a hundred pixels. Asserting it here is asserting it in
 *      the only place the difference exists.
 */
async function checkCanvasGrid(browser, label) {
  /** Mean ink and shade count over a strip of bare canvas. */
  const MEASURE = () => {
    window.__gridMeasure = async (bytes) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
      );
      const surface = document.createElement('canvas');
      surface.width = bitmap.width;
      surface.height = bitmap.height;
      const context = surface.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      const total = bitmap.width * bitmap.height;

      const counts = new Map();
      const luminance = new Float64Array(256);
      const histogram = new Float64Array(256);
      for (let i = 0; i < data.length; i += 4) {
        const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        const value = Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
        histogram[value] += 1;
        luminance[value] = value;
      }

      let backdrop = 0;
      for (let value = 0; value < 256; value += 1) {
        if (histogram[value] > histogram[backdrop]) backdrop = value;
      }

      let ink = 0;
      let away = 0;
      for (let value = 0; value < 256; value += 1) {
        ink += histogram[value] * Math.abs(value - backdrop);
        if (Math.abs(value - backdrop) > 1) away += histogram[value];
      }

      return {
        /*
         * Shades covering more than a thousandth of the strip. The tail below
         * that is the antialiasing on any text that strays into frame, which is
         * not what is being measured and would otherwise set the number.
         */
        shades: [...counts.values()].filter((n) => n / total > 0.001).length,
        ink: ink / total,
        coverage: away / total,
        backdrop,
      };
    };
  };

  /*
   * ONE DENSITY, AND IT IS THE ENGINE'S OWN.
   *
   * `deviceScaleFactor` is quietly ignored by Gecko and by WebKit's Playwright
   * build - a context asked for 2x reports `devicePixelRatio` of 1 and renders
   * at 1x - so a sweep over it here would assert the same thing twice and call
   * it coverage. Which it did, until the coverage figure was computed from the
   * REQUESTED density and came out against a 2x ideal on a 1x render.
   *
   * So everything below is derived from what the page reports, and higher
   * densities are covered where they can be: `grid.test.ts` asserts every rule
   * lands on a whole device pixel at 1x, 1.25x, 1.5x, 2x and 3x.
   */
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    try {
      await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
      await page.evaluate(() => {
        window.localStorage.setItem('patchbay:cold-open:v1', String(Date.now()));
      });
      await gotoCanvas(page);
      await page.locator('[data-testid="canvas-grid"]').waitFor({ timeout: 15_000 });
      await page.evaluate(MEASURE);
      await page.evaluate(() => {
        const root = document.querySelector('[data-testid="canvas-root"]');
        window.__setZoom = async (target) => {
          const readout = () =>
            Number(
              document
                .querySelector('[data-testid="canvas-readout"]')
                .textContent.match(/(\d+)%/)[1],
            ) / 100;
          for (let attempt = 0; attempt < 200; attempt += 1) {
            const current = readout();
            if (Math.abs(current - target) < 0.0015) break;
            const box = root.getBoundingClientRect();
            const step = Math.max(-1, Math.min(1, Math.log2(target / current) * 6));
            root.dispatchEvent(
              new WheelEvent('wheel', {
                deltaY: -step * 12,
                ctrlKey: true,
                clientX: box.left + box.width / 2,
                clientY: box.top + box.height / 2,
                bubbles: true,
                cancelable: true,
              }),
            );
            await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
          }
          return readout();
        };
      });

      /* -- The layer really is drawing in device pixels ------------------- */

      const backing = await page.evaluate(() => {
        const canvas = document.querySelector('[data-testid="canvas-grid"]');
        return {
          tag: canvas.tagName,
          width: canvas.width,
          height: canvas.height,
          css: Math.round(canvas.clientWidth),
          ratio: window.devicePixelRatio,
          opacity: window.getComputedStyle(canvas).opacity,
        };
      });

      const dpr = backing.ratio;

      check(
        label,
        'the grid is a canvas with a device-pixel backing store',
        backing.tag === 'CANVAS' && backing.width === Math.round(backing.css * dpr),
        `${backing.width}px of bitmap for ${backing.css}px of layer at ${dpr}x`,
      );

      check(
        label,
        'the grid layer carries no opacity of its own',
        backing.opacity === '1',
        `opacity ${backing.opacity} - a per-level ink replaced the whole-layer fade`,
      );

      /* -- Crispness, coverage and density across the range --------------- */

      const strip = { x: 24, y: 150, width: 320, height: 620 };
      const readings = [];

      for (const zoom of [0.25, 0.33, 0.4, 0.56, 0.71, 0.79, 0.89, 1, 1.12, 1.41, 1.59, 2, 2.5]) {
        const reached = await page.evaluate((target) => window.__setZoom(target), zoom);
        await page.waitForTimeout(70);
        const shot = await page.screenshot({ clip: strip });
        const reading = await page.evaluate((bytes) => window.__gridMeasure(bytes), [...shot]);
        readings.push({ zoom: reached, ...reading });
      }

      const worstShades = readings.reduce((a, b) => (a.shades > b.shades ? a : b));
      check(
        label,
        'a bare strip of grid is a handful of shades at every zoom',
        worstShades.shades <= 8,
        `worst ${worstShades.shades} shades at ${Math.round(worstShades.zoom * 100)}% - antialiased rules give a continuum, which is what the banding was`,
      );

      /*
       * Coverage against the geometry, at the two zooms where every inked level
       * is at FULL ink and the pitch is therefore unambiguous. In between, a
       * part-drawn level adds rules of its own and the closed form stops
       * applying - which is why this is checked where it is exact rather than
       * with a tolerance wide enough to cover the fade.
       */
      for (const [zoom, pitch] of [
        [1, 8],
        [2, 8],
      ]) {
        const reading = readings.find((one) => Math.abs(one.zoom - zoom) < 0.02);
        if (!reading) continue;
        const devicePitch = pitch * dpr;
        const ideal = 1 - ((devicePitch - 1) / devicePitch) ** 2;

        check(
          label,
          `at ${zoom * 100}% every rule is one device pixel wide`,
          Math.abs(reading.coverage - ideal) < 0.02,
          `${(reading.coverage * 100).toFixed(1)}% of pixels inked against the geometry's ${(ideal * 100).toFixed(1)}% - the gradient build measured about twice this`,
        );
      }

      const inks = readings.map((one) => one.ink);
      const lo = Math.min(...inks);
      const hi = Math.max(...inks);

      check(
        label,
        'the surface keeps its density across the whole zoom range',
        hi / lo < 1.8,
        `mean ink ${lo.toFixed(2)} to ${hi.toFixed(2)} luminance units, ${(hi / lo).toFixed(2)}x - the gradient build ran to 3.9x`,
      );

      /*
       * And the working range on its own, which is tighter: the ends of the
       * zoom range are where the proportion of MAJOR rules on screen changes
       * most, because the major square is anchored to the world rather than to
       * the screen. See the note in grid.ts.
       */
      const working = readings.filter((one) => one.zoom >= 0.4 && one.zoom <= 2);
      const workingLo = Math.min(...working.map((one) => one.ink));
      const workingHi = Math.max(...working.map((one) => one.ink));

      check(
        label,
        'and holds it to within a quarter between 40% and 200%',
        workingHi / workingLo < 1.3,
        `mean ink ${workingLo.toFixed(2)} to ${workingHi.toFixed(2)}, ${(workingHi / workingLo).toFixed(3)}x`,
      );
    } finally {
      await context.close();
    }
  }

  /* -- Both weights of ink, in two themes ------------------------------- */

  const themed = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await themed.newPage();

  try {
    await page.evaluate(MEASURE).catch(() => undefined);

    for (const theme of ['graphite', 'vellum']) {
      await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
      await page.evaluate((name) => {
        window.localStorage.setItem(
          'patchbay:theme:v1',
          JSON.stringify({ version: 1, selection: { kind: 'preset', name } }),
        );
        window.localStorage.setItem('patchbay:cold-open:v1', String(Date.now()));
      }, theme);
      await gotoCanvas(page);
      await page.locator('[data-testid="canvas-grid"]').waitFor({ timeout: 15_000 });

      const tokens = await page.evaluate(() => {
        const canvas = document.querySelector('[data-testid="canvas-grid"]');
        const style = window.getComputedStyle(canvas);
        const probe = document.createElement('span');
        canvas.parentElement.append(probe);
        const channels = (value) => {
          probe.style.color = value;
          return (window.getComputedStyle(probe).color.match(/[\d.]+/g) ?? [])
            .slice(0, 3)
            .join(',');
        };
        const minor = channels(style.getPropertyValue('--pb-canvas-grid-minor').trim());
        const major = channels(style.getPropertyValue('--pb-canvas-grid-major').trim());
        probe.remove();
        return { minor, major };
      });

      const shot = await page.screenshot({ clip: { x: 24, y: 150, width: 320, height: 620 } });
      const drawn = await page.evaluate(
        async (bytes) => {
          const bitmap = await createImageBitmap(
            new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
          );
          const surface = document.createElement('canvas');
          surface.width = bitmap.width;
          surface.height = bitmap.height;
          const context = surface.getContext('2d');
          context.drawImage(bitmap, 0, 0);
          const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
          const seen = new Set();
          for (let i = 0; i < data.length; i += 4) {
            seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
          }
          return [...seen];
        },
        [...shot],
      );

      const present = new Set(drawn);
      check(
        label,
        `${theme}: both weights of ink reached real pixels`,
        present.has(tokens.minor) && present.has(tokens.major),
        `minor ${tokens.minor} ${present.has(tokens.minor) ? 'drawn' : 'MISSING'}, major ${tokens.major} ${present.has(tokens.major) ? 'drawn' : 'MISSING'} - vellum's minor rule used to BE the backdrop`,
      );
    }

    /* -- And the zoom, in the units this engine actually reports --------- */

    await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      window.localStorage.setItem(
        'patchbay:theme:v1',
        JSON.stringify({ version: 1, selection: { kind: 'preset', name: 'graphite' } }),
      );
    });
    await gotoCanvas(page);
    await page.locator('[data-testid="canvas-root"]').waitFor({ timeout: 15_000 });

    const readZoom = async () =>
      Number((await page.locator('[data-testid="canvas-readout"]').innerText()).match(/(\d+)%/)[1]);

    check(label, 'the canvas starts at 100%', (await readZoom()) === 100);

    /*
     * A REAL WHEEL EVENT FROM PLAYWRIGHT, not a synthesised one: `mouse.wheel`
     * goes through the browser's own input pipeline, so the `deltaMode` and the
     * detent size are whatever this engine would really send.
     */
    const box = await page.locator('[data-testid="canvas-root"]').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down('Control');

    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(120);
    const afterOne = await readZoom();

    check(
      label,
      'one wheel detent is one notch, not a jump to the clamp',
      afterOne >= 110 && afterOne <= 114,
      `100% -> ${afterOne}% (one notch is 112%; the old handler reached the 250% clamp)`,
    );

    for (let detent = 0; detent < 5; detent += 1) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(150);
    const doubled = await readZoom();

    check(label, 'six detents double the zoom exactly', doubled === 200, `${doubled}%`);

    for (let detent = 0; detent < 12; detent += 1) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(150);
    const halved = await readZoom();
    await page.keyboard.up('Control');

    check(
      label,
      'and twelve back out halve it, so the ladder is symmetric',
      halved === 50,
      `${halved}%`,
    );

    await page.locator('[data-testid="canvas-root"]').click({ position: { x: 40, y: 400 } });
    for (let press = 0; press < 3; press += 1) await page.keyboard.press('+');
    await page.waitForTimeout(120);

    check(
      label,
      'three presses of + double the zoom',
      (await readZoom()) === 100,
      `${await readZoom()}% from 50%`,
    );
  } finally {
    await themed.close();
  }

  /* -- Forced colours, where a faded rule is not available -------------- */

  const forced = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    forcedColors: 'active',
  });
  const forcedPage = await forced.newPage();

  try {
    await forcedPage.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
    await forcedPage.evaluate(() => {
      window.localStorage.setItem('patchbay:cold-open:v1', String(Date.now()));
    });
    await gotoCanvas(forcedPage);
    await forcedPage.locator('[data-testid="canvas-grid"]').waitFor({ timeout: 15_000 });

    const shot = await forcedPage.screenshot({
      clip: { x: 24, y: 150, width: 320, height: 620 },
    });
    const shades = await forcedPage.evaluate(
      async (bytes) => {
        const bitmap = await createImageBitmap(
          new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
        );
        const surface = document.createElement('canvas');
        surface.width = bitmap.width;
        surface.height = bitmap.height;
        const context = surface.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
        const counts = new Map();
        for (let i = 0; i < data.length; i += 4) {
          const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const total = bitmap.width * bitmap.height;
        return [...counts.values()].filter((n) => n / total > 0.002).length;
      },
      [...shot],
    );

    /*
     * Two: the forced backdrop and one weight of rule. The subdivisions are
     * dropped on purpose - system colours come in two weights and a faded rule
     * is not among them, so a full-strength subdivision every few pixels would
     * bury the nodes it is behind. See `inkFrom`.
     */
    check(
      label,
      'forced colours draws one weight of rule and no faded ones',
      shades === 2,
      `${shades} shades covering the strip, where the grid draws only its major rule`,
    );
  } finally {
    await forced.close();
  }
}

async function checkColdOpen(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  try {
    /* -- With JavaScript switched off entirely -------------------------- */
    const noScript = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      javaScriptEnabled: false,
    });
    const staticPage = await noScript.newPage();
    try {
      await staticPage.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });

      const headline = staticPage.locator('#cold-open-title');
      const visible = await headline.isVisible();
      const text = ((await headline.textContent()) ?? '').trim();
      check(
        label,
        'the first screen renders with no JavaScript at all',
        visible && text.length > 0,
        text,
      );

      /*
       * Styled, not merely present. The stylesheet is a render-blocking <link>
       * in the built document, so a panel that arrived as unstyled markup
       * would mean the CSS had moved into the module graph - which is exactly
       * what happens in dev, and would be a real regression in production.
       */
      const painted = await staticPage.evaluate(() => {
        const panel = document.querySelector('.cold-open-panel');
        if (!panel) return null;
        const styles = getComputedStyle(panel);
        return { border: styles.borderTopWidth, background: styles.backgroundColor };
      });
      check(
        label,
        'and it is painted by the stylesheet rather than left as bare markup',
        painted !== null && painted.border !== '0px' && painted.background !== 'rgba(0, 0, 0, 0)',
        painted === null ? 'no panel' : `${painted.border} border on ${painted.background}`,
      );

      const links = await staticPage.locator('#cold-open a[href^="/?p="]').count();
      check(
        label,
        'and its example pipelines are real links, not scripted buttons',
        links === 3,
        `${String(links)} share link(s)`,
      );
    } finally {
      await noScript.close().catch(() => {});
    }

    /* -- With the module graph blocked ---------------------------------- */
    /*
     * STRONGER THAN THE NO-JAVASCRIPT CONTEXT ABOVE, and it is here because
     * of a bug that one could not see.
     *
     * The style layer used to be imported by `main.tsx`, which put it in the
     * module graph. A production build extracts that into a render-blocking
     * <link>, so the check above passed and everything looked right - while
     * `pnpm dev`, which does no extraction, served the panel as raw unstyled
     * markup until the first chunk arrived. Scripting being OFF hid the
     * difference: with no modules to run there is no module-injected
     * stylesheet to be late.
     *
     * So: scripting on, inline bootstrap running, and every chunk refused.
     * That is the app failing to arrive rather than being switched off, and
     * the panel has to be fully painted anyway - which is the whole claim the
     * first screen makes about itself.
     */
    const blocked = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const blockedPage = await blocked.newPage();
    try {
      await blockedPage.route('**/assets/*.js', (route) => route.abort());
      await blockedPage.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });

      const painted = await blockedPage.evaluate(() => {
        const box = document.querySelector('.cold-open-panel');
        const title = document.getElementById('cold-open-title');
        if (!box || !title) return null;
        return {
          border: getComputedStyle(box).borderTopWidth,
          background: getComputedStyle(box).backgroundColor,
          // The cold open's OWN rule, not an inherited default: nothing else
          // would uppercase this heading.
          transform: getComputedStyle(title).textTransform,
        };
      });
      /*
       * And the one control that needs the app says so, rather than looking
       * live and swallowing the press. This is the state a cold connection
       * shows for real, for as long as the entry bundle and the canvas chunk
       * take; here it is permanent, which is what makes it checkable.
       */
      check(
        label,
        'and its one scripted control is visibly not ready, rather than dead',
        await blockedPage.locator('#cold-open-start').isDisabled(),
      );

      check(
        label,
        'the first screen is painted with every module refused',
        painted !== null &&
          painted.border !== '0px' &&
          painted.background !== 'rgba(0, 0, 0, 0)' &&
          painted.transform === 'uppercase',
        painted === null
          ? 'no panel'
          : `${painted.border} border on ${painted.background}, title ${painted.transform}`,
      );
    } finally {
      await blocked.close().catch(() => {});
    }

    /* -- A first-time visitor ------------------------------------------- */
    await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
    check(
      label,
      'a first-time visitor to / gets the introduction',
      await page.locator('#cold-open').isVisible(),
    );

    const held = await page.evaluate(() => {
      const root = document.getElementById('root');
      const toolbar = document.querySelector('[data-canvas-chrome="toolbar"] button');
      return {
        inert: root?.inert ?? null,
        // The real question: can anything behind the panel take focus?
        focusable: (() => {
          toolbar?.focus();
          return document.activeElement === toolbar;
        })(),
      };
    });
    check(
      label,
      'and the canvas behind it cannot be focused or tabbed into',
      held.inert === true && held.focusable === false,
      `inert=${String(held.inert)}, toolbar took focus=${String(held.focusable)}`,
    );

    /* -- An example pipeline -------------------------------------------- */
    await page.locator('#cold-open a[href^="/?p="]').first().click();
    await page.locator('[data-node-id]').first().waitFor({ timeout: 15_000 });
    const wired = await page.evaluate(() => ({
      panel: document.getElementById('cold-open') !== null,
      nodes: document.querySelectorAll('[data-node-id]').length,
      inert: document.getElementById('root')?.inert ?? null,
    }));
    check(
      label,
      'an example link opens the pipeline it names, with no panel in the way',
      wired.panel === false && wired.nodes === 2 && wired.inert === false,
      `${String(wired.nodes)} node(s)`,
    );

    /*
     * AND FRAMES IT. The first version of these links encoded the graph at the
     * world origin, so both nodes landed in the top-left corner with half the
     * first one under the toolbar and the rest of the canvas empty - a
     * pipeline that decoded perfectly and read as a broken page. Two things
     * fixed it and this asserts the pair: the links now carry the coordinates
     * the app itself would produce, and any share link is fitted on arrival.
     */
    const framing = await page.evaluate(() => {
      const surface = document.querySelector('[role="application"]');
      if (!surface) return null;
      const canvas = surface.getBoundingClientRect();
      const bar = document.querySelector('[data-canvas-chrome="toolbar"]')?.getBoundingClientRect();
      const nodes = [...document.querySelectorAll('[data-node-id]')].map((node) =>
        node.getBoundingClientRect(),
      );
      if (nodes.length === 0) return null;

      return {
        inView: nodes.every(
          (box) =>
            box.left >= canvas.left &&
            box.right <= canvas.right &&
            box.top >= canvas.top &&
            box.bottom <= canvas.bottom,
        ),
        clearOfToolbar:
          bar === undefined || nodes.every((box) => box.top >= bar.bottom || box.left >= bar.right),
        first: nodes[0],
      };
    });
    check(
      label,
      'and frames it on the canvas rather than in the corner under the toolbar',
      framing !== null && framing.inView && framing.clearOfToolbar,
      framing === null
        ? 'no nodes'
        : `first node at ${String(Math.round(framing.first.left))},${String(Math.round(framing.first.top))}`,
    );

    /* -- Dismissing it by hand ------------------------------------------ */
    const fresh = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const freshPage = await fresh.newPage();
    try {
      await freshPage.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
      await freshPage.locator('#cold-open-start').click();
      await freshPage.locator('#cold-open').waitFor({ state: 'detached', timeout: 15_000 });

      const released = await freshPage.evaluate(() => ({
        inert: document.getElementById('root')?.inert ?? null,
        focused: document.activeElement?.getAttribute('data-testid') ?? null,
      }));
      check(
        label,
        'dismissing it releases the app and hands focus to the canvas',
        released.inert === false && released.focused === 'canvas-root',
        `focus on ${released.focused ?? 'nothing'}`,
      );

      /*
       * Reloaded, and checked at `domcontentloaded` rather than after the app
       * has booted. A panel that were merely REMOVED BY REACT would still have
       * been painted first, and "you saw the introduction again for 200ms" is
       * the failure this is here to rule out.
       */
      await freshPage.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
      check(
        label,
        'and a reload never paints it again',
        (await freshPage.locator('#cold-open').count()) === 0,
      );

      /* -- Somebody with work saved ------------------------------------- */
      await freshPage.waitForLoadState('networkidle');
      await freshPage.getByRole('button', { name: 'Add tool' }).click();
      await freshPage.locator('[role="option"]').first().waitFor({ timeout: 10_000 });
      await freshPage.locator('[role="option"]').first().click();
      await freshPage.locator('[data-node-id]').first().waitFor({ timeout: 10_000 });

      // The flag is what suppressed the last reload; clear it, so what is
      // being tested now is the SAVED GRAPH and nothing else.
      await freshPage.evaluate(() => {
        window.localStorage.removeItem('patchbay:cold-open:v1');
      });
      /*
       * WAIT FOR THE SAVE, do not time it.
       *
       * `createDebouncedSaver` is subscribed to the whole canvas store, not to
       * the graph, and the store also carries the announcement log - so every
       * line the pipeline announces while the new nodes settle pushes the
       * 500ms window out again. A fixed wait passed locally and lost the race
       * in both engines here, which left the next assertion claiming that a
       * saved graph does not suppress the panel when what had actually
       * happened was that nothing had been saved yet.
       */
      await freshPage.waitForFunction(
        () => (window.localStorage.getItem('patchbay:graph:v3') ?? '').includes('"nodes"'),
        undefined,
        { timeout: 20_000 },
      );

      await freshPage.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });

      /*
       * Read at `domcontentloaded`, before the module script has run, which is
       * the earliest moment a paint could have happened. Anything later would
       * pass just as happily on a panel that was shown and then withdrawn.
       */
      check(
        label,
        'a saved graph is enough on its own to suppress it',
        (await freshPage.locator('#cold-open').count()) === 0,
      );

      /*
       * And the other half of the same statement: the reason it is suppressed
       * is that there is something better to show, so that thing has to
       * actually arrive. WAITED FOR rather than counted - restoring a graph is
       * a chunk fetch and then an effect, and `networkidle` is neither.
       */
      await freshPage
        .locator('[data-node-id]')
        .first()
        .waitFor({ timeout: 15_000 })
        .catch(() => {});
      const restored = await freshPage.locator('[data-node-id]').count();
      check(
        label,
        'and the work it was suppressed in favour of is on the canvas',
        restored > 0,
        `${String(restored)} node(s) restored`,
      );

      /*
       * AND IS NOT REFRAMED, which is the other half of the share-link
       * decision rather than an absence of one. A link's coordinates belong to
       * whoever sent it; a save's belong to the person reading it, who chose
       * them against this viewport - so a restore that fitted would overrule
       * its own user's layout on every reload. The plane is left exactly where
       * the default viewport puts it.
       */
      const planeTransform = await freshPage.evaluate(
        () =>
          document.querySelector('[data-testid="canvas-plane"]')?.style.transform ?? '(no plane)',
      );
      /*
       * Matched rather than compared. The canvas writes
       * `translate(${x}px, ${y}px) scale(${zoom})`, and reading it back off
       * `style.transform` returns the CSS serialisation - which drops a
       * second argument of zero, so an untouched plane comes back as
       * `translate(0px) scale(1)` in both engines. Both spellings mean the
       * same thing and both mean "nobody moved this".
       */
      check(
        label,
        'and a restored save is left where its author put it, not fitted',
        /^translate\(0px(?:, 0px)?\) scale\(1\)$/.test(planeTransform),
        planeTransform,
      );
    } finally {
      await fresh.close().catch(() => {});
    }

    /* -- Every other URL ------------------------------------------------ */
    const other = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const otherPage = await other.newPage();
    try {
      for (const path of ['/tools', '/tools/base64', '/styleguide', '/nothing-here']) {
        await otherPage.goto(`${ORIGIN}${path}`, { waitUntil: 'domcontentloaded' });
        check(
          label,
          `${path} is served the same document and still never shows it`,
          (await otherPage.locator('#cold-open').count()) === 0,
        );
      }
    } finally {
      await other.close().catch(() => {});
    }
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
    await gotoCanvas(page);
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
    /*
     * GUIDANCE, NOT SUMMARIES, and the distinction is now load-bearing. A tool
     * summary is longer than the box and is deliberately clamped to two lines
     * with an ellipsis. The guidance a BLOCKED node shows is the opposite: it
     * is the instruction for getting unblocked, it was written to fit, and
     * losing its last words is the bug this check exists for.
     *
     * Measured by cloning without the clamp, because overflow no longer
     * reports it: a clamped element drops the extra lines rather than
     * scrolling them, so `scrollHeight > clientHeight` is false whether or not
     * anything was cut. The clone says how tall the text WANTS to be; two
     * lines is what it gets.
     */
    const guidance = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('[class*="nodeSummaryText"]')];
      return boxes.map((el) => {
        const line = parseFloat(getComputedStyle(el).lineHeight);
        const clone = el.cloneNode(true);
        clone.style.webkitLineClamp = 'none';
        clone.style.position = 'absolute';
        clone.style.visibility = 'hidden';
        clone.style.inlineSize = `${String(el.clientWidth)}px`;
        el.parentElement.appendChild(clone);
        const wanted = Math.round(clone.getBoundingClientRect().height / line);
        clone.remove();
        return { text: (el.textContent ?? '').trim().slice(0, 60), wanted };
      });
    });
    check(
      label,
      'no node guidance needs more than the two lines it gets',
      guidance.length > 0 && guidance.every((entry) => entry.wanted <= 2),
      `${guidance.length.toString()} checked, ${guidance
        .filter((entry) => entry.wanted > 2)
        .map((entry) => entry.text)
        .join(' | ')}`,
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
    /*
     * Input is typed in the inspector, which is where it now lives. That makes
     * this the end-to-end proof of the whole route as well as of the worker:
     * open the panel, type into the node's only text port, and the node's own
     * `data-status` goes to ok because a real tool ran in a real worker.
     */
    await inspectFirstNode(page);
    const editor = page.locator('textarea[data-inspector-input]').first();
    await editor.waitFor({ timeout: 15_000 });
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

    /*
     * The details port is drawn as a REPORT now - the notes in sentences, then
     * a before-and-after table - so the machine-readable payload lives behind
     * the view's own Raw toggle rather than being the only thing on offer.
     * Every numeric assertion below wants the payload, so the toggle is
     * pressed rather than the numbers being read back out of prose.
     */
    await page.getByRole('button', { name: 'Raw' }).click({ timeout: 30_000 });
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

    /*
     * AND THE GAP THAT LEAVES, NAMED WHERE SOMEBODY WILL SEE IT.
     *
     * Playwright's WebKit has no OffscreenCanvas at all. Real Safari has had it
     * since 16.4 - so the branch this engine takes here is NOT the branch a
     * Safari user takes, and the worker path is proved only in Gecko. That is
     * a real hole and it is easy to read the green line above as covering it,
     * which is exactly why it gets its own line.
     */
    if (!offscreen.main) {
      skip(
        label,
        'the worker path for image conversion in a WebKit',
        'this build has no OffscreenCanvas, so it takes the fallback; real Safari has had OffscreenCanvas since 16.4 and takes the worker path, which is therefore proved only in Gecko. Six minutes on a Mac: docs/manual-checks.md',
      );
    }

    check(label, 'no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  } finally {
    await context.close();
  }

  try {
    await checkColdOpen(browser, label);
    await checkChromeWidths(browser, label);
    await checkCanvasGrid(browser, label);
    await checkRunnerLayout(browser, label);
    await checkInspector(browser, label);
    await checkInspectorMotion(browser, label);
    await checkInspectorTouch(engine, label);
    await checkDialogScroll(browser, label);
    await checkRouteFeedback(browser, label);
    await checkOffline(browser, label);
    await checkAxe(browser, label);
    await checkConsoleSilence(browser, label);
    await checkDeepLinks(browser, label);
    await checkStructuredData(browser, label);
    await checkDiff(browser, label);
    await checkRegex(browser, label);
    await checkOutputViews(browser, label);
    await checkHead(browser, label);
    await checkTouch(engine, label);
    await checkMobileLayout(engine, label);
    await checkSoftKeyboard(engine, label);
    await checkBackgroundedTab(browser, label);
    await checkTwoTabs(browser, label);
    await checkRichTextClipboard(browser, label);
    await checkTruncation(browser, label);
    await checkPreviewSandbox(browser, label);
    await checkPipeline(browser, label);
    await checkCanvasFileInput(browser, label);
    await checkFileInputTouch(engine, label);
    await checkImageConvert(browser, label);
    await checkVideoRemux(browser, label);
    await checkLargeVideo(browser, label);
    await checkThemeEditor(browser, label);
  } finally {
    await browser.close();
  }
}

/**
 * A WHOLE PIPELINE, IN A REAL WORKER.
 *
 * Every pipeline test in the unit suite injects `strategy: 'main'`, because
 * jsdom has no Worker at all. So the thing the canvas actually does - post
 * several nodes' work to one shared worker, clone buffers across the boundary,
 * hold a deadline per node, and destroy the worker when a tool wedges it - has
 * been asserted only against a main-thread stand-in.
 *
 * Two properties are worth the round trip.
 *
 * 1. A CHAIN CARRIES ITS VALUE ACROSS THE BOUNDARY. The canvas draws statuses
 *    rather than values, so the assertion is that the far end reaches `ok` -
 *    which is not a weak claim here. Base64 decode produces real bytes; if
 *    those bytes were detached or lost in the hand-off, the tool below it
 *    would report a parse failure on an empty document, not a wrong answer.
 *    Reaching `ok` at the end of the chain means the bytes arrived.
 *
 * 2. ONE NODE TIMING OUT DOES NOT DAMAGE AN UNRELATED ONE. The regex tester is
 *    given a pattern that backtracks catastrophically. It runs `exec`
 *    synchronously and checks no signal, so it wedges the worker thread
 *    outright and the engine's only remedy is to destroy the worker - taking
 *    every other in-flight request with it. A base64 node beside it used to
 *    sit there until its own 15s deadline and then report a timeout it never
 *    had. This is the only place that can be shown: it needs a real worker, a
 *    real terminate, and a tool that genuinely does not yield.
 */
async function checkPipeline(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  /*
   * HOW MANY TIMES EACH REQUEST ACTUALLY RAN.
   *
   * Every assertion in this file was about the ANSWER, and a tool is a pure
   * function - so running one twice produces the same answer twice and no
   * assertion about answers can see it. JavaScriptCore evaluated the worker's
   * entry module a second time when a tool chunk imported it back (it is a
   * shared chunk as well as the entry), which gave `message` two listeners and
   * ran every tool in the worker TWICE. Twice the CPU and twice the peak
   * memory of every worker tool in Safari, invisible in Firefox, and invisible
   * in the unit suite because jsdom has no worker to evaluate anything in.
   *
   * The worker announces `started` once per execution, so counting those
   * against the `execute` messages that were posted is the whole check.
   */
  await page.addInitScript(() => {
    const posted = [];
    const started = [];
    Object.assign(window, { __execution: { posted, started } });

    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(url, options) {
        super(url, options);
        this.addEventListener('message', (event) => {
          if (event.data?.kind === 'started') started.push(event.data.requestId);
        });
      }
      postMessage(message, transfer) {
        if (message?.kind === 'execute') posted.push(message.requestId);
        return super.postMessage(message, transfer);
      }
    };
  });

  /**
   * A graph as a link, which is the app's own way to be handed a whole one.
   *
   * Deliberately still `v: 2` after the port audit bumped the format to 3. The
   * migration is unit-tested, but a share link is decompressed, decoded,
   * migrated and validated by browser APIs - `DecompressionStream`, a strict
   * `TextDecoder` - so having every cross-browser run rebuild a real graph from
   * an older link is coverage worth having for free. Bump it only when v2 stops
   * being migratable, and then leave it one behind again.
   */
  const link = (nodes, edges) => `${ORIGIN}/?p=${shareParam({ v: 2, n: nodes, e: edges })}`;

  /** The status word a node prints in its footer. */
  const statusOf = (id) =>
    page.evaluate(
      (nodeId) =>
        document.querySelector(`[data-testid="node-${nodeId}"] [class*="nodeFooter"] span`)
          ?.textContent ?? null,
      id,
    );

  /**
   * Types into a node's input, through the inspector, which is where input
   * lives.
   *
   * Selecting the node from the KEYBOARD rather than clicking it: these graphs
   * are laid out at fixed coordinates and the docked rail covers the right of
   * the canvas, so a node can genuinely be underneath the panel. Enter on a
   * focused node is the documented route and reaches every node at every
   * width.
   *
   * AND THE VALUE IS CHECKED TO HAVE LANDED, WHICH IS NOT A FORMALITY.
   *
   * `fill` puts the text in the box and fires the events; it does not know
   * whether anything took it. The editor is a CONTROLLED React field, so it
   * renders its state and nothing else - the box still holding what we typed,
   * a moment later, is therefore proof that the value reached the graph, and
   * an empty box is proof that it did not.
   *
   * This is what this check was missing, and it cost a season of re-runs. The
   * canvas deferred moving focus into the panel to an animation frame, and a
   * late frame landed BETWEEN Playwright focusing the field and inserting the
   * text - so the text went to the close button, silently, because text that
   * lands on a button is not an error anywhere. `fill` reported success, the
   * node stayed `blocked` for want of an input it appeared to have, and the
   * check failed twenty-five seconds later against the scheduler, which had
   * done nothing wrong. A precondition that can fail quietly is a check that
   * blames the wrong thing.
   */
  const typeInto = async (id, value) => {
    await page.locator(`[data-testid="node-${id}"]`).focus();
    await page.keyboard.press('Enter');
    const field = page.locator('[data-inspector-input]').first();
    await field.waitFor({ timeout: 15_000 });
    await field.fill(value);

    const deadline = Date.now() + 5_000;
    let held = '';
    for (;;) {
      held = await field.inputValue().catch(() => '');
      if (held === value || Date.now() > deadline) break;
      await page.waitForTimeout(50);
    }
    check(
      label,
      `what is typed into ${id} reaches the node it was typed into`,
      held === value,
      held === value
        ? ''
        : `the editor holds ${String(held.length)} of ${String(value.length)} characters`,
    );
  };

  const untilStatus = async (id, wanted, timeout) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const status = await statusOf(id);
      if (status === wanted || Date.now() > deadline) return status;
      await page.waitForTimeout(100);
    }
  };

  try {
    /* -- A chain, carried across the worker boundary ---------------------- */
    await page.goto(
      link(
        [
          ['n1', 'base64', 0, 0, { mode: 'decode' }],
          ['n2', 'structured-data', 320, 0, { source: 'auto', target: 'yaml', indent: 2 }],
          ['n3', 'hash', 640, 0, { algorithm: 'sha-256', encoding: 'hex' }],
        ],
        [
          ['n1', 'output', 'n2', 'input'],
          ['n2', 'output', 'n3', 'input'],
        ],
      ),
      { waitUntil: 'networkidle' },
    );
    await page.locator('[data-testid="node-n3"]').waitFor({ timeout: 15_000 });

    // {"name":"ada"} in base64. Real bytes really cross into the worker.
    await typeInto('n1', 'eyJuYW1lIjoiYWRhIn0=');

    const chained = await untilStatus('n3', 'ok', 30_000);
    check(
      label,
      'a three-tool chain runs end to end through the real worker',
      chained === 'ok',
      String(chained),
    );

    const execution = await page.evaluate(() => window.__execution);
    const ranTwice = execution.posted.filter(
      (id) => execution.started.filter((other) => other === id).length > 1,
    );
    check(
      label,
      'each request runs its tool once, not once per copy of the worker entry',
      execution.posted.length > 0 && ranTwice.length === 0,
      execution.posted.length === 0
        ? 'nothing was posted to a worker at all'
        : `${String(execution.started.length)} starts for ${String(execution.posted.length)} requests`,
    );

    /* -- One node's timeout, and the nodes beside it ---------------------- */
    await page.goto(
      link(
        [
          ['n1', 'regex-tester', 0, 0, { pattern: WEDGE_PATTERN, mode: 'match' }],
          ['n2', 'base64', 0, 320, { mode: 'decode' }],
          ['n3', 'structured-data', 320, 320, { source: 'auto', target: 'yaml', indent: 2 }],
        ],
        [['n2', 'output', 'n3', 'input']],
      ),
      { waitUntil: 'networkidle' },
    );
    await page.locator('[data-testid="node-n3"]').waitFor({ timeout: 15_000 });

    await typeInto('n1', `${'a'.repeat(40)}!`);
    await typeInto('n2', 'eyJuYW1lIjoiYWRhIn0=');

    const startedAt = Date.now();
    const runaway = await untilStatus('n1', 'error', 25_000);
    const bystander = await untilStatus('n2', 'ok', 25_000);
    const bystanderMs = Date.now() - startedAt;
    const downstream = await untilStatus('n3', 'ok', 25_000);

    check(
      label,
      'a pattern that wedges the worker is stopped by its own deadline',
      runaway === 'error',
      String(runaway),
    );
    check(
      label,
      'the node beside it succeeds instead of reporting a timeout it never had',
      bystander === 'ok',
      String(bystander),
    );
    check(
      label,
      'and it does not sit out its own 15s deadline first',
      bystanderMs < 12_000,
      `${String(bystanderMs)}ms`,
    );
    check(
      label,
      'the bytes it produced survived the replay onto a new worker',
      // Not a formality: an empty or detached buffer here parses as an empty
      // document, and this node would report a parse error rather than `ok`.
      downstream === 'ok',
      String(downstream),
    );

    /* -- Editing while a runaway node is in flight ------------------------ */

    /*
     * WHAT A USER DOES THAT THE TWO CHECKS ABOVE DO NOT: CHANGE THEIR MIND.
     *
     * Both of those let the runaway node run to its own deadline, which is the
     * only path the engine had ever been driven down. Editing the document
     * while it is in flight takes a different one: the run is superseded, so
     * the in-flight request is CANCELLED - and cancelling settles the caller
     * without stopping the tool, because a synchronous tool cannot be stopped
     * from the outside.
     *
     * That used to strand the worker. The request was forgotten, deadline and
     * all, so nothing was left that could ever destroy a thread still spinning
     * inside `RegExp.exec`, and the next run sat in a queue that would not move
     * until the pattern happened to give up by itself - with the main thread
     * idle and the node saying `Running`. Measured on the version without the
     * fix: 10.8s in WebKit and 4.1s in Gecko, against 2.1s in both with it. The
     * bound for a tool that never returns at all is the waiting node's own
     * timeout, which is 15s here.
     *
     * The runaway node is DELETED rather than edited so that the next run has
     * no short deadline of its own to rescue it - that is the difference
     * between measuring the engine and measuring the regex tool's two seconds.
     * The threshold is 10s for the same reason it is not 3s: it has to sit
     * clear of the 2.1s the fix produces and clear of the replacement worker's
     * boot, while still failing the 10.8s that the defect produced in the
     * slower of the two engines.
     */
    await page.goto(
      link(
        [
          [
            'n1',
            'regex-tester',
            0,
            0,
            {
              pattern: '((a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q|r|s|t|u|v|w|x|y|z)*)*!!',
              mode: 'match',
            },
          ],
          ['n2', 'base64', 0, 320, { mode: 'decode' }],
        ],
        [],
      ),
      { waitUntil: 'networkidle' },
    );
    await page.locator('[data-testid="node-n2"]').waitFor({ timeout: 15_000 });

    await typeInto('n1', `${'a'.repeat(40)}!`);
    const wedging = await untilStatus('n1', 'run', 10_000);
    check(
      label,
      'a runaway node reaches the worker before anything else happens to it',
      wedging === 'run',
      String(wedging),
    );

    // Escape leaves the editor and puts focus back on the node, which is where
    // Delete is handled - the canvas root never sees a key typed in the panel.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Delete');
    await page.locator('[data-testid="node-n1"]').waitFor({ state: 'detached', timeout: 10_000 });

    const editedAt = Date.now();
    await typeInto('n2', 'eyJuYW1lIjoiYWRhIn0=');
    const afterEdit = await untilStatus('n2', 'ok', 25_000);
    const afterEditMs = Date.now() - editedAt;

    check(
      label,
      'the run after a cancelled one is not left queued behind the worker it wedged',
      afterEdit === 'ok' && afterEditMs < 10_000,
      `${String(afterEdit)} after ${String(afterEditMs)}ms`,
    );
  } finally {
    await context.close();
  }
}

/* ========================================================================== *
 * A FILE AS A NODE'S INPUT
 * ========================================================================== */

/**
 * PUTTING A FILE ON THE CANVAS, IN A REAL ENGINE.
 *
 * The unit suite drives the whole feature and cannot see the three things that
 * decide whether it works for a person:
 *
 *   1. A REAL FILE PICKER. jsdom's `upload` fakes the change event; only
 *      `setInputFiles` against a real `<input type="file">` proves the control
 *      an engine actually renders is the one the app wired up. And the bytes
 *      then have to survive the worker boundary, which jsdom has no worker for.
 *
 *   2. A REAL DRAG AND DROP. jsdom has no `DataTransfer` carrying files, so the
 *      unit test dispatches an event with a hand-built one. What that cannot
 *      check is the thing the gesture is dangerous for: without a prevented
 *      `dragover` the BROWSER navigates to the dropped file and the app is
 *      gone. That is asserted here by watching the URL.
 *
 *   3. GEOMETRY AND A COARSE POINTER. The mobile audit found file controls
 *      under the 44px minimum, and the inspector is a new home for one - in a
 *      320px rail, which is the narrowest box in the app.
 *
 * The journey at the end is the one the feature exists for and could not be
 * started before it: drop a photo, convert it to WebP, hash the result.
 */
async function checkCanvasFileInput(browser, label) {
  const png = makePng(16);

  /** A wired graph with no data in it, which is all a link may carry. */
  const link = (nodes, edges) => `${ORIGIN}/?p=${shareParam({ v: 3, n: nodes, e: edges })}`;

  const statusOf = (page, id) =>
    page.evaluate(
      (nodeId) =>
        document.querySelector(`[data-testid="node-${nodeId}"] [class*="nodeFooter"] span`)
          ?.textContent ?? null,
      id,
    );

  const untilStatus = async (page, id, wanted, timeout) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const status = await statusOf(page, id);
      if (status === wanted || Date.now() > deadline) return status;
      await page.waitForTimeout(100);
    }
  };

  /* -- The picker, end to end through the real worker -------------------- */

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  try {
    await page.goto(link([['n1', 'image-convert', 0, 0, { format: 'image/webp' }]], []), {
      waitUntil: 'networkidle',
    });
    await page.locator('[data-testid="node-n1"]').waitFor({ timeout: 15_000 });

    /*
     * BLOCKED, AND THE SENTENCE OFFERS A FILE. This node's port takes bytes
     * only, so before there was a file control the summary read "Wire an
     * output into Image." - describing the half of the answer that could not
     * be reached, on the one tool where there was nothing else to try.
     */
    const guidance = await page.evaluate(
      () =>
        document.querySelector('[data-testid="node-n1"] [class*="nodeSummaryText"]')?.textContent ??
        '',
    );
    check(
      label,
      'a bytes-only node tells the user a file will do, not only a wire',
      guidance.includes('Add a file in the inspector'),
      JSON.stringify(guidance),
    );

    /*
     * ENTER ON THE NODE LANDS ON THE FILE CHOOSER. There is no editor to step
     * into here, so the key that means "step into this node's input" has to
     * mean the chooser instead - otherwise it silently does nothing on exactly
     * the node this feature exists for. Same task as the keystroke, which is
     * the property only a real engine can be held to.
     */
    await page.locator('[data-testid="node-n1"]').focus();
    await page.keyboard.press('Enter');
    const landed = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        onFile: active?.hasAttribute('data-file-input') ?? false,
        what: active?.getAttribute('aria-label') ?? active?.tagName ?? 'nothing',
      };
    });
    check(
      label,
      'Enter on a node with no text editor puts focus on its file chooser',
      landed.onFile,
      landed.what,
    );

    await page.locator('[data-testid="node-inspector"] input[type="file"]').setInputFiles({
      name: 'holiday.png',
      mimeType: 'image/png',
      buffer: png,
    });

    const converted = await untilStatus(page, 'n1', 'ok', 45_000);
    check(
      label,
      'a file chosen in the inspector runs the node through the real worker',
      converted === 'ok',
      String(converted),
    );

    /*
     * THE SNIFF, NOT THE EXTENSION. The file is named `.png` and declared
     * `image/png`, and what the node reports has to come from the bytes - so
     * this is checked against a file whose name LIES further down.
     */
    const summary = await page.evaluate(
      () =>
        document.querySelector('[data-testid="node-n1"] [class*="nodeSummaryText"]')?.textContent ??
        '',
    );
    /*
     * THE SNIFFED SUMMARY OF THE BYTES THE TOOL PRODUCED.
     *
     * A node summarises only its FIRST declared output, and `image-convert`'s
     * first output is the converted image rather than its report - so the
     * sentence is `584 B WebP image`: a size, and the label the SNIFF gives the
     * result. That is a better thing to assert than the report's prose, because
     * it proves the conversion happened AND that the label came from sniffing
     * the output rather than from the PNG that went in.
     *
     * The size is matched by shape rather than by value: WebP encoders
     * legitimately differ between engines - 102 B in Gecko against 584 B in
     * JavaScriptCore, measured.
     *
     * It replaces a NEGATIVE assertion ("the summary is not the guidance"),
     * which passed perfectly happily against `Those options are not valid for
     * this tool.` while the fixture above was passing a bare `webp` for a
     * media-type option. A negative assertion cannot tell a result from a
     * different failure.
     */
    check(
      label,
      'a converted node reports the sniffed summary of the bytes it produced',
      /^\d+(\.\d+)? (B|kB|MB) WebP image$/.test(summary.trim()),
      JSON.stringify(summary),
    );

    /* -- Reload: the name survives, the bytes do not ------------------- */

    /*
     * THE PERSISTENCE ANSWER, DRIVEN THROUGH A REAL PAGE LOAD. A file is
     * session state by design, so the document keeps its name and the node
     * says which file to go and find. jsdom can simulate this by clearing a
     * store; only a real reload proves the saved graph really carries the name
     * and really does not carry the bytes.
     */
    await page.waitForTimeout(900); // the graph save is debounced by 500ms
    const savedGraph = await page.evaluate(() => window.localStorage.getItem('patchbay:graph:v3'));
    check(
      label,
      'the saved canvas records the file name and not its contents',
      savedGraph !== null &&
        savedGraph.includes('holiday.png') &&
        !savedGraph.includes('iVBOR') &&
        !savedGraph.includes('IHDR'),
      savedGraph === null ? 'nothing saved' : `${String(savedGraph.length)} bytes saved`,
    );

    await gotoCanvas(page);
    await page.locator('[data-testid="node-n1"]').waitFor({ timeout: 15_000 });
    const afterReload = await untilStatus(page, 'n1', 'blocked', 20_000);
    const reloadSummary = await page.evaluate(
      () =>
        document.querySelector('[data-testid="node-n1"] [class*="nodeSummaryText"]')?.textContent ??
        '',
    );
    check(
      label,
      'a reloaded node names the file it needs again rather than looking empty',
      afterReload === 'blocked' && reloadSummary.includes('"holiday.png" needs choosing again'),
      `${String(afterReload)} - ${JSON.stringify(reloadSummary)}`,
    );

    /* -- The share link carries no filename ---------------------------- */

    /*
     * A filename is often the most revealing single string in a document, and
     * a link is something people paste into chat. Checked against the REAL URL
     * the app builds, because that is the artefact that leaves the machine.
     */
    await page.evaluate(() => {
      navigator.clipboard.writeText = () => Promise.resolve();
    });
    await page.getByRole('button', { name: /Share/i }).click();
    await page.waitForTimeout(500);
    const shareUrl = await page.evaluate(() => window.location.href);
    check(
      label,
      'a share link built from a canvas with a file carries no filename',
      !shareUrl.includes('holiday'),
      shareUrl.slice(0, 80),
    );
  } finally {
    await context.close().catch(() => {});
  }

  /* -- A real drop, and the navigation it must not cause ----------------- */

  const dropContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const dropPage = await dropContext.newPage();

  try {
    await dropPage.goto(link([['n1', 'image-convert', 0, 0, {}]], []), {
      waitUntil: 'networkidle',
    });
    await dropPage.locator('[data-testid="node-n1"]').waitFor({ timeout: 15_000 });
    const before = dropPage.url();

    const transfer = await dropPage.evaluateHandle(
      (bytes) => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(bytes)], 'dropped.png', { type: 'image/png' }));
        return data;
      },
      [...png],
    );

    const node = dropPage.locator('[data-testid="node-n1"]');
    await node.dispatchEvent('dragover', { dataTransfer: transfer });

    /*
     * THE DROP HIGHLIGHT. A drop target nothing marks is a guess, and it is a
     * guess the user gets wrong on overlapping nodes. Colour alone would not
     * do - the border STYLE changes too, which is the rule every state in this
     * app is held to - and a computed style is something only an engine has.
     *
     * POLLED, NOT READ ONCE, and that is a fix rather than a precaution. The
     * dragover above sets React state, and this used to read the computed style
     * one round trip later on the assumption that a render had happened in
     * between. It usually had: this passed in both engines three runs in a row
     * and then failed in WebKit alone, reporting the resting `solid 1px` -
     * which is not a defect in the highlight, it is a check racing a commit it
     * never waited for. The state stays set until a drop or a real dragleave,
     * so there is nothing to re-dispatch; there is only something to wait for.
     */
    const highlight = await (async () => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const style = await node.evaluate((el) => {
          const computed = getComputedStyle(el);
          return { style: computed.borderTopStyle, width: computed.borderTopWidth };
        });
        if (style.style === 'dashed' || Date.now() > deadline) return style;
        await dropPage.waitForTimeout(50);
      }
    })();
    check(
      label,
      'the node a file is dragged over is marked by more than its colour',
      highlight.style === 'dashed',
      `border ${highlight.style} ${highlight.width}`,
    );

    await node.dispatchEvent('drop', { dataTransfer: transfer });

    const dropped = await untilStatus(dropPage, 'n1', 'ok', 45_000);
    check(
      label,
      'a file dropped on a node with one free input runs it',
      dropped === 'ok',
      String(dropped),
    );

    /*
     * AND THE PAGE IS STILL THE APP. With no prevented `dragover` anywhere on
     * the route, a drop hands the file to the browser and the canvas is
     * replaced by a picture. That is what this route did before there was a
     * handler, and it is the one failure here that loses the user's work.
     */
    check(
      label,
      'dropping a file never navigates the browser away from the canvas',
      dropPage.url() === before &&
        (await dropPage.locator('[data-testid="node-n1"]').count()) === 1,
      dropPage.url() === before ? '' : `navigated to ${dropPage.url().slice(0, 60)}`,
    );

    /* -- Two ports, and the refusal to guess between them --------------- */
    await dropPage.goto(link([['n1', 'diff', 0, 0, {}]], []), { waitUntil: 'networkidle' });
    await dropPage.locator('[data-testid="node-n1"]').waitFor({ timeout: 15_000 });

    const textTransfer = await dropPage.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(['alpha'], 'left.txt', { type: 'text/plain' }));
      return data;
    });
    await dropPage
      .locator('[data-testid="node-n1"]')
      .dispatchEvent('drop', { dataTransfer: textTransfer });

    await dropPage.getByTestId('node-inspector').waitFor({ timeout: 10_000 });
    const named = await dropPage.evaluate(() =>
      [...document.querySelectorAll('[data-testid="node-inspector"] input[type="file"]')].map(
        (el) =>
          el.getAttribute('aria-label') ??
          document.querySelector(`label[for="${el.id}"]`)?.textContent ??
          '',
      ),
    );
    check(
      label,
      'a drop on a two-input node opens the inspector with both ports named',
      named.some((name) => name.includes('Original')) &&
        named.some((name) => name.includes('Changed')),
      JSON.stringify(named),
    );
  } finally {
    await dropContext.close().catch(() => {});
  }

  /* -- The whole journey the feature exists for -------------------------- */

  const journeyContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const journeyPage = await journeyContext.newPage();

  try {
    /*
     * DROP A PHOTO, CONVERT IT TO WEBP, HASH THE RESULT.
     *
     * The sentence this change was measured against, and it could not be
     * started at all before: `image-convert`'s only input takes bytes, so with
     * no file control there was nothing to type into and no wire that could
     * have come from anywhere.
     */
    await journeyPage.goto(
      link(
        [
          ['n1', 'image-convert', 0, 0, { format: 'image/webp' }],
          /*
           * MD5 rather than SHA-256, and the reason is the assertion below
           * rather than the algorithm: a node's summary is truncated to 60
           * characters, because it is also the node's accessible name and that
           * string is read from end to end. A SHA-256 in hex is 64. So a check
           * reading a digest off the NODE has to pick one that fits, or read it
           * from the inspector instead.
           */
          ['n2', 'hash', 360, 0, { algorithm: 'md5', encoding: 'hex' }],
        ],
        [['n1', 'output', 'n2', 'input']],
      ),
      { waitUntil: 'networkidle' },
    );
    await journeyPage.locator('[data-testid="node-n2"]').waitFor({ timeout: 15_000 });

    await journeyPage.locator('[data-testid="node-n1"]').focus();
    await journeyPage.keyboard.press('Enter');
    await journeyPage
      .locator('[data-testid="node-inspector"] input[type="file"]')
      .setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png });

    const hashed = await untilStatus(journeyPage, 'n2', 'ok', 60_000);
    const digest = await journeyPage.evaluate(
      () =>
        document.querySelector('[data-testid="node-n2"] [class*="nodeSummaryText"]')?.textContent ??
        '',
    );
    /*
     * The digest's SHAPE, not its value: WebP encoders differ between engines,
     * so the bytes being hashed are legitimately not the same in Gecko and
     * JavaScriptCore. What is asserted is that the chain carried real bytes all
     * the way through - an md5 of nothing at all has its own well-known value,
     * which is checked against explicitly.
     */
    check(
      label,
      'drop a photo, convert it to WebP, hash the result - the whole journey runs',
      hashed === 'ok' &&
        /^[0-9a-f]{32}$/.test(digest.trim()) &&
        digest.trim() !== 'd41d8cd98f00b204e9800998ecf8427e',
      `${String(hashed)} - ${JSON.stringify(digest.slice(0, 40))}`,
    );

    /*
     * ONE FILE, TWO CONSUMERS, THROUGH THE REAL BOUNDARY. Buffers are borrowed
     * rather than transferred precisely because a fan-out detaches the second
     * consumer, and a file is a second source of one buffer reaching several
     * tools. `fanout.test.ts` holds this for a wired output in jsdom; only here
     * does it cross a real `postMessage`.
     */
    await journeyPage.goto(
      link(
        [
          ['n1', 'hash', 0, 0, { algorithm: 'sha-1', encoding: 'hex' }],
          ['n2', 'hash', 360, 0, { algorithm: 'md5', encoding: 'hex' }],
        ],
        [],
      ),
      { waitUntil: 'networkidle' },
    );
    await journeyPage.locator('[data-testid="node-n2"]').waitFor({ timeout: 15_000 });

    for (const id of ['n1', 'n2']) {
      await journeyPage.locator(`[data-testid="node-${id}"]`).focus();
      await journeyPage.keyboard.press('Enter');
      await journeyPage
        .locator('[data-testid="node-inspector"] input[type="file"]')
        .setInputFiles({ name: 'shared.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
      await journeyPage.waitForTimeout(300);
    }

    const both = await Promise.all([
      untilStatus(journeyPage, 'n1', 'ok', 30_000),
      untilStatus(journeyPage, 'n2', 'ok', 30_000),
    ]);
    const digests = await journeyPage.evaluate(() =>
      ['n1', 'n2'].map(
        (id) =>
          document
            .querySelector(`[data-testid="node-${id}"] [class*="nodeSummaryText"]`)
            ?.textContent?.trim() ?? '',
      ),
    );
    /*
     * The two digests of "hi" under two algorithms. Compared to the KNOWN
     * values rather than to each other: two algorithms make equality prove
     * nothing, and a detached buffer hashes as the empty input, which has its
     * own well-known digest and would sail past a "both ran" assertion.
     */
    check(
      label,
      'one file feeding two nodes reaches both with intact bytes',
      both.every((status) => status === 'ok') &&
        digests[0] === 'c22b5f9178342609428d6f51b2c5af4c0bde6a42' &&
        digests[1] === '49f68a5c8493ec2c0bf489821c21fc3b',
      JSON.stringify(digests),
    );
  } finally {
    await journeyContext.close().catch(() => {});
  }
}

/**
 * A FILE CONTROL UNDER A FINGER, IN THE NARROWEST BOX IN THE APP.
 *
 * Takes the ENGINE rather than a browser, because a coarse pointer needs
 * `launchTouchBrowser` - Gecko only reports one when the prefs were set at
 * launch, for the cross-origin-isolation reason written down above.
 *
 * The mobile audit found file controls under the 44px minimum once already, and
 * the inspector is a new home for one: a 320px rail on a desktop, a sheet on a
 * phone, and the file summary is the widest single line this control draws.
 */
async function checkFileInputTouch(engine, label) {
  const browser = await launchTouchBrowser(engine);
  const link = (nodes, edges) => `${ORIGIN}/?p=${shareParam({ v: 3, n: nodes, e: edges })}`;

  const phone = await browser.newContext({
    viewport: { width: 390, height: 780 },
    hasTouch: true,
  });
  const phonePage = await phone.newPage();

  try {
    await phonePage.goto(link([['n1', 'diff', 0, 0, {}]], []), { waitUntil: 'networkidle' });
    await phonePage.locator('[data-testid="node-n1"]').waitFor({ timeout: 15_000 });

    await phonePage.locator('[data-testid="node-n1"]').focus();
    await phonePage.keyboard.press('Enter');
    await phonePage.getByTestId('node-inspector').waitFor({ timeout: 10_000 });
    await phonePage.waitForTimeout(300);

    /*
     * 44px, WCAG 2.5.5, AND THE MOBILE AUDIT ALREADY FOUND FILE CONTROLS UNDER
     * IT. The <label> rather than the <input>: the input is the control but it
     * is visually hidden, so the label is the whole of what a finger can aim
     * at. Measured on a COARSE pointer, because that is what the rule is about
     * - a narrow window on a laptop keeps the dense layout.
     */
    const targets = await phonePage.evaluate(() => {
      const panel = document.querySelector('[data-testid="node-inspector"]');
      if (!panel) return null;
      return [...panel.querySelectorAll('input[type="file"]')].map((input) => {
        const label = panel.querySelector(`label[for="${input.id}"]`);
        const box = label?.getBoundingClientRect();
        return {
          text: label?.textContent?.trim() ?? '(no label)',
          height: box ? Math.round(box.height) : 0,
          right: box ? Math.round(box.right) : 0,
        };
      });
    });
    check(
      label,
      'every file control in the inspector meets the 44px touch minimum',
      targets !== null && targets.length === 2 && targets.every((target) => target.height >= 44),
      JSON.stringify(targets),
    );

    /*
     * AND FITS. The rail is 320px at its narrowest and the sheet is 390px
     * here; a file summary is a filename, a sniffed label and a size on one
     * line, which is the widest thing this control ever draws.
     */
    await phonePage
      .locator('[data-testid="node-inspector"] input[type="file"]')
      .first()
      .setInputFiles({
        name: 'a-rather-long-file-name-from-a-camera-20260908.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('alpha\nbeta\n'),
      });
    await phonePage.waitForTimeout(600);

    const overflow = await phonePage.evaluate(() => {
      const panel = document.querySelector('[data-testid="node-inspector"]');
      const boxes = [...panel.querySelectorAll('[class*="dropZone"], [class*="fileSummary"]')].map(
        (el) => {
          const r = el.getBoundingClientRect();
          return { right: Math.round(r.right), overflows: el.scrollWidth > el.clientWidth + 1 };
        },
      );
      return {
        boxes,
        width: window.innerWidth,
        docScrollsSideways:
          document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    check(
      label,
      'a long filename stays inside the panel rather than widening the page',
      !overflow.docScrollsSideways &&
        overflow.boxes.length > 0 &&
        overflow.boxes.every((box) => box.right <= overflow.width + 1 && !box.overflows),
      JSON.stringify(overflow),
    );
  } finally {
    await phone.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/**
 * IMAGE CONVERSION, CHECKED ON THE PIXELS RATHER THAN ON THE BYTE COUNT.
 *
 * This is the tool where a passing test proves the least. Dimensions and a
 * non-zero length are easy to assert and are satisfied by an image that is
 * upside down, grey, black where it should be white, or one frame of twelve.
 * Every failure this tool has ever had is of that shape: output that is
 * plausible and wrong, which is the kind nobody reports.
 *
 * So each conversion here goes through the whole product - file input, real
 * worker or real main-thread fallback, real encoder - and then the OUTPUT IS
 * DECODED AGAIN IN THE PAGE and its pixels are compared with the colours that
 * went in. jsdom cannot do any of this: it has no decoder, no canvas and no
 * encoder, so the unit suite can only assert the drawing calls, never their
 * result.
 *
 * The two engines also split the work for free. Firefox has OffscreenCanvas
 * and takes the worker path; Playwright's WebKit has none and is downgraded to
 * the main thread. Running the identical pixel assertions in both is what
 * turns "the fallback produces an identical result" from a claim in the README
 * into something asserted.
 */
async function checkImageConvert(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  // The output port hands its bytes to `URL.createObjectURL` on Download, and
  // that is the only place the finished file is reachable from outside the
  // app. Wrapping it is less invasive than driving a real download and works
  // the same way in both engines.
  await context.addInitScript(() => {
    const original = URL.createObjectURL.bind(URL);
    window.__lastBlob = null;
    URL.createObjectURL = (blob) => {
      window.__lastBlob = blob;
      return original(blob);
    };
  });

  const page = await context.newPage();

  try {
    await page.goto(`${ORIGIN}/tools/image-convert`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1, name: 'Image' }).waitFor({ timeout: 15_000 });

    /* -- Driving the tool ------------------------------------------------- */

    /*
     * Every option is set on every run, and the page is reloaded before each
     * one. Both halves were learned the hard way: options persist for the life
     * of the page, so a `maxEdge` left over from the resize check silently
     * shrank the images in the quality check - and the previous run's report
     * is still on screen, so "wait for a report" returned the last one and two
     * checks passed against the wrong conversion entirely.
     */
    const setOptions = async ({ format = 'WebP', quality = 0.85, maxEdge = 0 }) => {
      // Quality before format: the field is hidden while the target is PNG,
      // because a PNG encoder ignores it. A hidden field keeps its value, so
      // setting it first still reaches the tool - and this ordering is itself
      // the check that the value survives being hidden.
      await page.getByLabel('Quality').fill(String(quality));
      await page.getByLabel('Longest edge (pixels)').fill(String(maxEdge));
      await page.getByLabel('Convert to').click();
      await page.getByRole('option', { name: format, exact: true }).click();
    };

    /**
     * Uploads a file, runs, and returns the report plus the encoded output.
     *
     * `outcome` is 'ok' or 'error'; an expected failure returns the rendered
     * message instead of waiting forever for a result that is not coming.
     */
    const run = async (file, options = {}, outcome = 'ok') => {
      await page.goto(`${ORIGIN}/tools/image-convert`, { waitUntil: 'networkidle' });
      await page.getByRole('heading', { level: 1, name: 'Image' }).waitFor({ timeout: 15_000 });
      await page.evaluate(() => {
        window.__lastBlob = null;
      });
      await page.locator('input[type="file"]').setInputFiles(file);
      await setOptions(options);

      const started = Date.now();
      await page.getByRole('button', { name: 'Run' }).click();

      if (outcome === 'error') {
        const report = page.locator('p', { hasText: 'Code:' }).first();
        await report.waitFor({ timeout: 30_000 });
        return {
          elapsed: Date.now() - started,
          code: (await report.textContent()) ?? '',
          message:
            (await page.locator('p', { hasText: 'larger than' }).first().textContent()) ?? '',
        };
      }

      // The report's Raw toggle; see the note in runChecks. The button only
      // exists once a report has been drawn, so waiting for it is also the
      // wait for the run to finish.
      await page.getByRole('button', { name: 'Raw' }).click({ timeout: 30_000 });
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('textarea[readonly]')].some((box) =>
            box.value.includes('changePercent'),
          ),
        undefined,
        { timeout: 30_000 },
      );

      const report = await page.evaluate(() => {
        const box = [...document.querySelectorAll('textarea[readonly]')].find((candidate) =>
          candidate.value.includes('changePercent'),
        );
        return box ? JSON.parse(box.value) : null;
      });

      await page.getByRole('button', { name: 'Download' }).first().click();
      const encoded = await page.evaluate(async () => {
        const blob = window.__lastBlob;
        if (!blob) return null;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
      });

      return { elapsed: Date.now() - started, report, encoded };
    };

    /** Decodes an encoded output back to pixels, in the page. */
    const pixelsOf = (encoded, points) =>
      page.evaluate(
        async ([data, wanted]) => {
          const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([bytes]));
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const context2d = canvas.getContext('2d');
          context2d.drawImage(bitmap, 0, 0);
          const data2d = context2d.getImageData(0, 0, bitmap.width, bitmap.height).data;
          const at = wanted.map(([x, y]) => {
            const index = (y * bitmap.width + x) * 4;
            return [data2d[index], data2d[index + 1], data2d[index + 2], data2d[index + 3]];
          });
          // Whole-image extremes, for the aliasing check.
          let min = 255;
          let max = 0;
          for (let index = 0; index < data2d.length; index += 4) {
            min = Math.min(min, data2d[index]);
            max = Math.max(max, data2d[index]);
          }
          return { width: bitmap.width, height: bitmap.height, at, min, max };
        },
        [encoded, points],
      );

    const asBytes = (encoded) => Buffer.from(encoded, 'base64');
    const distance = (got, want) =>
      Math.max(Math.abs(got[0] - want[0]), Math.abs(got[1] - want[1]), Math.abs(got[2] - want[2]));

    /* -- 1. A lossless round trip must be pixel-exact --------------------- */

    const swatch = { name: 'swatch.png', mimeType: 'image/png', buffer: makeSwatchPng() };
    const centres = SWATCH_COLOURS.map((_, index) => [
      (index % 4) * 4 + 1,
      Math.floor(index / 4) * 4 + 1,
    ]);

    const toPng = await run(swatch, { format: 'PNG (lossless)' });
    const pngPixels = await pixelsOf(toPng.encoded, centres);
    const pngWorst = Math.max(
      ...pngPixels.at.map((got, index) => distance(got, SWATCH_COLOURS[index])),
    );
    check(
      label,
      'a PNG round trip reproduces every colour exactly',
      pngWorst === 0 && pngPixels.width === 16,
      `worst channel error ${String(pngWorst)}, ${String(pngPixels.width)}x${String(pngPixels.height)}`,
    );

    /* -- 2. And a lossy one must be close ---------------------------------- */

    const toWebp = await run(swatch, { format: 'WebP', quality: 1 });
    const webpPixels = await pixelsOf(toWebp.encoded, centres);
    const webpWorst = Math.max(
      ...webpPixels.at.map((got, index) => distance(got, SWATCH_COLOURS[index])),
    );
    check(
      label,
      'a WebP conversion keeps every colour within a few levels',
      webpWorst <= 8,
      `worst channel error ${String(webpWorst)}`,
    );

    const toJpeg = await run(swatch, { format: 'JPEG', quality: 0.95 });
    const jpegPixels = await pixelsOf(toJpeg.encoded, centres);
    const jpegWorst = Math.max(
      ...jpegPixels.at.map((got, index) => distance(got, SWATCH_COLOURS[index])),
    );
    check(
      label,
      'a JPEG conversion keeps every colour within a visible threshold',
      jpegWorst <= 16,
      `worst channel error ${String(jpegWorst)}`,
    );

    /* -- 3. Transparency, which is the classic silent ruin ---------------- */

    const transparent = {
      name: 'logo.png',
      mimeType: 'image/png',
      buffer: makeTransparentPng(),
    };

    const flattened = await run(transparent, { format: 'JPEG', quality: 0.95 });
    const flatPixels = await pixelsOf(flattened.encoded, [
      [1, 1],
      [6, 1],
    ]);
    const wasTransparent = flatPixels.at[1];
    check(
      label,
      'transparency converted to JPEG becomes white, not black',
      wasTransparent[0] >= 245 && wasTransparent[1] >= 245 && wasTransparent[2] >= 245,
      `the transparent half came back rgb(${wasTransparent.slice(0, 3).join(', ')})`,
    );
    check(
      label,
      'the opaque half of the same image is unharmed',
      distance(flatPixels.at[0], [230, 30, 30]) <= 16,
      `rgb(${flatPixels.at[0].slice(0, 3).join(', ')})`,
    );
    check(
      label,
      'and the tool says it flattened the transparency',
      (flattened.report?.summary ?? '').includes('Transparency') &&
        (flattened.report?.notes ?? []).some((note) => note.level === 'warn'),
      flattened.report?.summary ?? 'no summary',
    );

    const kept = await run(transparent, { format: 'WebP', quality: 1 });
    const keptPixels = await pixelsOf(kept.encoded, [[6, 1]]);
    check(
      label,
      'transparency converted to WebP survives',
      keptPixels.at[0][3] === 0,
      `alpha ${String(keptPixels.at[0][3])}`,
    );

    /* -- 4. EXIF orientation, and the metadata that goes with it ---------- */

    /*
     * A photograph off a phone: upright pixels, a flag saying rotate 90
     * clockwise, GPS coordinates and a comment. The source is 4 wide and 2
     * tall with a red left half; displayed correctly it is 2 wide and 4 tall
     * with a red TOP half. An implementation that drops the flag and keeps the
     * pixels hands back a sideways photograph - and one that keeps the flag
     * while re-encoding through a canvas rotates it twice.
     */
    const baseJpeg = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 4;
      canvas.height = 2;
      const context2d = canvas.getContext('2d');
      context2d.fillStyle = 'rgb(230, 30, 30)';
      context2d.fillRect(0, 0, 2, 2);
      context2d.fillStyle = 'rgb(40, 70, 220)';
      context2d.fillRect(2, 0, 2, 2);
      const blob = await new Promise((resolve) => {
        canvas.toBlob(resolve, 'image/jpeg', 1);
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    });

    const rotated = {
      name: 'holiday.jpg',
      mimeType: 'image/jpeg',
      buffer: withExif(Buffer.from(baseJpeg, 'base64'), 6),
    };

    const upright = await run(rotated, { format: 'PNG (lossless)' });
    const uprightPixels = await pixelsOf(upright.encoded, [
      [0, 0],
      [0, 3],
    ]);
    check(
      label,
      'a sideways photograph is written upright, with its axes swapped',
      uprightPixels.width === 2 && uprightPixels.height === 4,
      `${String(uprightPixels.width)}x${String(uprightPixels.height)}`,
    );
    check(
      label,
      'and the rotation is applied in the right direction',
      distance(uprightPixels.at[0], [230, 30, 30]) <= 24 &&
        distance(uprightPixels.at[1], [40, 70, 220]) <= 24,
      `top rgb(${uprightPixels.at[0].slice(0, 3).join(', ')}), bottom rgb(${uprightPixels.at[1].slice(0, 3).join(', ')})`,
    );
    check(
      label,
      'the reported dimensions agree with the file that was produced',
      upright.report?.to?.width === uprightPixels.width &&
        upright.report.to.height === uprightPixels.height,
      `report ${String(upright.report?.to?.width)}x${String(upright.report?.to?.height)}`,
    );

    /*
     * THE PRIVACY ONE. Nothing in the output may carry the EXIF block, the GPS
     * pointer or the comment that went in. This is asserted on the actual
     * bytes rather than on a promise in a README: someone about to share a
     * photograph is entitled to more than a sentence.
     */
    const uprightBytes = asBytes(upright.encoded);
    const latin = uprightBytes.toString('latin1');
    check(
      label,
      'no EXIF, GPS or comment survives into the output',
      !latin.includes('Exif') && !latin.includes('patchbay-secret-comment'),
      `${String(uprightBytes.length)} bytes out`,
    );
    check(
      label,
      'and the tool named what it removed',
      (upright.report?.from?.metadata ?? []).includes('GPS location') &&
        (upright.report?.to?.metadata ?? []).length === 0,
      JSON.stringify(upright.report?.from?.metadata ?? null),
    );

    /* -- 5. Animation, flattened but not silently -------------------------- */

    const animated = { name: 'loop.gif', mimeType: 'image/gif', buffer: makeAnimatedGif() };
    const still = await run(animated, { format: 'PNG (lossless)' });
    const stillPixels = await pixelsOf(still.encoded, [[1, 1]]);
    check(
      label,
      'an animated GIF converts to its first frame',
      distance(stillPixels.at[0], [230, 30, 30]) <= 8,
      `rgb(${stillPixels.at[0].slice(0, 3).join(', ')})`,
    );
    check(
      label,
      'and the user is told the other frames were discarded',
      (still.report?.summary ?? '').includes('first frame') && still.report?.from?.frames === 2,
      still.report?.summary ?? 'no summary',
    );

    /* -- 6. A large downscale must average, not sample -------------------- */

    /*
     * 512 columns of alternating black and white, reduced to 64. Averaged, the
     * result is uniform mid-grey. Point-sampled, it is stripes or a solid
     * block - an image that looks fine in a thumbnail and is wrong. Measured
     * on both engines this passes at imageSmoothingQuality 'low' too; the
     * assertion exists so that a future change which breaks it is noticed.
     */
    const stripes = { name: 'stripes.png', mimeType: 'image/png', buffer: makeStripesPng() };
    const shrunk = await run(stripes, { format: 'PNG (lossless)', maxEdge: 64 });
    const shrunkPixels = await pixelsOf(shrunk.encoded, [[32, 4]]);
    check(
      label,
      'an 8x downscale averages the detail away instead of aliasing it',
      shrunkPixels.width === 64 && shrunkPixels.min >= 110 && shrunkPixels.max <= 145,
      `${String(shrunkPixels.width)}px wide, luma range ${String(shrunkPixels.min)}-${String(shrunkPixels.max)}`,
    );

    /* -- 7. A bomb, refused before it can be decoded ---------------------- */

    /*
     * 48 kB of PNG that decodes to 20000x20000, which is 1.6 GB of RGBA.
     * Measured in this harness: `createImageBitmap` completes SUCCESSFULLY on
     * it in about 2000 ms in both engines - so a guard reading `bitmap.width`
     * has already paid for the attack it is preventing. The tool reads the
     * IHDR instead, and the elapsed time is the only observable proof of that:
     * the threshold below is a third of the measured decode, and a run that
     * decoded first cannot come in under it.
     */
    const bomb = { name: 'bomb.png', mimeType: 'image/png', buffer: makeBombPng(20_000) };
    const refused = await run(bomb, { format: 'WebP' }, 'error');
    check(
      label,
      'a decompression bomb is refused',
      refused.code.includes('limit-exceeded'),
      refused.code.trim(),
    );
    check(
      label,
      'and refused from its header, before the decoder is given a chance',
      refused.elapsed < 700,
      `${String(refused.elapsed)} ms, against ~2000 ms for the decode alone`,
    );

    /* -- 8. Two real files, which synthetic fixtures cannot stand in for -- */

    /*
     * A 1200x630 screenshot and a 512x512 logo, both real, both RGBA, both
     * written by a real encoder across several IDAT chunks. Two things here
     * are not testable with a fixture built for the occasion.
     *
     * The header parser now DECIDES WHETHER A FILE IS OPENED AT ALL, so a
     * parser that misreads a real file refuses a real photograph. A file built
     * by the same code that parses it cannot catch that; these were written by
     * a browser and by Playwright.
     *
     * And both declare an alpha channel that neither uses, which is what every
     * screenshot saved as RGBA looks like. Warning that their transparency was
     * flattened would be false, and false warnings are how a true one gets
     * ignored.
     */
    const realFiles = [
      ['social-preview.png', 1200, 630],
      ['icon-512.png', 512, 512],
    ];

    for (const [name, width, height] of realFiles) {
      const real = {
        name,
        mimeType: 'image/png',
        buffer: await readFile(join(ROOT, 'public', name)),
      };
      const converted = await run(real, { format: 'JPEG', quality: 0.8 });
      check(
        label,
        `the header parser reads ${name} the way its encoder wrote it`,
        converted.report?.from?.width === width && converted.report.from.height === height,
        `${String(converted.report?.from?.width)}x${String(converted.report?.from?.height)}, expected ${String(width)}x${String(height)}`,
      );
      check(
        label,
        `an opaque RGBA ${name} is not warned about for transparency it never had`,
        converted.report?.from?.hasAlpha === false &&
          !(converted.report.summary ?? '').includes('Transparency'),
        converted.report?.summary ?? 'no summary',
      );
    }

    // And a real one through the resizer, at a ratio a thumbnail would use.
    const logo = {
      name: 'icon-512.png',
      mimeType: 'image/png',
      buffer: await readFile(join(ROOT, 'public', 'icon-512.png')),
    };
    const thumbnail = await run(logo, { format: 'WebP', quality: 0.8, maxEdge: 96 });
    const thumbnailPixels = await pixelsOf(thumbnail.encoded, [[48, 48]]);
    check(
      label,
      'a real logo resized to a thumbnail comes out the size it was asked for',
      thumbnailPixels.width === 96 &&
        thumbnailPixels.height === 96 &&
        thumbnail.report.to.width === 96,
      `${String(thumbnailPixels.width)}x${String(thumbnailPixels.height)}`,
    );

    /* -- 8. Quality means something, and means nothing for PNG ------------ */

    const photo = { name: 'photo.png', mimeType: 'image/png', buffer: makeStripesPng() };
    const low = await run(photo, { format: 'JPEG', quality: 0.3, maxEdge: 0 });
    const high = await run(photo, { format: 'JPEG', quality: 0.95, maxEdge: 0 });
    check(
      label,
      'a lower JPEG quality produces a smaller file',
      low.report.to.bytes < high.report.to.bytes,
      `${String(low.report.to.bytes)} B at 0.3 against ${String(high.report.to.bytes)} B at 0.95`,
    );

    const pngLow = await run(photo, { format: 'PNG (lossless)', quality: 0.3, maxEdge: 0 });
    const pngHigh = await run(photo, { format: 'PNG (lossless)', quality: 0.95, maxEdge: 0 });
    check(
      label,
      'PNG ignores quality, and says so rather than pretending',
      pngLow.report.to.bytes === pngHigh.report.to.bytes &&
        (pngLow.report.notes ?? []).some((note) => note.title.includes('Quality does not apply')),
      `${String(pngLow.report.to.bytes)} B at both`,
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/* ========================================================================== */

/**
 * A TINY MP4, BUILT HERE, CONVERTED IN A REAL WORKER.
 *
 * The feasibility investigation's own rule for testing this feature: a
 * conversion's correctness does not need a long conversion. Every seam in the
 * tool - the file input, the size guard, the worker protocol, the port, the
 * bytes view, the download - is exercised by a file of a few hundred bytes,
 * and every seam bug this repository has ever found has been in the plumbing
 * rather than in the format code.
 *
 * The fixture is built by hand HERE rather than imported from the tool's own
 * fixtures, and deliberately in the layout the tool's writer never emits:
 * `mdat` before `moov`, and a 32-bit `stco`. A file produced by the code under
 * test proves the code agrees with itself and nothing more.
 *
 * WHAT THIS CANNOT SAY is whether the result plays. That needs a person and a
 * player, and it is in docs/manual-checks.md. What it can say - and does - is
 * that the compressed frames come out byte for byte, which is the property a
 * player would be checking on our behalf.
 */
function makeTinyMp4() {
  const b = (value, width) => {
    const out = [];
    let rest = value;
    for (let index = 0; index < width; index += 1) {
      out.unshift(rest % 256);
      rest = Math.floor(rest / 256);
    }
    return out;
  };
  const tag = (text) => [...text].map((character) => character.charCodeAt(0));
  const box = (type, ...parts) => {
    const body = parts.flat();
    return [...b(8 + body.length, 4), ...tag(type), ...body];
  };
  const full = (type, version, flags, ...parts) => box(type, [version], b(flags, 3), ...parts);
  const matrix = [
    ...b(0x00010000, 4),
    ...b(0, 4),
    ...b(0, 4),
    ...b(0, 4),
    ...b(0x00010000, 4),
    ...b(0, 4),
    ...b(0, 4),
    ...b(0, 4),
    ...b(0x40000000, 4),
  ];

  // Three samples with a signature run in each, so a frame that moved or was
  // zeroed can be told apart from one that survived.
  const samples = [0, 1, 2].map((index) =>
    Array.from({ length: 24 }, (_, at) => (index * 31 + at * 7 + 11) & 0xff),
  );

  const ftyp = box('ftyp', tag('isom'), b(0x200, 4), tag('mp41'));
  const media = samples.flat();
  const mdat = box('mdat', media);
  const firstSample = ftyp.length + 8;

  const stbl = box(
    'stbl',
    full(
      'stsd',
      0,
      0,
      b(1, 4),
      box(
        'avc1',
        new Array(6).fill(0),
        b(1, 2),
        new Array(16).fill(0),
        b(64, 2),
        b(48, 2),
        b(0x00480000, 4),
        b(0x00480000, 4),
        b(0, 4),
        b(1, 2),
        new Array(32).fill(0),
        b(0x0018, 2),
        b(0xffff, 2),
        box('avcC', [0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x02, 0x67, 0x64, 0x01, 0x00, 0x00]),
      ),
    ),
    full('stts', 0, 0, b(1, 4), b(3, 4), b(40, 4)),
    full('stsc', 0, 0, b(1, 4), b(1, 4), b(3, 4), b(1, 4)),
    full('stsz', 0, 0, b(0, 4), b(3, 4), b(24, 4), b(24, 4), b(24, 4)),
    // The 32-bit table, one chunk holding all three samples.
    full('stco', 0, 0, b(1, 4), b(firstSample, 4)),
  );

  const trak = box(
    'trak',
    full(
      'tkhd',
      0,
      7,
      b(0, 4),
      b(0, 4),
      b(1, 4),
      b(0, 4),
      b(120, 4),
      new Array(8).fill(0),
      b(0, 2),
      b(0, 2),
      b(0, 2),
      b(0, 2),
      matrix,
      b(64 * 0x10000, 4),
      b(48 * 0x10000, 4),
    ),
    box(
      'mdia',
      full('mdhd', 0, 0, b(0, 4), b(0, 4), b(1000, 4), b(120, 4), b(0x55c4, 2), b(0, 2)),
      full('hdlr', 0, 0, b(0, 4), tag('vide'), new Array(12).fill(0), tag('Harness'), [0]),
      box(
        'minf',
        full('vmhd', 0, 1, b(0, 2), b(0, 2), b(0, 2), b(0, 2)),
        box('dinf', full('dref', 0, 0, b(1, 4), full('url ', 0, 1))),
        stbl,
      ),
    ),
  );

  const moov = box(
    'moov',
    full(
      'mvhd',
      0,
      0,
      // A non-zero creation time: a real record of when the camera was
      // running, which the repackage is expected to report as removed.
      b(3_800_000_000, 4),
      b(0, 4),
      b(1000, 4),
      b(120, 4),
      b(0x00010000, 4),
      b(0x0100, 2),
      b(0, 2),
      new Array(8).fill(0),
      matrix,
      new Array(24).fill(0),
      b(2, 4),
    ),
    trak,
  );

  return { bytes: Buffer.from([...ftyp, ...mdat, ...moov]), media: Buffer.from(media) };
}

/**
 * A TINY MPEG TRANSPORT STREAM, BUILT HERE, RE-FRAMED IN A REAL WORKER.
 *
 * This exists for one thing the MP4 fixture above cannot reach. Repackaging an
 * MP4 or a Matroska file copies each sample as a contiguous run of the input;
 * a transport stream has no such run, so its reader ASSEMBLES - it gathers a
 * frame out of the packets carrying it, rewrites the Annex B framing into
 * length prefixes, and hands the writer a buffer of its own.
 *
 * That is a second code path through the worker boundary, and it is the one
 * that allocates. It is also where the picture size comes from: a transport
 * stream states none anywhere, so 640 by 480 in the report below is the
 * sequence parameter set having been read bit by bit, in this engine, through
 * exponential-Golomb codes. A `tkhd` of 0 by 0 plays perfectly in a desktop
 * player and occupies no space in a browser, which is exactly the sort of
 * failure only a real engine can be asked about.
 *
 * The parameter sets are the bytes the tool's own fixtures produce, quoted
 * here rather than imported: this script drives the built application and has
 * no access to the source tree it was built from.
 */
function makeTinyTs() {
  const SPS = [0x67, 0x42, 0x00, 0x1e, 0xda, 0x02, 0x80, 0xf6, 0x40];
  const PPS = [0x68, 0xce, 0x3c, 0x80];
  // One IDR slice with distinguishable contents and no two consecutive zeros,
  // so nothing in it can be mistaken for a start code.
  const idr = [0x65];
  for (let index = 0; index < 400; index += 1) idr.push((index * 7 + 11) & 0xff);

  const startCode = [0, 0, 0, 1];
  const accessUnit = [...startCode, ...SPS, ...startCode, ...PPS, ...startCode, ...idr];

  /** A PSI section: table id, a 12-bit length, the body, then a zero CRC. */
  const section = (tableId, body) => {
    const length = body.length + 4;
    return [tableId, 0xb0 | ((length >> 8) & 0x0f), length & 0xff, ...body, 0, 0, 0, 0];
  };

  const PMT_PID = 0x1000;
  const VIDEO_PID = 0x0100;

  const pat = section(0x00, [
    0x00,
    0x01, // transport_stream_id
    0xc1, // version 0, current
    0x00,
    0x00,
    0x00,
    0x01, // programme 1
    0xe0 | ((PMT_PID >> 8) & 0x1f),
    PMT_PID & 0xff,
  ]);

  const pmt = section(0x02, [
    0x00,
    0x01, // programme number
    0xc1,
    0x00,
    0x00,
    0xe0 | 0x10,
    0x00, // PCR pid
    0xf0,
    0x00, // no programme descriptors
    0x1b, // stream type: H.264
    0xe0 | ((VIDEO_PID >> 8) & 0x1f),
    VIDEO_PID & 0xff,
    0xf0,
    0x00, // no stream descriptors
  ]);

  /** A 33-bit timestamp in the five-byte form a PES header uses. */
  const stamp = (prefix, value) => [
    (prefix << 4) | ((Math.floor(value / 2 ** 30) & 0x07) << 1) | 1,
    Math.floor(value / 2 ** 22) & 0xff,
    ((Math.floor(value / 2 ** 15) & 0x7f) << 1) | 1,
    Math.floor(value / 2 ** 7) & 0xff,
    ((value & 0x7f) << 1) | 1,
  ];

  const pes = [
    0,
    0,
    1,
    0xe0, // video stream id
    0,
    0, // a declared length of zero, which is what a video PES writes
    0x80,
    0xc0, // both timestamps present
    10,
    ...stamp(3, 0),
    ...stamp(1, 0),
    ...accessUnit,
  ];

  /*
   * The packets, each padded to 188 bytes with a stuffing adaptation field -
   * which is what a real muxer writes for the tail of every frame, and the
   * shape a reader skipping the field by the wrong amount gets wrong.
   */
  const packets = [];
  const emit = (pid, payload) => {
    let at = 0;
    let first = true;
    while (at < payload.length) {
      const take = Math.min(184, payload.length - at);
      const stuffing = 184 - take;
      const packet = [
        0x47,
        (first ? 0x40 : 0) | ((pid >> 8) & 0x1f),
        pid & 0xff,
        (stuffing > 0 ? 0x30 : 0x10) | (packets.length & 0x0f),
      ];
      if (stuffing === 1) packet.push(0);
      else if (stuffing > 1) {
        packet.push(stuffing - 1, 0x00);
        for (let index = 0; index < stuffing - 2; index += 1) packet.push(0xff);
      }
      packet.push(...payload.slice(at, at + take));
      packets.push(...packet);
      at += take;
      first = false;
    }
  };

  emit(0, [0x00, ...pat]);
  emit(PMT_PID, [0x00, ...pmt]);
  emit(VIDEO_PID, pes);

  return { bytes: Buffer.from(packets), slice: Buffer.from(idr) };
}

async function checkVideoRemux(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  // The output port hands its bytes to `URL.createObjectURL` on Download, and
  // that is the only place the finished file is reachable from outside the
  // app. The same wrapper the image check uses.
  await context.addInitScript(() => {
    const original = URL.createObjectURL.bind(URL);
    window.__lastBlob = null;
    URL.createObjectURL = (blob) => {
      window.__lastBlob = blob;
      return original(blob);
    };
  });

  const page = await context.newPage();
  const fixture = makeTinyMp4();

  try {
    const run = async (file, operation, outcome = 'ok') => {
      await page.goto(`${ORIGIN}/tools/video-remux`, { waitUntil: 'networkidle' });
      await page.getByRole('heading', { level: 1, name: 'Video' }).waitFor({ timeout: 15_000 });
      await page.evaluate(() => {
        window.__lastBlob = null;
      });
      await page.locator('input[type="file"]').setInputFiles(file);
      await page.getByLabel('Operation').click();
      await page.getByRole('option', { name: operation, exact: true }).click();

      const started = Date.now();
      await page.getByRole('button', { name: 'Run' }).click();

      if (outcome === 'error') {
        const code = page.locator('p', { hasText: 'Code:' }).first();
        await code.waitFor({ timeout: 30_000 });
        return { elapsed: Date.now() - started, code: (await code.textContent()) ?? '' };
      }

      await page.getByRole('button', { name: 'Raw' }).click({ timeout: 30_000 });
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('textarea[readonly]')].some((field) =>
            field.value.includes('"summary"'),
          ),
        undefined,
        { timeout: 30_000 },
      );

      const report = await page.evaluate(() => {
        const field = [...document.querySelectorAll('textarea[readonly]')].find((candidate) =>
          candidate.value.includes('"summary"'),
        );
        return field ? JSON.parse(field.value) : null;
      });

      await page.getByRole('button', { name: 'Download' }).first().click();
      const encoded = await page.evaluate(async () => {
        const blob = window.__lastBlob;
        if (!blob) return null;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
      });

      return { elapsed: Date.now() - started, report, encoded };
    };

    /* -- 1. A repackage, in a real worker --------------------------------- */

    const file = { name: 'clip.mp4', mimeType: 'video/mp4', buffer: fixture.bytes };
    const done = await run(file, 'Repackage as MP4');
    const out = Buffer.from(done.encoded ?? '', 'base64');

    check(
      label,
      'a video is repackaged through the worker and comes back',
      out.length > 0 && done.report?.to?.format === 'MP4 · H.264',
      `${String(out.length)} bytes, ${String(done.report?.to?.format)}`,
    );

    /*
     * THE ASSERTION THE WHOLE TOOL RESTS ON. Not "the file is well formed" - a
     * file whose index is immaculate and whose offsets are four bytes out is
     * well formed and is noise - but that the compressed frames in it are the
     * ones that went in.
     */
    check(
      label,
      'and every compressed frame in it is the one that went in',
      out.includes(fixture.media),
      out.includes(fixture.media) ? 'all three frames byte-identical' : 'the media did not survive',
    );

    check(
      label,
      'the index is written in front of the media, which the source was not',
      out.indexOf('moov') > 0 && out.indexOf('moov') < out.indexOf('mdat'),
      `moov at ${String(out.indexOf('moov'))}, mdat at ${String(out.indexOf('mdat'))}`,
    );

    /*
     * The privacy claim, asserted on the bytes. The source carries a real
     * recording timestamp in `mvhd`; the output must say it removed it and
     * must not have carried it.
     */
    check(
      label,
      'the recording date is reported as removed, and is not in the output',
      (done.report?.from?.metadata ?? []).includes('Recording date') &&
        (done.report?.to?.metadata ?? []).length === 0,
      JSON.stringify(done.report?.from?.metadata ?? null),
    );

    /*
     * Time is the reason this feature was cut down to a remuxer at all. The
     * investigation measured 284 seconds for a one-minute 1080p transcode and
     * 0.2 seconds for the same clip remuxed. This fixture is a few hundred
     * bytes, so the number below is worker boot and a round trip rather than
     * the work - and it is asserted because a regression that reintroduced a
     * decode would show up here and nowhere else.
     */
    check(
      label,
      'a repackage costs a round trip rather than a conversion',
      done.elapsed < 5000,
      `${String(done.elapsed)} ms end to end, including worker boot`,
    );

    /* -- 2. The refusal, where a person will actually meet one ------------ */

    const notVideo = {
      name: 'notes.mp4',
      mimeType: 'video/mp4',
      buffer: Buffer.from('this is not a video, whatever it has been called', 'utf8'),
    };
    const refused = await run(notVideo, 'Repackage as MP4', 'error');
    check(
      label,
      'a file that is not a video is refused whatever its name says',
      refused.code.includes('unsupported-type'),
      refused.code.trim(),
    );

    /* -- 3. Audio, on a file that has none -------------------------------- */

    const noAudio = await run(file, 'Extract the audio track', 'error');
    check(
      label,
      'extracting audio from a file with none says so rather than producing nothing',
      noAudio.code.includes('invalid-input'),
      noAudio.code.trim(),
    );

    /* -- 4. A transport stream, which is the assembling path -------------- */

    /*
     * A SECOND CODE PATH THROUGH THE SAME BOUNDARY, and the reason it is worth
     * a real engine rather than only a unit test.
     *
     * The MP4 above is copied: each sample is a contiguous run of the input,
     * and the writer reads straight out of the bytes the worker was handed. A
     * transport stream has no such run - one picture is spread across the
     * packets carrying it - so its reader gathers the frame, rewrites the
     * Annex B framing into length prefixes, and hands the writer a buffer of
     * its own. That is an allocation inside the worker, in a shape the other
     * three containers never take.
     */
    const stream = makeTinyTs();
    const streamFile = { name: 'capture.ts', mimeType: 'video/mp2t', buffer: stream.bytes };
    const remuxed = await run(streamFile, 'Repackage as MP4');
    const streamOut = Buffer.from(remuxed.encoded ?? '', 'base64');

    check(
      label,
      'a transport stream is assembled into an MP4 through the worker',
      streamOut.length > 0 && remuxed.report?.to?.format === 'MP4 · H.264',
      `${String(streamOut.length)} bytes, ${String(remuxed.report?.to?.format)}`,
    );

    /*
     * THE PICTURE SIZE, WHICH IS THE ONE THING ONLY A BROWSER CAN BE WRONG
     * ABOUT. A transport stream states no size anywhere, so this number is the
     * sequence parameter set having been walked through its exponential-Golomb
     * codes in this engine. A reader that skipped it writes a `tkhd` of 0 by 0,
     * which a desktop player renders perfectly - it reads the size out of the
     * stream - and which a browser lays out at zero pixels with no error at
     * all. Forty macroblocks by thirty map units is 640 by 480.
     */
    check(
      label,
      'and its picture size is read out of the parameter set, since nothing states it',
      remuxed.report?.to?.width === 640 && remuxed.report?.to?.height === 480,
      `${String(remuxed.report?.to?.width)} x ${String(remuxed.report?.to?.height)}`,
    );

    /*
     * The narrow version of the claim the MP4 check makes broadly. "Byte for
     * byte" is false for this container by design - the framing around each
     * coded picture is rewritten - so what has to survive is one level down:
     * the NAL unit payload itself, unchanged, behind a four-byte length.
     */
    check(
      label,
      'every coded picture survives the re-framing unchanged',
      streamOut.includes(stream.slice),
      streamOut.includes(stream.slice)
        ? 'the slice is byte-identical inside its length prefix'
        : 'the coded picture did not survive',
    );

    check(
      label,
      'and the result says the framing was rebuilt rather than claiming byte for byte',
      (remuxed.report?.notes ?? []).some((note) => note.title.includes('framing was rebuilt')),
      JSON.stringify((remuxed.report?.notes ?? []).map((note) => note.title)),
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/* ========================================================================== *
 * A file larger than the tool used to accept
 * ========================================================================== */

/**
 * A transport stream of roughly `targetBytes`, written to disk.
 *
 * WRITTEN RATHER THAN PASSED, and that matters: `setInputFiles` with a buffer
 * sends the whole thing over the DevTools protocol, and the point of this
 * check is a file the browser opens from disk and never receives. A path is
 * what a real file chooser produces.
 *
 * Its shape is `makeTinyTs`'s, with a larger coded picture and the frame
 * repeated - so the tables are read once, the frames are gathered, and the
 * walk has to cross hundreds of megabytes to find them all.
 */
async function writeBigTransportStream(targetBytes) {
  const SPS = [0x67, 0x42, 0x00, 0x1e, 0xda, 0x02, 0x80, 0xf6, 0x40];
  const PPS = [0x68, 0xce, 0x3c, 0x80];

  const section = (tableId, body) => {
    const length = body.length + 4;
    return [tableId, 0xb0 | ((length >> 8) & 0x0f), length & 0xff, ...body, 0, 0, 0, 0];
  };
  const PMT_PID = 0x1000;
  const VIDEO_PID = 0x0100;
  const pat = section(0x00, [
    0x00,
    0x01,
    0xc1,
    0x00,
    0x00,
    0x00,
    0x01,
    0xe0 | ((PMT_PID >> 8) & 0x1f),
    PMT_PID & 0xff,
  ]);
  const pmt = section(0x02, [
    0x00,
    0x01,
    0xc1,
    0x00,
    0x00,
    0xe0 | 0x10,
    0x00,
    0xf0,
    0x00,
    0x1b,
    0xe0 | ((VIDEO_PID >> 8) & 0x1f),
    VIDEO_PID & 0xff,
    0xf0,
    0x00,
  ]);
  const stamp = (prefix, value) => [
    (prefix << 4) | ((Math.floor(value / 2 ** 30) & 0x07) << 1) | 1,
    Math.floor(value / 2 ** 22) & 0xff,
    ((Math.floor(value / 2 ** 15) & 0x7f) << 1) | 1,
    Math.floor(value / 2 ** 7) & 0xff,
    ((value & 0x7f) << 1) | 1,
  ];

  // A quarter of a megabyte per picture, which keeps the sample table beside
  // the point and the file itself the point.
  const idr = [0x65];
  for (let index = 0; index < 256 * 1024; index += 1) idr.push((index * 7 + 11) & 0xff);
  const startCode = [0, 0, 0, 1];

  let counter = 0;
  const packetsFor = (pid, payload, chunks) => {
    let at = 0;
    let first = true;
    while (at < payload.length) {
      const take = Math.min(184, payload.length - at);
      const stuffing = 184 - take;
      const packet = [
        0x47,
        (first ? 0x40 : 0) | ((pid >> 8) & 0x1f),
        pid & 0xff,
        (stuffing > 0 ? 0x30 : 0x10) | (counter & 0x0f),
      ];
      counter += 1;
      if (stuffing === 1) packet.push(0);
      else if (stuffing > 1) {
        packet.push(stuffing - 1, 0x00);
        for (let index = 0; index < stuffing - 2; index += 1) packet.push(0xff);
      }
      packet.push(...payload.slice(at, at + take));
      chunks.push(Buffer.from(packet));
      at += take;
      first = false;
    }
  };

  const path = join(tmpdir(), `patchbay-big-${String(process.pid)}.ts`);
  const out = createWriteStream(path);
  const write = (buffer) =>
    new Promise((resolve, reject) => {
      out.write(buffer, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

  const header = [];
  packetsFor(0, [0x00, ...pat], header);
  packetsFor(PMT_PID, [0x00, ...pmt], header);
  await write(Buffer.concat(header));

  let written = header.reduce((total, chunk) => total + chunk.length, 0);
  let frames = 0;
  while (written < targetBytes) {
    const time = frames * 3000;
    const pes = [
      0,
      0,
      1,
      0xe0,
      0,
      0,
      0x80,
      0xc0,
      10,
      ...stamp(3, time),
      ...stamp(1, time),
      ...startCode,
      ...SPS,
      ...startCode,
      ...PPS,
      ...startCode,
      ...idr,
    ];
    const chunks = [];
    packetsFor(VIDEO_PID, pes, chunks);
    const block = Buffer.concat(chunks);
    await write(block);
    written += block.length;
    frames += 1;
  }

  await new Promise((resolve) => {
    out.end(resolve);
  });
  return { path, bytes: written, frames };
}

/**
 * THE CHANGE THIS RELEASE IS ABOUT, ASSERTED ON A FILE THAT PROVES IT.
 *
 * The video tool refused anything over 256 MB, and nearly every file it exists
 * for is larger than that. What made 256 MB the number was not video, it was
 * memory: a run held the input three times over - the page kept the chosen
 * file's bytes for the session, the worker got a structured clone, and the
 * output was built beside it - and a transport stream cost a fourth copy,
 * because its frames are not contiguous and had to be gathered first.
 *
 * None of those copies exists now, and this is the check that says so rather
 * than the commit message. Four things are measured, and three of them would
 * have been false before:
 *
 *   1. A file larger than the old limit is repackaged at all.
 *   2. THE PAGE NEVER READS IT. `Blob.prototype.slice` and `.arrayBuffer` are
 *      counted on the main thread, for `File` receivers only, so what is
 *      measured is the bytes the TAB pulled out of the chosen file. It used to
 *      be all of them, at the moment the file was chosen. It should now be the
 *      4 kB the sniff looks at and nothing else - the worker reads the rest in
 *      its own realm through its own window, and none of that is visible here,
 *      which is the point.
 *   3. The answer comes back as a blob of the right size, which is what a
 *      download is handed.
 *
 * Only a real engine can be asked any of this. jsdom has no Worker, so nothing
 * in the unit suite has ever executed `FileReaderSync` - the whole mechanism
 * this rests on - even once.
 */
async function checkLargeVideo(browser, label) {
  // Comfortably past the old 256 MB ceiling and still quick to write.
  const TARGET = 320 * 1024 * 1024;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  await context.addInitScript(() => {
    window.__fileBytesRead = 0;
    const slice = Blob.prototype.slice;
    const arrayBuffer = Blob.prototype.arrayBuffer;
    Blob.prototype.slice = function patchedSlice(start, end, type) {
      if (this instanceof File) {
        const from = start ?? 0;
        const to = end ?? this.size;
        window.__fileBytesRead += Math.max(0, to - from);
      }
      return slice.call(this, start, end, type);
    };
    Blob.prototype.arrayBuffer = function patchedArrayBuffer() {
      if (this instanceof File) window.__fileBytesRead += this.size;
      return arrayBuffer.call(this);
    };

    const original = URL.createObjectURL.bind(URL);
    window.__lastBlob = null;
    URL.createObjectURL = (blob) => {
      window.__lastBlob = blob;
      return original(blob);
    };
  });

  const page = await context.newPage();
  let made = null;

  try {
    made = await writeBigTransportStream(TARGET);

    await page.goto(`${ORIGIN}/tools/video-remux`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1, name: 'Video' }).waitFor({ timeout: 15_000 });

    const chosenAt = Date.now();
    await page.locator('input[type="file"]').setInputFiles(made.path);
    await page.getByText('MB', { exact: false }).first().waitFor({ timeout: 60_000 });
    const chooseMs = Date.now() - chosenAt;

    const afterChoosing = await page.evaluate(() => window.__fileBytesRead);
    check(
      label,
      'choosing a 320 MB video reads 4 kB of it and no more',
      afterChoosing <= 8192,
      `${String(afterChoosing)} bytes read on the main thread, in ${String(chooseMs)} ms`,
    );

    const started = Date.now();
    await page.getByRole('button', { name: 'Run' }).click();
    await page.getByRole('button', { name: 'Download' }).first().waitFor({ timeout: 300_000 });
    const elapsed = Date.now() - started;

    // The report is drawn as a report; `Raw` is where its JSON is legible to a
    // harness, the same way `checkVideoRemux` reads it.
    await page.getByRole('button', { name: 'Raw' }).click({ timeout: 30_000 });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('textarea[readonly]')].some((field) =>
          field.value.includes('"summary"'),
        ),
      undefined,
      { timeout: 30_000 },
    );
    const report = await page.evaluate(() => {
      const field = [...document.querySelectorAll('textarea[readonly]')].find((candidate) =>
        candidate.value.includes('"summary"'),
      );
      return field ? JSON.parse(field.value) : null;
    });

    check(
      label,
      'a video larger than the old 256 MB ceiling is repackaged',
      report?.to?.format === 'MP4 · H.264' && (report?.to?.bytes ?? 0) > 256 * 1024 * 1024,
      `${String(made.bytes)} bytes in, ${String(report?.to?.bytes)} out, ${String(report?.to?.frames)} frames, ${String(elapsed)} ms`,
    );

    check(
      label,
      'and its picture size still comes out of the parameter set',
      report?.to?.width === 640 && report?.to?.height === 480,
      `${String(report?.to?.width)} x ${String(report?.to?.height)}`,
    );

    const duringRun = await page.evaluate(() => window.__fileBytesRead);
    check(
      label,
      'and the page never reads the file, whatever the worker does with it',
      duringRun <= 8192,
      `${String(duringRun)} bytes read on the main thread across the whole run`,
    );

    await page.getByRole('button', { name: 'Download' }).first().click();
    const handed = await page.evaluate(() => {
      const blob = window.__lastBlob;
      return blob ? { size: blob.size, type: blob.type } : null;
    });

    /*
     * The download is where a value leaves, and a deferred one leaves as the
     * blob it already was. Asserting the SIZE rather than the bytes is
     * deliberate: reading 320 MB back into the page to compare them would be
     * the very thing this whole change exists to stop doing.
     */
    check(
      label,
      'the finished file is handed over as a blob rather than assembled in the tab',
      handed !== null && handed.size === report?.to?.bytes && handed.type === 'video/mp4',
      handed === null ? 'no blob' : `${String(handed.size)} bytes of ${handed.type}`,
    );
  } finally {
    await context.close().catch(() => {});
    if (made !== null) await rm(made.path, { force: true }).catch(() => {});
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
