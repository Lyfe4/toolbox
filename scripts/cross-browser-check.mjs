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

  const regions = [...layout.children].map((el, index) => {
    const heading = el.querySelector('h2');
    return {
      index,
      // The controls rail is a plain div holding the Options panel and the run
      // bar, so it is named from the panel inside it.
      name: (heading?.textContent ?? '(unnamed)').trim(),
      ...box(el),
    };
  });

  const run = [...document.querySelectorAll('button')].find(
    (el) => (el.textContent ?? '').trim() === 'Run',
  );
  const scroller = document.querySelector('[class*="optionsScroll"]');
  const rail = document.querySelector('[class*="controls"]');

  return {
    regions,
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
        }
      : null,
    scroller: scroller
      ? {
          scrolls: scroller.scrollHeight > scroller.clientHeight + 1,
          overflowY: getComputedStyle(scroller).overflowY,
          focusableInside: scroller.querySelectorAll(
            'button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
          ).length,
        }
      : null,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    docScrollWidth: document.documentElement.scrollWidth,
    docClientWidth: document.documentElement.clientWidth,
    docHeight: document.documentElement.scrollHeight,
  };
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

      /* -- 2. Run sits between the options and the output ---------------- */
      check(
        label,
        `Run is below the options and above the output at ${at}`,
        probe.run !== null && probe.run.top >= options.top && probe.run.bottom <= options.bottom,
        probe.run === null
          ? 'no Run button'
          : `run ${String(probe.run.top)}..${String(probe.run.bottom)} in options ${String(
              options.top,
            )}..${String(options.bottom)}`,
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
     * output is the one line "Run the tool to see output here", there is
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
  } finally {
    await shortContext.close().catch(() => {});
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
    check(
      label,
      'the contrast readout reports a theme the user has just broken',
      /\d+ of 33 pairs fail WCAG AA/.test(summary ?? ''),
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
    await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
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

    await page.getByTestId('dialog-option-base64').click();
    await page.waitForTimeout(300);

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

    const field = await page.evaluate(() => {
      const element = document.querySelector('[role="group"] textarea');
      return element ? parseFloat(getComputedStyle(element).fontSize) : 0;
    });
    // Below 16px, iOS Safari zooms the viewport on focus and never zooms back.
    check(label, 'a node field will not make iOS zoom in', field >= 16, `${String(field)}px`);
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
        await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
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
        await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
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
async function checkSoftKeyboard(engine, label) {
  skip(
    label,
    'a real on-screen keyboard does not cover a focused field',
    'no engine Playwright drives can open one, and none can shrink the visual viewport independently of the layout viewport - the checks below shrink the WINDOW, which runs the same code on a different event',
  );

  const browser = await launchTouchBrowser(engine);
  const context = await browser.newContext({
    viewport: { width: 390, height: 780 },
    hasTouch: true,
  });
  const page = await context.newPage();

  try {
    /* -- The canvas has nothing for the browser to scroll ---------------- */
    await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
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

    /* -- And does reveal them -------------------------------------------- */
    const before = await page.evaluate(() => {
      const field = document.querySelector('[data-node-input]');
      field.focus();
      const box = field.getBoundingClientRect();
      return { top: Math.round(box.top), bottom: Math.round(box.bottom) };
    });

    // 336px is roughly an iPhone keyboard. The window rather than the visual
    // viewport, because nothing here can move the two independently.
    await page.setViewportSize({ width: 390, height: 780 - 336 });
    await page.waitForTimeout(400);

    const after = await page.evaluate(() => {
      const box = document.activeElement.getBoundingClientRect();
      return {
        tag: document.activeElement.tagName,
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        height: window.innerHeight,
      };
    });
    check(
      label,
      'the canvas pans a focused node field back above a shrunken viewport',
      after.tag === 'TEXTAREA' && after.top >= 0 && after.bottom <= after.height,
      `${String(before.top)}..${String(before.bottom)} -> ${String(after.top)}..${String(after.bottom)} in ${String(after.height)}px`,
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
    await finePage.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
    await finePage.getByRole('button', { name: 'Add tool' }).click();
    await finePage.locator('[role="dialog"]').first().waitFor({ timeout: 10_000 });
    await finePage.getByTestId('dialog-option-base64').click();
    await finePage.waitForTimeout(600);

    const plane = () =>
      finePage.evaluate(
        () => document.querySelector('[data-testid="canvas-plane"]')?.style.transform ?? '',
      );

    const settled = await plane();
    await finePage.evaluate(() => {
      document.querySelector('[data-node-input]')?.focus();
    });
    await finePage.setViewportSize({ width: 390, height: 780 - 336 });
    await finePage.waitForTimeout(400);

    check(
      label,
      'a fine pointer never has the canvas move under a focused field',
      (await plane()) === settled,
      `${settled} -> ${await plane()}`,
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
async function checkTruncation(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });

    // Text convert has both kinds: "Input" fits, "Detected source" does not.
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
      await touchPage.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
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

    check(label, 'no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  } finally {
    await context.close();
  }

  try {
    await checkChromeWidths(browser, label);
    await checkRunnerLayout(browser, label);
    await checkDialogScroll(browser, label);
    await checkRouteFeedback(browser, label);
    await checkOffline(browser, label);
    await checkAxe(browser, label);
    await checkConsoleSilence(browser, label);
    await checkDeepLinks(browser, label);
    await checkStructuredData(browser, label);
    await checkDiff(browser, label);
    await checkRegex(browser, label);
    await checkHead(browser, label);
    await checkTouch(engine, label);
    await checkMobileLayout(engine, label);
    await checkSoftKeyboard(engine, label);
    await checkTruncation(browser, label);
    await checkPreviewSandbox(browser, label);
    await checkPipeline(browser, label);
    await checkImageConvert(browser, label);
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

  /** A graph as a link, which is the app's own way to be handed a whole one. */
  const link = (nodes, edges) => `${ORIGIN}/?p=${shareParam({ v: 2, n: nodes, e: edges })}`;

  /** The status word a node prints in its footer. */
  const statusOf = (id) =>
    page.evaluate(
      (nodeId) =>
        document.querySelector(`[data-testid="node-${nodeId}"] [class*="nodeFooter"] span`)
          ?.textContent ?? null,
      id,
    );

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
    await page.locator('[data-testid="node-n1"] textarea').fill('eyJuYW1lIjoiYWRhIn0=');

    const chained = await untilStatus('n3', 'ok', 30_000);
    check(
      label,
      'a three-tool chain runs end to end through the real worker',
      chained === 'ok',
      String(chained),
    );

    /* -- One node's timeout, and the nodes beside it ---------------------- */
    await page.goto(
      link(
        [
          /*
           * WHY THIS PATTERN AND NOT (a+)+$, AND WHY THE ALPHABET IS IN IT.
           *
           * The two engines disagree about catastrophic backtracking, and the
           * disagreement decides whether this check tests anything at all.
           * SpiderMonkey runs the backtracking until it exhausts its stack -
           * about seven seconds here - and then throws. JavaScriptCore instead
           * bounds the backtracking COUNT and gives up quietly, which for
           * (a+)+$ over 32 characters lands at roughly 0.9s: comfortably
           * inside the tool's 2s deadline, so the worker was never wedged and
           * the check passed while proving nothing.
           *
           * (a*)*(b*)*c over 40 characters replaced it, at a measured ~2.4s in
           * JSC - past the deadline, but by less than half a second. That
           * margin has since closed: the same pattern now measures 1.3-2.9s
           * across runs on the same machine, so the check reports `ok` for n1
           * about as often as it reports `error`, which is worse than a
           * failing check because it looks like a flake.
           *
           * LENGTHENING THE SUBJECT DOES NOT HELP, and that is the thing worth
           * writing down. JSC's budget is a count of backtracks, not a time,
           * and it is spent inside a single `exec` however long the subject
           * is: 40 characters and 200 characters both give up at ~1.9s. What
           * raises the cost is making each backtrack step more expensive, so
           * the alternation is the whole lower-case alphabet rather than `a*`.
           * Measured: WebKit ~6.8s, Firefox ~7.0s (stack exhaustion), against
           * a 2s deadline. Both engines are now more than 3x past it.
           *
           * If this ever reports `ok` again, JSC has got faster rather than
           * anything having regressed - widen the alternation, do not lengthen
           * the input.
           */
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
          ['n3', 'structured-data', 320, 320, { source: 'auto', target: 'yaml', indent: 2 }],
        ],
        [['n2', 'output', 'n3', 'input']],
      ),
      { waitUntil: 'networkidle' },
    );
    await page.locator('[data-testid="node-n3"]').waitFor({ timeout: 15_000 });

    await page.locator('[data-testid="node-n1"] textarea').fill(`${'a'.repeat(40)}!`);
    await page.locator('[data-testid="node-n2"] textarea').fill('eyJuYW1lIjoiYWRhIn0=');

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
  } finally {
    await context.close();
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
