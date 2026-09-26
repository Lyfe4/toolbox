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
import { createHash } from 'node:crypto';
import { deflateRawSync, deflateSync, inflateRawSync } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { chromium, firefox, webkit } from 'playwright';

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
 * The published JWS vectors
 * ========================================================================== */

const jwsToBytes = (text) => Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const jwsToText = (bytes) =>
  bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * The four fixtures under `src/tools/jwt-decode/spec/`, read from the same
 * files the unit suite imports so the two cannot drift: a regenerated fixture
 * changes both at once, and a deleted one fails this script before a browser
 * starts.
 *
 * `scripts/generate-jws-oracle.mjs` writes them, and refuses to write one
 * unless CPython's `cryptography` and Node's WebCrypto both reach the published
 * verdict for every case.
 */
const JWS_FIXTURES = Object.fromEntries(
  await Promise.all(
    ['rfc7515', 'rfc7520', 'rfc4231', 'wycheproof'].map(async (name) => [
      name,
      JSON.parse(await readFile(join(ROOT, `src/tools/jwt-decode/spec/${name}.json`), 'utf8')),
    ]),
  ),
);

/**
 * The vectors that can be driven through the tool's own UI, with the tampered
 * variants each check needs worked out here rather than written down.
 *
 * ONLY FOUR OF THE TWELVE ALGORITHMS CAN BE. `decodeToken` requires a JSON
 * payload, because a JWT's payload is JSON - and almost every published JOSE
 * example is a JWS rather than a JWT. RFC 7515 A.4 signs the ASCII string
 * "Payload", the cookbook signs a line of Tolkien, and Wycheproof signs "foo".
 * The two exceptions are Wycheproof's PS256 salt cases, whose payload is the
 * digit string `123400` - which happens to be valid JSON.
 *
 * So this list is HS256, RS256, ES256 and PS256, and what it cannot reach is
 * measured instead: see "what each engine can actually do with a published
 * vector".
 */
const JWS_UI_EXAMPLES = (() => {
  const byAppendix = (appendix) =>
    JWS_FIXTURES.rfc7515.cases.find((entry) => entry.appendix === appendix);
  const hmac = byAppendix('A.1');
  const rsa = byAppendix('A.2');
  const ec = byAppendix('A.3');
  const pssKey = JWS_FIXTURES.wycheproof.publicKeyPem.PS256;
  const pss = JWS_FIXTURES.wycheproof.cases.filter(
    (entry) => entry.algorithm === 'PS256' && entry.expect === 'valid' && entry.payloadIsJwtShaped,
  );

  if (!hmac || !rsa || !ec || !pssKey || pss.length === 0) {
    throw new Error('cross-browser: the JWS fixtures are missing a case the UI checks need');
  }

  const fromToken = (name, token, key, keyEncoding, wrongKindKey, wrongKey) => {
    const [header, payload, signature] = token.split('.');
    const flipped = jwsToBytes(signature);
    flipped[0] ^= 0x01;
    return {
      name,
      token,
      key,
      keyEncoding,
      tamperedToken: `${header}.${payload}.${jwsToText(flipped)}`,
      /** A key of another kind entirely: nothing should even import. */
      wrongKindKey,
      /** A key of the RIGHT kind and the wrong value: a check happens and fails. */
      wrongKey,
    };
  };

  return [
    /*
     * A.1's key is the RFC's base64url secret, so this one also drives the
     * `Secret encoding` select. It is the only published HMAC token here, and
     * the only thing that puts the HS path in front of a real engine at all.
     */
    fromToken(
      'RFC 7515 A.1 HS256',
      hmac.token,
      hmac.key,
      'base64url',
      rsa.key,
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ),
    fromToken('RFC 7515 A.2 RS256', rsa.token, rsa.key, 'utf8', ec.key, pssKey),
    fromToken('RFC 7515 A.3 ES256', ec.token, ec.key, 'utf8', rsa.key, null),
    fromToken(`Wycheproof ${pss[0].id} PS256`, pss[0].token, pssKey, 'utf8', ec.key, rsa.key),
  ];
})();

/**
 * Every published vector, flattened to what an engine needs to answer for
 * itself: the key, the bytes that were signed, the signature, and the WebCrypto
 * parameters the generator PROVED those bytes verify under.
 *
 * The parameters come from the fixture rather than from this file on purpose.
 * Re-deriving them here would make this script's expectations its own, which is
 * the thing the whole exercise is against; taking them from the fixture means
 * they are the ones two independent verifiers already agreed about.
 */
const JWS_ENGINE_VECTORS = (() => {
  const out = [];
  const push = (source, algorithm, webcrypto, key, keyEncoding, message, signature) => {
    /*
     * A MISSING FIELD HAS TO FAIL HERE, not in the page. The first run of this
     * check reported `TypeError: vector.webcrypto is undefined` as five
     * algorithm failures in each engine, which reads exactly like two browsers
     * refusing RSA-PSS and P-384 - and was one wrong property name in this
     * file. An `undefined` that travels into `page.evaluate` comes back wearing
     * the browser's name.
     */
    if (!webcrypto?.format || !key || !message || !signature) {
      throw new Error(`cross-browser: the ${source} ${algorithm} vector is incomplete`);
    }
    out.push({ source, algorithm, webcrypto, key, keyEncoding, message, signature });
  };

  for (const entry of JWS_FIXTURES.rfc7515.cases) {
    push(
      `RFC 7515 ${entry.appendix}`,
      entry.algorithm,
      entry.webcrypto,
      entry.key,
      entry.keyEncoding,
      `${entry.header}.${entry.payload}`,
      entry.signature,
    );
  }
  for (const entry of JWS_FIXTURES.rfc7520.cases) {
    push(
      `RFC 7520 ${entry.section}`,
      entry.algorithm,
      entry.webcrypto,
      entry.key,
      entry.keyEncoding,
      `${entry.header}.${entry.payload}`,
      entry.signature,
    );
  }
  for (const entry of JWS_FIXTURES.rfc4231.cases) {
    push(
      `RFC 4231 case ${entry.testCase}`,
      entry.algorithm,
      entry.webcrypto,
      entry.key,
      entry.keyEncoding,
      entry.signingInput,
      entry.signature,
    );
  }
  /*
   * One positive per algorithm from Wycheproof, not all two hundred. This is a
   * question about the ENGINE - can it do PS512 at all, can it do P-384 - and a
   * second vector for the same algorithm answers it a second time. The full
   * suite, including every negative, runs in the unit suite.
   */
  const seen = new Set();
  for (const entry of JWS_FIXTURES.wycheproof.cases) {
    if (entry.expect !== 'valid' || seen.has(entry.algorithm)) continue;
    seen.add(entry.algorithm);
    const message =
      entry.kind === 'ecdsa' ? entry.signingInput : entry.token.split('.').slice(0, 2).join('.');
    const signature = entry.kind === 'ecdsa' ? entry.signature : entry.token.split('.')[2];
    push(
      `Wycheproof ${entry.id}`,
      entry.algorithm,
      // Hoisted to one block per algorithm in that fixture: there are two
      // hundred cases and five keys, and inlining both made the file six times
      // the size for a reviewer reading the same PEM over and over.
      JWS_FIXTURES.wycheproof.webcrypto[entry.algorithm],
      JWS_FIXTURES.wycheproof.publicKeyPem[entry.keyId],
      'utf8',
      message,
      signature,
    );
  }
  return out;
})();

/** The twelve `alg` values the tool offers, all of which must be represented. */
const JWS_ALGORITHMS = [...new Set(JWS_ENGINE_VECTORS.map((entry) => entry.algorithm))].sort();

if (JWS_UI_EXAMPLES.length !== 4 || JWS_ALGORITHMS.length !== 12) {
  throw new Error(
    `cross-browser: expected 4 UI examples and 12 algorithms, got ${JWS_UI_EXAMPLES.length} and ${JWS_ALGORITHMS.length}`,
  );
}

/* ========================================================================== *
 * The image-resampling oracle
 * ========================================================================== */

/**
 * `src/tools/image-convert/spec/resample.json`, generated by
 * `scripts/generate-resample-oracle.mjs`: a fixed pattern, the same downscale
 * performed by Pillow, and the list of output pixels four reference filters
 * agree about. See the check that uses it for what a tolerance means here.
 */
const RESAMPLE = JSON.parse(
  await readFile(join(ROOT, 'src/tools/image-convert/spec/resample.json'), 'utf8'),
);

/**
 * `src/tools/video-remux/spec/playback.json`, generated by
 * `scripts/generate-video-playback-fixture.mjs`: twelve frames of flat colour,
 * encoded once by a real x264 and committed, so that `check:browsers` can hand
 * a real decoder a file this tool made without needing an encoder itself.
 */
const VIDEO_PLAYBACK = JSON.parse(
  await readFile(join(ROOT, 'src/tools/video-remux/spec/playback.json'), 'utf8'),
);

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
/**
 * The ancillary chunks a PNG really carries, read here rather than asked of
 * the tool.
 *
 * This exists because the tool used to STATE that its output carried no
 * metadata - a hard-coded empty list, asserted by a unit test running against
 * a stubbed canvas whose blob no encoder had ever touched. Driven for real,
 * Playwright's WebKit writes an `iCCP` profile named `Skia` into every PNG it
 * encodes. The claim and the bytes disagreed, in a real engine, on every
 * conversion, and nothing in the suite was in a position to notice.
 *
 * So the assertion below is no longer "the list is empty". It is "the list
 * matches the file", which is the question that has an answer.
 */
function pngMetadataChunks(bytes) {
  const carriers = new Set(['iCCP', 'eXIf', 'tEXt', 'zTXt', 'iTXt']);
  const found = [];
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    if (type === 'IEND') break;
    if (carriers.has(type)) found.push(type);
    const next = at + 12 + length;
    if (next <= at || next > bytes.length) break;
    at = next;
  }
  return found;
}

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
const skipped = [];

/**
 * Records something that could NOT be checked here, and why.
 *
 * Not a pass and not a failure. A check that silently disappears in one engine
 * is worse than one that fails, because the summary then reads as full
 * coverage - so anything the harness cannot do gets a visible line naming the
 * engine limitation behind it.
 *
 * AND THAT LINE HAS TO REACH THE SUMMARY, which for a long time it did not.
 * The reason above is the whole point of this function, and the final line
 * still said `OK - Firefox and WebKit both pass` with no mention of how many
 * checks had quietly stood down - eight hundred lines above, where nobody
 * scrolls. Every skip is counted now and named at the end, so the shape of the
 * coverage is visible in the same glance as the verdict.
 */
function skip(browser, name, reason) {
  console.log(`  skip ${name} - ${reason}`);
  skipped.push(`${browser}: ${name}`);
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

/**
 * Whether the toolbar's inspector toggle LOOKS pressed when it is, and still
 * does under the pointer.
 *
 * It carried `aria-pressed` from the start and drew nothing for it. Pressed is
 * an accent border and an accent bar, and the bar is the half that does not
 * rest on colour; hovered is asserted separately because the hover rule is the
 * more specific one, and a state that disappears when the pointer arrives is
 * the rich copy button's bug again. The partner for "not pressed" is the same
 * control measured pressed, so a toggle that never changes cannot pass.
 */
async function checkInspectorToggleLook(page, label, where) {
  const toggle = page.getByRole('button', { name: 'Inspector', exact: true });
  const look = () =>
    toggle.evaluate((button) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--pb-border-accent)';
      document.body.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      const style = getComputedStyle(button);
      return {
        pressed: button.getAttribute('aria-pressed'),
        border: style.borderTopColor,
        shadow: style.boxShadow,
        accent,
      };
    });

  await page.mouse.move(1, 1);
  await setInspector(page, false);
  const off = await look();
  await setInspector(page, true);
  await page.mouse.move(1, 1);
  await page.waitForTimeout(250);
  const on = await look();
  await toggle.hover();
  await page.waitForTimeout(250);
  const hovered = await look();
  await page.mouse.move(1, 1);

  check(
    label,
    `${where}: the inspector toggle shows whether the panel is showing`,
    off.pressed === 'false' &&
      on.pressed === 'true' &&
      off.shadow === 'none' &&
      off.border !== on.accent &&
      on.border === on.accent &&
      on.shadow !== 'none',
    `off: border ${off.border}, shadow ${off.shadow}; on: border ${on.border}, shadow ${on.shadow}; accent ${on.accent}`,
  );
  check(
    label,
    `${where}: and still shows it under the pointer`,
    hovered.border === hovered.accent && hovered.shadow !== 'none',
    `hovered: border ${hovered.border}, shadow ${hovered.shadow}`,
  );
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
     * `checkInspectorMotion` asserts that starting point and the memory
     * behind it ("It starts closed, and remembers"); everything here is about the rail once it is showing.
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

    /*
     * ONE RULE AT THE BOUNDARY, COUNTED IN PAINTED PIXELS.
     *
     * Everything above describes the HANDLE, and all of it stayed true while
     * the panel drew a second hairline of its own four pixels away: the rail
     * nulled three of its four borders and kept `border-inline-start`, so the
     * boundary was two 1px rules in the same `--pb-border-hairline` with a gap
     * down the middle. Every assertion here passed throughout, because not one
     * of them asked how many lines there are - they all asked about the one
     * they already knew the name of.
     *
     * So this counts ink instead of reading declarations. A strip one pixel
     * tall is taken across the boundary and the runs matching the rule's own
     * colour are counted; the canvas grid is a different token and does not
     * answer. Exactly one, or the divider has grown a twin again.
     */
    const boundary = await page.evaluate(() => {
      const handle = document.querySelector('[data-testid="inspector-handle"]');
      const panel = document.querySelector('[data-testid="node-inspector"]');
      if (!handle || !panel) return null;
      const hb = handle.getBoundingClientRect();
      const pb = panel.getBoundingClientRect();
      const cs = getComputedStyle(panel);
      return {
        /*
         * THE BOUNDARY, AND NOT A PIXEL OF CANVAS.
         *
         * This overhung the handle by 6px on the canvas side at first, and
         * caught the grid's heavy rule - which is drawn in the SAME ink as the
         * hairline, so it counted as a second boundary and failed against a
         * build that was correct. Measured at 1440px: canvas rule at x1088,
         * handle's rule at x1096, panel edge at x1100.
         *
         * The boundary is exactly the handle's track plus the panel's first two
         * columns: the handle's rule lives in the first, and a border on the
         * panel - the defect this exists to catch - would paint in the second.
         * Nothing on the canvas can reach either.
         */
        clip: {
          x: Math.round(hb.left),
          // Mid-panel, which is inside the body and clear of the head's own rule.
          y: Math.round(pb.top + pb.height / 2),
          width: Math.round(pb.left - hb.left) + 2,
          height: 1,
        },
        ink: getComputedStyle(handle, '::before').backgroundColor,
        panelBorders: [
          cs.borderTopWidth,
          cs.borderRightWidth,
          cs.borderBottomWidth,
          cs.borderLeftWidth,
        ].join('/'),
      };
    });

    let rules = null;
    if (boundary !== null) {
      const strip = await page.screenshot({ clip: boundary.clip });
      rules = await page.evaluate(
        async ({ bytes, ink }) => {
          const bitmap = await createImageBitmap(
            new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
          );
          const surface = document.createElement('canvas');
          surface.width = bitmap.width;
          surface.height = 1;
          const context = surface.getContext('2d');
          context.drawImage(bitmap, 0, 0);
          const { data } = context.getImageData(0, 0, bitmap.width, 1);
          const want = (ink.match(/\d+/g) ?? []).slice(0, 3).map(Number);
          const runs = [];
          let inRun = false;
          for (let x = 0; x < bitmap.width; x += 1) {
            const hit =
              Math.abs(data[x * 4] - want[0]) +
                Math.abs(data[x * 4 + 1] - want[1]) +
                Math.abs(data[x * 4 + 2] - want[2]) <=
              12;
            if (hit && !inRun) runs.push(1);
            else if (hit) runs[runs.length - 1] += 1;
            inRun = hit;
          }
          return runs;
        },
        { bytes: [...strip], ink: boundary.ink },
      );
    }

    /*
     * The COUNT is this check's whole job - the rule's width is the first
     * check above, and a check that asserts two things fails without saying
     * which.
     */
    check(
      label,
      'the boundary is one hairline, not the handle’s rule beside a panel border',
      rules !== null && rules.length === 1,
      rules === null
        ? 'no handle'
        : `${String(rules.length)} run(s) of the rule colour [${rules.join(', ')}]px wide, panel borders ${boundary.panelBorders}`,
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
  // The footnote stack - Ports plus whatever the route puts beside it. It is
  // the tail of the CONTENT column, so the column's height runs to its bottom.
  const notes = document.querySelector('[class*="notes"]');

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
    /*
     * THE PORTS FOOTNOTE, AS A TABLE.
     *
     * Each entry is a direction, a name, a type and a sentence, and it used to
     * be drawn as a name line with a paragraph under it running the full width
     * of the page - twelve words set across 1,888px on a wide monitor. The
     * identity and the sentence are two columns now, and the question that
     * distinguishes the two layouts is geometric: is the sentence BESIDE its
     * name or UNDER it.
     *
     * Paired by document order rather than by a shared wrapper, because the
     * cells are siblings: an output contributes a name and a note, and an
     * input contributes a name alone. That is the arrangement that would break
     * under grid auto-placement, so it is also the thing worth measuring.
     */
    ports: (() => {
      const cells = [...document.querySelectorAll('[class*="portName"], [class*="portNote"]')];
      const rows = [];
      for (let index = 0; index < cells.length; index += 1) {
        const name = cells[index];
        if (!name.className.includes('portName')) continue;
        const next = cells[index + 1];
        const note = next && next.className.includes('portNote') ? next : null;
        rows.push({
          name: box(name),
          note: note ? box(note) : null,
          text: (name.textContent ?? '').trim().slice(0, 40),
        });
      }
      return rows;
    })(),
    notes: notes ? box(notes) : null,
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
  /*
   * 1439 and 1440 pin the SECOND breakpoint the same way, and its number is
   * arithmetic too: the input column is capped at 440px so a paste target stops
   * being sized by the monitor, the rail is 300, and the widest thing the
   * output draws wants about 600. 440 + 300 + 600 + 32 for the two gaps + 32
   * for the page's gutters = 1404, and 1440 is the next round number clear of
   * it. Above it the input, the rail and the result are three columns and the
   * two halves of the loop this page exists for are on screen together.
   */
  const widths = [320, 390, 768, 999, 1000, 1280, 1439, 1440, 1920];

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

      /*
       * THE PORTS FOOTNOTE IS A CLOSED DISCLOSURE, AND A CLOSED ONE MEASURES
       * ZERO. Every assertion below about where a port's sentence sits relative
       * to its name is `0 >= 0` and `0 <= 0` against a shut `<details>` - true
       * of a correct layout and equally true of a broken one, which is the
       * exact shape this file spent a round removing. It is opened here, and
       * the cells are asserted to have real width before their positions are
       * trusted. Whether it is CLOSED to begin with is its own check below.
       */
      const opened = await page.evaluate(() => {
        const details = document.querySelector('details');
        if (!details) return false;
        details.open = true;
        return true;
      });
      check(label, `the ports disclosure can be opened at ${at}`, opened, '');
      await page.waitForTimeout(100);

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

      /* -- THE PORTS FOOTNOTE IS A TABLE ABOVE 720px -------------------- */
      /*
       * A port is a direction, a name, a type and a sentence. Drawn as a name
       * with a paragraph under it, that is a column of prose running the full
       * width of the page - and the wider the monitor the less it reads as
       * either prose or data. Two columns, with the sentence on a measure.
       *
       * The check is stated as a relationship rather than as a number, because
       * the number is the breakpoint and the breakpoint is already asserted by
       * the two sides of it below. What must be true is that the sentence is
       * BESIDE its own name above 720 and UNDER it below - and that it belongs
       * to that name, which is what the pairing by document order tests: under
       * grid auto-placement an input (which has a name and no sentence) would
       * push the next port's NAME into the second column and every row after
       * it would be off by one.
       */
      const noted = probe.ports.filter((row) => row.note !== null);
      check(
        label,
        `every port with a sentence has one at ${at}`,
        noted.length > 0,
        `${String(noted.length)} of ${String(probe.ports.length)} rows`,
      );
      /*
       * THE POSITIVE PARTNER. Each comparison below is between two coordinates,
       * and a pair of zero-sized boxes satisfies all of them. This is what says
       * the boxes are really on screen, so the relationships mean something.
       */
      check(
        label,
        `the ports table is drawn rather than collapsed to nothing at ${at}`,
        noted.every((row) => row.name.right > row.name.left && row.note.right > row.note.left),
        noted
          .map(
            (row) =>
              `${String(row.name.right - row.name.left)}x${String(row.note.right - row.note.left)}`,
          )
          .join(' '),
      );
      if (width >= 720) {
        check(
          label,
          `a port's sentence sits beside its name rather than under it at ${at}`,
          noted.every((row) => row.note.left >= row.name.right && row.note.top <= row.name.bottom),
          noted
            .map(
              (row) =>
                `${row.text}: name ${String(row.name.left)}..${String(row.name.right)}@${String(
                  row.name.top,
                )}, note ${String(row.note.left)}@${String(row.note.top)}`,
            )
            .join(' | '),
        );
        /*
         * AND THE SENTENCE HAS A MEASURE. Without this the second column is
         * simply the rest of the window and the only thing that changed is
         * where the line starts - 1,140px of sentence instead of 1,888.
         */
        check(
          label,
          `a port's sentence is bounded rather than page-width at ${at}`,
          noted.every((row) => row.note.right - row.note.left <= 720),
          noted.map((row) => String(row.note.right - row.note.left)).join('/'),
        );
      } else {
        check(
          label,
          `a port's sentence stacks under its name at ${at}`,
          noted.every((row) => row.note.top >= row.name.bottom && row.note.left === row.name.left),
          noted
            .map((row) => `name@${String(row.name.bottom)} note@${String(row.note.top)}`)
            .join('/'),
        );
      }

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

        if (width >= 1440) {
          /* -- THREE COLUMNS, AND THE RESULT IS ONE OF THEM ---------------- */
          /*
           * The defect this replaces was not a bug in any one rule, it was a
           * layout with no ceiling: above 1000 the main column is whatever is
           * left of the window, so on `/tools/base64` the input editor was
           * 906px wide at 1280 and 1546px at 1920 for a string you pasted, and
           * the result it produced was a row further down. Measured on the
           * shipped build at 1920, the output box's top was at y=608; here it
           * is at 256, and the page is 926px tall against 1240.
           *
           * Asserted as three facts rather than as a set of numbers: the three
           * regions share a top, they are ordered left to right in DOM order,
           * and the input has stopped growing.
           */
          check(
            label,
            `the input, the rail and the result are three columns at ${at}`,
            Math.abs(output.top - input.top) <= 2 &&
              output.left >= options.right &&
              options.left >= input.right,
            `tops ${[input.top, options.top, output.top].join('/')}, lefts ${[
              input.left,
              options.left,
              output.left,
            ].join('/')}`,
          );
          /*
           * THE MEASURE, which is the whole reason for the third column. A
           * cap nobody asserts is a cap that drifts back to `1fr` the first
           * time somebody simplifies the template.
           */
          check(
            label,
            `the input column is a measure rather than a share of the window at ${at}`,
            input.right - input.left === 440,
            `${String(input.right - input.left)}px`,
          );
        } else {
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
            output.top < options.bottom && output.top >= input.bottom,
            `output starts ${String(output.top)}, input ends ${String(
              input.bottom,
            )}, rail ends ${String(options.bottom)}`,
          );
        }
        /*
         * THE FOOTNOTE IS IN THE CONTENT COLUMN, NEVER THE RAIL'S.
         *
         * It used to span both columns, below the grid, and the reason it was
         * below the grid was a real defect: a sticky box's travel is bounded by
         * its containing block, which for a grid item is the grid CONTAINER, so
         * a full-bleed row inside this grid lay across the rail's whole travel
         * range and the rail covered 52px of it at the foot of a JWT page.
         *
         * Taking it out of the grid removed the horizontal half of that overlap
         * by accident. The rule now stated directly is the narrower one -
         * nothing may occupy the rail's column - which lets the footnote sit in
         * the content column where a tall rail leaves the space. So what is
         * asserted is the horizontal separation the safety rests on, and the
         * overlap check below is what proves the consequence.
         */
        check(
          label,
          `the ports footnote is in the content column, clear of the rail, at ${at}`,
          ports.left === input.left && ports.right <= options.left && ports.top >= input.bottom,
          `ports ${String(ports.left)}..${String(ports.right)} against input at ${String(
            input.left,
          )} and a rail starting ${String(options.left)}`,
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
        /*
         * THE TALLEST COLUMN IS SPELLED DIFFERENTLY IN THE TWO LAYOUTS. With
         * two columns the content column is Input stacked on Output, so its
         * height is the distance from one top to the other bottom. With three
         * it is three siblings in one row, and none of them stretches - so the
         * question is simply which of the three is tallest.
         */
        const railHeight = probe.rail?.height ?? 0;
        /*
         * THE CONTENT COLUMN RUNS TO THE FOOT OF THE FOOTNOTES, which is what
         * changed when they moved into the grid. With two columns it is Input,
         * Output and then the footnotes stacked; with three it is Input and the
         * footnotes, and the result is a column of its own.
         */
        const contentColumn = (probe.notes?.bottom ?? output.bottom) - input.top;
        const tallest =
          width >= 1440
            ? Math.max(contentColumn, railHeight, output.bottom - output.top)
            : Math.max(contentColumn, railHeight);
        check(
          label,
          `the grid is as tall as its tallest column and no taller at ${at}`,
          Math.abs(probe.layoutHeight - tallest) <= 2,
          `grid ${String(probe.layoutHeight)}, content column ${String(
            contentColumn,
          )}, rail ${String(railHeight)}, output ${String(output.bottom - output.top)}`,
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
    /*
     * -- THE OVERLAP, AT THE FOOT OF THE PAGE ------------------------------
     *
     * This is the state the original defect appeared in, and it is the one that
     * matters now that the Ports and Privacy panels are back INSIDE the grid.
     * The rail travels until its bottom reaches the bottom of its containing
     * block, which is the grid container - so it passes beside both of them on
     * the way down. What stops it reaching them is that they are in the content
     * column and it is in the column beside: two boxes that never share a
     * horizontal band cannot overlap however far either travels.
     *
     * Asserted at rest further up and again here, scrolled, because "at rest"
     * is exactly the state the 52px overlap did NOT show up in.
     */
    await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await page.waitForTimeout(300);
    const bottom = await page.evaluate(RUNNER_PROBE);
    check(
      label,
      'the rail overlaps nothing with the page scrolled to its foot',
      bottom !== null && bottom.overlaps.length === 0,
      bottom === null
        ? 'no layout'
        : bottom.overlaps.map((entry) => `${entry.name} by ${String(entry.overlap)}px`).join(', '),
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

  /* -- 5. THE RESULT IS ON SCREEN WITH THE INPUT, ON THE TALLEST INPUT --- */
  /*
   * THE COMPLAINT THIS ROUND EXISTS FOR, MADE MEASURABLE.
   *
   * "Paste something, read the result" was a scroll on a wide monitor, and
   * base64 is the wrong tool to prove it with: its Input panel is 336px, so its
   * Output panel clears an 800px fold in the stacked layout as well and any
   * assertion about the fold passes either way. `diff` is the tool where it
   * bites - two editors, 604px of Input panel - and measured on the shipped
   * build at 1280x800 its Output panel's top was at 811 in an 800px window.
   * Eleven pixels, which is the whole result.
   *
   * At 1440 the two are columns: the Output panel's top is the Input panel's
   * top, and both are on screen. The control below is what stops this being a
   * check that a short page satisfies - the input really is taller than the
   * space under the page heading, so "the result is above the fold" is a fact
   * about the arrangement rather than about there being little to arrange.
   */
  const wideContext = await browser.newContext({ viewport: { width: 1440, height: 800 } });
  const widePage = await wideContext.newPage();

  try {
    await widePage.goto(`${ORIGIN}/tools/diff`, { waitUntil: 'networkidle' });
    await widePage.getByRole('heading', { level: 1, name: 'Diff' }).waitFor({ timeout: 15_000 });
    await widePage.waitForTimeout(250);

    const probe = await widePage.evaluate(RUNNER_PROBE);
    const [input, , output] = probe?.regions ?? [];

    /*
     * THE CONTROL. Without it, "the result is above the fold" is satisfied by a
     * page with nothing much on it. What has to be true is that STACKING would
     * not have been enough: the input ends one gap short of the fold or past
     * it, so the Output panel that used to follow it could not have been on
     * screen. Measured on the shipped build at 1280x800, it was at 811.
     */
    const gap = 16;
    check(
      label,
      'stacking the result under this input would have put it below the fold',
      input !== undefined && input.bottom + gap >= probe.innerHeight,
      input === undefined
        ? 'no input region'
        : `input ends at ${String(input.bottom)}, fold at ${String(probe.innerHeight)}`,
    );
    check(
      label,
      'the result of the tallest input in the set is on screen beside it, not under it',
      input !== undefined &&
        output !== undefined &&
        Math.abs(output.top - input.top) <= 2 &&
        output.top < probe.innerHeight &&
        output.left >= input.right,
      input === undefined || output === undefined
        ? 'no regions'
        : `input ${String(input.top)}..${String(input.bottom)} ending at x=${String(
            input.right,
          )}, output at ${String(output.top)} x=${String(output.left)}, fold ${String(
            probe.innerHeight,
          )}`,
    );
  } finally {
    await wideContext.close().catch(() => {});
  }

  /* -- 6. AN EMPTY RESULT IS THE SIZE OF THE SENTENCE IN IT -------------- */
  /*
   * REPORTED FROM A SCREENSHOT, AND IT IS THE THREE-COLUMN LAYOUT'S OWN
   * VERSION OF A DEFECT THIS PAGE HAD ALREADY DELETED ONCE.
   *
   * `.output` carries `align-self: stretch` in the two-column layout, and it
   * has to: there the panel is row two of a grid the rail spans, so the rail's
   * surplus is ENCLOSED - a hole between the result and the ports footnote -
   * and stretching the panel into it is what makes it invisible.
   *
   * In three columns nothing encloses it. The surplus is the end of a shorter
   * column with a full-width Ports panel under all three, so stretching buys
   * nothing and costs the rule the reserved viewport height was deleted for:
   * the Output panel gets sized by HOW MANY OPTION FIELDS ARE ON SCREEN.
   *
   * ONE TOOL AND TWO TARGETS RATHER THAN TWO TOOLS, which is what makes this a
   * property and not a coincidence. `text-convert` reveals and hides fields as
   * its target format changes - four on HTML, eight on Markdown - so the same
   * page, with the same empty Output panel showing the same sentence, is
   * measured against two different rails. Every other variable is held still by
   * construction. Measured on the build this replaces: the panel followed the
   * rail from 302px to 624px while the sentence in it never changed.
   *
   * The control is that the rail really did move. Without it, "the panel did
   * not change" is satisfied by a target switch that changed nothing at all.
   */
  const emptyContext = await browser.newContext({ viewport: { width: 1920, height: 900 } });
  const emptyPage = await emptyContext.newPage();

  try {
    await emptyPage.goto(`${ORIGIN}/tools/text-convert`, { waitUntil: 'networkidle' });
    await emptyPage
      .getByRole('heading', { level: 1, name: 'Text convert' })
      .waitFor({ timeout: 15_000 });
    await emptyPage.getByRole('combobox', { name: 'Target format' }).waitFor({ timeout: 15_000 });

    const idleWith = async (target) => {
      await emptyPage.getByRole('combobox', { name: 'Target format' }).click();
      await emptyPage.getByRole('option', { name: target, exact: true }).click();
      await emptyPage.evaluate(() => {
        window.scrollTo(0, 0);
      });
      await emptyPage.waitForTimeout(250);
      const probe = await emptyPage.evaluate(RUNNER_PROBE);
      const output = probe?.regions[2];
      return {
        rail: probe?.rail?.height ?? 0,
        output: output === undefined ? 0 : output.bottom - output.top,
      };
    };

    const short = await idleWith('HTML (normalised)');
    const tall = await idleWith('Markdown');

    check(
      label,
      'switching the target really does change the height of the rail',
      tall.rail - short.rail > 100,
      `rail ${String(short.rail)} on HTML against ${String(tall.rail)} on Markdown`,
    );
    check(
      label,
      'an empty result is the same size whatever the rail beside it is doing',
      Math.abs(tall.output - short.output) <= 2,
      `output ${String(short.output)} on HTML against ${String(tall.output)} on Markdown`,
    );
    /*
     * And it is the size of the sentence rather than of anything beside it.
     * Two panels that both stretched to the same wrong height would satisfy the
     * line above perfectly.
     */
    check(
      label,
      'and it is the size of what is in it, not of the rail beside it',
      tall.output > 0 && tall.output < tall.rail,
      `output ${String(tall.output)} against a ${String(tall.rail)}px rail`,
    );
  } finally {
    await emptyContext.close().catch(() => {});
  }

  /* -- 7. THE PORTS DISCLOSURE, AND THE KEYBOARD PATH INTO IT ------------ */
  /*
   * The footnote is closed by default, because open it is the tallest thing in
   * the content column - 389px against a 302px options rail, which is what made
   * the rail look stunted beside it. Collapsed it is 92px and the column is
   * 444px against that rail rather than 922.
   *
   * WHAT HAS TO SURVIVE BEING HIDDEN is the same pair the option notes are held
   * to: it must be reachable without a pointer, and the text must still be in
   * the document rather than conjured on demand. A `<details>` gives both
   * natively, which is why it is one rather than a button and a piece of state -
   * but "natively" is a claim about two engines, so it is measured in both.
   */
  const portsContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const portsPage = await portsContext.newPage();

  try {
    await portsPage.goto(`${ORIGIN}/tools/text-convert`, { waitUntil: 'networkidle' });
    await portsPage
      .getByRole('heading', { level: 1, name: 'Text convert' })
      .waitFor({ timeout: 15_000 });
    await portsPage.waitForTimeout(250);

    const shut = await portsPage.evaluate(() => {
      const details = document.querySelector('details');
      const table = document.querySelector('[class*="ports"]');
      const panel = [...document.querySelectorAll('section')].find(
        (el) => (el.querySelector('h2')?.textContent ?? '').trim() === 'Ports',
      );
      return {
        open: details?.open ?? null,
        panelHeight: panel === undefined ? 0 : Math.round(panel.getBoundingClientRect().height),
        /*
         * THE SENTENCES SPECIFICALLY, not the table's whole text. A port's
         * description is the thing that would be worth conjuring on demand and
         * therefore the thing worth asserting is not - and the first version of
         * this measured `textContent` of the whole table, which survives
         * `hidden`, `display: none` and anything else short of real removal. It
         * counted the port NAMES and called it proof about the sentences.
         */
        notes: document.querySelectorAll('[class*="portNote"]').length,
        text: [...document.querySelectorAll('[class*="portNote"]')]
          .map((note) => (note.textContent ?? '').trim())
          .join('').length,
      };
    });

    check(
      label,
      'the ports footnote starts closed',
      shut.open === false,
      `open=${String(shut.open)}, panel ${String(shut.panelHeight)}px`,
    );
    check(
      label,
      'and is a footnote rather than the tallest thing in the column when it is',
      shut.panelHeight > 0 && shut.panelHeight < 140,
      `${String(shut.panelHeight)}px`,
    );
    check(
      label,
      'its sentences are in the document while it is shut, not conjured on opening',
      shut.notes >= 3 && shut.text > 100,
      `${String(shut.notes)} sentences, ${String(shut.text)} characters`,
    );

    /* -- Opened from the keyboard alone ---------------------------------- */
    /*
     * Tab to the summary and press Enter. A disclosure a pointer can open and a
     * keyboard cannot would be the same defect as a hover-only control, in a
     * place nobody would look for it.
     */
    await portsPage.locator('h1').first().click();
    let reached = false;
    for (let step = 0; step < 40 && !reached; step += 1) {
      await portsPage.keyboard.press('Tab');
      reached = await portsPage.evaluate(
        () => document.activeElement?.tagName.toLowerCase() === 'summary',
      );
    }
    check(label, 'the ports summary is reachable by Tab', reached, '');

    await portsPage.keyboard.press('Enter');
    await portsPage.waitForTimeout(200);

    const afterKey = await portsPage.evaluate(() => {
      const details = document.querySelector('details');
      const panel = [...document.querySelectorAll('section')].find(
        (el) => (el.querySelector('h2')?.textContent ?? '').trim() === 'Ports',
      );
      const note = document.querySelector('[class*="portNote"]');
      return {
        open: details?.open ?? null,
        panelHeight: panel === undefined ? 0 : Math.round(panel.getBoundingClientRect().height),
        noteHeight: note === null ? 0 : Math.round(note.getBoundingClientRect().height),
      };
    });

    check(
      label,
      'Enter on it opens the footnote and paints the table',
      afterKey.open === true &&
        afterKey.noteHeight > 0 &&
        afterKey.panelHeight > shut.panelHeight + 100,
      `${String(shut.panelHeight)} -> ${String(afterKey.panelHeight)}px, a sentence is ${String(
        afterKey.noteHeight,
      )}px`,
    );
  } finally {
    await portsContext.close().catch(() => {});
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
    /*
     * FOUR TARGETS, AND `exact` ON THE NAME.
     *
     * Round three split HTML into "HTML (normalised)" and "HTML (sanitised)",
     * and a locator asking for "HTML" then matched both - which Playwright
     * refuses rather than guessing, correctly. Both are listed here because
     * they are two layouts to measure, not one.
     */
    for (const target of [
      'HTML (normalised)',
      'HTML (sanitised)',
      'Markdown',
      'Plain text (strip formatting)',
    ]) {
      await targetPage.getByRole('combobox', { name: 'Target format' }).click();
      await targetPage.getByRole('option', { name: target, exact: true }).click();
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
     * Three of the four layouts put Run on screen without scrolling; Markdown's
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
     * is the SAME distance in all four layouts - which is the whole difference
     * between a control that travels with its panel and one adrift in reserved
     * space. Measured at 29px; asserted as a bound and an agreement rather than
     * as that number, because the chrome is a border and a padding rather than
     * a token this script can read.
     */
    /*
     * THE FOUR MEASUREMENTS ARE FOUR DIFFERENT LAYOUTS, which every assertion
     * below assumes and none of them checked. A combobox that stopped changing
     * the options panel - or four reads of one layout - satisfies both of the
     * lines under here perfectly: the gaps agree because they are the same gap,
     * and Run is on screen because it is the same Run. The comment above
     * already says which layout is the tall one, so that is what is asserted.
     */
    const runs = seen.map((entry) => entry.run);
    check(
      label,
      'each target really draws its own layout rather than the same one four times',
      new Set(runs).size > 1 &&
        Math.max(...runs) === seen.find((entry) => entry.target === 'Markdown')?.run,
      seen.map((entry) => `${entry.target} at ${String(entry.run)}`).join(', '),
    );

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
 * transformed plane, and the grid, which does resize with the root, repaints in
 * well under a frame. See the measured table in architecture.md. What is NOT
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
     * AND THE GRID IS REDRAWN IN THE FRAME THE CANVAS IS RESIZED IN.
     *
     * The slide narrows the canvas every frame, and the grid is a bitmap that
     * has to be told. It used to be told through React, which renders after
     * the frame paints - so every frame of the slide painted the previous
     * frame's bitmap stretched into the new box, up to a hundred pixels of
     * squeeze at the right edge, and the grid appeared to shift as the panel
     * opened and closed. Nothing about where the rules rest was ever wrong.
     *
     * Read from a ResizeObserver created AFTER the grid's own, which is
     * therefore called after it in every frame and is the last script to run
     * before that frame paints: what it sees is what is painted. A count of
     * the distinct widths it saw goes beside the verdict, because an observer
     * that was never called passes "no frame disagreed" perfectly.
     */
    const resized = await page.evaluate(async () => {
      const root = document.querySelector('[data-testid="canvas-root"]');
      const grid = document.querySelector('[data-testid="canvas-grid"]');
      const frames = [];
      const observer = new ResizeObserver(() => {
        const box = grid.getBoundingClientRect();
        frames.push({
          box: Math.round(box.width * window.devicePixelRatio * 100) / 100,
          bitmap: grid.width,
        });
      });
      observer.observe(root);
      const toggle = [...document.querySelectorAll('button')].find(
        (button) => button.textContent.trim() === 'Inspector',
      );
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      toggle.click();
      await wait(450);
      toggle.click();
      await wait(450);
      observer.disconnect();
      return {
        widths: new Set(frames.map((frame) => Math.round(frame.box))).size,
        stale: frames.filter((frame) => Math.abs(frame.box - frame.bitmap) > 1),
        frames: frames.length,
      };
    });

    check(
      label,
      'every frame of the slide paints a grid drawn for that frame',
      resized.widths >= 4 && resized.stale.length === 0,
      `${String(resized.stale.length)} of ${String(resized.frames)} frames painted a bitmap drawn for another width, over ${String(resized.widths)} widths${resized.stale.length > 0 ? ` - first ${JSON.stringify(resized.stale[0])}` : ''}`,
    );
    await checkInspectorToggleLook(page, label, '1440px');

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
     *
     * THE FRAME COUNT USED TO BE THE ASSERTION, AND IT WAS A RACE.
     *
     * It read the panel's width "two frames in" and required it to be at rest,
     * on the reasoning that two frames is far less than a slide. Two frames is
     * a duration this harness does not control: under the load of a full run it
     * failed about one time in three, which three sessions wrote off as
     * environmental. Measured instead - the exact sequence below, twelve runs
     * across both engines - the app is right every time: under reduced motion
     * the panel is 0 and then 340, with nothing in between, while a normal
     * context walks 13, 201, 281, 318 on the way. The check above this one says
     * the rule out loud: "a timing assertion in this harness would be flaky".
     *
     * So the question becomes one a late frame cannot answer wrongly. Sample
     * every frame and count the INTERMEDIATE widths - the panel caught part way
     * across. A slow machine can only REMOVE samples, so the count is an
     * under-report and never an over-report, and the two measurements are
     * compared with each other: the control is the same code WITHOUT the
     * preference, and it has to find several.
     *
     * THE BOUND IS ONE RATHER THAN ZERO, AND THAT WAS THIS CHECK'S OWN BUG.
     * It asserted zero, on the premise that "nothing ever draws the panel
     * there". The app draws it there: the shared override collapses the
     * animation to 1ms rather than removing it, deliberately, so
     * `animationend` still fires - and a frame can land inside 1ms. See the
     * note on the assertion itself for the measurement.
     */
    const traceOpen = async (page) =>
      page.evaluate(async () => {
        const root = document.querySelector('[data-testid="canvas-root"]');
        root.focus();
        const pressedAt = performance.now();
        root.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true }));

        const widths = [];
        let firstFrameMs = null;
        for (let frame = 0; frame < 12; frame += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          firstFrameMs ??= Math.round(performance.now() - pressedAt);
          const panel = document.querySelector('[data-testid="node-inspector"]');
          widths.push(panel ? Math.round(panel.getBoundingClientRect().width) : 0);
        }

        const panel = document.querySelector('[data-testid="node-inspector"]');
        return {
          widths,
          firstFrameMs,
          duration: panel ? getComputedStyle(panel).animationDuration : null,
          resting: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
        };
      });

    const partWayAcross = (trace) =>
      trace.widths.filter((width) => width > 0 && width < trace.resting);

    const reduced = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    });
    const reducedPage = await reduced.newPage();
    try {
      await gotoCanvas(reducedPage);
      await reducedPage.locator('[role="application"]').first().waitFor({ timeout: 15_000 });
      await setInspector(reducedPage, false);

      const instant = await traceOpen(reducedPage);
      const midway = partWayAcross(instant);

      /*
       * AT MOST ONE SAMPLE PART WAY ACROSS, NOT NONE - AND THE DIFFERENCE IS A
       * BUG IN THIS CHECK RATHER THAN IN THE APP.
       *
       * The version this replaces asserted `midway.length === 0`, on the stated
       * premise that "a slow machine removes samples; it cannot invent one
       * between 0 and the resting width, because nothing ever draws the panel
       * there". That premise is false, and the app is the reason it is false:
       * the shared reduced-motion override collapses the animation to **1ms**
       * rather than removing it, deliberately, so that `animationend` still
       * fires. A panel animating from 0 to 340 over 1ms really is drawn part
       * way across, for one millisecond, and a `requestAnimationFrame` callback
       * can land inside it.
       *
       * Measured, because "flaky" is not a diagnosis: ten passes of this check
       * on an idle machine failed twice, at 25px, 134px, 252px and 258px across
       * runs - arbitrary points in the slide, which is the signature of a frame
       * landing inside the window rather than of a panel stopping anywhere. The
       * identical ten passes against the previous commit failed twice as well,
       * so it is neither new nor caused by whatever is being changed around it.
       *
       * ONE IS A BOUND RATHER THAN A TOLERANCE. Frames are at least ~4ms apart
       * in any engine this drives, and the animation is 1ms, so at most one
       * sample can ever fall inside it. Two would mean the animation is longer
       * than a frame interval, which is the defect this check is for. The
       * control below still has to find several, so "hardly any" cannot be
       * satisfied by a measurement that can see nothing.
       */
      check(
        label,
        'reduced motion ends the slide rather than merely shortening it',
        instant.duration === '0.001s' && instant.resting >= 335 && midway.length <= 1,
        `duration ${String(instant.duration)}, ${String(instant.resting)}px at rest, widths ${instant.widths.join(',')}`,
      );
    } finally {
      await reduced.close().catch(() => {});
    }

    /*
     * THE CONTROL, WITHOUT WHICH THE LINE ABOVE IS SATISFIED BY A PANEL THAT
     * NEVER MOVES AT ALL. If the slide were removed for everybody, or if this
     * measurement simply could not see one, "no intermediate width" would be
     * true for the wrong reason - which is the shape this whole file spent a
     * round removing.
     */
    const moving = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const movingPage = await moving.newPage();
    try {
      await gotoCanvas(movingPage);
      await movingPage.locator('[role="application"]').first().waitFor({ timeout: 15_000 });
      await setInspector(movingPage, false);

      const slide = await traceOpen(movingPage);
      const midway = partWayAcross(slide);

      /*
       * The one condition under which finding nothing says nothing about the
       * app: a first frame that landed after the whole 150 ms animation was
       * over. That is a machine too loaded to sample inside the window, it is a
       * NUMBER rather than a hunch, and it is a skip rather than a pass -
       * because a pass here would be the check being satisfied by an absence,
       * which is the shape this file spent a round removing.
       */
      if (midway.length === 0 && (slide.firstFrameMs ?? 0) > 150) {
        skip(
          label,
          'the panel caught part way across',
          `the first frame landed ${String(slide.firstFrameMs)}ms after the keystroke, past the 150ms slide, so nothing could be sampled during it`,
        );
      } else {
        check(
          label,
          'and without the preference the panel really is caught part way across',
          slide.duration !== '0.001s' && midway.length > 0,
          `duration ${String(slide.duration)}, first frame ${String(slide.firstFrameMs)}ms in, widths ${slide.widths.join(',')}`,
        );
      }
    } finally {
      await moving.close().catch(() => {});
    }

    /*
     * AT A PHONE'S WIDTH THE PANEL IS A SHEET OVER THE CANVAS, which nothing
     * has to move out of the way for, so opening it cannot move the grid by
     * construction - and that is exactly the kind of claim that goes stale.
     * The strip of canvas above the sheet is captured closed, open and closed
     * again, with the canvas chrome hidden, and has to be the same bytes all
     * three times. The partners: the sheet really is up and really stops below
     * the strip, and the strip really has grid in it.
     */
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    const phonePage = await phone.newPage();
    try {
      await gotoCanvas(phonePage);
      await phonePage.locator('[data-testid="canvas-grid"]').waitFor({ timeout: 15_000 });
      await phonePage.waitForTimeout(600);
      await setInspector(phonePage, false);

      const strip = await phonePage.evaluate(() => {
        const box = document.querySelector('[data-testid="canvas-root"]').getBoundingClientRect();
        return { x: box.left, y: box.top, width: box.width, height: Math.floor(box.height * 0.3) };
      });
      const capture = () => gridShot(phonePage, { clip: strip });

      const closed = await capture();
      await setInspector(phonePage, true);
      await phonePage.waitForTimeout(400);
      const sheet = await phonePage.evaluate(() => {
        const panel = document.querySelector('[data-testid="node-inspector"]');
        return panel ? panel.getBoundingClientRect().top : null;
      });
      const open = await capture();
      await setInspector(phonePage, false);
      await phonePage.waitForTimeout(400);
      const closedAgain = await capture();

      const inked = await phonePage.evaluate(
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
          const shades = new Set();
          for (let i = 0; i < data.length; i += 4) shades.add(`${data[i]},${data[i + 1]}`);
          return shades.size;
        },
        [...closed],
      );

      check(
        label,
        'at 390px the sheet opens and closes without moving a single pixel of grid above it',
        sheet !== null &&
          sheet >= strip.y + strip.height &&
          inked >= 2 &&
          open.equals(closed) &&
          closedAgain.equals(closed),
        `sheet top ${String(sheet)} below a strip ending ${String(strip.y + strip.height)}, ${String(inked)} shades in the strip, open ${open.equals(closed) ? 'identical' : 'DIFFERENT'}, closed again ${closedAgain.equals(closed) ? 'identical' : 'DIFFERENT'}`,
      );
      await checkInspectorToggleLook(phonePage, label, '390px');
    } finally {
      await phone.close().catch(() => {});
    }
  } finally {
    await context.close().catch(() => {});
  }
}

/* ========================================================================== *
 * THE CANVAS'S MOTION
 * ========================================================================== */

/**
 * FIVE PIECES OF MOTION, EACH SAMPLED FRAME BY FRAME, AND EACH AGAIN WITH THE
 * PREFERENCE THAT REMOVES IT.
 *
 * A wire draws in, a node settles, a port flicks when a wire lands, a node's
 * timing figure counts up, and the grid draws in once per page load. jsdom runs
 * no animation and has no layout, so none of that is visible to the unit suite;
 * `motion.test.tsx` holds WHEN each one fires and this holds that it MOVES.
 *
 * EVERY ASSERTION IS ABOUT A STATE OR A POSITION, NEVER ABOUT HOW LONG
 * ANYTHING TOOK. The inspector's own motion check spent a round learning why:
 * "two frames in" is a duration this harness does not control, and a slow
 * machine turns it into a failure. So each piece is asked questions a late
 * frame cannot answer wrongly - was it caught part of the way, did it only ever
 * move one way, did it stop where it rests, did anything else move - and a slow
 * machine can only REMOVE samples, never invent one. Where a machine is so slow
 * that the first frame landed after the whole animation, that is a skip naming
 * the number, not a pass.
 *
 * REDUCED MOTION IS ASSERTED, NOT ASSUMED, and against the specific trap the
 * brief named: the shared override in global.css collapses animations to 1ms
 * rather than removing them, and a frame can land inside 1ms. So under the
 * preference these assert that the animation does not EXIST - no arrival class
 * written, `animation-name: none` computed - rather than that it was not seen,
 * which is a claim about a sampler. The normal pass is the positive partner: it
 * shows every one of these is observable in the first place.
 */
async function checkCanvasMotion(browser, label) {
  for (const reduced of [false, true]) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      ...(reduced ? { reducedMotion: 'reduce' } : {}),
    });
    try {
      await motionPass(await context.newPage(), label, reduced);
    } finally {
      await context.close().catch(() => {});
    }
  }
}

/**
 * The page half: readers, and a sampler that runs one of them every frame.
 *
 * Installed once per document. The sampler is bounded by a window rather than
 * a frame count, because a frame count is a duration that differs by five
 * times between the two engines here; the window is only how long to look, and
 * nothing is asserted about it.
 */
const MOTION_PAGE = () => {
  /*
   * THE GRID, READ OFF ITS BITMAP AND SORTED BY RANK.
   *
   * The draw-in changes only the ink of each rank, on one bitmap with nothing
   * on the element, so the bitmap is the whole of what the screen shows - and
   * `ruled` below asserts the "nothing on the element" half every frame.
   *
   * The baseline is taken BEHIND THE COLD OPEN, where the layer already holds
   * the finished grid at the viewport the draw-in will use. One row, the
   * quietest, so it crosses the vertical rules and no horizontal one. A rule's
   * rank is read from where it falls between two heavy rules - the heavy ones
   * are the runs in the major ink at full alpha - at sixteenths of the heavy
   * pitch: a rule at 8/16 is the rank below heavy, at 4/16 and 12/16 the next,
   * and so on down, which is how the ladder subdivides.
   */
  const gridRow = (canvas, y) => canvas.getContext('2d').getImageData(0, y, canvas.width, 1).data;
  const baseline = () => {
    const canvas = document.querySelector('[data-testid="canvas-grid"]');
    const context = canvas.getContext('2d');
    const { width, height } = canvas;
    const all = context.getImageData(0, 0, width, height).data;
    let row = 0;
    let quietest = Infinity;
    for (let y = 0; y < height; y += 1) {
      let sum = 0;
      for (let x = 0; x < width; x += 1) sum += all[(y * width + x) * 4 + 3];
      if (sum < quietest) {
        quietest = sum;
        row = y;
      }
    }
    const data = gridRow(canvas, row);
    const probe = document.createElement('canvas').getContext('2d');
    probe.fillStyle = getComputedStyle(canvas).getPropertyValue('--pb-canvas-grid-major').trim();
    probe.fillRect(0, 0, 1, 1);
    const major = probe.getImageData(0, 0, 1, 1).data;

    const runs = [];
    for (let x = 0; x < width; x += 1) {
      if (data[x * 4 + 3] === 0) continue;
      if (runs.length > 0 && runs.at(-1).end === x) runs.at(-1).end = x + 1;
      else runs.push({ start: x, end: x + 1 });
    }
    const isMajor = (x) =>
      data[x * 4 + 3] === 255 && [0, 1, 2].every((c) => Math.abs(data[x * 4 + c] - major[c]) <= 2);
    const heavy = runs.filter((run) => isMajor(run.start)).map((run) => run.start);
    const gaps = heavy
      .slice(1)
      .map((at, i) => at - heavy[i])
      .sort((a, b) => a - b);
    const pitch = gaps[Math.floor(gaps.length / 2)] ?? 0;
    const rankOf = new Int8Array(width).fill(-1);
    for (const run of runs) {
      const before = heavy.filter((at) => at <= run.start).at(-1) ?? (heavy[0] ?? 0) - pitch;
      let k = Math.round(((run.start - before) / pitch) * 16) % 16;
      let rank = 0;
      if (k !== 0) {
        rank = 4;
        while (k % 2 === 0) {
          k /= 2;
          rank -= 1;
        }
      }
      for (let x = run.start; x < run.end; x += 1) rankOf[x] = rank;
    }
    const full = [0, 0, 0, 0, 0];
    for (let x = 0; x < width; x += 1) if (rankOf[x] >= 0) full[rankOf[x]] += data[x * 4 + 3];
    window.__gridBaseline = { row, rankOf: [...rankOf], full, finalRow: [...data] };
    return {
      row,
      pitch,
      heavy: heavy.length,
      ranks: full.map((sum) => sum > 0),
      width,
    };
  };
  const rect = (element) => {
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return [box.left, box.top, box.width, box.height].map((v) => Math.round(v * 10) / 10).join(',');
  };
  const node = (id) => document.querySelector(`[data-testid="node-${id}"]`);
  const glyph = (id, side, port) =>
    node(id)?.querySelector(`[data-port-side="${side}"][data-port-id="${port}"] svg`) ?? null;
  const named = (element, part) =>
    element === null
      ? []
      : element
          .getAnimations()
          .map((animation) => animation.animationName ?? '')
          .filter((name) => name.includes(part));

  /** What the brightest ink resolves to here, measured on a real element. */
  const inkPrimary = () => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--pb-ink-primary)';
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  };

  const readers = {
    /*
     * Each rank's ink on the baseline row as a share of its ink at rest, plus
     * the three things a frame must never do: ink a pixel the finished grid
     * leaves bare (a rule that travels), hold a bitmap that is not its box
     * (the stretch last round fixed), or carry CSS that makes the screen differ
     * from the bitmap.
     */
    grid: () => {
      const grid = document.querySelector('[data-testid="canvas-grid"]');
      const base = window.__gridBaseline;
      if (!grid || !base) return null;
      const data = gridRow(grid, base.row);
      const sums = [0, 0, 0, 0, 0];
      let stray = 0;
      let exact = data.length === base.finalRow.length;
      for (let x = 0; x < grid.width; x += 1) {
        const alpha = data[x * 4 + 3];
        if (base.rankOf[x] >= 0) sums[base.rankOf[x]] += alpha;
        else if (alpha > 0) stray += 1;
        for (let c = 0; c < 4 && exact; c += 1) {
          if (data[x * 4 + c] !== base.finalRow[x * 4 + c]) exact = false;
        }
      }
      const dpr = window.devicePixelRatio;
      const box = grid.getBoundingClientRect();
      const style = getComputedStyle(grid);
      return {
        ink: sums.map((sum, rank) =>
          base.full[rank] > 0 ? Math.round((sum / base.full[rank]) * 1000) / 1000 : null,
        ),
        stray,
        exact,
        boxed:
          grid.width === Math.round(box.width * dpr) &&
          grid.height === Math.round(box.height * dpr),
        ruled:
          style.animationName === 'none' && (style.clipPath === 'none' || style.clipPath === ''),
        drawing: grid.hasAttribute('data-draw-in'),
      };
    },
    settle: ({ still }) => {
      const nodes = [...document.querySelectorAll('[data-node-id]')];
      const arrived = nodes.find((element) => !still.includes(element.dataset.nodeId)) ?? null;
      return {
        id: arrived?.dataset.nodeId ?? null,
        width: arrived ? Math.round(arrived.getBoundingClientRect().width * 10) / 10 : null,
        classed: arrived?.className.includes('nodeArriving') ?? false,
        running: named(arrived, 'node-settle').length,
        others: still.map((id) => rect(node(id))).join(' '),
      };
    },
    connect: ({ from, to, before }) => {
      const wire =
        [...document.querySelectorAll('[data-edge-id]')].find(
          (element) => !before.includes(element.getAttribute('data-edge-id')),
        ) ?? null;
      const stroke = wire?.querySelector('path:last-child') ?? null;
      const style = stroke ? getComputedStyle(stroke) : null;
      const out = glyph(from, 'output', 'output');
      const into = glyph(to, 'input', 'input');
      const timing = node(to)?.querySelector('[data-final]') ?? null;
      return {
        wire: stroke !== null,
        dash: style ? style.strokeDasharray : null,
        offset: style ? Number.parseFloat(style.strokeDashoffset) : null,
        wireClassed: stroke?.getAttribute('class')?.includes('wireArriving') ?? false,
        wireRunning: named(stroke, 'wire-draw').length,
        out: out ? getComputedStyle(out).color : null,
        into: into ? getComputedStyle(into).color : null,
        contactClassed:
          (out?.getAttribute('class')?.includes('portContact') ?? false) ||
          (into?.getAttribute('class')?.includes('portContact') ?? false),
        // Empty is no figure: a run holds the last one's box with nothing in it.
        text: timing?.textContent || null,
        final: timing?.getAttribute('data-final') ?? null,
        timingBox: rect(timing),
        titleBox: rect(node(to)?.querySelector('[class*="nodeTitle"]') ?? null),
        nodes: `${rect(node(from))} ${rect(node(to))}`,
        status: node(to)?.dataset.status ?? null,
      };
    },
    quiet: ({ to }) => {
      const timing = node(to)?.querySelector('[data-final]') ?? null;
      return {
        // Empty is no figure: a run holds the last one's box with nothing in it.
        text: timing?.textContent || null,
        final: timing?.getAttribute('data-final') ?? null,
        status: node(to)?.dataset.status ?? null,
        titleBox: rect(node(to)?.querySelector('[class*="nodeTitle"]') ?? null),
        motion: document
          .getAnimations()
          .map((animation) => animation.animationName ?? '')
          .filter((name) => /wire-draw|node-settle|port-contact|grid-draw/.test(name)),
      };
    },
  };

  window.__motion = {
    inkPrimary,
    gridBaseline: baseline,
    /**
     * Runs `act`, then samples `reader` every frame for `ms`. `act` is a
     * selector to click, so a click and the first sample are in the same task
     * and the first frame after the click is the first frame read.
     *
     * `window.__motionStopWhen`, if a caller installed one, ends the window
     * early on the frame it first returns true - so `ms` can be a ceiling for
     * a wait that is really for a state, rather than a guess at how long the
     * state takes to arrive.
     */
    sample: (reader, args, ms, act) =>
      new Promise((resolve) => {
        const started = performance.now();
        const samples = [];
        let firstFrameMs = null;
        if (act) document.querySelector(act)?.click();
        const tick = (now) => {
          firstFrameMs ??= Math.round(now - started);
          samples.push(readers[reader](args));
          if (now - started < ms && !(window.__motionStopWhen?.() ?? false)) {
            requestAnimationFrame(tick);
          } else {
            window.__motionStopWhen = undefined;
            resolve({ samples, firstFrameMs });
          }
        };
        requestAnimationFrame(tick);
      }),
  };
};

/** Values strictly between two ends: the animation caught part of the way. */
const between = (values, low, high) => values.filter((value) => value > low && value < high);

/** A sequence with its repeats folded, for a detail line a person can read. */
const steps = (values) =>
  values.filter((value, index) => index === 0 || value !== values[index - 1]).join(',');

/** Whether a sequence only ever moves one way. */
const monotone = (values, direction) =>
  values.every((value, index) => index === 0 || direction * (value - values[index - 1]) >= -1e-6);

async function motionPass(page, label, reduced) {
  const mode = reduced ? 'under reduced motion' : '';
  const say = (text) => (reduced ? `${text}, ${mode}` : text);
  const install = () => page.evaluate(MOTION_PAGE);
  const sample = (reader, args, ms, act = null) =>
    page.evaluate(([r, a, m, c]) => window.__motion.sample(r, a, m, c), [reader, args, ms, act]);

  /* -- 5. The grid, on the one page load that has a cold open -------------- */

  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await install();

  /*
   * NOT BEHIND THE PANEL. The cold open covers the whole viewport, and a first
   * visit is exactly the page load the grid draws in on - so a draw-in that ran
   * behind the introduction would be the one draw-in this page gets, spent
   * where nobody can see it.
   */
  const base = await page.evaluate(() => window.__motion.gridBaseline());
  const behind = await sample('grid', {}, 150);
  check(
    label,
    say('the grid does not draw in behind the cold open, where nobody can see it'),
    behind.samples.length > 0 &&
      behind.samples.every((reading) => reading !== null && !reading.drawing && reading.exact),
    `${String(behind.samples.length)} frames behind the panel, ${String(
      behind.samples.filter((reading) => reading?.drawing).length,
    )} of them drawing; baseline row ${String(base.row)}, heavy pitch ${String(base.pitch)}px, ranks ${base.ranks
      .map((on, rank) => (on ? String(rank) : '-'))
      .join('')}`,
  );

  const sweep = await sample('grid', {}, 700, '#cold-open-start');
  const frames = sweep.samples.filter((reading) => reading !== null);
  /** The ranks this zoom actually draws, coarsest first. */
  const ranks = base.ranks.flatMap((on, rank) => (on ? [rank] : []));
  const finest = ranks.at(-1);
  const inkOf = (reading, rank) => reading.ink[rank] ?? 0;
  const strip = (reading) => ranks.map((rank) => inkOf(reading, rank).toFixed(2)).join('/');

  /*
   * THE PLACEMENT HOLDS ON EVERY FRAME, in both passes: the bitmap is its box,
   * nothing is on the element, and no pixel is inked that the grid at rest
   * leaves bare. The last is what "converging rather than travelling" means
   * as a state - every rule is in its final place from its first frame.
   */
  check(
    label,
    say(
      'every frame of the grid arriving is a bitmap its own box, with every rule already in its place',
    ),
    frames.length > 0 &&
      ranks.length >= 3 &&
      frames.every((reading) => reading.boxed && reading.ruled && reading.stray === 0),
    `${String(frames.filter((reading) => !reading.boxed).length)} unboxed, ${String(
      frames.filter((reading) => !reading.ruled).length,
    )} with CSS on the layer, ${String(
      frames.reduce((sum, reading) => sum + reading.stray, 0),
    )} stray pixels, over ${String(frames.length)} frames`,
  );

  if (reduced) {
    check(
      label,
      say('the grid is simply there, with no draw-in at all'),
      frames.length > 0 && frames.every((reading) => reading.exact && !reading.drawing),
      `${String(frames.filter((reading) => !reading.exact).length)} of ${String(
        frames.length,
      )} frames not the grid at rest; first ${frames[0] ? strip(frames[0]) : 'none'}`,
    );
  } else {
    const partWay = frames.filter((reading) =>
      ranks.some((rank) => inkOf(reading, rank) > 0 && inkOf(reading, rank) < 1),
    );
    if (partWay.length === 0 && (sweep.firstFrameMs ?? 0) > 400) {
      skip(
        label,
        'the grid caught part way through drawing in',
        `first frame ${String(sweep.firstFrameMs)}ms after the click, past the 400ms draw-in`,
      );
    } else {
      /*
       * No frame of the finished grid first. The bitmap behind the panel IS
       * the finished grid, so a draw-in that begins a tick late shows it for a
       * frame and then takes it away - which the first build of this did.
       */
      check(
        label,
        'the first frame after the cold open comes down is not the finished grid',
        frames.length > 0 && ranks.every((rank) => inkOf(frames[0], rank) < 1),
        `first frame ${frames[0] ? strip(frames[0]) : 'none'}, ${String(sweep.firstFrameMs)}ms after the click`,
      );
      const ordered = frames.every((reading) =>
        ranks.every(
          (rank, i) => i === 0 || inkOf(reading, rank) <= inkOf(reading, ranks[i - 1]) + 0.02,
        ),
      );
      const rising = ranks.every((rank) =>
        monotone(
          frames.map((reading) => inkOf(reading, rank)),
          1,
        ),
      );
      const structureFirst = frames.some(
        (reading) => inkOf(reading, ranks[0]) > 0 && inkOf(reading, finest) === 0,
      );
      check(
        label,
        'the grid assembles coarse to fine: heavy rules first, no finer rank ever ahead of a coarser one',
        structureFirst && ordered && rising && partWay.length >= 3 && frames.at(-1).exact,
        `${String(partWay.length)} part-way frames; heavy-alone ${String(structureFirst)}, ordered ${String(
          ordered,
        )}, rising ${String(rising)}, ends at rest ${String(frames.at(-1)?.exact)}; ${[
          ...new Set(frames.map(strip)),
        ]
          .slice(0, 12)
          .join(' ')}`,
      );
    }
  }

  /*
   * ONCE PER PAGE LOAD: not on the way back from another route, and again on a
   * reload. Read off the class the draw-in leaves behind, which is a state -
   * the animation itself is long over by the time a route has loaded.
   */
  await page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('link', { name: 'Tools' })
    .click();
  await page.waitForURL(/\/tools$/);
  await page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Home' }).click();
  await page.locator('[data-testid="canvas-grid"]').waitFor({ timeout: 15_000 });
  await install();
  const back = await sample('grid', {}, 150);
  check(
    label,
    say('coming back to the canvas from /tools does not draw the grid in again'),
    back.samples.length > 0 &&
      back.samples.every((reading) => reading !== null && !reading.drawing && reading.exact),
    `${String(back.samples.filter((reading) => reading?.drawing).length)} of ${String(back.samples.length)} frames drawing`,
  );
  await page.reload({ waitUntil: 'networkidle' });
  const reloaded = await page.evaluate(
    () =>
      document.querySelector('[data-testid="canvas-grid"]')?.hasAttribute('data-draw-in') ?? false,
  );
  /*
   * Under the preference a reload spends the draw-in without running it, so
   * the attribute - "this mount drew the grid in" - is absent there, which is
   * the partner of the no-draw-in check above rather than a gap in this one.
   */
  check(
    label,
    say(
      reduced
        ? 'a reload does not draw the grid in either'
        : 'a reload is a cold open, and draws the grid in again',
    ),
    reduced ? !reloaded : reloaded,
    '',
  );

  /* -- 2. A node settles -------------------------------------------------- */

  const addTool = async (testId, still) => {
    await page.getByRole('button', { name: 'Add tool' }).click();
    await page.locator('[role="dialog"]').first().waitFor({ timeout: 10_000 });
    await install();
    return sample('settle', { still }, 400, `[data-testid="dialog-option-${testId}"]`);
  };

  await addTool('base64', []);
  await page.waitForTimeout(300);
  const [first] = await page.evaluate(() =>
    [...document.querySelectorAll('[data-node-id]')].map((element) => element.dataset.nodeId),
  );

  const settle = await addTool('hash', [first]);
  const widths = settle.samples.map((reading) => reading.width).filter((width) => width !== null);
  const second = settle.samples.find((reading) => reading.id !== null)?.id ?? null;
  const othersStill = new Set(settle.samples.map((reading) => reading.others)).size === 1;

  if (reduced) {
    check(
      label,
      say('a new node arrives at its own size, with no settle'),
      widths.length > 0 &&
        widths.every((width) => Math.abs(width - 224) <= 0.5) &&
        settle.samples.every((reading) => !reading.classed && reading.running === 0),
      `widths ${[...new Set(widths)].join(',')}`,
    );
  } else {
    const partWay = between(widths, 0, 223.5);
    if (partWay.length === 0 && (settle.firstFrameMs ?? 0) > 120) {
      skip(
        label,
        'a new node caught part way through settling',
        `first frame ${String(settle.firstFrameMs)}ms after the click, past the 120ms settle`,
      );
    } else {
      check(
        label,
        'a new node settles from about 96% to its own size, never past it',
        new Set(partWay).size >= 2 &&
          widths[0] >= 224 * 0.955 &&
          widths[0] < 223.5 &&
          monotone(widths, 1) &&
          Math.max(...widths) <= 224.5 &&
          Math.abs(widths.at(-1) - 224) <= 0.5,
        `widths ${steps(widths)}`,
      );
    }
  }
  check(
    label,
    say('and nothing else on the canvas moves while it does'),
    othersStill,
    `${String(new Set(settle.samples.map((reading) => reading.others)).size)} distinct positions for the node already there`,
  );

  /* -- 1, 3 and 4. A wire lands ------------------------------------------ */

  /*
   * THE COUNT NEEDS A RUN LONG ENOUGH TO HAVE A NUMBER IN IT. Nodes here run in
   * 1-8ms and a figure under a millisecond has nothing to count, so the hash is
   * fed four megabytes - which takes more than 2ms on any machine this could
   * plausibly run on. That is a precondition, stated and checked below, not a
   * measurement: if the figure is under 2ms the count assertion FAILS saying
   * so, rather than passing on a count that had nothing to show.
   */
  await page.locator(`[data-testid="node-${first}"]`).focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('node-inspector').waitFor({ timeout: 10_000 });
  await page
    .locator('[data-inspector-input]')
    .first()
    .fill('x'.repeat(4 * 1024 * 1024));
  await page.waitForFunction(
    (id) => document.querySelector(`[data-testid="node-${id}"]`)?.dataset.status === 'ok',
    first,
    { timeout: 30_000 },
  );

  /*
   * THE OUTPUT BOX IS A PREVIEW AT THIS SIZE. A textarea is laid out whole,
   * and re-mounting one that holds the 5.6 MB base64 of this input after every
   * run held Gecko's main thread for ~620ms and WebKit's for ~1.3s per
   * keystroke upstream (round twenty-one; none once capped). Read as a state:
   * every read-only box holds at most the cap, and the one that was clipped
   * says so. The partner is that the value really is bigger than the box.
   */
  const boxes = await page.evaluate(() => {
    const inspector = document.querySelector('[data-testid="node-inspector"]');
    const areas = [...(inspector?.querySelectorAll('textarea[readonly]') ?? [])];
    return {
      lengths: areas.map((area) => area.value.length),
      hint:
        inspector?.textContent?.match(/Showing the first [\d,]+ of [\d,]+ characters/)?.[0] ?? null,
    };
  });
  check(
    label,
    say('a multi-megabyte result is previewed in its box, not laid out whole, and says so'),
    boxes.lengths.length > 0 &&
      boxes.lengths.every((length) => length <= 65_536) &&
      boxes.hint === 'Showing the first 65,536 of 5,592,408 characters',
    `box lengths ${boxes.lengths.join(',')}; ${String(boxes.hint)}`,
  );
  await setInspector(page, false);
  await page.waitForTimeout(400);

  const portCentre = async (id, side) => {
    const box = await page
      .locator(
        `[data-testid="node-${id}"] [data-port-side="${side}"][data-port-id="${side === 'output' ? 'output' : 'input'}"] svg`,
      )
      .boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const from = await portCentre(first, 'output');
  const to = await portCentre(second, 'input');
  const before = await page.evaluate(() =>
    [...document.querySelectorAll('[data-edge-id]')].map((element) =>
      element.getAttribute('data-edge-id'),
    ),
  );
  await install();
  const ink = await page.evaluate(() => window.__motion.inkPrimary());

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * step) / 8,
      from.y + ((to.y - from.y) * step) / 8,
    );
  }
  const landing = sample('connect', { from: first, to: second, before }, 1500);
  await page.mouse.up();
  // Off the port, so its hover colour is not what the last frames read.
  await page.mouse.move(to.x + 200, to.y + 200);
  const landed = await landing;
  const withWire = landed.samples.filter((reading) => reading.wire);

  check(
    label,
    say('the wire lands'),
    withWire.length > 0,
    `${String(withWire.length)} frames with the new wire`,
  );

  /*
   * THE DRAW, and not the travelling dash that follows it. The wire's own run
   * starts a few hundred milliseconds later and dashes the same stroke in real
   * lengths - `10px, 190px` from an offset of 200 - so the draw is read from the
   * frames that carry its class, and the frame after them has to be a plain
   * stroke or that dash, never the draw's own one-unit pattern held over.
   */
  const drawing = withWire.filter((reading) => reading.wireClassed);
  const afterDraw = withWire.slice(drawing.length);
  const offsets = drawing.map((reading) => reading.offset);
  if (reduced) {
    check(
      label,
      say('a new wire is simply there, whole, from its first frame'),
      withWire.length > 0 &&
        withWire.every(
          (reading) => reading.dash === 'none' && !reading.wireClassed && reading.wireRunning === 0,
        ),
      `dashes ${[...new Set(withWire.map((reading) => reading.dash))].join(',')}`,
    );
    check(
      label,
      say('neither port flicks'),
      withWire.every(
        (reading) => !reading.contactClassed && reading.out !== ink && reading.into !== ink,
      ),
      `ink ${ink}; out ${[...new Set(withWire.map((reading) => reading.out))].join(',')}; in ${[
        ...new Set(withWire.map((reading) => reading.into)),
      ].join(',')}`,
    );
  } else {
    const partWay = between(offsets, 0, 1);
    if (partWay.length === 0 && (landed.firstFrameMs ?? 0) > 150) {
      skip(
        label,
        'a new wire caught part way through drawing in',
        `first frame ${String(landed.firstFrameMs)}ms after the drop, past the 150ms draw`,
      );
    } else {
      check(
        label,
        'a new wire draws in from its output end rather than appearing whole',
        new Set(partWay).size >= 3 &&
          monotone(offsets, -1) &&
          withWire.slice(0, drawing.length).every((reading) => reading.wireClassed) &&
          afterDraw.length > 0 &&
          afterDraw.every((reading) => reading.dash !== '1px, 1px' && !reading.wireClassed) &&
          withWire.at(-1)?.dash === 'none',
        `${String(new Set(partWay).size)} part-way offsets ${offsets.map((value) => value.toFixed(2)).join(',')}, then ${[
          ...new Set(afterDraw.map((reading) => reading.dash)),
        ].join(' / ')}`,
      );
    }
    /*
     * THE FIRST FRAME WITH THE WIRE IS THE BRIGHT ONE - the claim the 33ms
     * rests on. An animation's clock starts on the first frame that draws it,
     * so however late the next frame is, this one cannot be missed.
     */
    check(
      label,
      'both ports flick to the brightest ink on the first frame the wire exists',
      withWire.length > 0 && withWire[0].out === ink && withWire[0].into === ink,
      `ink ${ink}; first frame out ${String(withWire[0]?.out)}, in ${String(withWire[0]?.into)}`,
    );
    check(
      label,
      'and drop back rather than staying lit',
      withWire.length > 0 && withWire.at(-1).out !== ink && withWire.at(-1).into !== ink,
      `last frame out ${String(withWire.at(-1)?.out)}, in ${String(withWire.at(-1)?.into)}`,
    );
  }

  /* The count. */
  const counted = withWire.filter((reading) => reading.text !== null);
  const finals = [...new Set(counted.map((reading) => reading.final))];
  const final = counted.at(-1)?.final ?? null;
  const texts = counted.map((reading) => reading.text);
  if (reduced) {
    check(
      label,
      say('the timing figure is shown as it is, with no count'),
      counted.length > 0 && counted.every((reading) => reading.text === reading.final),
      `texts ${[...new Set(texts)].join(',')}`,
    );
  } else {
    const value = (text) => Number.parseFloat(text);
    const enough = final !== null && !final.startsWith('<') && value(final) >= 2;
    check(
      label,
      'the run the wire causes is long enough to have a count in it at all',
      enough,
      `final figure ${String(final)} - under 2ms there is nothing to count, and the check below would prove nothing`,
    );
    if (enough) {
      check(
        label,
        'the timing figure counts up from zero to its value and stops there',
        /^0(\.00)?(ms|s)$/.test(texts[0]) &&
          monotone(texts.map(value), 1) &&
          texts.at(-1) === final &&
          new Set(texts).size >= 3 &&
          finals.length === 1,
        `${steps(texts)} (final ${String(final)})`,
      );
    }
  }
  const counting = counted.filter((reading) => reading.final === final);
  check(
    label,
    say('the count moves nothing beside it: the figure and the title hold their boxes'),
    counting.length > 0 &&
      new Set(counting.map((reading) => reading.timingBox)).size === 1 &&
      new Set(counting.map((reading) => reading.titleBox)).size === 1,
    `${String(new Set(counting.map((reading) => reading.timingBox)).size)} figure boxes, ${String(
      new Set(counting.map((reading) => reading.titleBox)).size,
    )} title boxes over ${String(counting.length)} frames`,
  );
  check(
    label,
    say('and neither node moves while the wire lands'),
    new Set(landed.samples.map((reading) => reading.nodes)).size === 1,
    `${String(new Set(landed.samples.map((reading) => reading.nodes)).size)} distinct positions`,
  );

  if (reduced) return;

  /* -- Nothing while a value is being typed ------------------------------- */

  /*
   * TYPED INTO THE NODE UPSTREAM, so every keystroke that reaches the
   * pipeline's debounce re-runs the node the wire landed on and hands it a new
   * figure - the exact event the count is otherwise armed for. The partner
   * below is that it really did get new figures; without one, "it never
   * counted" is satisfied by a node that never ran.
   */
  await page.locator(`[data-testid="node-${first}"]`).focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('node-inspector').waitFor({ timeout: 10_000 });
  const field = page.locator('[data-inspector-input]').first();
  await field.focus();
  await page.keyboard.press('End');
  await install();
  /*
   * UNTIL THE LAST KEYSTROKE'S RUN HAS LANDED - a state, with thirty seconds
   * as a ceiling rather than a guess. This was a six-second window, and it
   * failed two runs in three in Gecko at `e9ec507` and after it alike: each
   * keystroke into a four-megabyte controlled field holds Gecko's main thread
   * for one to three seconds, so the four keys took 7.6-9.9s to type and the
   * downstream figure landed at 9-12s, after the window had closed on a node
   * still `running`. WebKit lands it in about three. The window was measuring
   * the engine's keystroke cost, not the count.
   *
   * Each `input` event resets it, so a run that started for an earlier
   * keystroke cannot end it: the node has to go `running` after the LAST one
   * and come back `ok`. Typing is over when `keyboard.type` resolves, which
   * waits for every key to be handled.
   */
  await page.evaluate((id) => {
    const input = document.querySelector('[data-inspector-input]');
    let lastInput = performance.now();
    let ranSince = false;
    window.__typingDone = false;
    input.addEventListener('input', () => {
      lastInput = performance.now();
      ranSince = false;
    });
    window.__motionStopWhen = () => {
      const status = document.querySelector(`[data-testid="node-${id}"]`)?.dataset.status;
      if (status === 'running' && performance.now() > lastInput) ranSince = true;
      return window.__typingDone === true && ranSince && status === 'ok';
    };
  }, second);
  const quiet = sample('quiet', { to: second }, 30_000);
  await page.keyboard.type('abcd', { delay: 350 });
  await page.evaluate(() => {
    window.__typingDone = true;
  });
  const typed = await quiet;
  const shown = typed.samples.filter((reading) => reading.text !== null);
  /*
   * A NEW FIGURE, NOT MERELY A RUN. The first version of this partner accepted
   * a `running` frame as proof, and against a break that armed the count on
   * every keystroke it passed: the window ended with the node still running,
   * so no figure ever arrived for the count to be wrong about. A figure that
   * lands after a `running` frame is the event the count would fire on.
   */
  const firstRun = typed.samples.findIndex((reading) => reading.status === 'running');
  const reruns =
    firstRun !== -1 &&
    typed.samples
      .slice(firstRun)
      .some((reading) => reading.status === 'ok' && reading.text !== null);
  check(
    label,
    'typing re-runs the node downstream, and a new figure lands after typing begins',
    reruns,
    `the node went ${typed.samples
      .map((reading) => `${String(reading.status)} ${String(reading.text)}`)
      .filter((step, index, all) => index === 0 || step !== all[index - 1])
      .join(' > ')}`,
  );
  check(
    label,
    'and nothing counts or moves while somebody types',
    shown.every((reading) => reading.text === reading.final) &&
      typed.samples.every((reading) => reading.motion.length === 0),
    `${String(shown.filter((reading) => reading.text !== reading.final).length)} counting frames; motion ${[
      ...new Set(typed.samples.flatMap((reading) => reading.motion)),
    ].join(',')}`,
  );
  /*
   * A RUN MOVES NOTHING IN THE HEADER. The figure is cleared while a node
   * runs, and its box used to leave with it, so the title widened for the
   * running frames and narrowed when the next figure landed - on every
   * keystroke that re-ran the node. The partner is a running frame read AFTER
   * a figure was shown: the one state the shift lived in, actually observed.
   * A new figure may be a different width from the last, which is a real
   * change rather than a shift, so the title is compared across each run -
   * the frame before it, every running frame, and nothing else.
   */
  const shiftedRuns = [];
  let runsAfterAFigure = 0;
  typed.samples.forEach((reading, index) => {
    const previous = typed.samples[index - 1];
    if (reading.status !== 'running' || previous === undefined) return;
    if (previous.status === 'running' || previous.text === null) return;
    runsAfterAFigure += 1;
    const run = [previous];
    for (let next = index; typed.samples[next]?.status === 'running'; next += 1)
      run.push(typed.samples[next]);
    const boxes = new Set(run.map((step) => step.titleBox));
    if (boxes.size !== 1) shiftedRuns.push([...boxes].join(' > '));
  });
  check(
    label,
    'a run that re-starts on a keystroke leaves the title where it was',
    runsAfterAFigure > 0 && shiftedRuns.length === 0,
    `${String(runsAfterAFigure)} runs seen starting from a shown figure, ${String(
      shiftedRuns.length,
    )} moved the title${shiftedRuns.length > 0 ? `: ${shiftedRuns[0]}` : ''}`,
  );
  await setInspector(page, false);

  /* -- Undo and redo restore; they do not arrive --------------------------- */

  await page.locator('[data-testid="canvas-root"]').focus();
  await page.keyboard.press('Control+z');
  const undone = await page.evaluate(
    (known) =>
      [...document.querySelectorAll('[data-edge-id]')].filter(
        (element) => !known.includes(element.getAttribute('data-edge-id')),
      ).length,
    before,
  );
  await install();
  const redoing = sample('connect', { from: first, to: second, before }, 400);
  await page.keyboard.press('Control+y');
  const redone = (await redoing).samples.filter((reading) => reading.wire);
  check(
    label,
    'a wire brought back by redo is simply there - no draw-in, no flick',
    undone === 0 &&
      redone.length > 0 &&
      redone.every(
        (reading) => reading.dash === 'none' && !reading.wireClassed && !reading.contactClassed,
      ),
    `${String(undone)} new wires after undo, ${String(redone.length)} frames after redo, dashes ${[
      ...new Set(redone.map((reading) => reading.dash)),
    ].join(',')}`,
  );
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
    /*
     * THE NAVIGATION HAS TO HAVE HAPPENED. `?.click()` on a link that is not
     * there navigates nowhere, sees no mutation, and reports a clean run - so
     * the negative below passed just as happily against a broken selector as
     * against a fast route. It returns what it did as well as what it saw now,
     * and the check asserts both halves.
     */
    const fastNav = await fastPage.evaluate(async () => {
      const track = document.querySelector('[data-testid="route-progress"]');
      if (!track)
        return { clicked: false, arrived: false, flashed: true, why: 'no progress track' };
      let flashed = false;
      const observer = new MutationObserver(() => {
        if (track.hasAttribute('data-pending')) flashed = true;
      });
      observer.observe(track, { attributes: true });
      const link = document.querySelector('a[href="/tools"]');
      link?.click();
      await new Promise((resolve) => setTimeout(resolve, 600));
      observer.disconnect();
      return {
        clicked: link !== null,
        arrived: window.location.pathname === '/tools',
        flashed,
        why: link === null ? 'no /tools link to click' : '',
      };
    });

    check(
      label,
      'a fast navigation really navigates, and shows nothing at all',
      fastNav.clicked && fastNav.arrived && !fastNav.flashed,
      fastNav.why || `arrived ${String(fastNav.arrived)}, flashed ${String(fastNav.flashed)}`,
    );
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
 * WHETHER A NOTIFICATION EVER LEAVES ON ITS OWN.
 *
 * The defect this covers survived a unit suite that had six tests on the toast
 * and hit production anyway. Every one of those tests asserted something about
 * a toast that was on screen; none asked whether it was still there a minute
 * later.
 *
 * THE PAGE'S CLOCK IS DRIVEN, NOT WAITED OUT - round sixteen. This section was
 * 55 s per engine, nearly all of it real twenty-second lifetimes. The
 * countdown is one `window.setTimeout` per notification and `Date.now()`, both
 * looked up at the moment they are called (`Toast.tsx`), so Playwright's
 * `page.clock` - which replaces exactly those - advances the page past a
 * deadline in no time at all while every pointer event stays a real one. The
 * lifetime is NOT shortened: the app's own twenty seconds is what the clock
 * is driven past, and a provider that starts no timer - the reported bug -
 * leaves the notification on screen however far the clock goes. `runFor`
 * rather than `fastForward`, because it fires every timer due in the window
 * rather than each at most once, so a countdown that ticked would be driven
 * the way time would drive it.
 *
 * What it gives up, said: that the engine's REAL setTimeout fires a callback
 * after twenty real seconds. That is the engine's promise rather than this
 * app's, and every other timed check in this file already relies on it.
 *
 * The unit suite can ask that now, with a fake clock. What it still cannot ask
 * is whether a REAL pointer reaches the viewport element - jsdom has no
 * layout, so `pointermove` and `pointerleave` there are events a test dispatched
 * rather than events a mouse produced, and the original bug was precisely a
 * pause raised by one of those and never lowered. So the three things below
 * are each driven by the mouse:
 *
 *  1. resting on a notification stops its countdown,
 *  2. taking the pointer away finishes it,
 *  3. a notification raised AFTER one was dismissed by hand still expires -
 *     the reported bug, whose whole mechanism was that the hand dismissal
 *     happens with the pointer over the toast.
 *
 * And one thing about the stack rather than the clock: several deletions in a
 * row leave three notifications, not several.
 */
async function checkNotifications(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  /*
   * Seven base64 nodes in one flat row. The canvas fits a share link to the
   * content on arrival, so a row is centred vertically and leaves the
   * bottom-right corner - where the notifications stack - clear of anything
   * this check needs to click.
   */
  const nodes = [];
  for (let index = 1; index <= 7; index += 1) {
    nodes.push([`n${String(index)}`, 'base64', (index - 1) * 300, 0, { mode: 'encode' }]);
  }

  const notifications = page.getByRole('region', { name: /notifications/i }).locator('li');
  const centreOf = async (locator) => {
    const box = await locator.boundingBox();
    return box === null ? null : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };

  /*
   * WHETHER THE COUNT HOLDS, rather than what it reads at one instant.
   *
   * A dismissal the driven clock sets off leaves the screen when React commits
   * it, and WebKit commits a turn later: a count taken the moment `runFor`
   * returned read 1 with the pause broken, and passed. Found by breaking the
   * pause, which failed this check in Firefox and not in WebKit. So "still
   * there" is asked for 400 ms of real time, in which a commit the clock has
   * already caused lands; "gone" was always a wait for the detachment.
   */
  const holds = async (expected) => {
    for (let look = 0; look < 8; look += 1) {
      if ((await notifications.count()) !== expected) return false;
      await page.waitForTimeout(50);
    }
    return true;
  };

  try {
    await page.goto(`${ORIGIN}/?p=${shareParam({ v: 3, n: nodes, e: [] })}`, {
      waitUntil: 'networkidle',
    });
    await page.locator('[data-testid="node-n7"]').waitFor({ timeout: 15_000 });
    // Installed once the canvas is up, so the app boots on real time and only
    // the countdowns that start from here run on the driven clock.
    await page.clock.install();

    const deleteNode = async (id) => {
      await page.locator(`[data-testid="node-${id}"]`).click({ timeout: 10_000 });
      await page.keyboard.press('Delete');
      await page
        .locator(`[data-testid="node-${id}"]`)
        .waitFor({ state: 'detached', timeout: 10_000 });
      await notifications.first().waitFor({ timeout: 5_000 });
    };

    /* -- The clock stops under the pointer, and only under the pointer ---- */

    /*
     * The hover arrives LATE in the toast's life, fourteen seconds into
     * twenty, and is held for twelve - past the deadline whichever way the
     * clock is read, with six seconds left to run once the pointer goes.
     */
    await deleteNode('n1');
    await page.clock.runFor(14_000);

    const overToast = await centreOf(notifications.first());
    if (overToast !== null) await page.mouse.move(overToast.x, overToast.y);
    await page.clock.runFor(12_000);

    const held = await holds(1);
    check(
      label,
      'a pointer resting on a notification stops its countdown',
      overToast !== null && held,
      `still on screen 26s into a 20s life: ${String(held)}`,
    );

    /*
     * The positive partner of the thaw: at five of the six seconds left it
     * is still there, so "gone after the pointer left" is the countdown
     * finishing and not the notification leaving the moment the pointer did.
     */
    await page.mouse.move(20, 20);
    await page.clock.runFor(5_000);
    const early = await holds(1);
    await page.clock.runFor(1_500);
    const thawed = await notifications
      .first()
      .waitFor({ state: 'detached', timeout: 5_000 })
      .then(
        () => true,
        () => false,
      );
    check(
      label,
      'and finishes it once the pointer has left, when its time is up and not before',
      early && thawed,
      `on screen 5s after the pointer left: ${String(early)}; gone at 6.5s: ${String(thawed)}`,
    );

    /* -- The bug, with the mouse that caused it --------------------------- */

    await deleteNode('n2');
    const overClose = await centreOf(
      page.getByRole('button', { name: 'Dismiss notification' }).first(),
    );
    if (overClose !== null) {
      await page.mouse.move(overClose.x, overClose.y);
      await page.mouse.click(overClose.x, overClose.y);
    }
    const dismissed = await notifications
      .first()
      .waitFor({ state: 'detached', timeout: 5_000 })
      .then(
        () => true,
        () => false,
      );

    await deleteNode('n3');
    await page.clock.runFor(19_000);
    const beforeItsTime = await holds(1);
    await page.clock.runFor(1_500);
    const expired = await notifications
      .first()
      .waitFor({ state: 'detached', timeout: 5_000 })
      .then(
        () => true,
        () => false,
      );
    check(
      label,
      'a notification raised after one was dismissed by hand still expires on its own',
      dismissed && beforeItsTime && expired,
      `dismissed=${String(dismissed)}, on screen at 19s: ${String(beforeItsTime)}, gone at 20.5s: ${String(expired)}`,
    );

    /* -- And the stack has a ceiling -------------------------------------- */

    for (const id of ['n4', 'n5', 'n6', 'n7']) await deleteNode(id);
    const stacked = await notifications.count();
    const viewportBox = await page
      .getByRole('region', { name: /notifications/i })
      .locator('ol')
      .boundingBox();
    check(
      label,
      'four deletions in a row leave three notifications, not four',
      stacked === 3,
      `${String(stacked)} on screen`,
    );
    check(
      label,
      'and the stack stays inside the window it is pinned to',
      viewportBox !== null && viewportBox.y >= 0 && viewportBox.y + viewportBox.height <= 900,
      viewportBox
        ? `top ${String(Math.round(viewportBox.y))}, bottom ${String(Math.round(viewportBox.y + viewportBox.height))}`
        : 'no viewport box',
    );
  } finally {
    await context.close().catch(() => {});
  }

  /*
   * WHERE THEY ARE, not only how long they last. Everything above is about
   * lifetime, and for as long as that was all this section asked, a single
   * notification at 390px sat on top of the canvas readout in both engines.
   */
  await notificationPlacement(browser, label, { width: 390, height: 844, coarse: false });
  const touch = await launchTouchBrowser(browser.browserType());
  try {
    await notificationPlacement(touch, label, { width: 390, height: 844, coarse: true });
  } finally {
    await touch.close().catch(() => {});
  }
  await notificationPlacement(browser, label, { width: 1280, height: 900, coarse: false });

  // And over the phone's inspector sheet, where the readout is hidden.
  await notificationsOverTheSheet(browser, label, { coarse: false });
  const sheetTouch = await launchTouchBrowser(browser.browserType());
  try {
    await notificationsOverTheSheet(sheetTouch, label, { coarse: true });
  } finally {
    await sheetTouch.close().catch(() => {});
  }
}

/**
 * Four deletions, and where every notification is after each one: against the
 * readout, the window's edges and each other.
 *
 * Read once each notification's own entrance has FINISHED - its
 * `animation.finished`, which is a state, not a wait - because the entrance
 * slides it 8px sideways, and a margin read part way through is a reading of
 * the slide.
 */
async function notificationPlacement(browser, label, { width, height, coarse }) {
  const narrow = width <= 640;
  const where = `at ${String(width)}px${coarse ? ' under a finger' : ''}`;
  const context = await browser.newContext({
    viewport: { width, height },
    ...(coarse ? { hasTouch: true } : {}),
  });
  const page = await context.newPage();
  // Two columns, so a phone's fit keeps every node on screen and clickable.
  const nodes = [];
  for (let index = 0; index < 6; index += 1) {
    nodes.push([
      `n${String(index + 1)}`,
      'base64',
      (index % 2) * 260,
      Math.floor(index / 2) * 200,
      { mode: 'encode' },
    ]);
  }
  const readings = [];
  try {
    await page.goto(`${ORIGIN}/?p=${shareParam({ v: 3, n: nodes, e: [] })}`, {
      waitUntil: 'networkidle',
    });
    await page.locator('[data-testid="node-n4"]').waitFor({ timeout: 15_000 });
    for (const id of ['n1', 'n2', 'n3', 'n4']) {
      // A phone's sheet covers most of the canvas, and a selection opens it.
      await setInspector(page, false);
      await page.locator(`[data-testid="node-${id}"]`).click({ timeout: 10_000 });
      await page.keyboard.press('Delete');
      await page
        .locator(`[data-testid="node-${id}"]`)
        .waitFor({ state: 'detached', timeout: 10_000 });
      await setInspector(page, false);
      readings.push(
        await page.evaluate(async () => {
          const items = [...document.querySelectorAll('[role="region"] ol > li')];
          await Promise.all(items.flatMap((item) => item.getAnimations().map((a) => a.finished)));
          const box = (element) => {
            if (!element) return null;
            const { left, top, right, bottom } = element.getBoundingClientRect();
            return { left, top, right, bottom };
          };
          return {
            readout: box(document.querySelector('[data-testid="canvas-readout"]')),
            toasts: items.map((item) => ({
              box: box(item),
              title: box(item.querySelector('[class*="title"]')),
              action: box(item.querySelector('[class*="action"]')),
            })),
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            viewport: document.documentElement.clientWidth,
          };
        }),
      );
    }
  } finally {
    await context.close().catch(() => {});
  }

  /*
   * AND ONE WITH A SENTENCE, which a narrow viewport still spans: a share link
   * that does not decode is refused on arrival with the reason under the
   * title. The description's own box is the partner - a notification that lost
   * its sentence would be narrow for the wrong reason.
   */
  let sentence = null;
  if (narrow) {
    const refused = await browser.newContext({
      viewport: { width, height },
      ...(coarse ? { hasTouch: true } : {}),
    });
    try {
      const refusedPage = await refused.newPage();
      await refusedPage.goto(`${ORIGIN}/?p=not-a-pipeline`, { waitUntil: 'networkidle' });
      await refusedPage.locator('[role="region"] ol > li').first().waitFor({ timeout: 15_000 });
      sentence = await refusedPage.evaluate(async () => {
        const item = document.querySelector('[role="region"] ol > li');
        await Promise.all(item.getAnimations().map((animation) => animation.finished));
        const box = item.getBoundingClientRect();
        const readout = document.querySelector('[data-testid="canvas-readout"]');
        return {
          left: box.left,
          right: box.right,
          described: item.querySelector('[class*="description"]') !== null,
          margin: readout ? readout.getBoundingClientRect().left : null,
          viewport: document.documentElement.clientWidth,
        };
      });
    } finally {
      await refused.close().catch(() => {});
    }
  }

  const counts = readings.map((reading) => reading.toasts.length);
  const all = readings.flatMap((reading) => reading.toasts.map((toast) => ({ ...toast, reading })));
  const overlaps = (a, b) =>
    a !== null &&
    b !== null &&
    a.left < b.right &&
    b.left < a.right &&
    a.top < b.bottom &&
    b.top < a.bottom;
  const px = (value) => String(Math.round(value));

  // The partner every "never covers" below needs: there was something to cover.
  check(
    label,
    `notifications ${where} are on screen with the readout they must stay off`,
    readings.length === 4 &&
      readings.every((reading) => reading.readout !== null && reading.toasts.length > 0),
    `counts ${counts.join(',')}; readout ${readings.every((reading) => reading.readout !== null) ? 'present' : 'missing'}`,
  );
  if (coarse) {
    // Or the finger pass is the mouse pass again: the readout only grows under one.
    const grown = readings.every(
      (reading) => reading.readout !== null && reading.readout.bottom - reading.readout.top >= 44,
    );
    check(
      label,
      `the pointer ${where} really is coarse: the readout has grown to its 44px targets`,
      grown,
      `readout ${px((readings[0]?.readout?.bottom ?? 0) - (readings[0]?.readout?.top ?? 0))}px tall`,
    );
  }
  const covering = all.filter((toast) => overlaps(toast.box, toast.reading.readout));
  check(
    label,
    `no notification ${where} covers the canvas readout`,
    all.length > 0 && covering.length === 0,
    covering.length === 0
      ? `${String(all.length)} readings clear of it`
      : `bottom ${px(covering[0].box.bottom)} over a readout from ${px(covering[0].reading.readout.top)}`,
  );
  const outside = all.filter(
    (toast) => toast.box.left < 0 || toast.box.right > toast.reading.viewport,
  );
  check(
    label,
    `and none ${where} runs past the window's edge`,
    readings.every((reading) => reading.overflow <= 0) && outside.length === 0,
    `overflow ${readings.map((reading) => String(reading.overflow)).join(',')}; ${String(outside.length)} outside`,
  );

  if (narrow) {
    /*
     * ON THE RIGHT MARGIN AND AS WIDE AS WHAT IT SAYS. The margin is the
     * readout's own inset, --pb-space-md. These four are deletions - a title,
     * an Undo and a close, no sentence - so each has to end on the right margin
     * and start well clear of the left one; the band they used to fill is what
     * a notification WITH a sentence still gets, asserted below.
     */
    const offRight = all.filter(
      (toast) =>
        Math.abs(toast.reading.viewport - toast.box.right - toast.reading.readout.left) > 0.5,
    );
    const spanning = all.filter((toast) => toast.box.left - toast.reading.readout.left < 40);
    check(
      label,
      `notifications ${where} sit on the right margin, as wide as what they say`,
      all.length > 0 && offRight.length === 0 && spanning.length === 0,
      `${String(offRight.length)} off the margin, ${String(spanning.length)} spanning; widths ${[...new Set(all.map((toast) => px(toast.box.right - toast.box.left)))].join('/')}px of a ${px((all[0]?.reading.viewport ?? 0) - 2 * (all[0]?.reading.readout.left ?? 0))}px band`,
    );
    const stacked = all.filter(
      (toast) =>
        toast.action === null || toast.title === null || toast.action.top >= toast.title.bottom,
    );
    check(
      label,
      `each ${where} is one line, its Undo beside the message rather than under it`,
      stacked.length === 0,
      `${String(stacked.length)} with the action on a row of its own`,
    );
    check(
      label,
      `a notification ${where} that carries a sentence spans the band between both margins`,
      sentence !== null &&
        sentence.described &&
        sentence.margin !== null &&
        Math.abs(sentence.left - sentence.margin) <= 0.5 &&
        Math.abs(sentence.viewport - sentence.right - sentence.margin) <= 0.5,
      sentence === null
        ? 'no refusal was raised'
        : `${px(sentence.left)}..${px(sentence.right)} against margins of ${String(sentence.margin)}, ${sentence.described ? 'with' : 'WITHOUT'} its sentence`,
    );
    check(
      label,
      `four deletions ${where} leave at most two notifications, not a column up the canvas`,
      counts.join(',') === '1,2,2,2',
      `counts ${counts.join(',')}`,
    );
  } else {
    // Desktop: the corner column it has always been, and the ceiling of three.
    const last = readings.at(-1)?.toasts ?? [];
    const pinned = last.every(
      (toast) =>
        Math.abs(toast.box.right - (width - 16)) <= 0.5 &&
        Math.abs(toast.box.right - toast.box.left - 320) <= 0.5,
    );
    check(
      label,
      `notifications ${where} stay a 320px column pinned to the bottom-right corner, three at most`,
      counts.join(',') === '1,2,3,3' &&
        pinned &&
        Math.abs((last.at(-1)?.box.bottom ?? 0) - (height - 16)) <= 0.5,
      `counts ${counts.join(',')}; last ${px(last.at(-1)?.box.left ?? -1)}..${px(last.at(-1)?.box.right ?? -1)}, bottom ${px(last.at(-1)?.box.bottom ?? -1)}`,
    );
  }
}

/**
 * NOTIFICATIONS OVER THE PHONE'S INSPECTOR SHEET: WHERE THEY ARE, ON PURPOSE.
 *
 * Round twenty-three measured the three placements the brief named and kept
 * this one - see architecture.md, "Over the inspector sheet". The decision
 * rests on three measured facts, and this holds each of them, so a change that
 * moves notifications off the reasons fails here rather than in a review:
 *
 *   1. THEY STAY OVER THE SHEET'S BODY, inside its box and below its header -
 *      never over its Close button, and never over the canvas strip above it,
 *      where a stack would take half of the only canvas left on screen and,
 *      under a finger, the selection bar's Delete.
 *   2. THEY DO NOT COVER THE BUTTON JUST PRESSED. Copy sits at the left of the
 *      output's toolbar and a receipt sits on the right margin, as wide as what
 *      it says. Not "no control in the sheet": a wide button row can put its
 *      NEXT button under a receipt - text-convert's HTML view under a finger,
 *      measured - which is the cost this placement was kept at, and recorded.
 *   3. THE PARTNER: two are on screen and the sheet is open, so none of the
 *      above passes on a page that raised nothing.
 */
async function notificationsOverTheSheet(browser, label, { coarse }) {
  const where = `at 390px${coarse ? ' under a finger' : ''}`;
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    ...(coarse ? { hasTouch: true } : {}),
    acceptDownloads: true,
  });
  const page = await context.newPage();
  try {
    await page.goto(
      `${ORIGIN}/?p=${shareParam({ v: 3, n: [['n1', 'base64', 0, 0, { mode: 'encode' }]], e: [] })}`,
      { waitUntil: 'networkidle' },
    );
    await page.locator('[data-testid="node-n1"]').waitFor({ timeout: 15_000 });
    await page.locator('[data-testid="node-n1"]').focus();
    await page.keyboard.press('Enter');
    const field = page.locator('[data-inspector-input]').first();
    await field.waitFor({ timeout: 15_000 });
    await field.fill('hello world');
    for (let look = 0; look < 300; look += 1) {
      if ((await nodeFace(page))?.status === 'ok') break;
      await page.waitForTimeout(100);
    }

    const inspector = page.getByTestId('node-inspector');
    const copy = inspector.getByRole('button', { name: /^Copy/ }).first();
    await copy.scrollIntoViewIfNeeded();
    await copy.click();
    const download = inspector.getByRole('button', { name: /^Download/ }).first();
    await download.click();
    const notifications = page.getByRole('region', { name: /notifications/i }).locator('li');
    for (let look = 0; look < 50 && (await notifications.count()) < 2; look += 1) {
      await page.waitForTimeout(100);
    }

    const reading = await page.evaluate(async () => {
      const items = [...document.querySelectorAll('[role="region"] ol > li')];
      await Promise.all(items.flatMap((item) => item.getAnimations().map((a) => a.finished)));
      const box = (element) => {
        if (!element) return null;
        const { left, top, right, bottom } = element.getBoundingClientRect();
        return { left, top, right, bottom };
      };
      const sheet = document.querySelector('[data-testid="node-inspector"]');
      const close = [...(sheet?.querySelectorAll('button') ?? [])].find(
        (button) => button.getAttribute('aria-label') === 'Close the inspector',
      );
      const buttons = [...(sheet?.querySelectorAll('button') ?? [])];
      return {
        sheet: box(sheet),
        header: box(sheet?.querySelector('h2') ?? null),
        close: box(close ?? null),
        copy: box(
          buttons.find((button) =>
            /^Copy/.test(button.getAttribute('aria-label') ?? button.textContent ?? ''),
          ) ?? null,
        ),
        toasts: items.map((item) => box(item)),
      };
    });

    const overlaps = (a, b) =>
      a !== null &&
      b !== null &&
      a.left < b.right &&
      b.left < a.right &&
      a.top < b.bottom &&
      b.top < a.bottom;
    const px = (value) => String(Math.round(value));
    const { sheet, header, close, copy: copied, toasts } = reading;

    check(
      label,
      `two notifications ${where} are on screen over an open inspector sheet`,
      sheet !== null && toasts.length === 2,
      `${String(toasts.length)} notifications; sheet ${sheet === null ? 'closed' : `${px(sheet.top)}..${px(sheet.bottom)}`}`,
    );
    const outside = toasts.filter(
      (toast) =>
        sheet === null ||
        toast.left < sheet.left ||
        toast.right > sheet.right ||
        toast.bottom > sheet.bottom ||
        toast.top < (close?.bottom ?? sheet.top),
    );
    check(
      label,
      `notifications ${where} sit over the sheet's body, below its header, not over the canvas`,
      toasts.length > 0 &&
        outside.length === 0 &&
        !toasts.some((toast) => overlaps(toast, header) || overlaps(toast, close)),
      toasts
        .map(
          (toast) =>
            `${px(toast.left)}..${px(toast.right)} x ${px(toast.top)}..${px(toast.bottom)}`,
        )
        .join(', ') +
        ` against a sheet from ${sheet === null ? '-' : px(sheet.top)} and a header to ${close === null ? '-' : px(close.bottom)}`,
    );
    check(
      label,
      `and none ${where} covers the Copy button that was just pressed`,
      copied !== null && toasts.length > 0 && !toasts.some((toast) => overlaps(toast, copied)),
      `copy ${copied === null ? 'missing' : `${px(copied.left)}..${px(copied.right)} x ${px(copied.top)}..${px(copied.bottom)}`}; notifications from x ${toasts.length === 0 ? '-' : px(Math.min(...toasts.map((toast) => toast.left)))}`,
    );
  } finally {
    await context.close().catch(() => {});
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
/**
 * The build against the site it is about to replace.
 *
 * Every other check here reads `dist/`, and `dist/` cannot see the failure this
 * exists for. Moving `sourcemap` from `true` to `'hidden'` changed the bytes of
 * 51 files and the name of none, because a file's hash is taken before the
 * map comment is appended. Those URLs are `immutable` and the service worker is
 * cache-first, so every returning visitor kept the commented bytes - and
 * DevTools on the live site went on fetching thirteen maps and `connect-src
 * 'none'` went on refusing them - while `dist/` and the server both held the
 * new bytes and the source-map check above passed against both. The bytes that
 * mattered were only in caches, under names that promised they could not
 * differ.
 *
 * So the promise is what is asserted: a URL this build shares with the live
 * deploy must hold the same bytes, because a browser that has it will never
 * ask again. And the live site's own scripts are scanned for a map comment, so
 * a deploy that differs from the build is seen too. It needs the network, and
 * says so when it has none, rather than passing on a comparison it never made.
 * `PATCHBAY_LIVE_ORIGIN` points it at another deploy.
 */
async function checkLiveAssets(label) {
  const live = process.env.PATCHBAY_LIVE_ORIGIN ?? SITE_URL;
  let worker;
  try {
    const response = await fetch(`${live}/sw.js`);
    worker = response.ok ? await response.text() : `HTTP ${String(response.status)}`;
  } catch (error) {
    worker = `unreachable: ${error instanceof Error ? error.message : String(error)}`;
  }
  const literal = /JSON\.parse\(("(?:[^"\\]|\\.)*")\)/.exec(worker)?.[1];
  const precached = literal ? JSON.parse(JSON.parse(literal)) : [];
  const liveAssets = precached.filter((url) => /^\/assets\/[^/]+\.(?:js|css)$/.test(url));
  check(
    label,
    `the live site's precache list was read (${live})`,
    liveAssets.length > 0,
    literal ? `${String(liveAssets.length)} scripts and stylesheets` : worker.slice(0, 80),
  );
  if (liveAssets.length === 0) return;

  const bodies = new Map();
  for (let i = 0; i < liveAssets.length; i += 8) {
    await Promise.all(
      liveAssets.slice(i, i + 8).map(async (url) => {
        const response = await fetch(`${live}${url}`);
        if (response.ok) bodies.set(url, Buffer.from(await response.arrayBuffer()));
      }),
    );
  }
  const pointing = [...bodies].filter(([, body]) =>
    /[#@] sourceMappingURL=/.test(body.toString('utf8')),
  );
  check(
    label,
    'the live site serves no script or stylesheet that points at a source map',
    bodies.size === liveAssets.length && pointing.length === 0,
    `${String(bodies.size)} of ${String(liveAssets.length)} fetched, ${String(pointing.length)} pointing${
      pointing.length > 0
        ? ` (${pointing
            .slice(0, 3)
            .map(([url]) => url)
            .join(', ')})`
        : ''
    }`,
  );

  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const built = new Set(await readdir(join(DIST, 'assets')));
  const shared = [...bodies.keys()].filter((url) => built.has(url.slice('/assets/'.length)));
  const changed = [];
  for (const url of shared) {
    const ours = await readFile(join(DIST, url.slice(1)));
    if (digest(ours) !== digest(bodies.get(url) ?? Buffer.alloc(0))) changed.push(url);
  }
  // Zero shared is a pass and says why: every URL is new, which is a re-key
  // rather than a comparison, and the detail must not read like one.
  check(
    label,
    'no URL this build shares with the live site holds different bytes',
    changed.length === 0,
    shared.length === 0
      ? `no URL shared with the ${String(bodies.size)} live files - every one is new, so no cache holds any of them`
      : `${String(shared.length)} shared, ${String(changed.length)} changed${changed.length > 0 ? ` (${changed.slice(0, 3).join(', ')}) - a browser that has these will never fetch the new bytes` : ''}`,
  );
}

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
   * AND NOTHING THE BROWSER LOADS ASKS IT TO CONNECT FOR A SOURCE MAP.
   *
   * Every chunk used to end in `//# sourceMappingURL=`, so opening devtools on
   * the live site fetched one map per chunk and `connect-src 'none'` refused
   * each: a steady run of violations that were the policy working, which is
   * exactly the noise a real violation would be filed under. The maps are
   * still built - `sourcemap: 'hidden'` - and the count of them is the partner,
   * so a build that simply stopped making maps cannot pass for one that stopped
   * pointing at them.
   */
  const shipped = [
    ...(await readdir(join(DIST, 'assets'))).map((name) => join('assets', name)),
    ...(await readdir(DIST)).filter((name) => name.endsWith('.js')),
  ];
  const loaded = shipped.filter((name) => /\.(?:js|css)$/.test(name));
  const pointing = [];
  for (const name of loaded) {
    if (/[#@] sourceMappingURL=/.test(await readFile(join(DIST, name), 'utf8')))
      pointing.push(name);
  }
  const maps = shipped.filter((name) => name.endsWith('.map'));
  check(
    label,
    'no built script or stylesheet points the browser at a source map',
    loaded.length > 0 && pointing.length === 0 && maps.length > 0,
    `${String(loaded.length)} files scanned, ${String(pointing.length)} pointing${pointing.length > 0 ? ` (${pointing.slice(0, 3).join(', ')})` : ''}, ${String(maps.length)} maps still built`,
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
   * STYLE-SRC STAYS A LIST OF BYTE SEQUENCES, NOT A CATEGORY.
   *
   * The select refusals were fixed by admitting two exact stylesheets and
   * moving a third onto the CSSOM, and the easier fix was one token:
   * `'unsafe-inline'`. It was weighed and declined - see docs/architecture.md,
   * "What the console noise was" - and this is what makes that a decision
   * rather than a default somebody reverses the next time a library inserts a
   * `<style>`. `'self'` and exactly three hashes, the count csp-hash.ts
   * writes; a fourth is a new decision and should arrive with its reason.
   */
  const styleSrc = /style-src ([^;]*)/.exec(global['Content-Security-Policy'] ?? '')?.[1] ?? '';
  const styleSources = styleSrc.trim().split(/\s+/);
  check(
    label,
    "style-src is 'self' and three hashes, with no 'unsafe-inline'",
    styleSources[0] === "'self'" &&
      styleSources.length === 4 &&
      styleSources.slice(1).every((source) => /^'sha256-[A-Za-z0-9+/]+=*'$/.test(source)),
    styleSrc.slice(0, 90) || 'no style-src found',
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
      /*
       * A BLANK DOCUMENT HAS NO VIOLATIONS, AND THAT IS NOT A PASS.
       *
       * Every one of the six scans below asserts `violations.length === 0`,
       * which a route that rendered nothing at all satisfies perfectly - a
       * lazy chunk that failed to load, a router that matched nothing, a theme
       * switch that threw. `networkidle` does not mean "the app drew
       * something". Guarding here rather than at the six call sites so the
       * protection cannot be forgotten when a seventh is added.
       */
      if (document.querySelectorAll('body *').length < 10) {
        return [
          {
            id: 'harness:empty-document',
            impact: 'critical',
            nodes: document.querySelectorAll('body *').length,
            target: 'nothing rendered - axe was asked about a blank page',
          },
        ];
      }
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
 * A ONE-COLUMN FILE, READ BY ITS NAME, AND SAID WHERE A PERSON LOOKS.
 *
 * Round twenty-three. A column of ids has no delimiter in it, so content
 * detection refuses it - rightly, for pasted text, because every multi-line
 * paste is a valid one-column CSV. A FILE called `ids.csv` has said what it is,
 * so it is read as the table it claims to be. That is a guess of a different
 * kind from every other one this tool makes, and the Detected report exists to
 * make guesses visible, so the claim here is that it is SEEN: on `/tools` in
 * the report's summary and a note, and on a node's face beside its result,
 * with nothing clicked.
 *
 * EVERY CONTROL IS ON SUBJECT. The same bytes named `.txt` are refused exactly
 * as pasted text is; a `.csv` with two columns is read by its content and says
 * `(detected)` as it always has; pasted text keeps the refusal and the refusal
 * still says to choose CSV. The unit suite (`byName.test.ts`) holds the payload;
 * this holds the drawing, which jsdom has none of.
 */
async function checkFileExtension(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  const IDS = 'id\n1001\n1002\n1003\n';
  const PEOPLE = 'name,age\nada,36\ngrace,45\n';
  const upload = (name, text) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });

  /**
   * What `/tools/structured-data` draws for one input: a file chosen with the
   * page's own file control, or text typed into the box. From a fresh page, and
   * settled on the notification this page's one press of Run raises - finished
   * or failed - so an empty page cannot pass a control.
   */
  const onPage = async ({ file, text }) => {
    await page.goto(`${ORIGIN}/tools/structured-data`, { waitUntil: 'networkidle' });
    await page
      .getByRole('heading', { level: 1, name: 'Structured data' })
      .waitFor({ timeout: 15_000 });
    if (file) await page.locator('input[type="file"]').setInputFiles(file);
    if (text) await page.getByLabel('Structured data input').fill(text);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await page
      .getByRole('region', { name: /notifications/i })
      .getByText(/^Structured data (finished|failed)$/)
      .first()
      .waitFor({ timeout: 30_000 })
      .catch(() => {});
    const drawn = await page.evaluate(() => {
      const summary = document.querySelector(
        'section[aria-label="Structured data Detected"] p[class*="summary"]',
      );
      const rect = summary?.getBoundingClientRect() ?? { width: 0, height: 0 };
      return {
        summary: (summary?.textContent ?? '').trim(),
        summaryDrawn: rect.width > 0 && rect.height > 0,
      };
    });
    const output = page.getByLabel('Structured data Converted');
    return {
      ...drawn,
      notes: await drawnReportNotes(page),
      output: (await output.count()) > 0 ? await output.inputValue() : null,
      error: await drawnError(page),
    };
  };

  /**
   * One structured-data node fed `file` through the inspector's own file
   * control, and its face once a run has FINISHED - `ok` or `error`, since two
   * of these are refusals.
   */
  const onNodeWithFile = async (file) => {
    const options = { source: 'auto', target: 'json', indent: 2, delimiter: 'comma' };
    await page.goto(
      `${ORIGIN}/?p=${shareParam({ v: 3, n: [['n1', 'structured-data', 0, 0, options]], e: [] })}`,
      { waitUntil: 'networkidle' },
    );
    await page.locator('[data-testid="node-n1"]').waitFor({ timeout: 15_000 });
    await page.locator('[data-testid="node-n1"]').focus();
    await page.keyboard.press('Enter');
    await page.locator('[data-testid="node-inspector"] input[type="file"]').setInputFiles(file);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const face = await nodeFace(page);
      if (face !== null && FINISHED.has(face.status)) return face;
      if (Date.now() > deadline) {
        const why = `HARNESS: no finished run in 30s - status ${face?.status ?? 'none'}`;
        return { text: why, drawn: false, spoken: why, status: face?.status ?? '', verdict: '' };
      }
      await page.waitForTimeout(100);
    }
  };

  const records = (output) => {
    try {
      return JSON.parse(output ?? '');
    } catch {
      return null;
    }
  };

  try {
    /* -- the case: ids.csv, one column, on the tool page ------------------ */
    const named = await onPage({ file: upload('ids.csv', IDS) });
    const because = named.notes.find((note) => note.title.includes('because the file is named'));
    check(
      label,
      'a one-column .csv is read as a table, and the report says the NAME decided it',
      named.summaryDrawn &&
        named.summary === 'CSV (from the file name) → JSON' &&
        JSON.stringify(records(named.output)) ===
          JSON.stringify([{ id: '1001' }, { id: '1002' }, { id: '1003' }]),
      `${named.summary} | ${named.output ?? named.error.text}`.slice(0, 240),
    );
    check(
      label,
      'and a note naming the file is drawn, at the level of a note rather than a loss',
      because !== undefined &&
        because.drawn &&
        because.word === 'Note' &&
        because.title === 'Read as CSV because the file is named ids.csv' &&
        !named.notes.some((note) => note.word === 'Warning'),
      drawnSummary({ failed: null, notes: named.notes }),
    );

    /* -- the controls, on the tool page ----------------------------------- */
    const txt = await onPage({ file: upload('ids.txt', IDS) });
    check(
      label,
      'the same bytes named .txt are refused, and the refusal says to choose CSV',
      txt.error.drawn &&
        txt.error.text.includes('This is not JSON, YAML, CSV or TSV that this tool can read.') &&
        txt.error.text.includes('choose CSV as the source format') &&
        txt.output === null &&
        !txt.summary.includes('file name'),
      txt.error.text.slice(0, 260),
    );

    const people = await onPage({ file: upload('people.csv', PEOPLE) });
    check(
      label,
      'a .csv with two columns is read by its content, and says detected as it always has',
      people.summaryDrawn &&
        people.summary === 'CSV (detected) → JSON' &&
        !people.notes.some((note) => note.title.includes('file is named')) &&
        JSON.stringify(records(people.output)) ===
          JSON.stringify([
            { name: 'ada', age: '36' },
            { name: 'grace', age: '45' },
          ]),
      `${people.summary} | ${drawnSummary({ failed: null, notes: people.notes })}`.slice(0, 240),
    );

    const typed = await onPage({ text: IDS });
    check(
      label,
      'pasted text with one column keeps the refusal, and it still says to choose CSV',
      typed.error.drawn &&
        typed.error.text.includes('choose CSV as the source format') &&
        typed.error.text.includes('A file whose name ends in .csv or .tsv is read as a table') &&
        typed.output === null,
      typed.error.text.slice(0, 300),
    );

    /* -- on a node's face ------------------------------------------------- */
    const node = await onNodeWithFile(upload('ids.csv', IDS));
    check(
      label,
      'a node fed ids.csv prints the guess beside its result, and says it aloud',
      node.drawn &&
        node.status === 'ok' &&
        node.verdict === 'ok' &&
        node.text === '3 items · CSV by its name' &&
        node.spoken.includes('3 items · CSV by its name'),
      JSON.stringify(node),
    );

    const txtNode = await onNodeWithFile(upload('ids.txt', IDS));
    check(
      label,
      'a node fed the same bytes named .txt prints the refusal, and no guess',
      txtNode.drawn &&
        txtNode.status === 'error' &&
        txtNode.text.includes('This is not JSON, YAML, CSV or TSV') &&
        !txtNode.text.includes('by its name'),
      JSON.stringify(txtNode),
    );

    const peopleNode = await onNodeWithFile(upload('people.csv', PEOPLE));
    check(
      label,
      'a node fed a two-column .csv prints its result alone',
      peopleNode.drawn &&
        peopleNode.status === 'ok' &&
        peopleNode.text === '2 items' &&
        !peopleNode.spoken.includes('by its name'),
      JSON.stringify(peopleNode),
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * WHETHER A LOSS REPORT IS ACTUALLY ON THE SCREEN.
 *
 * Round three turned six silent losses into reported ones, and every unit test
 * for them asserts a PAYLOAD: the note is in the value the tool returned. That
 * is not the claim. The claim is that a person using the tool sees it without
 * doing anything - which is a question about layout, visibility and the
 * canvas's own text, and jsdom has none of those.
 *
 * So this drives the real thing, in two real engines, and asks four questions
 * that the unit suite is structurally unable to ask:
 *
 *   1. ON `/tools`, is the note DRAWN? Not "in the DOM" - drawn, with a box of
 *      non-zero size, with no click anywhere. Every output port renders on that
 *      page, so a report port is visible by construction; "by construction" is
 *      what this file exists to distrust.
 *   2. ON A CANVAS NODE, does the node's own face say it? A node summarises its
 *      first output and the report is the third port, so without
 *      `lossSummary` the sentence would exist only inside a panel nobody opens.
 *      The text is read off the rendered node.
 *   3. THE NEGATIVE CONTROL, in the browser, for both: a conversion that loses
 *      nothing must show no note and no "Lossy" on its node. A report that
 *      fires on ordinary input is the one people learn to ignore.
 *   4. AND THE ONE EXTERNAL ORACLE THIS FILE CAN ASK. `rgb(50% 50% 50%)` is
 *      quantised to 128 because that is what a browser does; the browser is
 *      right here, so it is asked rather than assumed.
 */
async function checkLossReports(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  try {
    /* -- 1 and 3: the tool page ------------------------------------------- */
    await page.goto(`${ORIGIN}/tools/structured-data`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1, name: 'Structured data' }).waitFor({
      timeout: 15_000,
    });

    await page.getByLabel('Structured data input').fill('{"id": 12345678901234567890}');
    await page.getByRole('button', { name: 'Run' }).click();
    await page.getByLabel('Structured data Converted').waitFor({ timeout: 30_000 });

    const lossy = await drawnNotes(page, 'Structured data Detected notes');
    check(
      label,
      'a rounded integer is drawn on the tool page without opening anything',
      lossy.drawn && lossy.text.includes('rounded'),
      lossy.text.slice(0, 120),
    );

    check(
      label,
      'the note says which number and what it became',
      lossy.text.includes('12345678901234567890') && lossy.text.includes('12345678901234567000'),
      lossy.text.slice(0, 160),
    );

    // The negative control, on the same page, one run later.
    await page.getByLabel('Structured data input').fill('{"id": 42}');
    await page.getByRole('button', { name: 'Run' }).click();
    await page.waitForTimeout(500);
    const clean = await drawnNotes(page, 'Structured data Detected notes');
    check(
      label,
      'a conversion that loses nothing draws no note at all',
      !clean.drawn && clean.text === '',
      clean.text.slice(0, 120),
    );

    /* -- 2 and 3: a canvas node ------------------------------------------- */
    const lossyNode = await onNode(
      page,
      'structured-data',
      { source: 'auto', target: 'csv', indent: 2, delimiter: 'comma' },
      '[{"user": {"name": "ada"}, "id": 1}]',
      (text) => text.startsWith('Lossy'),
    );
    check(
      label,
      'a canvas node prints what the conversion lost on its own face',
      lossyNode !== null &&
        lossyNode.drawn &&
        lossyNode.text.startsWith('Lossy ·') &&
        lossyNode.text.includes('nested'),
      JSON.stringify(lossyNode),
    );

    // The node's accessible name carries it too, because a chain readable by
    // eye and not by ear is not one a keyboard user can follow.
    const spoken = await page.evaluate(
      () => document.querySelector('[data-testid="node-n1"]')?.getAttribute('aria-label') ?? '',
    );
    check(
      label,
      'and its accessible name carries the loss as well as the result',
      spoken.includes('lossy:'),
      spoken.replace(/\s+/g, ' ').slice(0, 160),
    );

    // The negative control on the canvas: a flat table loses nothing.
    /*
     * `2 items`, not `a,b`. This waited on the CSV HEADER until round seven,
     * because the header was what a node drew for every table it ever
     * produced - and for the same reason two of these documents with different
     * numbers of rows were the same node. See `checkSerialisedFaces`.
     */
    const cleanNode = await onNode(
      page,
      'structured-data',
      { source: 'auto', target: 'csv', indent: 2, delimiter: 'comma' },
      '[{"a": 1, "b": 2}, {"a": 3, "b": 4}]',
      (text) => text.includes('2 items'),
    );
    check(
      label,
      'a node whose conversion lost nothing says nothing about loss',
      cleanNode !== null && cleanNode.drawn && !cleanNode.text.includes('Lossy'),
      JSON.stringify(cleanNode),
    );

    /* -- 4: the browser as the oracle for rgb() ---------------------------- */
    const computed = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.color = 'rgb(50% 50% 50%)';
      document.body.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    });
    check(
      label,
      'this engine agrees that rgb(50% 50% 50%) is 128, which is why the parser rounds',
      computed.replace(/\s/g, '') === 'rgb(128,128,128)',
      computed,
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/* ========================================================================== *
 * The timestamp tool's zone data, which is the engine's
 * ========================================================================== */

/**
 * The oracle's zone instants that no tz release from 2022a to 2026d moved,
 * and one instant per release that did - both from
 * `scripts/generate-tz-sentinels.py`, read from the files the tool and its
 * tests read, so there is no second copy here to drift.
 */
const TZ_STABLE = JSON.parse(
  await readFile(join(ROOT, 'src/tools/timestamp/spec/tz-stable.json'), 'utf8'),
);
const TZ_SENTINELS = JSON.parse(
  await readFile(join(ROOT, 'src/tools/timestamp/spec/tz-sentinels.json'), 'utf8'),
);

/**
 * THE ONE PART OF THE TIMESTAMP TOOL THAT IS NOT ITS OWN CODE.
 *
 * Every offset for a named zone comes from the engine's `Intl`, which carries
 * its own copy of IANA's tz database at its own release, and jsdom's is
 * Node's - a third copy, and not the one anybody's browser has. The unit
 * suite therefore runs the tool's arithmetic against Python's `zoneinfo`
 * instead of against any engine (`timestamp.oracle.test.ts`); this is the
 * other half, which only a real engine can be asked:
 *
 *   1. AT EVERY INSTANT NO RELEASE HAS MOVED, the engine must agree with the
 *      oracle exactly. A disagreement there cannot be a matter of which
 *      release the engine carries, so it is a defect - in the engine's data,
 *      or in how its answer is read.
 *   2. AT EACH RELEASE'S SENTINEL the engine must be on one side of that
 *      release's change or the other, and the releases it has must be a
 *      prefix: an engine with 2026b's change and not 2025c's would be carrying
 *      no release at all, and the tool's claim about which release it is would
 *      mean nothing.
 *   3. THE TOOL MUST CLAIM THE RELEASE MEASURED HERE. The page is driven with
 *      a wall time in a named zone, and its report has to name the release
 *      this section worked out on its own, by asking the engine directly.
 *   4. AND THE TOOL PAGE ITSELF writes the oracle's offset for a zone at a
 *      quarter-hour, a half-hour, a southern-hemisphere summer and a
 *      local-mean-time second - through the Time zone field and the Convert
 *      to select a person uses.
 *
 * The engine is asked here with the same `formatToParts` reading `zones.ts`
 * makes, written again rather than imported, because the built tool's module
 * is not reachable from a page and the point is what the ENGINE answers.
 */
async function checkTimestampZones(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  try {
    await page.goto(`${ORIGIN}/tools/timestamp`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1, name: 'Timestamp' }).waitFor({ timeout: 15_000 });

    const measured = await page.evaluate(
      ({ stable, sentinels }) => {
        const days = (year, month, day) => {
          const y = month <= 2 ? year - 1 : year;
          const era = Math.floor(y / 400);
          const yoe = y - era * 400;
          const doy = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
          return (
            era * 146_097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719_468
          );
        };
        const formatters = new Map();
        const offsetAt = (zone, seconds) => {
          let formatter = formatters.get(zone);
          if (formatter === undefined) {
            try {
              formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: zone,
                hourCycle: 'h23',
                era: 'short',
                year: 'numeric',
                month: 'numeric',
                day: 'numeric',
                hour: 'numeric',
                minute: 'numeric',
                second: 'numeric',
              });
            } catch {
              formatter = null;
            }
            formatters.set(zone, formatter);
          }
          if (formatter === null) return null;
          const parts = Object.fromEntries(
            formatter
              .formatToParts(new Date(seconds * 1000))
              .map((part) => [part.type, part.value]),
          );
          const year = parts.era === 'BC' ? 1 - Number(parts.year) : Number(parts.year);
          const local =
            days(year, Number(parts.month), Number(parts.day)) * 86_400 +
            Number(parts.hour) * 3600 +
            Number(parts.minute) * 60 +
            Number(parts.second);
          return local - seconds;
        };
        return {
          stable: stable.map(([zone, seconds, offset]) => ({
            zone,
            seconds,
            offset,
            engine: offsetAt(zone, seconds),
          })),
          sentinels: sentinels.map((sentinel) => ({
            ...sentinel,
            engine: offsetAt(sentinel.zone, sentinel.at),
          })),
        };
      },
      { stable: TZ_STABLE.instants, sentinels: TZ_SENTINELS.sentinels },
    );

    /* -- 1: the instants no release moved ----------------------------------- */
    const disagreeing = measured.stable.filter((row) => row.engine !== row.offset);
    check(
      label,
      'the engine agrees with IANA at every zone instant no tz release has moved',
      measured.stable.length > 300 && disagreeing.length === 0,
      disagreeing.length === 0
        ? `${String(measured.stable.length)} instants in ${String(new Set(measured.stable.map((row) => row.zone)).size)} zones`
        : disagreeing
            .slice(0, 6)
            .map(
              (row) =>
                `${row.zone} at ${String(row.seconds)}: ${String(row.engine)} not ${String(row.offset)}`,
            )
            .join('; '),
    );

    /* -- 2: the sentinels ------------------------------------------------------ */
    const sides = measured.sentinels.map((sentinel) => ({
      release: sentinel.release,
      has: sentinel.engine === sentinel.after,
      neither: sentinel.engine !== sentinel.after && sentinel.engine !== sentinel.before,
    }));
    const neither = sides.filter((side) => side.neither);
    check(
      label,
      'at every release sentinel the engine is on one side of that release or the other',
      neither.length === 0,
      neither.map((side) => side.release).join(', '),
    );
    const firstLack = sides.findIndex((side) => !side.has);
    const prefix = firstLack === -1 ? sides.length : firstLack;
    const consistent = sides.every((side, index) => side.has === index < prefix);
    const release = prefix === 0 ? null : sides[prefix - 1].release;
    check(
      label,
      'the releases the engine has are a prefix, so its data is one release rather than a mixture',
      consistent && release !== null,
      `answers like tzdata ${String(release)}; has ${sides
        .filter((side) => side.has)
        .map((side) => side.release)
        .join(' ')}; lacks ${
        sides
          .filter((side) => !side.has)
          .map((side) => side.release)
          .join(' ') || 'none'
      }`,
    );

    /* -- 3 and 4: the tool page ------------------------------------------------ */
    const runOnPage = async (text, zone, target) => {
      await page.goto(`${ORIGIN}/tools/timestamp`, { waitUntil: 'networkidle' });
      await page.getByRole('heading', { level: 1, name: 'Timestamp' }).waitFor({ timeout: 15_000 });
      const field = page.getByLabel('Timestamp input');
      await field.fill(text);
      if (zone !== null) await page.getByLabel('Time zone', { exact: true }).fill(zone);
      if (target !== null) {
        await page.getByRole('combobox', { name: 'Convert to' }).click();
        await page.getByRole('option', { name: target, exact: true }).click();
      }
      if ((await field.inputValue()) !== text)
        return { failed: 'HARNESS: the input box lost its text' };
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      try {
        await page
          .getByRole('region', { name: /notifications/i })
          .getByText('Timestamp finished', { exact: true })
          .first()
          .waitFor({ timeout: 30_000 });
      } catch {
        return {
          failed: `HARNESS: no finished run - ${(await drawnError(page)).text.slice(0, 160)}`,
        };
      }
      return {
        failed: null,
        output: await page.getByLabel('Timestamp Converted').inputValue(),
        notes: await drawnReportNotes(page),
      };
    };

    // A wall time with no offset in a zone with rules, so the answer rests on them.
    const claimed = await runOnPage('2024-06-01T12:00[America/Asuncion]', null, null);
    const rulesNote =
      claimed.failed === null
        ? claimed.notes.find((note) => note.title === "The zone rules are this browser's own")
        : undefined;
    check(
      label,
      'the tool page names the same tz release this engine was measured to answer like',
      rulesNote !== undefined &&
        rulesNote.drawn &&
        release !== null &&
        rulesNote.body.includes(`tzdata ${release}`),
      claimed.failed ??
        `${rulesNote?.body.slice(0, 200) ?? 'no such note'} (measured: ${String(release)})`,
    );

    // Modern offsets at a quarter-hour and a half-hour, and a local mean time
    // that is not a whole minute - the one RFC 3339 cannot write.
    const pickFor = (zone, wanted) =>
      measured.stable.find((row) => row.zone === zone && wanted(row));
    const modern = (row) => row.seconds > 1_000_000_000;
    const samples = [
      pickFor('Asia/Kathmandu', modern),
      pickFor('Australia/Lord_Howe', modern),
      pickFor('America/St_Johns', modern),
      pickFor('Pacific/Chatham', modern),
      pickFor('Africa/Monrovia', (row) => row.offset % 60 !== 0),
    ].filter((row) => row !== undefined);
    const written = [];
    for (const row of samples) {
      const reading = await runOnPage(String(row.seconds), row.zone, 'RFC 3339 in the time zone');
      const sign = row.offset < 0 ? '-' : '+';
      const magnitude = Math.abs(row.offset);
      const pad = (value) => String(value).padStart(2, '0');
      const offset = `${sign}${pad(Math.floor(magnitude / 3600))}:${pad(Math.floor((magnitude % 3600) / 60))}${magnitude % 60 === 0 ? '' : `:${pad(magnitude % 60)}`}`;
      written.push({ zone: row.zone, want: offset, got: reading.failed ?? reading.output });
    }
    const wrong = written.filter((entry) => !String(entry.got).endsWith(entry.want));
    check(
      label,
      'the tool page writes the oracle offset through its own Time zone field, to the second',
      samples.length === 5 && wrong.length === 0,
      (wrong.length === 0 ? written : wrong)
        .map((entry) => `${entry.zone} ${entry.got} (want ${entry.want})`)
        .join('; '),
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/* ========================================================================== *
 * The loss corpus, drawn
 * ========================================================================== */

/**
 * `spec/loss-corpus.json`, read from the file `lossCorpus.test.ts` imports, so
 * the two cannot list different rows: a row added there is driven here with no
 * edit to this file, and a row removed there stops being driven.
 */
const LOSS_CORPUS = JSON.parse(
  await readFile(join(ROOT, 'src/features/registry/spec/loss-corpus.json'), 'utf8'),
);

/**
 * Every note in every report list on a tool page, one entry per note: its
 * level word, title and body, and whether its own box is drawn.
 *
 * PER NOTE, not the list's text run together, because a row's claim is about
 * ONE note - a warning whose title names the subject and whose words name what
 * happened. Two notes that between them contain the right words are not that,
 * and a list read as one string cannot tell the difference.
 */
async function drawnReportNotes(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('ul[aria-label$=" notes"] > li')].map((item) => {
      const rect = item.getBoundingClientRect();
      const part = (name) =>
        (item.querySelector(`[class*="${name}"]`)?.textContent ?? '').replace(/\s+/g, ' ').trim();
      return {
        word: part('noteWord'),
        title: part('noteTitle'),
        body: part('noteBody'),
        drawn: rect.width > 0 && rect.height > 0,
      };
    }),
  );
}

/** Case-insensitive, as `lossCorpus.test.ts` matches: a title may start a sentence. */
const mentions = (haystack, needle) => haystack.toLowerCase().includes(needle.toLowerCase());

/**
 * One document through `/tools/<tool>` under the case's options, from a fresh
 * page, and what the page drew for it.
 *
 * TYPED FIRST, CHOSEN SECOND, READ BACK THIRD - round eleven's order, because
 * a fill landing while a Radix listbox hands focus back is discarded - and a
 * box that does not hold the document fails as the harness's fault.
 *
 * SETTLED ON THIS RUN. The page runs only when Run is pressed and this page
 * has pressed it once, so the `<name> finished` notification is this run's
 * and nothing else's. Before it, a page with no notes list at all would pass
 * every control; after it, the output and the notes are the ones this
 * document produced.
 */
async function corpusOnPage(page, entry, text) {
  await page.goto(`${ORIGIN}/tools/${entry.tool}`, { waitUntil: 'networkidle' });
  const heading = page.getByRole('heading', { level: 1 });
  await heading.waitFor({ timeout: 15_000 });
  const name = ((await heading.textContent()) ?? '').trim();

  const field = page.getByLabel(`${name} input`);
  await field.fill(text);
  for (const [control, choice] of Object.entries(entry.drawn.choose)) {
    await page.getByRole('combobox', { name: control }).click();
    await page.getByRole('option', { name: choice, exact: true }).click();
  }
  const typed = await field.inputValue();
  if (typed !== text) {
    return {
      failed: `HARNESS: the input box holds ${typed.length.toString()} characters, not the ${text.length.toString()} typed`,
    };
  }

  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const finished = page
    .getByRole('region', { name: /notifications/i })
    .getByText(`${name} finished`, { exact: true });
  try {
    await finished.first().waitFor({ timeout: 30_000 });
  } catch {
    const error = await drawnError(page);
    return {
      failed: `HARNESS: no finished run in 30s${error.drawn ? ` - the page drew an error: ${error.text.slice(0, 160)}` : ''}`,
    };
  }
  const output = page.getByLabel(`${name} Converted`);
  return {
    failed: null,
    output: (await output.count()) > 0 ? await output.inputValue() : null,
    notes: await drawnReportNotes(page),
  };
}

/** A short account of what a page drew, for a check's detail. */
const drawnSummary = (reading) =>
  reading.failed ??
  (reading.notes.length === 0
    ? 'no notes drawn'
    : reading.notes
        .map((note) => `[${note.word}] ${note.title} :: ${note.body}`)
        .join(' | ')
        .slice(0, 320));

/**
 * EVERY ROW OF THE LOSS CORPUS, DRAWN, IN TWO ENGINES.
 *
 * `lossCorpus.test.ts` decides whether a loss is TOLD by reading the payload a
 * tool returned. That is the ratio, and it is honest about what it measures.
 * What it cannot say is the other half of the matrix's definition of told:
 * that a person using the tool is shown it without doing anything, on the
 * panel on `/tools` and on a canvas node's own face. This section is that
 * half, for every row, read from the same file.
 *
 * Until round twenty-three five sections carried the rows a second time, by
 * hand, and the copy had drifted the way copies do: row 3 was in none of
 * them, rows 2, 14 and 15 had no node, rows 4 to 9 were one combined document,
 * and a new row was two edits. Now a row is one edit and is driven here the
 * run after it lands.
 *
 * WHAT EACH ROW IS HELD TO. The corpus's own `expect`, and the sharper words
 * the old checks asserted, which moved into the row as `drawn`:
 *
 *   ON THE PAGE, a note drawn with a box, at the WARNING level, whose title
 *   holds `expect.titleContains` and whose title and body hold every
 *   `expect.mentions` and every `drawn.says` - one note, not the list's words
 *   run together - with nothing in `drawn.unsaid` drawn anywhere, and the
 *   output holding nothing in `drawn.outputLacks`.
 *
 *   ON A NODE, a finished run whose verdict is `lossy`, whose face begins
 *   `Lossy ·` and holds `drawn.face` (the subject, by default), and whose
 *   accessible name carries `lossy:` and `drawn.spoken`.
 *
 *   EVERY CONTROL - the row's `clean` document and any in `drawn.controls` -
 *   on the page: no note about the subject at any level, no warning at all,
 *   none of the row's `says`, and nothing drawn at all where the control is
 *   `quiet`; on a node: a finished run whose verdict is `ok` and whose face
 *   and name say nothing about loss.
 */
async function checkLossCorpus(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  try {
    for (const entry of LOSS_CORPUS.cases) {
      if (entry.input === null) continue;
      const row = `row ${String(entry.row)}, ${entry.id}`;
      const { expect: expected, drawn } = entry;
      const says = drawn.says ?? [];

      /* -- the document that loses something, on the page ---------------- */
      const lossy = await corpusOnPage(page, entry, entry.input);
      const told =
        lossy.failed === null
          ? lossy.notes.find(
              (note) =>
                note.drawn &&
                note.word === 'Warning' &&
                mentions(note.title, expected.titleContains) &&
                [...expected.mentions, ...says].every((part) =>
                  mentions(`${note.title} ${note.body}`, part),
                ),
            )
          : undefined;
      const spoke =
        lossy.failed === null
          ? (drawn.unsaid ?? []).filter((part) =>
              lossy.notes.some((note) => `${note.title} ${note.body}`.includes(part)),
            )
          : [];
      const kept =
        lossy.failed === null && lossy.output !== null
          ? (drawn.outputLacks ?? []).filter((part) => lossy.output.includes(part))
          : [];
      check(
        label,
        `${row}: drawn on the tool page as a warning that names it, with nothing clicked`,
        told !== undefined && spoke.length === 0 && kept.length === 0 && lossy.output !== null,
        `${spoke.length > 0 ? `also says ${JSON.stringify(spoke)}; ` : ''}${kept.length > 0 ? `output still holds ${JSON.stringify(kept)}; ` : ''}${drawnSummary(lossy)}`,
      );

      /* -- the same document, on a node ---------------------------------- */
      const node = await onNode(page, entry.tool, entry.options, entry.input, (text) =>
        text.startsWith('Lossy'),
      );
      const face = drawn.face ?? expected.titleContains;
      check(
        label,
        `${row}: printed on a canvas node's face and in its accessible name`,
        node.drawn &&
          node.verdict === 'lossy' &&
          node.text.startsWith('Lossy ·') &&
          mentions(node.text, face) &&
          node.spoken.includes('lossy:') &&
          (drawn.spoken === undefined || node.spoken.includes(drawn.spoken)),
        JSON.stringify(node),
      );

      /* -- every control, on the page and on a node ---------------------- */
      const controls = [
        { input: entry.clean, quiet: drawn.quiet === true },
        ...(drawn.controls ?? []),
      ];
      for (const [index, control] of controls.entries()) {
        const which = index === 0 ? 'its clean document' : `control ${String(index)}`;
        const clean = await corpusOnPage(page, entry, control.input);
        const noise =
          clean.failed === null
            ? clean.notes.filter(
                (note) =>
                  note.word === 'Warning' ||
                  mentions(note.title, expected.titleContains) ||
                  says.some((part) => `${note.title} ${note.body}`.includes(part)),
              )
            : [];
        check(
          label,
          `${row}: ${which} draws no note about it on the tool page${control.quiet ? ', and no note at all' : ''}`,
          clean.failed === null &&
            clean.output !== null &&
            noise.length === 0 &&
            (!control.quiet || clean.notes.length === 0),
          drawnSummary(clean),
        );

        const quiet = await onNode(page, entry.tool, entry.options, control.input, () => true);
        check(
          label,
          `${row}: ${which} leaves a node's face clean`,
          quiet.drawn &&
            quiet.verdict === 'ok' &&
            !quiet.text.includes('Lossy') &&
            !quiet.spoken.includes('lossy:'),
          JSON.stringify(quiet),
        );
      }
    }
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * THE REFUSALS THIS TOOL DRAWS, AND WHERE THEY POINT.
 *
 * A refusal is not a loss-corpus row - a document that is refused has not been
 * converted, so no note about it exists to find - and it has two surfaces that
 * carry different amounts of text: the panel on `/tools` shows the message,
 * the code, the line and column, and the detail under them; a canvas node
 * shows the MESSAGE alone, because a node has no detail line. So both are
 * asked, of every sentence here:
 *
 *   1. THE VALUE MODEL. `$.a_nan is NaN, which JSON cannot represent` named a
 *      format that is in neither half of a YAML to YAML run. It names the value
 *      model now, carries a LINE AND COLUMN, and lists every offender rather
 *      than the first.
 *   2. THE ROUNDING ADVICE. It used to say `Convert to CSV or TSV to keep the
 *      digits` whatever the target was, which is false on every target
 *      including those two. It fits the target now.
 *   3. THE PRESENTATION CENSUS AS ONE NOTE. Corpus rows 4 to 7 are each one
 *      kind in one document, and `checkLossCorpus` drives them; what no row
 *      holds is all four in ONE document, which is the note's whole design.
 *   4. A POSITION EVERY ENGINE GETS. A JSON syntax error's line and column used
 *      to be read out of the engine's own message, and JavaScriptCore's message
 *      never has one - so this panel showed a position in Firefox and nothing
 *      in WebKit. And two YAML and CSV refusals at the column they are about.
 *
 * jsdom can read every one of those strings out of a payload. What it cannot
 * do is answer whether the box holding them has a size, which is the whole of
 * the difference between a refusal existing and a person being told.
 */
async function checkValueModel(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  /**
   * Runs one document and waits for the panel to settle on an answer.
   *
   * TYPES ONLY WHAT IS NOT ALREADY THERE, AND READS IT BACK. The first run
   * follows two listboxes, and a fill landing while Radix returns focus to a
   * trigger is discarded - crash B, round eleven. So the first document is
   * typed before either listbox opens, this skips typing text the box already
   * holds, and a box that does not hold the text is reported as the harness's
   * failure rather than as the tool's.
   */
  const run = async (text, settled) => {
    const field = page.getByLabel('Structured data input');
    if ((await field.inputValue()) !== text) await field.fill(text);
    const typed = await field.inputValue();
    if (typed !== text) {
      const lost = `HARNESS: the input box holds ${typed.length.toString()} characters, not the ${text.length.toString()} typed`;
      return { error: { drawn: false, text: lost }, notes: { drawn: false, text: lost } };
    }
    await page.getByRole('button', { name: 'Run' }).click();
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const error = await drawnError(page);
      const notes = await drawnNotes(page, 'Structured data Detected notes');
      if (settled(error, notes)) return { error, notes };
      await page.waitForTimeout(100);
    }
    return {
      error: await drawnError(page),
      notes: await drawnNotes(page, 'Structured data Detected notes'),
    };
  };

  /**
   * One document from a fresh page, under a chosen source and target, settled
   * on THIS run's own answer - its output or its error - because each run
   * starts from a `goto` and "wait until nothing is drawn" is true on the first
   * poll. Typed first, chosen second, read back: round eleven's order.
   */
  const runAs = async (text, source, target, settled) => {
    await page.goto(`${ORIGIN}/tools/structured-data`, { waitUntil: 'networkidle' });
    await page
      .getByRole('heading', { level: 1, name: 'Structured data' })
      .waitFor({ timeout: 15_000 });
    await page.getByLabel('Structured data input').fill(text);
    await page.getByRole('combobox', { name: 'Source format' }).click();
    await page.getByRole('option', { name: source, exact: true }).click();
    await page.getByRole('combobox', { name: 'Target format' }).click();
    await page.getByRole('option', { name: target, exact: true }).click();

    const typed = await page.getByLabel('Structured data input').inputValue();
    if (typed !== text) return null;

    await page.getByRole('button', { name: 'Run' }).click();
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const converted = page.getByLabel('Structured data Converted');
      const output = (await converted.count()) > 0 ? await converted.inputValue() : '';
      const error = await drawnError(page);
      if (settled(output, error)) return { output, error, notes: await drawnReportNotes(page) };
      await page.waitForTimeout(100);
    }
    return null;
  };

  try {
    /* -- 1: the refusal, on the tool page, YAML to YAML -------------------- */
    await page.goto(`${ORIGIN}/tools/structured-data`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1, name: 'Structured data' }).waitFor({
      timeout: 15_000,
    });

    // Typed BEFORE the listboxes; see `run`.
    await page.getByLabel('Structured data input').fill('a_nan: .nan\n');
    await page.getByRole('combobox', { name: 'Source format' }).click();
    await page.getByRole('option', { name: 'YAML', exact: true }).click();
    await page.getByRole('combobox', { name: 'Target format' }).click();
    await page.getByRole('option', { name: 'YAML', exact: true }).click();

    const nan = await run('a_nan: .nan\n', (error) => error.text.includes('value model'));
    check(
      label,
      'a refused value is drawn on the tool page and names the value model, not JSON',
      nan.error.drawn &&
        nan.error.text.includes("$.a_nan is NaN, which this tool's value model cannot hold.") &&
        !nan.error.text.includes('JSON'),
      nan.error.text.slice(0, 220),
    );

    check(
      label,
      'and the same panel says what the model holds and where the value is',
      nan.error.text.includes('text, finite numbers, true, false, null, lists and maps') &&
        nan.error.text.includes('Line 1, column 8'),
      nan.error.text.slice(0, 320),
    );

    /* -- every offender, not the first ------------------------------------ */
    const six = await run('a: .nan\nb: .inf\nc: -.inf\nd: .nan\ne: .nan\nf: .nan\n', (error) =>
      error.text.includes('6 values'),
    );
    check(
      label,
      'six unsupported values are enumerated in one run rather than needing six',
      six.error.drawn &&
        ['$.a is NaN', '$.b is Infinity', '$.c is -Infinity', '$.d', '$.e', '$.f'].every((part) =>
          six.error.text.includes(part),
        ),
      six.error.text.slice(0, 320),
    );

    /* -- the negative control for the refusal, on subject ------------------ */
    const fine = await run('a: 1\nb: two\n', (error) => !error.drawn);
    check(
      label,
      'a document the model holds draws no error panel at all',
      !fine.error.drawn && fine.error.text === '',
      fine.error.text.slice(0, 160),
    );

    /* -- 2: SD-13, the advice fitted to the target ------------------------- */
    const rounded = await run('id: 12345678901234567890\n', (_error, notes) =>
      notes.text.includes('rounded'),
    );
    check(
      label,
      'the rounding note tells a YAML target what a YAML output will hold',
      rounded.notes.drawn &&
        rounded.notes.text.includes('Quoting it in the source') &&
        rounded.notes.text.includes('the YAML output then holds it as a string') &&
        !rounded.notes.text.includes('Convert to CSV or TSV'),
      rounded.notes.text.slice(0, 280),
    );

    /* -- the refusal on a canvas node ------------------------------------- */
    const yamlToYaml = { source: 'yaml', target: 'yaml', indent: 2, delimiter: 'comma' };
    const refusedNode = await onNode(page, 'structured-data', yamlToYaml, 'a_nan: .nan\n', (text) =>
      text.includes('value model'),
    );
    check(
      label,
      'a node prints the refusal on its own face, in the words the panel used',
      refusedNode.drawn &&
        refusedNode.text.includes("$.a_nan is NaN, which this tool's value model cannot hold.") &&
        !refusedNode.text.includes('JSON'),
      JSON.stringify(refusedNode),
    );

    /*
     * -- 3: four kinds in one document, as ONE note -------------------------
     *
     * Asked of each note rather than of the list's words run together: a
     * census that wrote a note per kind would pass a check on the list's text,
     * and the node's face - one line - would then carry only the first.
     */
    const RICH =
      '# why this exists\ndefaults: &defaults\n  retries: 3\nservice: *defaults\ncustom: !mytype\n  a: 1\ntext: >\n  one\n  two\n';
    const rich = await runAs(RICH, 'YAML', 'JSON', (output) => output.includes('"retries": 3'));
    const census =
      rich?.notes.filter(
        (note) => note.word === 'Warning' && note.title.startsWith('Not carried over'),
      ) ?? [];
    check(
      label,
      'a comment, an anchor, a tag and a block style are drawn as ONE warning naming all four',
      census.length === 1 &&
        census[0].drawn &&
        ['1 comment', '1 anchor', '1 tag', '1 block style'].every((part) =>
          census[0].title.includes(part),
        ),
      rich === null ? 'did not settle' : drawnSummary({ failed: null, notes: rich.notes }),
    );

    /*
     * -- 4: a JSON syntax error's position, the same in both engines ---------
     *
     * Round sixteen. Each document below is one the old path gave no position
     * for in at least one engine, measured, and each check asks for the SAME
     * line and column in both: a check that accepted whatever this engine
     * printed would be the test that hid it.
     */
    for (const [text, where] of [
      ['{"a": }', 'Line 1, column 7'],
      ['[1, 2,]', 'Line 1, column 7'],
      ['{\n  "a": tru\n}', 'Line 2, column 8'],
    ]) {
      const bad = await runAs(text, 'JSON', 'YAML', (_output, error) => error.drawn);
      check(
        label,
        `a JSON syntax error in ${JSON.stringify(text)} is drawn with its position, ${where}`,
        bad !== null &&
          bad.error.text.includes('That is not valid JSON') &&
          bad.error.text.includes(where),
        bad === null ? 'did not settle' : bad.error.text.slice(0, 220),
      );
    }

    const good = await runAs('{"a": "zebra"}', 'JSON', 'YAML', (output) =>
      output.includes('zebra'),
    );
    check(
      label,
      'and valid JSON draws no error and no position',
      good !== null && !good.error.drawn && !good.error.text.includes('column'),
      good === null ? 'did not settle' : good.error.text.slice(0, 120),
    );

    /* -- SD-8 and SD-14b: two refusals, drawn at their column --------------- */
    const mistyped = await runAs('v: !!float abc\n', 'YAML', 'JSON', (_output, error) =>
      error.text.includes('tagged'),
    );
    check(
      label,
      'a value its tag cannot describe is refused on the tool page, with its line and column',
      mistyped !== null &&
        mistyped.error.drawn &&
        mistyped.error.text.includes('"abc" is tagged !!float and is not one.') &&
        mistyped.error.text.includes('Line 1, column 12'),
      mistyped === null ? 'did not settle' : mistyped.error.text.slice(0, 240),
    );

    const float = await runAs('v: !!float 1\n', 'YAML', 'JSON', (output) =>
      output.includes('"v": 1'),
    );
    check(
      label,
      'and !!float 1 is read as the number, not the string',
      float !== null && !float.error.drawn && !float.output.includes('"1"'),
      float === null ? 'did not settle' : float.output,
    );

    const duplicate = await runAs('alpha,beta,alpha\n1,2,3\n', 'CSV', 'JSON', (_output, error) =>
      error.text.includes('Duplicate column'),
    );
    check(
      label,
      'a duplicate column is refused at the column it is in, not at column 1',
      duplicate !== null &&
        duplicate.error.drawn &&
        duplicate.error.text.includes('Line 1, column 12'),
      duplicate === null ? 'did not settle' : duplicate.error.text.slice(0, 200),
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * THE CONTRAST TABLE THAT IGNORED ALPHA, AND THE COMPOSITOR IT NOW AGREES WITH.
 *
 * `#aabbccdd` used to report contrast ratios byte-identical to `#aabbcc`. Two
 * questions only a real engine can answer:
 *
 *   1. DO THE RATIOS DIFFER? Read off the rendered table for both colours, and
 *      the table must say on screen that it composites, and against what.
 *   2. IS THE FORMULA THE PLATFORM'S? `compositeOver` claims to do what the
 *      engine's own compositor does, so the engine is asked: the same colour is
 *      painted over the same backdrop on a real 2D canvas and the pixel read
 *      back. A formula chosen for tidiness would disagree here.
 *
 * The colour tool's NOTES - rows 1 to 3 of the loss corpus - are
 * `checkLossCorpus`'s, on the page and on a node.
 */
async function checkColourContrast(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  /** Every ratio the contrast table is showing, in row order. */
  const ratiosOn = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('td')]
        .map((cell) => (cell.textContent ?? '').trim())
        .filter((text) => text.endsWith(':1')),
    );

  /**
   * Runs one colour and waits for the answer rather than for the click: the
   * previous result stays on screen while the next run is in flight, and this
   * check is entirely about which table is on screen.
   */
  const convert = async (text, expected) => {
    // `Colour input`, not `Colour Colour`: the port name is only folded into
    // the accessible name when a tool has more than one input, and this has one.
    await page.getByLabel('Colour input').fill(text);
    await page.getByRole('button', { name: 'Run' }).click();
    const output = page.getByLabel('Colour Converted');
    await output.waitFor({ timeout: 30_000 });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await output.inputValue()) === expected) return true;
      await page.waitForTimeout(100);
    }
    return false;
  };

  try {
    await page.goto(`${ORIGIN}/tools/color-convert`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1, name: 'Colour' }).waitFor({ timeout: 15_000 });

    /* -- 1: the contrast table -------------------------------------------- */
    const opaqueRan = await convert('#aabbcc', '#aabbcc');
    const opaqueRatios = await ratiosOn();
    const alphaRan = await convert('#aabbccdd', '#aabbccdd');
    const alphaRatios = await ratiosOn();
    check(
      label,
      'a translucent colour no longer reports the opaque twin ratios',
      opaqueRan &&
        alphaRan &&
        opaqueRatios.length === 2 &&
        alphaRatios.length === 2 &&
        opaqueRatios.join() !== alphaRatios.join(),
      `${opaqueRatios.join(' ')} vs ${alphaRatios.join(' ')}`,
    );

    const disclosure = await page.evaluate(() => {
      const caption = document.querySelector('table caption');
      const element = [...document.querySelectorAll('p')].find((node) =>
        (node.textContent ?? '').includes('compositing'),
      );
      const rect = element?.getBoundingClientRect() ?? { width: 0, height: 0 };
      return {
        caption: caption?.textContent ?? '',
        note: (element?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        drawn: rect.width > 0 && rect.height > 0,
      };
    });
    check(
      label,
      'and the table says on screen that it composites, and against what',
      disclosure.caption.includes('composited onto each background') &&
        disclosure.drawn &&
        disclosure.note.includes('#93a2b1 on black') &&
        disclosure.note.includes('#b5c4d3 on white'),
      `${disclosure.caption} | ${disclosure.note.slice(0, 120)}`,
    );

    /* -- 2: the engine's own compositor as the oracle ---------------------- */
    const painted = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 1;
      const ctx = canvas.getContext('2d');
      if (ctx === null) return null;
      const read = (under) => {
        ctx.clearRect(0, 0, 2, 1);
        ctx.fillStyle = under;
        ctx.fillRect(0, 0, 2, 1);
        // source-over is the default, which is the claim being checked.
        ctx.fillStyle = 'rgba(170, 187, 204, 0.8666666666666667)';
        ctx.fillRect(0, 0, 2, 1);
        const pixel = ctx.getImageData(0, 0, 1, 1).data;
        return `#${[pixel[0], pixel[1], pixel[2]]
          .map((value) => value.toString(16).padStart(2, '0'))
          .join('')}`;
      };
      return { onBlack: read('#000000'), onWhite: read('#ffffff') };
    });
    check(
      label,
      'this engine composites #aabbccdd to the same two colours the table names',
      painted !== null && painted.onBlack === '#93a2b1' && painted.onWhite === '#b5c4d3',
      JSON.stringify(painted),
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/* ========================================================================== *
 * Reading a report and a canvas node
 * ========================================================================== */

/**
 * The drawn text of a notes list, and whether it occupies any space - the two
 * questions every loss check asks of a report: is it there, and could a person
 * see it without clicking anything.
 */
async function drawnNotes(page, name) {
  const list = page.getByRole('list', { name });
  if ((await list.count()) === 0) return { drawn: false, text: '' };
  const box = await list.first().boundingBox();
  return {
    drawn: box !== null && box.width > 0 && box.height > 0,
    text: ((await list.first().innerText()) ?? '').replace(/\s+/g, ' ').trim(),
  };
}

/**
 * A node's summary box, whether it is drawn, its accessible name and its run
 * status. Both the box and the name, because `textContent` is satisfied by a
 * node drawn at zero height behind the inspector, and a chain readable by eye
 * and not by ear is not one a keyboard user can follow.
 */
async function nodeFace(page) {
  return page.evaluate(() => {
    const node = document.querySelector('[data-testid="node-n1"]');
    const box = node?.querySelector('[class*="nodeSummary"]') ?? null;
    if (box === null) return null;
    const rect = box.getBoundingClientRect();
    return {
      text: (box.textContent ?? '').replace(/\s+/g, ' ').trim(),
      drawn: rect.width > 0 && rect.height > 0,
      spoken: node?.getAttribute('aria-label') ?? '',
      status: node?.getAttribute('data-status') ?? '',
      // `ok`, `lossy` or `after-loss`: the one word the footer and the LED
      // agree on. `succeeded` in the name is no control - a lossy node's name
      // says `succeeded, and lost something`.
      verdict: node?.getAttribute('data-verdict') ?? '',
    };
  });
}

/** The error panel a tool page draws, and whether it occupies any space. */
async function drawnError(page) {
  return page.evaluate(() => {
    const box = document.querySelector('[class*="error"]');
    if (box === null) return { drawn: false, text: '' };
    const rect = box.getBoundingClientRect();
    return {
      drawn: rect.width > 0 && rect.height > 0,
      text: (box.textContent ?? '').replace(/\s+/g, ' ').trim(),
    };
  });
}

/** What a run ends as. `blocked` is where an empty node starts, not an answer. */
const FINISHED = new Set(['ok', 'error', 'upstream-failed']);

/**
 * Loads one node of `tool` with `options`, types `text` into it through the
 * inspector, and waits for the face to satisfy `settled` ON A FINISHED RUN.
 *
 * ONE HELPER FOR EVERY LOSS CHECK, since round fifteen: four checks each
 * carried a word-for-word copy of the same load, type and poll, and the one
 * lesson that had to be in all of them was in none. A node shows its tool's
 * DESCRIPTION until a run lands, so a control that settles on a word the
 * description also contains passes before anything has run - round thirteen
 * found one waiting for `plain` on a node that said "Convert between Markdown,
 * HTML and plain text", with the accessible name reading `running`. Settling on
 * a finished `data-status` as well as the caller's text makes that impossible
 * for every caller at once, rather than for the ones that remembered.
 *
 * And the typed text is read back, because a fill can be discarded without an
 * error (round eleven), and a node that ran on nothing reports that faithfully
 * as a fact about the tool. A lost fill returns a face saying so, which every
 * caller's check prints.
 */
async function onNode(page, tool, options, text, settled) {
  await page.goto(`${ORIGIN}/?p=${shareParam({ v: 3, n: [['n1', tool, 0, 0, options]], e: [] })}`, {
    waitUntil: 'networkidle',
  });
  await page.locator('[data-testid="node-n1"]').waitFor({ timeout: 15_000 });
  await page.locator('[data-testid="node-n1"]').focus();
  await page.keyboard.press('Enter');
  const field = page.locator('[data-inspector-input]').first();
  await field.waitFor({ timeout: 15_000 });
  await field.fill(text);
  const typed = await field.inputValue();
  if (typed !== text) {
    const lost = `HARNESS: the inspector holds ${typed.length.toString()} characters, not the ${text.length.toString()} typed`;
    return { text: lost, drawn: false, spoken: lost, status: '' };
  }

  /*
   * A DEADLINE IS NOT AN ANSWER. Returning the face as it stood when time ran
   * out would hand a control the tool's description on a node that never ran,
   * and "says nothing about loss" is true of a description. So an unfinished
   * run comes back as undrawn, with its status in the text, and every check -
   * positive or control - fails on it and says why.
   */
  const deadline = Date.now() + 30_000;
  for (;;) {
    const face = await nodeFace(page);
    if (face !== null && FINISHED.has(face.status) && settled(face.text)) return face;
    if (Date.now() > deadline) {
      const why = `HARNESS: no finished run settled in 30s - status ${face?.status ?? 'none'}, face ${JSON.stringify(face?.text ?? null)}`;
      return { text: why, drawn: false, spoken: why, status: face?.status ?? '', verdict: '' };
    }
    await page.waitForTimeout(100);
  }
}

/**
 * ROUND SIXTEEN: THE CENSUS COUNTS WHAT A READER CAN SEE, in two engines.
 *
 * The unit suite holds every census note to the pasted-HTML oracle, which is
 * three engines' pixels committed as a fixture. What it cannot see is that the
 * notes a real worker produces are the ones drawn - on the tool page, without
 * a click, and on a node's face, where only a warning goes. So the three false
 * notes round fifteen found are driven here, each beside a true loss on the
 * same page so a check that "draws no note" cannot pass on a page that draws
 * none at all.
 *
 * Every settle word is `zebra`, which is in no description the page shows
 * before a run. A settle word must be one only THIS output holds: `plain` is in
 * text-convert's own description ("...HTML and plain text"), which is on a
 * node's face before the run has produced anything, and a control settling on
 * it passed on a node still reading `running`. `onNode` now also waits for a
 * finished run, so that cannot recur there; on the tool page the word still
 * matters.
 */
async function checkPastedCensus(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  const PRE = '<pre>zebra one\ntwo</pre>';
  const SPAN = '<p>a <span>zebra</span> word</p>';
  const DIV = '<div><p>zebra inside</p></div>';
  const SUP = '<p>zebra = mc<sup>2</sup></p>';
  const LOOSE = '<div>zebra on a line</div>';
  const REFUSED =
    '<p><a href="javascript:alert(1)">zebra</a> or <a href="https://example.com">this</a></p>';

  const runAs = async (text, target, expected) => {
    await page.goto(`${ORIGIN}/tools/text-convert`, { waitUntil: 'networkidle' });
    await page
      .getByRole('heading', { level: 1, name: 'Text convert' })
      .waitFor({ timeout: 15_000 });
    // Typed BEFORE either listbox opens: round eleven's rule.
    await page.getByLabel('Text convert input').fill(text);
    await page.getByRole('combobox', { name: 'Source format' }).click();
    await page.getByRole('option', { name: 'HTML', exact: true }).click();
    await page.getByRole('combobox', { name: 'Target format' }).click();
    await page.getByRole('option', { name: target, exact: true }).click();

    const typed = await page.getByLabel('Text convert input').inputValue();
    if (typed !== text) {
      return {
        output: null,
        notes: { drawn: false, text: `HARNESS: typed ${typed.length} of ${text.length}` },
      };
    }

    await page.getByRole('button', { name: 'Run' }).click();
    const output = page.getByLabel('Text convert Converted');
    await output.waitFor({ timeout: 30_000 });
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const value = await output.inputValue();
      if (value.includes(expected))
        return { output: value, notes: await drawnNotes(page, 'Text convert Report notes') };
      await page.waitForTimeout(100);
    }
    return { output: null, notes: { drawn: false, text: 'the output never arrived' } };
  };

  const claimsAnElement = (text) => text.includes('could not carry') || text.includes('invented');

  try {
    /* -- the three false notes, gone ------------------------------------- */
    for (const [name, html, target] of [
      ['a <pre> with no <code>', PRE, 'Markdown'],
      ['a bare <span>', SPAN, 'Markdown'],
      ['a <div> around a paragraph', DIV, 'HTML (normalised)'],
    ]) {
      const result = await runAs(html, target, 'zebra');
      check(
        label,
        `${name} draws no note about an element, on the tool page`,
        result.output !== null && !claimsAnElement(result.notes.text),
        result.output === null ? result.notes.text : result.notes.text.slice(0, 200),
      );
    }

    /* -- the true loss beside them, still said ------------------------- */
    const sup = await runAs(SUP, 'Markdown', 'zebra');
    check(
      label,
      'and a superscript the round trip unwraps is still drawn, naming it',
      sup.notes.drawn &&
        sup.notes.text.includes('could not carry') &&
        sup.notes.text.includes('<sup>'),
      sup.notes.text.slice(0, 200),
    );

    /* -- the paragraph, said at the strength it has --------------------- */
    const loose = await runAs(LOOSE, 'HTML (normalised)', '<p>zebra on a line</p>');
    check(
      label,
      'loose text put in a paragraph is drawn as a note, and not as a lost element',
      loose.notes.drawn &&
        loose.notes.text.includes('Loose content was put in a paragraph') &&
        !claimsAnElement(loose.notes.text),
      loose.notes.text.slice(0, 200),
    );

    /* -- a refused link, with the reason that is true ------------------- */
    const refused = await runAs(REFUSED, 'HTML (sanitised)', 'zebra');
    check(
      label,
      'a link whose address was refused says it became plain text, not that <a> is refused',
      refused.notes.drawn &&
        refused.notes.text.includes('1 link became plain text') &&
        !refused.notes.text.includes('not on the allowed list'),
      refused.notes.text.slice(0, 220),
    );

    /*
     * -- TC-1, the correctness half, in a real engine ----------------------
     *
     * A table cell holding a list used to emit a literal newline, which ends a
     * GFM row - so the output box held a table that renders wrongly. Corpus row
     * 14 holds the NOTE for this document; what no note can hold is that the
     * table it wrote is still a table, so the output is read back and asserted
     * three lines, every one a row.
     */
    const listed = LOSS_CORPUS.cases.find((entry) => entry.id === 'markdown-cell-list-flattened');
    const cells = await runAs(listed?.input ?? '', 'Markdown', 'South');
    const rows = (cells.output ?? '').split('\n').filter((line) => line !== '');
    check(
      label,
      'a table cell that was a list still writes a table of three lines, every one a row',
      rows.length === 3 && rows.every((line) => line.startsWith('|') && line.endsWith('|')),
      JSON.stringify(rows),
    );

    /* -- on a node's face, where only a warning goes -------------------- */
    const markdown = { source: 'html', target: 'markdown' };
    const normalised = { source: 'html', target: 'html' };

    // The normalised target, not Markdown: a face shows the output's first
    // line, and a Markdown fence's first line is three backticks, which holds
    // no settle word. The census is the same one on both targets.
    const preNode = await onNode(page, 'text-convert', normalised, PRE, (text) =>
      text.includes('zebra'),
    );
    check(
      label,
      'a node holding a <pre> with no <code> says nothing about loss',
      preNode !== null &&
        preNode.drawn &&
        preNode.spoken.includes('succeeded') &&
        !preNode.text.includes('Lossy'),
      JSON.stringify(preNode),
    );

    const looseNode = await onNode(page, 'text-convert', normalised, LOOSE, (text) =>
      text.includes('zebra'),
    );
    check(
      label,
      'nor does one whose text was put in a paragraph - that note is not a loss',
      looseNode !== null &&
        looseNode.drawn &&
        looseNode.spoken.includes('succeeded') &&
        !looseNode.text.includes('Lossy'),
      JSON.stringify(looseNode),
    );

    const supNode = await onNode(page, 'text-convert', markdown, SUP, (text) =>
      text.startsWith('Lossy'),
    );
    check(
      label,
      'while one holding a superscript prints the loss on its face',
      supNode !== null && supNode.drawn && supNode.text.includes('could not carry'),
      JSON.stringify(supNode),
    );
  } finally {
    await context.close();
  }
}

/**
 * JWT-3 AND CC-5a, two sentences a person reads rather than two notes.
 *
 *   JWT-3  the line under the claims table naming the claims it leaves out.
 *   CC-5a  a red that drifted to 359.98 through oklch() printed as hue 0,
 *          because the hex beside it is #ff0000 - and one 8-bit step away,
 *          left alone.
 */
async function checkClaimsAndHue(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = (payload) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.c2lnbmF0dXJl`;

  /** No key and no listbox, so nothing can steal the fill; read back anyway. */
  const decode = async (jwt, settled) => {
    await page.goto(`${ORIGIN}/tools/jwt-decode`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1, name: 'JWT' }).waitFor({ timeout: 15_000 });
    await page.getByLabel('JWT input').fill(jwt);
    if ((await page.getByLabel('JWT input').inputValue()) !== jwt) return null;
    await page.getByRole('button', { name: 'Run' }).click();
    await page.locator('[data-trust]').first().waitFor({ timeout: 30_000 });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await settled()) break;
      await page.waitForTimeout(100);
    }
    return page.evaluate(() => {
      const line = document.querySelector('[data-other-claims]');
      if (line === null) return { drawn: false, text: '' };
      const rect = line.getBoundingClientRect();
      return { drawn: rect.width > 0 && rect.height > 0, text: (line.textContent ?? '').trim() };
    });
  };

  /** Converts to hsl(), typed before the listbox opens, and returns the answer. */
  const toHsl = async (text) => {
    await page.goto(`${ORIGIN}/tools/color-convert`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1, name: 'Colour' }).waitFor({ timeout: 15_000 });
    await page.getByLabel('Colour input').fill(text);
    await page.getByRole('combobox', { name: 'Convert to' }).click();
    await page.getByRole('option', { name: 'hsl()', exact: true }).click();
    if ((await page.getByLabel('Colour input').inputValue()) !== text) return null;
    await page.getByRole('button', { name: 'Run' }).click();
    const output = page.getByLabel('Colour Converted');
    await output.waitFor({ timeout: 30_000 });
    // Settled on a value only an hsl() run can produce: a fresh page holds
    // nothing, and the hex default never starts with `hsl(`.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const value = await output.inputValue();
      if (value.startsWith('hsl(')) return value;
      await page.waitForTimeout(100);
    }
    return null;
  };

  try {
    const named = await decode(
      token({ sub: 'ada', name: 'Ada' }),
      async () => (await page.locator('[data-other-claims]').count()) > 0,
    );
    check(
      label,
      'the claims table says which claims it leaves out, drawn under it',
      named !== null &&
        named.drawn &&
        named.text === 'The table lists registered claims only. name is in the payload below.',
      JSON.stringify(named),
    );

    const registered = await decode(
      token({ sub: 'grace' }),
      async () => (await page.getByText('grace').count()) > 0,
    );
    check(
      label,
      'and a token whose every claim is in the table draws no such line',
      registered !== null && !registered.drawn && registered.text === '',
      JSON.stringify(registered),
    );

    // What this tool itself writes for #ff0000 at five places, which reads
    // back at hue 359.984. A hand-typed longer hue rounded to exactly 360 and
    // was caught by round nine's wrap rule instead, so the first version of
    // this check passed with the snap removed.
    const drifted = await toHsl('oklch(0.62796 0.25768 29.23)');
    check(
      label,
      'a red that drifted through oklch() prints hue 0, because its hex is #ff0000',
      drifted === 'hsl(0 100% 50%)',
      String(drifted),
    );

    const nextDoor = await toHsl('hsl(359.7 100% 50%)');
    check(
      label,
      'and a red one 8-bit step away keeps its hue',
      nextDoor === 'hsl(359.7 100% 50%)',
      String(nextDoor),
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * WHAT A NODE DRAWS WHEN ITS ANSWER IS A SERIALISED DOCUMENT.
 *
 * A node summarises its first output, and for three tools that output is a
 * document written out as text. The summary rule for text is "the first
 * non-empty line", which was written for prose and is syntax for everything
 * else - so until round seven a node drew:
 *
 *   - `[` or `{` for every pretty-printed JSON document it ever produced;
 *   - `---` for every YAML stream;
 *   - `--- original` for every unified patch, and `Empty` for every identical
 *     comparison, which is the word reserved for a run that produced nothing;
 *   - the subject handed straight back, for a replacement that matched
 *     nothing - indistinguishable from one that worked.
 *
 * Each of those is the SAME STRING for every document of its kind, so it
 * carries no information about the result it names.
 *
 * WHY IT IS HERE AND NOT ONLY IN THE UNIT SUITE. `resultSummary.test.ts`
 * asserts the strings the function returns, which is a claim about a function.
 * The claim worth making is that a person standing in front of the canvas
 * READS them, and jsdom has no layout engine: a node drawn at zero height
 * behind the inspector satisfies `textContent` and satisfies nothing else. So
 * every assertion below is paired - the measurement is drawn with a real box,
 * and the string the old rule would have drawn is not on the node.
 *
 * The negative halves are the ones that fail if `measuredBy` stops being read.
 */
async function checkSerialisedFaces(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();

  try {
    const nodeLink = (tool, options) =>
      `${ORIGIN}/?p=${shareParam({ v: 3, n: [['n1', tool, 0, 0, options]], e: [] })}`;

    /** The face of `n1`, and whether it takes up any room on screen. */
    const faceOf = () =>
      page.evaluate(() => {
        const box = document.querySelector('[data-testid="node-n1"] [class*="nodeSummary"]');
        if (box === null) return null;
        const rect = box.getBoundingClientRect();
        return {
          text: (box.textContent ?? '').replace(/\s+/g, ' ').trim(),
          drawn: rect.width > 0 && rect.height > 0,
          spoken: (
            document.querySelector('[data-testid="node-n1"]')?.getAttribute('aria-label') ?? ''
          )
            .replace(/\s+/g, ' ')
            .trim(),
        };
      });

    const untilFace = async (predicate) => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const face = await faceOf();
        if ((face !== null && predicate(face.text)) || Date.now() > deadline) return face;
        await page.waitForTimeout(100);
      }
    };

    /**
     * Opens a node and fills one of its input boxes.
     *
     * By PORT ID rather than by position: `diff` has two, and "the first
     * textarea in the panel" is a fact about the panel's layout rather than
     * about which document is which.
     */
    const typeInto = async (portId, value) => {
      await page.locator('[data-testid="node-n1"]').focus();
      await page.keyboard.press('Enter');
      const field = page.locator(`[data-inspector-input="${portId}"]`);
      await field.waitFor({ timeout: 15_000 });
      await field.fill(value);
    };

    const open = async (tool, options) => {
      await page.goto(nodeLink(tool, options), { waitUntil: 'networkidle' });
      await page.locator('[data-testid="node-n1"]').waitFor({ timeout: 15_000 });
    };

    /* -- 1: pretty-printed JSON, which is where this was reported ---------- */
    const CONVERT = {
      source: 'auto',
      target: 'json',
      indent: 2,
      delimiter: 'comma',
      sortKeys: false,
    };
    await open('structured-data', CONVERT);
    await typeInto('input', '[{"a": 1}, {"a": 2}]');

    const jsonFace = await untilFace((text) => text === '2 items');
    check(
      label,
      'a node holding a pretty-printed JSON document draws what it amounts to',
      jsonFace !== null && jsonFace.drawn && jsonFace.text === '2 items',
      JSON.stringify(jsonFace?.text ?? null),
    );
    check(
      label,
      'and not the opening bracket, which every one of them starts with',
      jsonFace !== null && jsonFace.text !== '[' && !jsonFace.text.startsWith('['),
      JSON.stringify(jsonFace?.text ?? null),
    );
    check(
      label,
      'and its accessible name carries the same measurement',
      jsonFace !== null && jsonFace.spoken.includes('2 items'),
      (jsonFace?.spoken ?? '').slice(0, 160),
    );

    /* -- 2: a YAML stream, whose first line is the document marker --------- */
    await open('structured-data', { ...CONVERT, target: 'yaml' });
    await typeInto('input', '---\na: 1\n---\nb: 2\n');

    const yamlFace = await untilFace((text) => text === '2 items');
    check(
      label,
      'a node holding a two-document YAML stream draws two, not the marker',
      yamlFace !== null && yamlFace.drawn && yamlFace.text === '2 items' && yamlFace.text !== '---',
      JSON.stringify(yamlFace?.text ?? null),
    );

    /* -- 3: a unified patch, whose first line is a constant ---------------- */
    const DIFF = {
      ignoreWhitespace: 'none',
      ignoreCase: false,
      lineEndings: 'ignore',
      refineWords: true,
      context: 3,
    };
    await open('diff', DIFF);
    await typeInto('original', 'one\ntwo\nthree\n');
    await typeInto('changed', 'one\n2\nthree\n');

    const patchFace = await untilFace((text) => text.includes('+1'));
    check(
      label,
      'a node holding a unified patch draws what changed',
      patchFace !== null && patchFace.drawn && patchFace.text === '+1 −1',
      JSON.stringify(patchFace?.text ?? null),
    );
    check(
      label,
      'and not `--- original`, which is the first line of every patch there is',
      patchFace !== null && !patchFace.text.includes('--- original'),
      JSON.stringify(patchFace?.text ?? null),
    );

    /* -- 4: and the identical pair, which produces no patch at all --------- */
    await open('diff', DIFF);
    await typeInto('original', 'one\ntwo\n');
    await typeInto('changed', 'one\ntwo\n');

    const sameFace = await untilFace((text) => text === 'Identical');
    check(
      label,
      'two identical documents draw `Identical` rather than `Empty`',
      sameFace !== null && sameFace.drawn && sameFace.text === 'Identical',
      JSON.stringify(sameFace?.text ?? null),
    );

    /*
     * -- 5: the one that was not merely uninformative but misleading --------
     *
     * A replacement that matched nothing hands the subject back unchanged, so
     * the node drew the first line of the text that went IN, under the word
     * `ok`. Both halves are checked in one page each, because the point is
     * that the two runs used to be indistinguishable.
     */
    const REPLACE = {
      pattern: 'zzz',
      mode: 'replace',
      replacement: 'X',
      global: true,
      ignoreCase: false,
      multiline: false,
      dotAll: false,
      unicode: 'none',
      sticky: false,
    };
    await open('regex-tester', REPLACE);
    await typeInto('input', 'alpha beta');

    const missedFace = await untilFace((text) => text === 'Nothing replaced');
    check(
      label,
      'a replacement that matched nothing says so on the node',
      missedFace !== null && missedFace.drawn && missedFace.text === 'Nothing replaced',
      JSON.stringify(missedFace?.text ?? null),
    );
    check(
      label,
      'and does not draw the subject it handed straight back',
      missedFace !== null && !missedFace.text.includes('alpha'),
      JSON.stringify(missedFace?.text ?? null),
    );

    await open('regex-tester', { ...REPLACE, pattern: 'a' });
    await typeInto('input', 'alpha beta');

    const didFace = await untilFace((text) => text === '3 replaced');
    check(
      label,
      'and a replacement that worked draws a different sentence from one that did not',
      didFace !== null &&
        didFace.drawn &&
        didFace.text === '3 replaced' &&
        didFace.text !== missedFace?.text,
      JSON.stringify([missedFace?.text ?? null, didFace?.text ?? null]),
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * A LOSS THAT FOLLOWS A WIRE, AND ONE VERDICT PER NODE.
 *
 * Round three put what a conversion lost on the face of the node that lost it,
 * and `checkLossReports` above asserts that sentence is really drawn. Two things
 * were still wrong on a canvas somebody looked at, and neither was a data bug:
 *
 *   1. That node's FOOTER said `ok` under a face reading `Lossy · …`. Two
 *      verdicts on one node, and the footer is the row a canvas of ten is
 *      scanned by.
 *   2. Wire it into a second node and the second one said `ok` with a blank
 *      face, holding a string where the source had an object. The node with the
 *      damaged value was the silent one.
 *
 * The unit suite can assert the words. It cannot assert that they are DRAWN, or
 * that the LED beside them is a different SHAPE rather than only a different
 * colour - jsdom has no layout engine and resolves `clip-path` to nothing. Both
 * are here, in two engines, with no click anywhere.
 *
 * THREE NEGATIVE CONTROLS, because a mark that fires on a clean canvas is the
 * one people learn to ignore before the day it is true:
 *
 *   - a long lossless chain, where every node has to say `ok`;
 *   - the same lossy node wired onward from `data` instead of `output` - the
 *     parsed source, which the write half's flattening is not in. That wire is
 *     the way AROUND this loss, and a warning on it would be a warning on the
 *     workaround;
 *   - the node that lost it, which is not downstream of anything and has to say
 *     `lossy` rather than `after loss`.
 */
async function checkLossAlongWires(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();

  const CSV = { source: 'auto', target: 'csv', indent: 2, delimiter: 'comma', sortKeys: false };
  const JSON_TARGET = {
    source: 'auto',
    target: 'json',
    indent: 2,
    delimiter: 'comma',
    sortKeys: false,
  };

  /** Nested, so a table has to flatten something; flat, so it does not. */
  const NESTED = '[{"user": {"name": "ada"}, "id": 1}, {"id": 2}]';
  const FLAT = '[{"a": 1, "b": 2}, {"a": 3, "b": 4}]';

  /**
   * The footer's status word, whether it occupies any space, and the LED's own
   * shape.
   *
   * Drawn as well as present, because `textContent` is satisfied by a node at
   * zero height behind the inspector, and the whole claim is that somebody
   * standing in front of the canvas reads this without pressing anything.
   */
  const verdictOf = (id) =>
    page.evaluate((nodeId) => {
      const node = document.querySelector(`[data-testid="node-${nodeId}"]`);
      if (node === null) return null;
      const slot = node.querySelector('[class*="nodeFooter"] > span');
      const led = node.querySelector('[class*="led"]');
      const box = slot === null ? null : slot.getBoundingClientRect();
      return {
        /*
         * The ATTRIBUTE and the drawn TEXT both, and they are compared against
         * each other below. An attribute nothing draws is a claim about a
         * payload, which is the thing this file exists to distrust.
         */
        attribute: node.getAttribute('data-verdict'),
        text: (slot?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        drawn: box !== null && box.width > 0 && box.height > 0,
        spoken: node.getAttribute('aria-label') ?? '',
        clipPath: led === null ? '' : getComputedStyle(led).clipPath,
      };
    }, id);

  const untilVerdict = async (id, wanted, timeout = 30_000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const state = await verdictOf(id);
      if ((state !== null && state.attribute === wanted) || Date.now() > deadline) return state;
      await page.waitForTimeout(100);
    }
  };

  /**
   * A whole graph in a share link, so nothing has to be wired by hand.
   *
   * A node's typed input deliberately does not travel in a link, so the head
   * node is filled once through the inspector and every node downstream of it
   * follows from the run.
   */
  const graphLink = (nodes, edges) => `${ORIGIN}/?p=${shareParam({ v: 3, n: nodes, e: edges })}`;

  const openChain = async (nodes, edges, input) => {
    await page.goto(graphLink(nodes, edges), { waitUntil: 'networkidle' });
    await page.locator('[data-testid="node-n1"]').waitFor({ timeout: 15_000 });
    await page.locator('[data-testid="node-n1"]').focus();
    await page.keyboard.press('Enter');
    const field = page.locator('[data-inspector-input]').first();
    await field.waitFor({ timeout: 15_000 });
    await field.fill(input);
    /*
     * Back out to the node. A share link opens the inspector on the first node,
     * and a 320px rail over a 1600px viewport still covers the right-hand end
     * of a four-node chain - so a node read while the panel is open can measure
     * zero through no fault of the thing being tested.
     */
    await page.keyboard.press('Escape');
  };

  try {
    /* -- 1. The node that lost it says so where its status goes ------------- */
    await openChain(
      [
        ['n1', 'structured-data', 40, 40, CSV],
        ['n2', 'structured-data', 400, 40, JSON_TARGET],
      ],
      [['n1', 'output', 'n2', 'input']],
      NESTED,
    );

    const lossy = await untilVerdict('n1', 'lossy');
    check(
      label,
      'the node that lost something says lossy in its footer, not ok',
      lossy !== null && lossy.drawn && lossy.text === 'lossy',
      JSON.stringify(lossy),
    );

    /* -- 2. And the node holding the damaged value says where it came from -- */
    const after = await untilVerdict('n2', 'after-loss');
    check(
      label,
      'the node downstream of it says after loss, drawn, with no click',
      after !== null && after.drawn && after.text === 'after loss',
      JSON.stringify(after),
    );

    check(
      label,
      'and its accessible name names the node upstream and what that node lost',
      after !== null &&
        after.spoken.includes('after a loss in Structured data') &&
        after.spoken.includes('nested'),
      (after?.spoken ?? '').replace(/\s+/g, ' ').slice(0, 200),
    );

    /*
     * THE SHAPE, NOT THE HUE. Three states that all mean "it ran" have to be
     * distinguishable with every colour discarded, which is what forced-colors
     * mode does and what this project's rules require of every signal. The two
     * loss states share a bite out of the square and differ by fill; `ok` has no
     * clip at all. jsdom resolves `clip-path` to the empty string, so this claim
     * has never been checkable anywhere but here.
     */
    check(
      label,
      'both loss LEDs carry a shape, and the same one',
      lossy !== null &&
        after !== null &&
        lossy.clipPath !== 'none' &&
        lossy.clipPath !== '' &&
        lossy.clipPath === after.clipPath,
      `lossy=${lossy?.clipPath ?? ''} after=${after?.clipPath ?? ''}`,
    );

    /* -- 3. The negative control that matters most: a wire from `data` ------ */
    await openChain(
      [
        ['n1', 'structured-data', 40, 40, CSV],
        ['n2', 'structured-data', 400, 40, JSON_TARGET],
      ],
      [['n1', 'data', 'n2', 'input']],
      NESTED,
    );

    const viaData = await untilVerdict('n2', 'ok');
    check(
      label,
      'a wire out of the port the loss is NOT in leaves the next node saying ok',
      viaData !== null && viaData.drawn && viaData.text === 'ok',
      JSON.stringify(viaData),
    );

    const stillLossy = await verdictOf('n1');
    check(
      label,
      'while the node that lost it still says so',
      stillLossy !== null && stillLossy.text === 'lossy',
      JSON.stringify(stillLossy),
    );

    /* -- 4. Four hops, so the warning does not stop at the first one -------- */
    const chain = [
      ['n1', 'structured-data', 40, 40, CSV],
      ['n2', 'structured-data', 340, 40, JSON_TARGET],
      ['n3', 'structured-data', 640, 40, JSON_TARGET],
      ['n4', 'hash', 940, 40, { algorithm: 'sha-256', encoding: 'hex' }],
    ];
    const chainWires = [
      ['n1', 'output', 'n2', 'input'],
      ['n2', 'output', 'n3', 'input'],
      ['n3', 'output', 'n4', 'input'],
    ];

    await openChain(chain, chainWires, NESTED);

    const far = await untilVerdict('n4', 'after-loss');
    check(
      label,
      'three wires later the warning is still there, which is where it used to vanish',
      far !== null && far.drawn && far.text === 'after loss',
      JSON.stringify(far),
    );

    /* -- 5. The same four nodes, one flat table: silence -------------------- */
    await openChain(chain, chainWires, FLAT);

    const clean = [];
    for (const id of ['n1', 'n2', 'n3', 'n4']) {
      clean.push(await untilVerdict(id, 'ok'));
    }

    check(
      label,
      'a long chain that loses nothing says ok on every node and mentions no loss',
      clean.every(
        (state) =>
          state !== null &&
          state.drawn &&
          state.text === 'ok' &&
          !state.spoken.toLowerCase().includes('loss'),
      ),
      JSON.stringify(clean.map((state) => (state === null ? null : state.text))),
    );

    check(
      label,
      'and a clean LED has no bite taken out of it',
      clean[0] !== null && (clean[0].clipPath === 'none' || clean[0].clipPath === ''),
      clean[0] === null ? 'missing' : clean[0].clipPath,
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
      /*
       * A CLOSED `<details>` PAINTS NONE OF ITS CONTENT, and both engines still
       * LAY THAT CONTENT OUT: measured on `/tools/base64` at 390px, a 17px
       * closed disclosure reporting a 133px table inside it, in Gecko and in
       * JavaScriptCore alike. Nothing is drawn - a screenshot of the panel is
       * the summary and the footer and nothing else - so every box in there is
       * a box this sweep must not reason about.
       *
       * It cost 52 checks to find that out, all of them "a child escaping its
       * parent" against content nobody can see. The first guess was that
       * `display: grid` on the direct child was overriding the UA rule that
       * hides it; removing the declaration entirely still reported 125px, so
       * the override was never the cause and the app needed no change at all.
       */
      if (node.tagName === 'DETAILS' && !node.open) return false;
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
 * WAITS UNTIL NOTHING THAT CAN CHANGE THE LAYOUT IS STILL HAPPENING - round
 * sixteen, for the probe below.
 *
 * checkMobileLayout used to wait out 56 navigations with `networkidle`, which
 * is Playwright's 500 ms of silence after the last request, and then a fixed
 * 250 ms, with 150-500 ms more around every overlay: measured, 54 of its 83
 * seconds per engine were those windows passing. And a window is not a
 * guarantee. A tool page draws its options only when `loadTool` resolves, and
 * a probe taken before that measures less page and finds fewer faults - it
 * PASSES - so "early" is the dangerous direction and a fixed wait only makes it
 * unlikely.
 *
 * So this waits for the things themselves, all at once:
 *
 *   - no request in flight - `inFlight` is fed by the page's own request
 *     events, so a chunk the page is still fetching holds it;
 *   - the fonts loaded, because a swap moves every line;
 *   - no finite animation or transition still running (an infinite one, the
 *     route bar's sweep or a travelling dash, would never finish);
 *   - no DOM mutation across two animation frames, which is what a React
 *     commit after any of the above looks like.
 *
 * Measured against the old waits before replacing them: over 112 loads, both
 * engines, all four widths, the probe read the same at this point as after
 * `networkidle` and 250 ms, every time. And `loaded` below is the positive
 * partner that makes being early a FAILURE rather than a pass.
 *
 * AND THE PAGE'S OWN WORD THAT IT HAS DRAWN, because the request half is blind
 * in WebKit. The first full run with this settle failed twice there - base64,
 * the first tool page each context opens, measured "still loading its
 * options". Traced: in WebKit a navigation reports only its four entry files;
 * the route's chunk and the tool's module are dynamic imports the service
 * worker answers, and they never appear as page requests at all. So "nothing
 * in flight" was true while the one fetch that draws the options was still
 * running. `networkidle` cannot see that fetch either - what covered it before
 * was the 250 ms that followed, which made it unlikely rather than impossible.
 * So the settle also waits, within its deadline, for what `LOADED_PROBE`
 * reads; and the check after it still asks, so a settle that gives up fails.
 */
async function settle(page, inFlight, deadline = 15_000) {
  const until = Date.now() + deadline;
  await page
    .waitForFunction(
      () =>
        document.readyState === 'complete' &&
        document.fonts.status === 'loaded' &&
        !document.querySelector('[data-testid="route-progress"][data-pending]'),
      undefined,
      { timeout: deadline },
    )
    .catch(() => undefined);
  await page.waitForFunction(DRAWN, undefined, { timeout: deadline }).catch(() => undefined);

  while (Date.now() < until) {
    if (inFlight.size === 0) {
      const quiet = await page.evaluate(
        () =>
          new Promise((resolve) => {
            let changed = false;
            const observer = new MutationObserver(() => {
              changed = true;
            });
            observer.observe(document, {
              subtree: true,
              childList: true,
              attributes: true,
              characterData: true,
            });
            const running = () =>
              document
                .getAnimations()
                .some(
                  (animation) =>
                    animation.playState === 'running' &&
                    animation.effect?.getComputedTiming().iterations !== Infinity,
                );
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                observer.disconnect();
                resolve(!changed && !running());
              }),
            );
          }),
      );
      if (quiet && inFlight.size === 0) return true;
    } else {
      await page.waitForTimeout(20);
    }
  }
  return false;
}

/** The requests a page has started and not yet finished, for `settle`. */
function requestsInFlight(page) {
  const inFlight = new Set();
  page.on('request', (request) => inFlight.add(request));
  page.on('requestfinished', (request) => inFlight.delete(request));
  page.on('requestfailed', (request) => inFlight.delete(request));
  return inFlight;
}

/**
 * Whether the page a probe is about to measure has finished drawing itself.
 *
 * A tool page says "Loading options..." until its tool's module has arrived,
 * and keeps Run disabled; measured in that state, every assertion below
 * passes on less than the page. Asked of every scene, so a settle that
 * returned early fails a check instead of a probe quietly measuring less.
 */
/**
 * The same question as a predicate, for `settle` to wait on.
 *
 * On a tool page, drawn means a Run button that is enabled and no "Loading
 * options...". "No Run button" is NOT drawn there: before the route's own chunk
 * arrives the page has neither the placeholder nor the button, and the first
 * version of this predicate read that as finished - which is how the fix for
 * WebKit's invisible module fetch failed WebKit again, on the same page.
 */
const DRAWN = () => {
  const run = [...document.querySelectorAll('button')].find(
    (button) => (button.textContent ?? '').trim() === 'Run',
  );
  const toolPage = /^\/tools\/[^/]+/.test(location.pathname);
  if (document.body.innerText.includes('Loading options')) return false;
  if (toolPage) return run !== undefined && !run.disabled;
  return run === undefined || !run.disabled;
};

const LOADED_PROBE = () => {
  const run = [...document.querySelectorAll('button')].find(
    (button) => (button.textContent ?? '').trim() === 'Run',
  );
  const toolPage = /^\/tools\/[^/]+/.test(location.pathname);
  const loading = document.body.innerText.includes('Loading options');
  const missing = toolPage && run === undefined;
  return {
    loaded: !loading && !missing && (run === undefined || !run.disabled),
    detail: loading
      ? 'still loading its options'
      : missing
        ? 'a tool page with no Run button yet'
        : run?.disabled
          ? 'Run is disabled'
          : '',
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

  /**
   * Settles the page, checks it drew all of itself, and measures it: the one
   * way every scene below is looked at, so no scene can be measured early.
   */
  const measure = async (page, inFlight, width, scene) => {
    const settled = await settle(page, inFlight);
    const drawn = await page.evaluate(LOADED_PROBE);
    check(
      label,
      `${scene} at ${String(width)}px had finished drawing when it was measured`,
      settled && drawn.loaded,
      settled ? drawn.detail : 'HARNESS: the page never settled in 15s',
    );
    assess(width, scene, await page.evaluate(MOBILE_PROBE));
  };

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
      const inFlight = requestsInFlight(page);

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
          await page.goto(`${ORIGIN}${path}`, { waitUntil: 'load' });
          await measure(page, inFlight, width, name);
        }

        /* -- Every overlay ------------------------------------------------- */
        await gotoCanvas(page);
        await page.locator('[role="application"]').first().waitFor({ timeout: 15_000 });

        await page.getByRole('button', { name: 'Add tool' }).click();
        await page.locator('[role="dialog"]').first().waitFor({ timeout: 10_000 });
        await measure(page, inFlight, width, 'the command palette');
        await page.keyboard.press('Escape');

        await page
          .locator('[role="application"]')
          .first()
          .click({ position: { x: 30, y: 300 } });
        await page.keyboard.press('?');
        await page.locator('[role="dialog"]').first().waitFor({ timeout: 10_000 });
        await measure(page, inFlight, width, 'the shortcuts reference');
        await page.keyboard.press('Escape');
        await settle(page, inFlight);

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
        await measure(page, inFlight, width, 'the overflow menu');

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
        await measure(page, inFlight, width, 'the canvas with a node');

        /*
         * THE INSPECTOR SHEET, which is the one region of this app that
         * deliberately covers another. Every measurement `assess` makes still
         * has to hold: a panel that overflows the viewport sideways, clips a
         * control, or puts a 30px tap target on a phone is a defect whether it
         * is a sheet or not - and this one holds a whole options form and an
         * output view inside 65% of a 780px screen.
         */
        await inspectFirstNode(page);
        await measure(page, inFlight, width, 'the inspector sheet');
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
        await settle(page, inFlight);
        /*
         * A FAILURE, NOT A SKIP, WHEN IT DOES NOT OPEN.
         *
         * This was a `skip` reading "it did not open from the C key", which is
         * an observation rather than a mechanism - and it is the branch a
         * regression in the C binding would take. Measured: the dialog opens at
         * all four widths in both engines, every run. So the branch was dead
         * code whose only remaining purpose was to absorb the defect it was
         * standing next to, and it would have absorbed it silently, because a
         * skip carries no failure and until now reached no summary either.
         *
         * What a phone genuinely cannot do is press C - that is the gap the
         * comment above names, and it is a gap in the touch model rather than
         * something the harness is unable to reach. The harness has a keyboard.
         */
        const opened = (await page.locator('[role="dialog"]').count()) > 0;
        check(
          label,
          `C on a focused node opens the connect dialog at ${String(width)}px`,
          opened,
          '',
        );
        if (opened) {
          await measure(page, inFlight, width, 'the connect dialog');
          await page.keyboard.press('Escape');
          await settle(page, inFlight);
        }

        /* -- The theme editor ---------------------------------------------- */
        await page.goto(`${ORIGIN}/styleguide`, { waitUntil: 'load' });
        await settle(page, inFlight);
        await page.getByRole('button', { name: 'Create theme' }).click();
        await measure(page, inFlight, width, 'the theme editor');

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
        await page.goto(`${ORIGIN}/tools/diff`, { waitUntil: 'load' });
        await settle(page, inFlight);
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
        await measure(page, inFlight, width, 'the diff output and its notes');

        await page.goto(`${ORIGIN}/tools/regex-tester`, { waitUntil: 'load' });
        await settle(page, inFlight);
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
        await measure(page, inFlight, width, 'the regex match table');

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
        await measure(page, inFlight, width, 'an open select');
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
 * EVERY RADIX COMPONENT, AT PHONE WIDTHS, UNDER THE REAL CSP.
 *
 * Opening a select used to make the policy refuse two stylesheets, every time,
 * in every engine: react-remove-scroll-bar's body scroll lock (injected through
 * react-style-singleton) and the `<style>` Radix Select's viewport renders to
 * hide its own scrollbar. The verification skill filed those refusals as
 * known noise - "the blocked styles are the popover's collision avoidance,
 * so it may render off-screen at a narrow width" - on the strength of one
 * look at 1440x900, and nothing here ever opened a select with a console
 * listener attached, so the question was never asked in a real engine.
 *
 * It was measured before this was written, at 1440, 390, 320 and 568x320 and
 * with the trigger 40px above the bottom edge, in three engines: the list was
 * on screen in all 24 arrangements, flipping above the trigger wherever below
 * had no room. Positioning is Floating UI writing through React's `style`
 * prop, which is the CSSOM, and the CSSOM is not governed by `style-src` -
 * `public/_headers` already says so. What the refusals cost was the scroll
 * lock's stylesheet (the JavaScript half of the lock kept working) and the
 * list's hidden scrollbar. See docs/architecture.md, "What the console noise
 * was".
 *
 * So both halves are asserted, because either alone would let the other come
 * back unnoticed:
 *
 *   - NOTHING IS REFUSED. A `securitypolicyviolation` recorder is installed
 *     before any app code, and every console error is kept. Its positive
 *     partner is a refusal caused on purpose, first, which the recorder has to
 *     see - an instrument that records nothing passes "zero refusals" in
 *     exactly the way a broken one does.
 *   - THE POPOVER IS ON SCREEN. A console check alone would not catch the bug
 *     that was feared: a list positioned off the edge logs nothing at all. So
 *     every popover this app draws is measured against the viewport, at the
 *     widths and in the one arrangement where collision avoidance has work to
 *     do.
 *   - WHAT WAS REFUSED NOW ARRIVES. The page is scroll locked while the list is
 *     open and unlocked after, and the viewport's stylesheet has rules. These
 *     are the positive partners of "nothing is refused": a fix that stopped the
 *     refusals by stopping the stylesheets from being inserted at all would
 *     pass the first assertion and fail these.
 *   - A LIST THAT DOES NOT FIT SAYS SO. With the scrollbar hidden, the scroll
 *     buttons are the only sign that a list continues, and a phone on its side
 *     is where a list stops fitting. The overflow is asserted to have happened
 *     before the button is asserted to exist.
 *
 * Tabs, Tooltip and Toast draw no stylesheet of their own and are driven here
 * for the "every Radix component, not only the one where it was noticed"
 * half: the refusal recorder is on for the whole page's life, so anything any
 * of them inserts is counted.
 */
async function checkPopovers(engine, label) {
  const browser = await launchTouchBrowser(engine);

  /** Installed before any app code runs, and before the policy is enforced on it. */
  const recordRefusals = () => {
    window.__cspRefused = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspRefused.push(
        `${event.effectiveDirective} from ${event.sourceFile || 'inline'}:${String(event.lineNumber)}`,
      );
    });
  };

  const open = async (options) => {
    const context = await browser.newContext(options);
    await context.addInitScript(recordRefusals);
    const page = await context.newPage();
    const errors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text().slice(0, 140));
    });
    page.on('pageerror', (error) => errors.push(`pageerror: ${String(error).slice(0, 140)}`));
    return { context, page, errors };
  };

  /** What this page's policy refused, and what reached the console, since load. */
  const assertQuiet = async (page, errors, at) => {
    const refused = await page.evaluate(() => window.__cspRefused ?? null);
    check(
      label,
      `${at}: the CSP refuses nothing`,
      Array.isArray(refused) && refused.length === 0,
      refused === null ? 'the recorder was never installed' : refused.join(' | '),
    );
    check(label, `${at}: no console errors`, errors.length === 0, errors.join(' | '));
  };

  /** The open popover's box, measured against the viewport it has to fit in. */
  const measurePopover = (page, selector) =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      return {
        box: `${r.left.toFixed(0)},${r.top.toFixed(0)} ${r.width.toFixed(0)}x${r.height.toFixed(0)} in ${String(vw)}x${String(vh)}`,
        sized: r.width > 0 && r.height > 0,
        inside: r.left >= -0.5 && r.top >= -0.5 && r.right <= vw + 0.5 && r.bottom <= vh + 0.5,
      };
    }, selector);

  const assertOnScreen = (at, what, measured) =>
    check(
      label,
      `${at}: ${what} is drawn, and entirely on screen`,
      measured !== null && measured.sized && measured.inside,
      measured === null ? 'nothing to measure' : measured.box,
    );

  /** Reads what the two formerly refused stylesheets are doing right now. */
  const librarySheets = (page) =>
    page.evaluate(() => {
      const viewportStyle = [...document.querySelectorAll('style')].find((s) =>
        (s.textContent ?? '').includes('[data-radix-select-viewport]'),
      );
      let viewportRules = -1;
      try {
        viewportRules = viewportStyle?.sheet ? viewportStyle.sheet.cssRules.length : 0;
      } catch {
        viewportRules = -2;
      }
      return {
        locked: document.body.hasAttribute('data-scroll-locked'),
        bodyOverflow: getComputedStyle(document.body).overflowY,
        viewportRules,
        // Where the scroll lock's stylesheet lives now: src/lib/styleSingleton.ts.
        adopted: document.adoptedStyleSheets.length,
      };
    });

  try {
    /* -- The instrument, shown to work before anything relies on it -------- */
    {
      const { context, page } = await open({ viewport: { width: 390, height: 844 } });
      try {
        await page.goto(`${ORIGIN}/tools`, { waitUntil: 'networkidle' });
        await page.evaluate(() => {
          const style = document.createElement('style');
          style.textContent = 'body { outline: 1px solid red; }';
          document.head.append(style);
        });
        await page.waitForTimeout(200);
        const refused = await page.evaluate(() => window.__cspRefused ?? null);
        check(
          label,
          'popovers: the refusal recorder sees a <style> injected on purpose',
          Array.isArray(refused) && refused.length === 1 && refused[0].startsWith('style-src'),
          JSON.stringify(refused),
        );
      } finally {
        await context.close().catch(() => {});
      }
    }

    /* -- The Category filter, where it was noticed ------------------------- */
    const categoryScenes = [
      { name: 'desktop', viewport: { width: 1440, height: 900 }, hasTouch: false },
      { name: 'phone', viewport: { width: 390, height: 844 }, hasTouch: true },
      { name: 'small phone', viewport: { width: 320, height: 568 }, hasTouch: true },
      { name: 'phone on its side', viewport: { width: 568, height: 320 }, hasTouch: true },
      // The arrangement collision avoidance exists for: no room below.
      {
        name: 'phone, trigger at the bottom edge',
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        atBottom: true,
      },
    ];

    for (const scene of categoryScenes) {
      const at = `the Category filter, ${scene.name}`;
      const { context, page, errors } = await open({
        viewport: scene.viewport,
        hasTouch: scene.hasTouch,
      });
      try {
        await page.goto(`${ORIGIN}/tools`, { waitUntil: 'networkidle' });
        const trigger = page.getByRole('combobox', { name: 'Category' });
        await trigger.waitFor({ timeout: 15_000 });

        if (scene.atBottom) {
          // A shorter window rather than a scroll: the filter is near the top
          // of the document, where there is nothing above it to scroll away.
          const bottom = await trigger.evaluate((el) => el.getBoundingClientRect().bottom);
          await page.setViewportSize({
            width: scene.viewport.width,
            height: Math.ceil(bottom) + 40,
          });
        }

        const idle = await librarySheets(page);
        await trigger.click();
        await page.getByRole('listbox').waitFor({ timeout: 10_000 });
        await page.waitForTimeout(250);

        const measured = await measurePopover(page, '[role="listbox"]');
        assertOnScreen(at, 'the open list', measured);
        if (scene.atBottom) {
          const side = await page.evaluate(
            () =>
              document
                .querySelector('[role="listbox"]')
                ?.closest('[data-side]')
                ?.getAttribute('data-side') ?? null,
          );
          check(
            label,
            `${at}: the list opens above a trigger with no room below`,
            side === 'top',
            `data-side=${String(side)}`,
          );
        }

        const sheets = await librarySheets(page);
        check(
          label,
          `${at}: the page is scroll locked while the list is open, and not before`,
          !idle.locked &&
            idle.bodyOverflow !== 'hidden' &&
            sheets.locked &&
            sheets.bodyOverflow === 'hidden' &&
            sheets.adopted === idle.adopted + 1,
          `before: ${JSON.stringify(idle)}, open: ${JSON.stringify(sheets)}`,
        );
        check(
          label,
          `${at}: the list's own stylesheet applies`,
          sheets.viewportRules === 2,
          `${String(sheets.viewportRules)} rules`,
        );

        const overflow = await page.evaluate(() => {
          const viewport = document.querySelector('[data-radix-select-viewport]');
          const down = document.querySelector('[data-select-scroll="down"]');
          return viewport
            ? {
                overflows: viewport.scrollHeight > viewport.clientHeight + 1,
                heights: `${String(viewport.scrollHeight)}/${String(viewport.clientHeight)}`,
                buttonDrawn: down !== null && down.getBoundingClientRect().height > 0,
              }
            : null;
        });
        if (scene.name === 'phone on its side') {
          // The precondition first: a list that happened to fit would make
          // the affordance check below a statement about nothing.
          check(
            label,
            `${at}: the list is taller than the room it has`,
            overflow?.overflows === true,
            overflow?.heights ?? 'no viewport',
          );
          check(
            label,
            `${at}: and a scroll button says there is more`,
            overflow?.buttonDrawn === true,
            JSON.stringify(overflow),
          );
        }

        /*
         * A bounded click, recorded rather than thrown: an option drawn off
         * the screen cannot be clicked, which is the very failure this check
         * is for, and it has to arrive as a named FAIL rather than as a
         * timeout that ends the whole run.
         */
        const chose = await page
          .getByRole('option', { name: 'Hashing', exact: true })
          .click({ timeout: 10_000 })
          .then(
            () => true,
            (error) => String(error).split('\n')[0],
          );
        if (chose !== true) await page.keyboard.press('Escape');
        /*
         * BOUNDED AND RECORDED TOO, for the same reason as the click. Round
         * twenty's second full run ended here, in Gecko, on a list still open
         * ten seconds after the pick - thrown, so the run died with every
         * check after it unread and nothing to say what state the page was in.
         * It did not recur in isolation. Now it is a named failure that says
         * what the pick returned, where focus was, and whether a second Escape
         * closes the list.
         */
        const stuck = await page
          .getByRole('listbox')
          .waitFor({ state: 'detached', timeout: 10_000 })
          .then(
            () => null,
            async () => {
              const focus = await page.evaluate(() => {
                const active = document.activeElement;
                return active
                  ? `${active.tagName.toLowerCase()}[role=${String(active.getAttribute('role'))}]`
                  : 'nothing';
              });
              await page.keyboard.press('Escape');
              const second = await page
                .getByRole('listbox')
                .waitFor({ state: 'detached', timeout: 5_000 })
                .then(
                  () => 'a second Escape closed it',
                  () => 'a second Escape did not close it',
                );
              return `still open 10s after the pick (${chose === true ? 'the click landed' : String(chose)}); focus on ${focus}; ${second}`;
            },
          );
        check(label, `${at}: the list closes after the pick`, stuck === null, stuck ?? 'closed');
        if (stuck !== null && (await page.getByRole('listbox').count()) > 0) continue;
        const hrefs = await page
          .locator('a[href^="/tools/"]')
          .evaluateAll((els) => [...new Set(els.map((el) => el.getAttribute('href')))]);
        check(
          label,
          `${at}: choosing Hashing leaves only Hash`,
          chose === true && hrefs.length === 1 && hrefs[0] === '/tools/hash',
          chose === true ? hrefs.join(', ') : `could not choose it: ${chose}`,
        );

        /*
         * The sheet has to LEAVE, not merely stop matching. Its rules are
         * scoped to `body[data-scroll-locked]`, so a sheet left behind once
         * the attribute goes is invisible to every computed style - and one
         * more would be left behind on every open, for the life of the tab.
         * Counted, because nothing else can see it.
         */
        const closed = await librarySheets(page);
        check(
          label,
          `${at}: closing the list releases the lock and takes its stylesheet away`,
          !closed.locked && closed.bodyOverflow !== 'hidden' && closed.adopted === idle.adopted,
          JSON.stringify(closed),
        );
        await assertQuiet(page, errors, at);
      } finally {
        await context.close().catch(() => {});
      }
    }

    /* -- The same Select in the two other containers it lives in ------------ */
    {
      const at = 'a tool page select, small phone';
      const { context, page, errors } = await open({
        viewport: { width: 320, height: 568 },
        hasTouch: true,
      });
      try {
        await page.goto(`${ORIGIN}/tools/base64`, { waitUntil: 'networkidle' });
        await page.getByRole('combobox', { name: 'Mode' }).click();
        await page.getByRole('listbox').waitFor({ timeout: 10_000 });
        await page.waitForTimeout(250);
        assertOnScreen(at, 'the open list', await measurePopover(page, '[role="listbox"]'));
        await page
          .getByRole('option', { name: 'Decode', exact: true })
          .click({ timeout: 10_000 })
          .catch(() => page.keyboard.press('Escape'));
        check(
          label,
          `${at}: the choice lands`,
          (await page.getByRole('combobox', { name: 'Mode' }).textContent())?.includes('Decode') ===
            true,
          '',
        );
        await assertQuiet(page, errors, at);
      } finally {
        await context.close().catch(() => {});
      }
    }

    {
      /*
       * The inspector is a sheet across the bottom of a phone, so its selects
       * sit low on the screen - the other place a list has no room below.
       */
      const at = 'an inspector select on the canvas, phone';
      const { context, page, errors } = await open({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      });
      try {
        await gotoCanvas(page);
        await page.getByRole('button', { name: 'Add tool' }).click();
        await page.getByTestId('dialog-option-base64').click();
        await page
          .locator('[role="dialog"]')
          .first()
          .waitFor({ state: 'detached', timeout: 10_000 });
        await setInspector(page, true);
        const panel = page.getByTestId('node-inspector');
        const trigger = panel.getByRole('combobox', { name: 'Mode' });
        await trigger.scrollIntoViewIfNeeded();
        await trigger.click();
        await page.getByRole('listbox').waitFor({ timeout: 10_000 });
        await page.waitForTimeout(250);
        assertOnScreen(at, 'the open list', await measurePopover(page, '[role="listbox"]'));
        await page.keyboard.press('Escape');
        await assertQuiet(page, errors, at);
      } finally {
        await context.close().catch(() => {});
      }
    }

    /* -- Tabs, Tooltip and Toast, on the page that shows all of them -------- */
    {
      const at = 'the styleguide components, small phone';
      // No touch: a tooltip is a hover-and-focus affordance, and a coarse
      // pointer is exactly where Radix declines to open one on hover.
      const { context, page, errors } = await open({ viewport: { width: 320, height: 568 } });
      try {
        await page.goto(`${ORIGIN}/styleguide`, { waitUntil: 'networkidle' });

        const tab = page.getByRole('region', { name: 'Tabs' }).getByRole('tab', { name: 'Output' });
        await tab.click();
        check(
          label,
          `${at}: a tab switches its panel`,
          (await tab.getAttribute('aria-selected')) === 'true',
          '',
        );

        // The right-hand tooltip: side="right" on a 320px screen has to move.
        const copy = page
          .getByRole('region', { name: 'Tooltip' })
          .getByRole('button', { name: 'Copy output' });
        await copy.scrollIntoViewIfNeeded();
        await copy.hover();
        await page.getByRole('tooltip').first().waitFor({ timeout: 10_000 });
        await page.waitForTimeout(250);
        assertOnScreen(
          at,
          'a tooltip',
          await measurePopover(page, '[data-radix-popper-content-wrapper] > *'),
        );
        await page.mouse.move(0, 0);

        await page
          .getByRole('region', { name: 'Toast' })
          .getByRole('button', { name: 'Warning', exact: true })
          .click();
        const toast = page.locator('li[data-state="open"]').first();
        await toast.waitFor({ timeout: 10_000 });
        await page.waitForTimeout(300);
        const toastBox = await toast.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const vw = document.documentElement.clientWidth;
          const vh = window.innerHeight;
          return {
            box: `${r.left.toFixed(0)},${r.top.toFixed(0)} ${r.width.toFixed(0)}x${r.height.toFixed(0)} in ${String(vw)}x${String(vh)}`,
            sized: r.width > 0 && r.height > 0,
            inside: r.left >= -0.5 && r.top >= -0.5 && r.right <= vw + 0.5 && r.bottom <= vh + 0.5,
          };
        });
        assertOnScreen(at, 'a toast', toastBox);

        const trigger = page.getByRole('combobox', { name: 'Encoding' });
        await trigger.scrollIntoViewIfNeeded();
        await trigger.click();
        await page.getByRole('listbox').waitFor({ timeout: 10_000 });
        await page.waitForTimeout(250);
        assertOnScreen(at, 'the open list', await measurePopover(page, '[role="listbox"]'));
        await page.keyboard.press('Escape');

        await assertQuiet(page, errors, at);
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
       * pipeline's re-run debounce is 300ms. Sub-100ms timers are the
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
         * ASSIGNED EXACTLY ONCE, AND ONLY WHEN THE OUTCOME IS KNOWN.
         *
         * This used to publish `captured` here and then overwrite it with the
         * engine's verdict when the forward settled, which made
         * `window.__clipboard` a value that meant three different things at
         * three different times - and the reader below could not tell them
         * apart. Both races were real and both were measured; see the note
         * above the read. One terminal assignment means a non-null read is
         * always a settled one, so `refusal` is never merely "not yet".
         *
         * The payload is the app's, whatever the engine does with it - so a
         * headless refusal costs the acceptance line and not the eight
         * assertions about what was built. The error is re-thrown so the app
         * takes its own failure path and the toast stays truthful.
         */
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

    // Typed BEFORE the listbox and read back after it: a fill landing while
    // Radix returns focus to the select trigger is discarded (crash B), and a
    // copy of an empty box would fail below as the clipboard's fault.
    const editor = page.locator('textarea').first();
    await editor.fill(source);
    await page.getByRole('combobox', { name: 'Target format' }).click();
    // The normalised target by its full name: since round three there are two
    // whose label begins "HTML", and a prefix match resolves to both.
    await page.getByRole('option', { name: 'HTML (normalised)', exact: true }).click();
    const typed = await editor.inputValue();
    check(
      label,
      'the harness typed the document it is about to copy',
      typed === source,
      `${typed.length.toString()} of ${source.length.toString()} characters in the box`,
    );
    await page.getByRole('button', { name: 'Run' }).click();

    const richCopy = page.getByRole('button', { name: 'Copy as rich text' });
    await richCopy.waitFor({ timeout: 20_000 });
    await richCopy.click();

    /*
     * WAITED FOR, NOT READ ON THE WAY PAST. THIS IS THE FIX FOR THE NINE.
     *
     * `click()` resolves when the click has been dispatched, not when what it
     * started has finished. The app calls `navigator.clipboard.write`
     * synchronously inside the handler - measured, every run - but the wrapper
     * above cannot record the payload synchronously, because reading a `Blob`
     * is asynchronous by construction: two `getType().text()` awaits stand
     * between entering the wrapper and having anything to publish.
     *
     * So the old `page.evaluate` immediately after the click was racing the
     * harness's OWN instrumentation, and losing. Measured against this build,
     * with the wrapper marking wrapper-entry synchronously so the two could be
     * told apart:
     *
     *   Gecko, idle machine:  2 of 5 runs read before the payload was there.
     *   Gecko, page under CPU load: 11 of 12, with the read landing 40-60 ms
     *     early against an `enteredAt` that was already in the past.
     *   JavaScriptCore: never lost that race, and always lost the second one -
     *     8 of 8 runs read the record before the engine's refusal arrived,
     *     ~18 ms early, so the acceptance line below reported that the engine
     *     ACCEPTED a write it had in fact refused with `NotAllowedError`.
     *
     * `entered` was true in all 20 runs and the engine's verdict, once it
     * arrived, never varied. Nothing about the app was ever intermittent.
     *
     * A timeout rather than an unbounded wait, because "the button never
     * reaches the clipboard API at all" is a real defect this check must still
     * be able to fail on - it now fails as itself instead of as eight
     * assertions about an empty string.
     */
    const settled = await page
      .waitForFunction(() => window.__clipboard !== null, undefined, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    const written = settled ? await page.evaluate(() => window.__clipboard) : null;

    /*
     * WHETHER THE ENGINE TOOK IT. A headless build that refuses clipboard
     * access is a fact about the harness rather than about the app, so it is a
     * skip - but a build that ACCEPTS the item has proved something worth
     * having, because `ClipboardItem` with two flavours at once is exactly
     * what older builds restricted.
     */
    if (written === null) {
      /*
       * Named as its own failure rather than left to be inferred from the
       * eight assertions below going red against an empty string. If the copy
       * button stops reaching the clipboard API, THIS is the line that says so.
       */
      check(
        label,
        'the copy button reaches navigator.clipboard.write, and it settles',
        false,
        'nothing reached it within 15 s',
      );
    } else if (written.refusal !== null) {
      skip(
        label,
        'the engine accepting a two-flavour ClipboardItem',
        `this build refused the write (${String(written.refusal).slice(0, 80)}); the payload it was given is still asserted below, in full, so what is unproved is only that an engine would ACCEPT a two-flavour item. Measured: Playwright's grantPermissions does not know clipboard-write for either engine and throws on the context, so a permission grant is not a way round this`,
      );
    } else {
      check(label, 'the engine accepts a two-flavour ClipboardItem', written.refusal === null, '');
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

    /*
     * THE `html !== ''` IS LOAD-BEARING, AND IS WHY THE COUNT WAS NINE.
     *
     * Two negative assertions over a string that is `''` whenever nothing
     * reached the wrapper - so this was the one check in this function that
     * PASSED in the exact failure mode the other nine reported. A check that
     * cannot fail when everything around it is failing is worse than absent:
     * it made the block read as "nine of ten", which invites the reader to
     * hunt for what was special about the ten.
     */
    check(
      label,
      'no <style> element, which Google Docs discards, and no stylesheet link',
      html !== '' && !/<style[\s>]/i.test(html) && !/<link[^>]*stylesheet/i.test(html),
      html === '' ? 'no payload to inspect' : '',
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

/**
 * THE PROGRESS MARKER, WHICH HAD NEVER BEEN PAINTED.
 *
 * `.progressBar` is a `<span>`, and on a non-replaced INLINE box `inline-size`,
 * `block-size` and `transform` do not apply. So its 33% width did nothing, its
 * 100% height did nothing, and the sweep animated a transform the box could not
 * have. Measured on the shipped build over 40 frames of a real run: one state,
 * `bar inline 0x0 transform=matrix(1, 0, 0, 1, 0, 0)`. The TRACK around it
 * rendered perfectly at 120x6, which is why this read as "the bar is just
 * empty" rather than as a missing element.
 *
 * Nothing else could have caught it. jsdom has no layout, so the box is zero
 * there whatever the CSS says; axe does not care whether a `progressbar` moves;
 * and no assertion anywhere asked whether the marker had a size. A progress bar
 * that cannot move is the affordance-without-behaviour rule CONTRIBUTING names,
 * in its quietest form - the control was not wired to nothing, it was wired to
 * something that could not be drawn.
 *
 * WHAT IS ASSERTED IS MOVEMENT, NOT A DURATION. The sweep is a CSS animation, so
 * sampling frames measures this machine only in how MANY samples it gets; a slow
 * one takes fewer and each one still has to differ. Two distinct transforms over
 * a run is the floor, and a stalled bar produces exactly one however long the
 * run lasts. The size is asserted beside it, because a 0x0 box has one transform
 * too and would satisfy a movement test that forgot to look.
 */
async function checkRunProgress(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  try {
    await page.goto(`${ORIGIN}/tools/text-convert`, { waitUntil: 'networkidle' });
    await page
      .getByRole('heading', { level: 1, name: 'Text convert' })
      .waitFor({ timeout: 15_000 });
    await page.getByRole('combobox', { name: 'Target format' }).waitFor({ timeout: 15_000 });

    /*
     * A document big enough that the run outlives a handful of frames. Every
     * other tool page in this file runs in single-digit milliseconds, which is
     * correct and is exactly why the marker's absence was invisible: there was
     * never anything on screen long enough to notice was not moving.
     */
    const document_ = Array.from(
      { length: 4_000 },
      (_, index) =>
        `## Heading ${String(index)}\n\nSome **bold** and _italic_ prose with a [link](https://example.com/${String(index)}).\n`,
    ).join('\n');
    /*
     * SET THROUGH THE VALUE SETTER RATHER THAN `fill`.
     *
     * Playwright's `fill` on a few hundred kilobytes takes 30 seconds in
     * JavaScriptCore and then throws - and the failure prints the document it
     * was handed, which turned one crash into a fifty-thousand-line log twice.
     * The native setter plus a bubbling `input` is what React listens for, and
     * it is instant whatever the size.
     */
    await page.evaluate((text) => {
      const field = document.querySelector('textarea:not([readonly])');
      if (!field) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(field, text);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }, document_);

    const sampled = await page.evaluate(async () => {
      const run = [...document.querySelectorAll('button')].find(
        (button) => (button.textContent ?? '').trim() === 'Run',
      );
      if (!run) return null;
      run.click();

      /*
       * SAMPLED FOR LONG ENOUGH TO SEE A LOOP, which is the point of the
       * no-reset assertion below. Forty frames is about two thirds of a second
       * and the shape this replaced looped every 1.2s, so a window that short
       * could not observe the very thing it was meant to refuse - driven
       * against a deliberately looping bar it reported no resets at all.
       *
       * Four hundred frames, because a headless engine runs well past 60fps:
       * 200 covered only 1469ms here, which is inside the 1.2s loop it has to
       * be able to see twice.
       *
       * The window is bounded by frames rather than by a clock, and the elapsed
       * time is reported rather than asserted: a slow machine takes fewer
       * samples over the same span, which weakens the evidence without ever
       * inventing a reset.
       */
      const frames = [];
      const startedAt = performance.now();
      for (let frame = 0; frame < 400; frame += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const track = document.querySelector('[role="progressbar"]');
        if (!track) break;
        const marker = track.firstElementChild;
        if (!marker) continue;
        const box = marker.getBoundingClientRect();
        frames.push({
          /*
           * The PAINTED width, which a `scaleX` animation legitimately takes
           * to zero at the start of every cycle, and the LAYOUT width, which
           * a transform never changes. The first is what moves; the second is
           * what says there is a box to move.
           */
          width: Math.round(box.width),
          layoutWidth: marker.offsetWidth,
          height: Math.round(box.height),
          transform: getComputedStyle(marker).transform,
        });
      }
      return { frames, elapsed: Math.round(performance.now() - startedAt) };
    });

    const frames = sampled?.frames ?? [];
    /*
     * The window has to outlast a plausible loop, or the no-reset assertion is
     * about nothing. 1.5s clears the 1.2s the looping version used.
     */
    check(
      label,
      'a run long enough to watch really does show the progress bar',
      sampled !== null && frames.length >= 4 && sampled.elapsed > 1500,
      `${String(frames.length)} frames over ${String(sampled?.elapsed ?? 0)}ms with a progressbar on screen`,
    );
    if (sampled === null || frames.length < 4 || sampled.elapsed <= 1500) return;

    /*
     * THE POSITIVE PARTNER. A marker that is not drawn has one transform for
     * the same reason a stalled one does, so "it moved" has to be paired with
     * "there is something to move".
     *
     * Against the LAYOUT width, not the painted one: the fill scales from zero
     * at the start of each cycle, so individual frames are legitimately 0px
     * wide and an every-frame assertion on the painted width would fail on a
     * correct bar. A transform never changes `offsetWidth`, so that is the box
     * itself - which was 0 when this element was an inline span.
     */
    check(
      label,
      'the progress marker is drawn rather than collapsed to nothing',
      frames.every((frame) => frame.layoutWidth > 2 && frame.height > 1),
      `${String(frames[0]?.layoutWidth)}x${String(frames[0]?.height)} laid out on the first sampled frame`,
    );
    /*
     * ONE FILL PER RUN, WHICH IS A MONOTONIC SEQUENCE.
     *
     * The shape before this looped, and pressing Run once and watching the bar
     * fill three times says three things happened. A loop is visible in the
     * samples as a DROP - the frame where it restarts is narrower than the one
     * before it - so "never narrower than the frame before" is the whole
     * assertion, and it is a property of the sequence rather than a duration
     * this harness would be measuring the machine with.
     *
     * One pixel of tolerance because the widths are rounded off a scaled box.
     */
    const widths = frames.map((frame) => frame.width);
    const resets = widths.filter((width, index) => index > 0 && width < widths[index - 1] - 1);
    check(
      label,
      'and it fills once rather than restarting while the run is still going',
      resets.length === 0,
      `${String(resets.length)} reset(s) across ${String(widths.length)} frames${
        resets.length === 0 ? '' : `, narrowing to ${resets.join(', ')}`
      }`,
    );
    /*
     * AND IT GROWS BY SOMETHING WORTH SEEING. A sequence that never goes
     * backwards is also satisfied by one that never goes anywhere.
     */
    check(
      label,
      'and the fill grows visibly over the run',
      widths[widths.length - 1] - widths[0] > 8,
      `${String(widths[0])} to ${String(widths[widths.length - 1])} of ${String(
        frames[0].layoutWidth,
      )}`,
    );

    /*
     * AGAINST THE PAINTED WIDTH, NOT THE COMPUTED TRANSFORM.
     *
     * The first version counted distinct `getComputedStyle().transform` values,
     * and a transform animates on an element that cannot render one: driven
     * against the inline `<span>` this whole check exists for, the property
     * swept through forty values while the box stayed 0x0 and nothing was ever
     * drawn. It reported movement on a bar that had none.
     *
     * The rendered width is the thing a person sees, it is zero when the
     * element cannot paint, and it is constant when the animation is dead - so
     * one distinct value means "not moving" for either reason.
     */
    const distinct = new Set(frames.map((frame) => frame.width));
    check(
      label,
      'and it fills rather than sitting still for the whole run',
      distinct.size > 1,
      `${String(distinct.size)} distinct painted width(s) over ${String(frames.length)} frames`,
    );
    /* -- ALIGNED WITH THE BUTTON IT BELONGS TO -------------------------- */
    /*
     * `.actions` is a wrapping flex row - Run on the left, the readout on the
     * right - and in a 300px rail a long duration pushes the readout onto its
     * own line UNDER the button. That is the state a person sees on any run
     * worth watching, and it is the one where the bar's left edge is compared
     * against something: every other control in the rail starts on that edge.
     *
     * `.busy` is itself a flex row with a gap, so an empty label span was still
     * a flex item and still took its gap, putting the finished bar 8px inside
     * that edge. The label is absent rather than empty now.
     *
     * The wrap is asserted first, because on a fast run the readout is short
     * enough to sit BESIDE the button - where it is supposed to be 64px to the
     * right and the comparison would mean nothing.
     */
    await page.waitForFunction(() => /Done in/.test(document.body.textContent ?? ''), undefined, {
      timeout: 60_000,
    });
    await page.waitForTimeout(400);

    const aligned = await page.evaluate(() => {
      const track = document.querySelector('[role="progressbar"]');
      const run = [...document.querySelectorAll('button')].find(
        (button) => (button.textContent ?? '').trim() === 'Run',
      );
      if (!track || !run) return null;
      const trackBox = track.getBoundingClientRect();
      const runBox = run.getBoundingClientRect();
      return {
        track: Math.round(trackBox.left),
        run: Math.round(runBox.left),
        wrapped: trackBox.top > runBox.top,
      };
    });

    check(
      label,
      'a long run pushes the readout onto its own line, which is what makes the edge comparable',
      aligned?.wrapped === true,
      `wrapped=${String(aligned?.wrapped)}`,
    );
    check(
      label,
      'and the finished bar starts on the same edge as the Run button',
      aligned !== null && aligned.wrapped && Math.abs(aligned.track - aligned.run) <= 1,
      aligned === null
        ? 'no bar or no button'
        : `bar at ${String(aligned.track)}, button at ${String(aligned.run)}`,
    );

    /* -- AND A SHORT RUN STILL SHOWS THE WHOLE JOURNEY ------------------- */
    /*
     * Everything above is measured on a deliberately long run, because that is
     * the only way to watch the indeterminate fill at all. The COMMON run here
     * is tens of milliseconds, and on one of those the fill reaches three
     * pixels before the answer arrives - so what a person actually sees is
     * nothing, and then a result.
     *
     * A run shorter than the sweep therefore plays the whole 0-to-100 on
     * completion, after the answer is already on screen. What is asserted is
     * the three things that makes: the bar outlives the result, it ARRIVES at
     * the end of the track, and it gets there through intermediate widths
     * rather than snapping - which is the difference between watching a bar
     * complete and being shown a full one.
     */
    await page.goto(`${ORIGIN}/tools/structured-data`, { waitUntil: 'networkidle' });
    await page
      .getByRole('heading', { level: 1, name: 'Structured data' })
      .waitFor({ timeout: 15_000 });
    await page.locator('textarea:not([readonly])').first().fill('test');

    const quick = await page.evaluate(async () => {
      const run = [...document.querySelectorAll('button')].find(
        (button) => (button.textContent ?? '').trim() === 'Run',
      );
      if (!run) return null;
      run.click();

      const frames = [];
      for (let frame = 0; frame < 90; frame += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const track = document.querySelector('[role="progressbar"]');
        const marker = track?.firstElementChild ?? null;
        frames.push({
          width: marker === null ? null : Math.round(marker.getBoundingClientRect().width),
          layoutWidth: marker === null ? null : marker.offsetWidth,
          done: /Done in/.test(document.body.textContent ?? ''),
        });
      }
      return frames;
    });

    const settled = quick?.findIndex((frame) => frame.done) ?? -1;
    check(
      label,
      'a short run really does settle inside the sampled window',
      settled > 0,
      `first "Done in" at frame ${String(settled)} of ${String(quick?.length ?? 0)}`,
    );
    if (quick === null || settled <= 0) return;

    const afterwards = quick.slice(settled).filter((frame) => frame.width !== null);
    check(
      label,
      'the bar is still on screen once the result is',
      afterwards.length > 10,
      `${String(afterwards.length)} frames with a bar after the result appeared`,
    );
    const full = afterwards.at(-1);
    check(
      label,
      'and it arrives at the end of the track rather than disappearing part way',
      full !== undefined && full.width === full.layoutWidth && full.width > 2,
      `${String(full?.width)} of ${String(full?.layoutWidth)} at the last sampled frame`,
    );
    /*
     * THROUGH the track, not straight to the end. A snap satisfies "arrives"
     * perfectly, and a snap is what this whole section exists to replace.
     */
    const steps = new Set(afterwards.map((frame) => frame.width));
    check(
      label,
      'and it travels there rather than snapping to full in one frame',
      steps.size > 5,
      `${String(steps.size)} distinct widths between the result and the full bar`,
    );
    /* -- A FAILED RUN DOES NOT GET A FULL BAR --------------------------- */
    /*
     * A full bar means the work finished, and a run that failed did not. This
     * is asserted rather than left as a consequence of the success branch,
     * because the branch reads like an oversight: somebody restoring "the bar
     * should always complete" would be fixing a bug that is not one.
     */
    await page.goto(`${ORIGIN}/tools/jwt-decode`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1, name: 'JWT' }).waitFor({ timeout: 15_000 });
    await page.getByLabel('JWT input').fill('this is not a token');
    await page.getByRole('button', { name: 'Run' }).click();
    await page.waitForTimeout(600);

    const failed = await page.evaluate(() => {
      const track = document.querySelector('[role="progressbar"]');
      const marker = track?.firstElementChild ?? null;
      return {
        errored: /failed|invalid|not a|cannot/i.test(document.body.textContent ?? ''),
        present: track !== null,
        width: marker === null ? null : Math.round(marker.getBoundingClientRect().width),
        layoutWidth: marker === null ? null : marker.offsetWidth,
      };
    });

    check(
      label,
      'the run really did fail, so the bar has something to refuse to complete for',
      failed.errored,
      `errored=${String(failed.errored)}`,
    );
    check(
      label,
      'a failed run leaves the bar short of full rather than completing it',
      failed.present === false || (failed.width !== null && failed.width < failed.layoutWidth),
      failed.present === false
        ? 'no bar at all'
        : `${String(failed.width)} of ${String(failed.layoutWidth)}`,
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * THE TOOL PAGE WARMS THE WORKER, AND ONLY WHERE A TOOL WILL RUN.
 *
 * A worker has its own module registry, so importing a tool into the page for
 * its option fields does nothing for the thread the tool runs on - and the
 * first press of Run was paying for the worker's import. Measured on the
 * production build, structured-data, the same input three times: 63ms, 7ms, 7ms
 * before, and 8ms, 9ms, 5ms after. The canvas never had the problem because it
 * calls `prefetch` when a node is added; this page never called it at all.
 *
 * THE COST IS A WORKER, so it must be paid only where a tool is actually going
 * to run. `/tools` lists eleven of them and runs none, and warming all eleven from an
 * index would be the hover-prefetch this engine's comment already rules out.
 * The count is taken by replacing the constructor before any application code
 * runs, because "did a worker start" is not otherwise observable from a page.
 */
async function checkWorkerWarmth(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    await page.addInitScript(() => {
      window.__workers = 0;
      const Real = window.Worker;
      window.Worker = class extends Real {
        constructor(...args) {
          window.__workers += 1;
          super(...args);
        }
      };
    });

    await page.goto(`${ORIGIN}/tools`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1, name: 'Every tool' }).waitFor({ timeout: 15_000 });
    await page.waitForTimeout(600);
    const onIndex = await page.evaluate(() => window.__workers);
    check(
      label,
      'listing the tools starts no worker, because none of them is going to run',
      onIndex === 0,
      `${String(onIndex)} worker(s)`,
    );

    await page.goto(`${ORIGIN}/tools/base64`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1, name: 'Base64' }).waitFor({ timeout: 15_000 });
    await page.getByRole('combobox', { name: 'Mode' }).waitFor({ timeout: 15_000 });
    await page.waitForTimeout(600);
    const onTool = await page.evaluate(() => window.__workers);
    check(
      label,
      'and opening one tool warms exactly one, before Run is ever pressed',
      onTool === 1,
      `${String(onTool)} worker(s)`,
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * THE OPTION NOTES TOGGLE, IN BOTH PANELS THAT HAVE ONE.
 *
 * Every option field may declare a sentence explaining it, and every one of
 * them used to be painted on every visit. Measured on the shipped build: the
 * two descriptions on `/tools/regex-tester` were 32px and 64px of a 490px
 * Options panel, and in the canvas inspector - where the rail is 320px at its
 * narrowest - the same sentences wrap further and push the Output section that
 * far down.
 *
 * They are a preference now, off by default, remembered, with one control in
 * the panel's own title bar. THE PART THAT NEEDS A REAL BROWSER is that hiding
 * them is a decision about PAINT and not about the accessibility tree: the
 * `<p>` stays in the DOM, stays the target of the control's
 * `aria-describedby`, and is clipped by the recipe `VisuallyHidden` uses. jsdom
 * can see the element and the attribute and cannot see that it occupies no
 * height, and axe cannot see it either way - so the pair of facts that make
 * this acceptable are asserted here, together.
 *
 * AND THE TOGGLE IS OPERATED FROM THE KEYBOARD, not clicked. A density control
 * reachable only by pointer would be the same defect in a different place.
 */
async function checkOptionNotes(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  /** The Options panel, its notes button, and what the descriptions measure. */
  const NOTES_PROBE = () => {
    const panel = [...document.querySelectorAll('section')].find(
      (el) => (el.querySelector('h2, h3')?.textContent ?? '').trim() === 'Options',
    );
    if (!panel) return null;

    const toggle = [...panel.querySelectorAll('button')].find(
      (el) => (el.textContent ?? '').trim() === 'Notes',
    );
    const heading = panel.querySelector('h2, h3');
    const descriptions = [...panel.querySelectorAll('[class*="description"]')].map((el) => ({
      text: (el.textContent ?? '').trim().slice(0, 40),
      height: Math.round(el.getBoundingClientRect().height),
      /*
       * THE TWO PROPERTIES THAT WOULD TAKE IT OUT OF THE ACCESSIBILITY TREE,
       * read rather than assumed. Everything else about the recipe is
       * cosmetic; these two are what would turn a density preference into a
       * removal.
       */
      display: getComputedStyle(el).display,
      visibility: getComputedStyle(el).visibility,
      /** Whether any control in this panel actually points at it. */
      describes: [...panel.querySelectorAll('[aria-describedby]')].some((control) =>
        (control.getAttribute('aria-describedby') ?? '').split(/\s+/u).includes(el.id),
      ),
    }));

    return {
      panelHeight: Math.round(panel.getBoundingClientRect().height),
      pressed: toggle?.getAttribute('aria-pressed') ?? null,
      /*
       * On the heading's own row, which is what makes it cost no height: the
       * title bar is there whether or not anything sits beside it.
       */
      onHeadingRow:
        toggle !== undefined &&
        heading !== null &&
        Math.abs(
          toggle.getBoundingClientRect().top +
            toggle.getBoundingClientRect().height / 2 -
            (heading.getBoundingClientRect().top + heading.getBoundingClientRect().height / 2),
        ) <= 4,
      descriptions,
    };
  };

  /** Tab until the Notes button has focus, or give up after a bounded walk. */
  const focusNotes = async (target) => {
    for (let step = 0; step < 60; step += 1) {
      const there = await target.evaluate(
        () => (document.activeElement?.textContent ?? '').trim() === 'Notes',
      );
      if (there) return true;
      await target.keyboard.press('Tab');
    }
    return false;
  };

  try {
    await page.goto(`${ORIGIN}/tools/regex-tester`, { waitUntil: 'networkidle' });
    await page
      .getByLabel(/pattern/i)
      .first()
      .waitFor({ timeout: 15_000 });
    await page.waitForTimeout(150);

    const off = await page.evaluate(NOTES_PROBE);
    check(
      label,
      'the options panel carries a notes toggle on its heading row',
      off !== null && off.pressed === 'false' && off.onHeadingRow,
      off === null
        ? 'no options panel'
        : `pressed=${String(off.pressed)}, onRow=${String(off.onHeadingRow)}`,
    );

    /*
     * The subject exists before anything is asserted about its absence. A
     * description that had stopped being rendered at all would satisfy every
     * "takes no height" assertion below perfectly well.
     */
    check(
      label,
      'the descriptions are still in the document with the notes off',
      off !== null && off.descriptions.length > 0 && off.descriptions.every((d) => d.text !== ''),
      off === null ? 'no panel' : `${String(off.descriptions.length)} descriptions`,
    );
    check(
      label,
      'a hidden description costs the panel no height',
      off !== null && off.descriptions.every((d) => d.height <= 1),
      off === null ? 'no panel' : off.descriptions.map((d) => String(d.height)).join('/'),
    );
    check(
      label,
      'a hidden description is still in the accessibility tree and still describes its control',
      off !== null &&
        off.descriptions.every(
          (d) => d.display !== 'none' && d.visibility !== 'hidden' && d.describes,
        ),
      off === null
        ? 'no panel'
        : off.descriptions
            .map((d) => `${d.display}/${d.visibility}/describes=${String(d.describes)}`)
            .join(' | '),
    );

    /* -- Operated from the keyboard, and it changes the height ----------- */
    await page.locator('h1').first().click();
    const reached = await focusNotes(page);
    check(label, 'the notes toggle is reachable by Tab', reached, '');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);

    const on = await page.evaluate(NOTES_PROBE);
    check(
      label,
      'pressing Enter on it paints the descriptions and grows the panel',
      on !== null &&
        off !== null &&
        on.pressed === 'true' &&
        on.descriptions.every((d) => d.height > 1) &&
        on.panelHeight > off.panelHeight,
      on === null || off === null
        ? 'no panel'
        : `${String(off.panelHeight)} -> ${String(on.panelHeight)}, heights ${on.descriptions
            .map((d) => String(d.height))
            .join('/')}`,
    );

    /* -- And it is remembered, which is what makes "the first time" work -- */
    await page.reload({ waitUntil: 'networkidle' });
    await page
      .getByLabel(/pattern/i)
      .first()
      .waitFor({ timeout: 15_000 });
    await page.waitForTimeout(150);
    const reloaded = await page.evaluate(NOTES_PROBE);
    check(
      label,
      'the answer survives a reload',
      reloaded !== null &&
        reloaded.pressed === 'true' &&
        reloaded.descriptions.every((d) => d.height > 1),
      reloaded === null ? 'no panel' : `pressed=${String(reloaded.pressed)}`,
    );

    /*
     * -- THE SAME CONTROL AND THE SAME ANSWER IN THE INSPECTOR ------------
     *
     * One preference, two hosts. The reason to check the second is not that
     * the state might differ - it is a module - but that the inspector draws
     * its own heading row rather than using `Panel`'s title bar, so "the
     * toggle is on the rule and costs no height" is a separate claim about a
     * separate stylesheet.
     */
    await page.goto(
      `${ORIGIN}/?p=${shareParam({ v: 3, n: [['n1', 'regex-tester', 200, 200, {}]], e: [] })}`,
      { waitUntil: 'networkidle' },
    );
    await page.locator('[data-testid="node-n1"]').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(600);

    const inspector = await page.evaluate(NOTES_PROBE);
    check(
      label,
      'the inspector carries the same toggle, on its own heading rule',
      inspector !== null && inspector.pressed === 'true' && inspector.onHeadingRow,
      inspector === null
        ? 'no options section'
        : `pressed=${String(inspector.pressed)}, onRow=${String(inspector.onHeadingRow)}`,
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * THE TOOLS INDEX, WHERE THE CARDS IN A ROW HAVE TO READ AS A ROW.
 *
 * Two defects, and the first is the subtle one: the cards were already the same
 * HEIGHT - the `<li>` stretches - and their CONTENTS were not aligned, because
 * each card's rows sized to their content and the surplus collected at the
 * bottom. Measured on the shipped build at 1280, one row of four cards had its
 * port metadata at 86, 86, 102 and 102 inside four boxes of identical height,
 * because two summaries wrapped to two lines and two to three.
 *
 * The second is the wrap. A chip per PORT is five of them on `text-convert`, in
 * a wrapping flex row whose break point is a function of the column width - so
 * `out: json` fell onto a line of its own on some cards and not others, and the
 * Diff card ran to three lines. It is one line per DIRECTION now, which is at
 * most two lines whatever a tool declares.
 *
 * Asserted at four widths because the number of columns decides which cards
 * share a row, and a rule that aligns a row of four can still leave a row of
 * two ragged.
 */
async function checkToolIndex(browser, label) {
  for (const width of [390, 768, 1440, 1920]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const at = `${String(width)}px`;

    try {
      await page.goto(`${ORIGIN}/tools`, { waitUntil: 'networkidle' });
      await page
        .getByRole('heading', { level: 1, name: 'Every tool' })
        .waitFor({ timeout: 15_000 });
      await page.waitForTimeout(200);

      /*
       * THE PRIVACY TEXT FILLS ITS BOX. It sat at a 68ch measure in the left
       * third of a panel as wide as the page, reported in round twenty-one as
       * bunched up. Two columns where there is room, stacked where there is
       * not - and either way the text reaches across the panel's body rather
       * than stopping short of it.
       */
      const policy = await page
        .getByText('Every tool on this list runs entirely')
        .evaluate((first) => {
          const second = first.nextElementSibling;
          const host = first.parentElement.getBoundingClientRect();
          const a = first.getBoundingClientRect();
          const b = second?.getBoundingClientRect();
          return b
            ? {
                sideBySide: Math.abs(a.top - b.top) < 1 && b.left > a.right,
                span: (Math.max(a.right, b.right) - Math.min(a.left, b.left)) / host.width,
              }
            : null;
        });
      // Two columns fit from about 720px; the widths either side of that are pinned.
      const columns = width >= 1280 ? true : width <= 390 ? false : null;
      check(
        label,
        `${at}: the privacy text ${columns === true ? 'sits in two columns across' : columns === false ? 'stacks and fills' : 'fills'} its panel`,
        policy !== null &&
          (columns === null || policy.sideBySide === columns) &&
          policy.span >= 0.97,
        policy === null
          ? 'second paragraph missing'
          : `side by side ${String(policy.sideBySide)}, spans ${String(Math.round(policy.span * 100))}% of the panel`,
      );

      const probe = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('ul li > a')].map((card) => {
          const rect = card.getBoundingClientRect();
          const ports = card.querySelector('[class*="cardPorts"]');
          const lines = [...card.querySelectorAll('[class*="cardPortLine"]')].map((line) => {
            const lineRect = line.getBoundingClientRect();
            const types = line.querySelector('[class*="cardPortTypes"]');
            return {
              height: Math.round(lineRect.height),
              /*
               * AGAINST ITS OWN LINE BOX, NOT AGAINST ITS PARENT. The first
               * version of this compared the type list to the row holding it -
               * which is a flex container that GROWS with it, so a list that
               * wrapped to three lines took its row with it and the comparison
               * was true of nothing. It passed against a deliberately narrowed
               * card at every width.
               */
              wrapped:
                types !== null &&
                types.getBoundingClientRect().height >
                  parseFloat(getComputedStyle(types).lineHeight) + 1,
            };
          });
          return {
            name: (card.querySelector('[class*="cardName"]')?.textContent ?? '').trim(),
            top: Math.round(rect.top + window.scrollY),
            height: Math.round(rect.height),
            portsTop:
              ports === null
                ? null
                : Math.round(ports.getBoundingClientRect().top + window.scrollY),
            lines,
            /*
             * A bordered, padded chip is what the metadata used to be, and it
             * is the weight the category badge is meant to carry alone.
             */
            badges: card.querySelectorAll('[class*="badge"]').length,
          };
        });
        return {
          cards,
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        };
      });

      check(
        label,
        `the tools index does not scroll sideways at ${at}`,
        probe.scrollWidth <= probe.clientWidth,
        `${String(probe.scrollWidth)} in ${String(probe.clientWidth)}`,
      );

      /*
       * The subject, before anything is asserted about its shape. An empty
       * list satisfies "every row is aligned" perfectly, and a route that
       * rendered nothing is exactly what a broken lazy chunk produces.
       */
      check(
        label,
        `every tool drew a card with both directions on it at ${at}`,
        probe.cards.length >= 10 && probe.cards.every((card) => card.lines.length === 2),
        `${String(probe.cards.length)} cards, lines ${probe.cards
          .map((card) => String(card.lines.length))
          .join('')}`,
      );

      /* -- Grouped into rows by their own top edge ----------------------- */
      const rows = new Map();
      for (const card of probe.cards) {
        const row = rows.get(card.top) ?? [];
        row.push(card);
        rows.set(card.top, row);
      }
      const ragged = [...rows.values()].filter(
        (row) => new Set(row.map((card) => card.height)).size > 1,
      );
      check(
        label,
        `every card in a row is the same height at ${at}`,
        ragged.length === 0,
        ragged
          .map((row) => row.map((card) => `${card.name} ${String(card.height)}`).join(', '))
          .join(' | '),
      );

      /*
       * AND THEIR METADATA SHARES A BASELINE, which is the assertion the old
       * layout would have failed while passing the one above it.
       */
      const misaligned = [...rows.values()].filter(
        (row) => new Set(row.map((card) => card.portsTop)).size > 1,
      );
      check(
        label,
        `the metadata of every card in a row sits on one line at ${at}`,
        misaligned.length === 0,
        misaligned
          .map((row) => row.map((card) => `${card.name}@${String(card.portsTop)}`).join(', '))
          .join(' | '),
      );

      const wrapping = probe.cards.filter((card) => card.lines.some((line) => line.wrapped));
      check(
        label,
        `neither direction's type list wraps at ${at}`,
        wrapping.length === 0,
        wrapping.map((card) => card.name).join(', '),
      );

      /* -- AND IT HOLDS FOR A TOOL NOBODY HAS WRITTEN YET --------------- */
      /*
       * THE FIRST VERSION OF THE ALIGNMENT CHECK ABOVE PASSED AGAINST THE
       * BROKEN LAYOUT, and that is worth writing down rather than quietly
       * fixing. With `auto auto auto` instead of `auto minmax(0, 1fr) auto`,
       * `align-content: stretch` distributes the card's spare height equally
       * between its three rows - so as long as every card in a row has the same
       * title height and the same metadata height, they all land in the same
       * place anyway, and the rule that actually pins the metadata to the
       * bottom edge is doing nothing that today's content can see.
       *
       * Today's content cannot see it because the metadata is now two lines on
       * every card. That is a fact about the eleven tools in the registry, not
       * about the layout, and the twelfth tool is exactly the case the rule
       * exists for.
       *
       * So one card's summary is made taller than its neighbours' - through
       * `element.style`, which the CSP does not govern, the same fixture
       * mechanism `TALL_OPTIONS_FIXTURE` uses on the tool runner - and the
       * question is asked again. With the row template the metadata stays on
       * the shared baseline; with three `auto` rows it drops about 12px.
       */
      const grown = await page.evaluate(() => {
        const summary = document.querySelector('ul li > a [class*="cardSummary"]');
        if (!summary) return false;
        summary.style.minBlockSize = '80px';
        return true;
      });
      check(label, `a card's summary can be made taller than its neighbours at ${at}`, grown, '');
      await page.waitForTimeout(150);

      const stretched = await page.evaluate(() => {
        const rows = new Map();
        for (const card of document.querySelectorAll('ul li > a')) {
          const top = Math.round(card.getBoundingClientRect().top + window.scrollY);
          const ports = card.querySelector('[class*="cardPorts"]');
          const row = rows.get(top) ?? [];
          row.push({
            name: (card.querySelector('[class*="cardName"]')?.textContent ?? '').trim(),
            height: Math.round(card.getBoundingClientRect().height),
            portsTop: Math.round(ports.getBoundingClientRect().top + window.scrollY),
          });
          rows.set(top, row);
        }
        return [...rows.values()];
      });

      /*
       * THE CONTROL IS THE ROW'S HEIGHT, NOT THE SUMMARY'S. Every card in a row
       * stretches to the row, and the summary is the row that absorbs the
       * slack - so making ONE summary taller makes every summary in that row
       * taller, correctly, and comparing them to each other proves nothing. The
       * fixture worked if the row is taller than it was.
       */
      const before = probe.cards[0]?.height ?? 0;
      const firstRow = stretched[0] ?? [];
      check(
        label,
        `the fixture really made the first row taller at ${at}`,
        firstRow.length > 0 && firstRow[0].height > before,
        `${String(before)} -> ${String(firstRow[0]?.height)}`,
      );
      const stillMisaligned = stretched.filter(
        (row) => new Set(row.map((card) => card.portsTop)).size > 1,
      );
      check(
        label,
        `an unusually tall summary does not drag its card's metadata off the line at ${at}`,
        stillMisaligned.length === 0,
        stillMisaligned
          .map((row) => row.map((card) => `${card.name}@${String(card.portsTop)}`).join(', '))
          .join(' | '),
      );

      /*
       * ONE BADGE PER CARD, AND IT IS THE CATEGORY. The port metadata used to
       * wear the same outlined chip, so a tool declaring five ports carried
       * six of them - the taxonomy's weight, for a footnote.
       */
      const overBadged = probe.cards.filter((card) => card.badges !== 1);
      check(
        label,
        `a card wears exactly one badge, and it is the category, at ${at}`,
        overBadged.length === 0,
        overBadged.map((card) => `${card.name} ${String(card.badges)}`).join(', '),
      );
    } finally {
      await context.close().catch(() => {});
    }
  }
}

/**
 * A NODE'S SUMMARY BOX, AND THE ONE THING IT MUST NOT DO.
 *
 * The box reserves two lines, because two lines is what the tool's own
 * description, the blocked guidance and an error message each need. Most
 * RESULTS are one line, and with the text at the top of the box the second
 * line's reserved height collected underneath it: measured on the shipped
 * build, a base64 node showing `aGk=` ended its text 42px down a 186px node
 * with the first port row at 74 - 32px of nothing between the answer and the
 * ports.
 *
 * Two changes. The box is 32px rather than 40 - the clamp means no third line
 * can exist, so it needs the two lines and no margin for a fourth - and it
 * centres its content, so what is left reads as the box's own padding rather
 * than as something missing.
 *
 * WHAT IS NOT DONE IS SIZING IT TO ITS CONTENT, and holding that line is most
 * of why this check exists. `SUMMARY_HEIGHT` is a term in `portOffsetY`, the
 * single place a port's position and the wire landing on it are agreed, so a
 * box that grew and shrank would move every wire on the node - and it would
 * move them WHILE SOMEBODY TYPES, because `NodeRunState` clears `outputs` when
 * a node starts and the node falls back to its tool's two-line description for
 * the frame it spends `running`. So the property is: a node is the same height
 * blocked, with a one-line result, and with a longer one. jsdom cannot see any
 * of it; every box there is zero by zero.
 */
async function checkNodeSummaryBox(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const SUMMARY_PROBE = () => {
    const node = document.querySelector('[data-node-id]');
    if (!node) return null;
    const box = node.querySelector('[class*="nodeSummary"]');
    const inner = node.querySelector('[class*="nodeSummaryText"]');
    const port = node.querySelector('button[class*="port"]');
    if (!box || !inner || !port) return null;

    const boxRect = box.getBoundingClientRect();
    const innerRect = inner.getBoundingClientRect();
    return {
      status: node.dataset.status,
      height: Math.round(node.getBoundingClientRect().height),
      text: (inner.textContent ?? '').trim().slice(0, 30),
      lines: Math.round(innerRect.height / parseFloat(getComputedStyle(inner).lineHeight)),
      above: Math.round(innerRect.top - boxRect.top),
      below: Math.round(boxRect.bottom - innerRect.bottom),
      /*
       * From the last line of the summary to the first port row: the gap a
       * person reads as the node being mostly empty.
       */
      toFirstPort: Math.round(port.getBoundingClientRect().top - innerRect.bottom),
    };
  };

  try {
    await page.goto(
      `${ORIGIN}/?p=${shareParam({ v: 3, n: [['n1', 'base64', 200, 200, {}]], e: [] })}`,
      { waitUntil: 'networkidle' },
    );
    await page.locator('[data-testid="node-n1"]').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(400);

    const blocked = await page.evaluate(SUMMARY_PROBE);
    check(
      label,
      'a blocked node fills its summary box with two lines of guidance',
      blocked !== null && blocked.status === 'blocked' && blocked.lines === 2,
      JSON.stringify(blocked),
    );

    const editor = page.locator('textarea:not([readonly])').first();
    await editor.waitFor({ timeout: 15_000 });
    await editor.fill('hi');
    await page.waitForTimeout(1200);
    const short = await page.evaluate(SUMMARY_PROBE);

    await editor.fill('a much longer piece of text than that one was, by some way');
    await page.waitForTimeout(1200);
    const long = await page.evaluate(SUMMARY_PROBE);

    /*
     * The subject, before the equality below is trusted: three reads of one
     * unchanged node agree about its height perfectly.
     */
    check(
      label,
      'the node really ran and produced two different answers',
      short !== null &&
        long !== null &&
        short.status === 'ok' &&
        long.status === 'ok' &&
        short.text !== long.text,
      `${String(short?.text)} then ${String(long?.text)}`,
    );

    /* -- THE PROPERTY: the node does not resize as the value changes ----- */
    check(
      label,
      'a node is the same height blocked, with a short result and with a long one',
      blocked !== null &&
        short !== null &&
        long !== null &&
        blocked.height === short.height &&
        short.height === long.height,
      `${String(blocked?.height)}/${String(short?.height)}/${String(long?.height)}`,
    );

    /* -- AND A SHORT ANSWER IS NOT STRANDED ABOVE A VOID ----------------- */
    /*
     * Centred, so the slack is split rather than collected under the text.
     * Stated as a comparison rather than as a pixel count, because the
     * clearance depends on the line height and the font; what must hold is
     * that the two ends of the box agree.
     *
     * AND THAT THERE IS SLACK TO SPLIT. "Above equals below" is satisfied
     * perfectly by a box sized to its content, which has neither - and a box
     * sized to its content is precisely the change the check above exists to
     * refuse. The first version of this check passed against it.
     */
    check(
      label,
      'a one-line result is centred in the box rather than sitting on its top edge',
      short !== null &&
        short.lines === 1 &&
        short.above > 0 &&
        Math.abs(short.above - short.below) <= 1,
      short === null ? 'no node' : `${String(short.above)} above, ${String(short.below)} below`,
    );
    /*
     * The gap this section is about, held to a number so it cannot drift back.
     * It was 32px on the shipped build; the box is 8px shorter and the slack
     * is halved, which puts it at 19.
     */
    check(
      label,
      'a short result is within twenty pixels of the first port row',
      short !== null && short.toFirstPort <= 20,
      short === null ? 'no node' : `${String(short.toFirstPort)}px`,
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
    /*
     * SCOPED TO THE DECODED REGION. Round three gave this tool a second output,
     * so the page has two `Raw` toggles - one per view - and an unscoped
     * locator matches both. The one this check is about is the decoded token's,
     * because the claim is that the verdict survives ITS toggle.
     */
    /*
     * AND THE SCOPING IS ASSERTED RATHER THAN TRUSTED, because the check below
     * it cannot fail on its own. `[data-trust]` is on screen BEFORE the click
     * as well as after, so a click that landed on the report's toggle, or on
     * nothing at all, leaves the banner exactly where a correct click does.
     * What makes the line mean something is that the DECODED view really went
     * raw, which its own button's `aria-pressed` says.
     */
    const decoded = page.getByRole('region', { name: 'JWT Decoded' });
    const rawButtons = await page.getByRole('button', { name: 'Raw' }).count();
    check(
      label,
      'the page really has two Raw toggles, which is why this one is scoped',
      rawButtons === 2,
      `${String(rawButtons)} Raw button(s)`,
    );

    const before = await decoded.getByRole('button', { name: 'Raw' }).getAttribute('aria-pressed');
    await decoded.getByRole('button', { name: 'Raw' }).click();
    const after = await decoded.getByRole('button', { name: 'Raw' }).getAttribute('aria-pressed');
    const stillThere = await page.locator('[data-trust]').count();

    check(
      label,
      'the Raw toggle this check presses is the decoded token’s own',
      before === 'false' && after === 'true',
      `${String(before)} then ${String(after)}`,
    );
    check(
      label,
      'the JWT verdict stays on screen in the raw view',
      stillThere === 1 && after === 'true',
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

    /* -- RS256, ES256 and PS256, against published vectors -------------- *
     *
     * WHY PUBLISHED TOKENS AND NOT ONES SIGNED HERE. Every other verification
     * in this repository signs with WebCrypto and then checks
     * with WebCrypto, which proves two halves of one primitive agree with each
     * other. RFC 7515 A.2 and A.3 publish the key, the signing input and the
     * signature, so a `verified` here means this engine's RSASSA-PKCS1-v1_5
     * and ECDSA agree with the working group rather than with themselves.
     *
     * AND WHY ONLY FOUR OF THE TWELVE ALGORITHMS. Not for want of vectors -
     * round six found published ones for all twelve. It is that this loop drives
     * the real UI, which means `decodeToken` has to accept the token, which
     * means the payload has to be JSON. RFC 7515 A.4 signs "Payload", the JOSE
     * cookbook signs a line of Tolkien, Wycheproof signs "foo": all legal JWS,
     * none of them a JWT. The two PS256 salt cases are the only published
     * vectors outside RFC 7515 A.1-A.3 whose payload happens to parse as JSON.
     * The other nine algorithms are put to each engine directly, below.
     *
     * AND WHY IN A BROWSER AT ALL, when the unit suite runs the same fixture.
     * The unit suite's WebCrypto is Node's. Gecko's is NSS and WebKit's is
     * its own; a PEM this tool's `importKey` path builds wrongly, or a curve
     * table that named the wrong curve, could still satisfy one implementation
     * consistently. This is the tool's own worker, its own key parsing and its
     * own verdict banner, driven three times in each of two more engines.
     */
    /*
     * A FRESH PAGE PER VERDICT, AND THAT IS NOT TIDINESS. The banner is on
     * screen from the previous run, so "wait until it is not `verified`" is
     * satisfied by the PREVIOUS run's answer before this one has finished - the
     * exact shape of assertion round four found passing without its click
     * landing. A reload means `[data-trust]` does not exist until this run
     * produces it, so waiting for it is waiting for this run.
     */
    const jwtVerdict = async (key, token, keyEncoding = 'utf8') => {
      await page.goto(`${ORIGIN}/tools/jwt-decode`, { waitUntil: 'networkidle' });
      await page.getByRole('heading', { level: 1, name: 'JWT' }).waitFor({ timeout: 15_000 });
      /*
       * EVERYTHING TYPED HAPPENS BEFORE THE LISTBOX OPENS, AND THAT ORDERING IS
       * THE FIX FOR A FAULT THAT HIT ROUGHLY ONE CALL IN THREE.
       *
       * This used to set the encoding first and fill the token afterwards, and
       * in WebKit the token fill was silently discarded: `fill` reported
       * success, reading the box back gave ZERO characters, Run then ran on an
       * empty box and the tool correctly said `Paste a JWT to decode`. It
       * presented as the verdict check failing, which is the one shape of
       * wrongness this file exists to remove.
       *
       * Measured rather than guessed. Driving the old sequence on one reused
       * page reproduced it 22 times in 64 calls; waiting for the listbox to be
       * detached before typing brought that to 1 in 64, which is what names the
       * mechanism - Radix hands focus back to the select trigger AFTER the
       * listbox is gone, and a `fill` landing inside that window types into an
       * element that focus is leaving. Waiting for a library's internal focus
       * return is a guess about a library; not typing after it is not. The
       * order below reproduced 0 times in 96.
       */
      await page.getByLabel('Key', { exact: true }).fill(key);
      await page.getByLabel('JWT input').fill(token);

      /*
       * A.1's key is base64url, and leaving this alone would hash the RFC's
       * ASCII SPELLING of the secret rather than the secret - which reads
       * `broken` and looks exactly like a signature problem. The control is
       * driven for every example rather than only that one, so the utf8 cases
       * assert that the default is the default instead of skipping the control.
       *
       * It is a listbox rather than a <select>, so it is clicked open and the
       * option is clicked by its VISIBLE name - `Base64`, not `base64url`.
       * `selectOption` fails on it with "Element is not a <select> element".
       */
      await page.getByRole('combobox', { name: 'Secret encoding' }).click();
      await page
        .getByRole('option', { name: keyEncoding === 'base64url' ? 'Base64' : 'Plain text' })
        .click();

      /*
       * AND THE BOX IS READ BACK BEFORE ANYTHING IS ASKED OF THE RESULT.
       *
       * The ordering above removes the hazard; this is what stops the next
       * person reintroducing it and getting a signature verdict as the error
       * message. A run driven on input the harness failed to type is a fact
       * about the harness, and it now SAYS so instead of being reported as the
       * tool reaching the wrong verdict.
       */
      const typed = await page.getByLabel('JWT input').inputValue();
      if (typed !== token) {
        return `the harness could not type the token - the box holds ${typed.length.toString()} of ${token.length.toString()} characters`;
      }

      await page.getByRole('button', { name: 'Run' }).click();

      /*
       * A VERDICT THAT NEVER ARRIVES IS A FINDING, NOT A CRASH.
       *
       * This used to be a bare `waitFor`, and when it timed out the whole run
       * died on an uncaught TimeoutError - roughly 1,700 passing checks
       * discarded, and a stack trace that says only which line was waiting.
       *
       * THE FAULT IT WAS BUILT FOR IS FIXED, and this stays. It was the lost
       * fill above: three occurrences in WebKit at varying depth through the
       * RSA examples, all of them after `326a057` put a listbox click between
       * the two fills, none before it, and the one occurrence anybody
       * instrumented said `invalid-input` on an empty box. Round twelve traced
       * that commit by commit - see docs/architecture.md. What kept it open for
       * four rounds is that a bare `waitFor` cannot say which of three things
       * went wrong, so the instrument stays whether or not anything is known to
       * need it.
       *
       * The waiting is the same. What is different is that giving up returns
       * what was ON SCREEN instead of throwing, so the check that follows fails
       * by name, carrying the reason, and the other 1,700 still report. A tool
       * that reported an error, a run still spinning, and a page that never
       * started are three different bugs and this could not previously tell
       * them apart.
       */
      try {
        await page.locator('[data-trust]').waitFor({ timeout: 30_000 });
      } catch {
        return page.evaluate(() => {
          const busy = document.querySelector('[role="status"][aria-busy="true"]');
          const error = [...document.querySelectorAll('[class*="error"]')]
            .map((node) => (node.textContent ?? '').trim())
            .filter(Boolean)[0];
          return `no verdict after 30s - ${
            error !== undefined
              ? `the tool reported: ${error.slice(0, 160)}`
              : busy === null
                ? 'nothing is running and nothing errored'
                : 'the run is still in flight'
          }`;
        });
      }
      return page.locator('[data-trust]').getAttribute('data-trust');
    };

    for (const example of JWS_UI_EXAMPLES) {
      const name = example.name;

      const trust = await jwtVerdict(example.key, example.token, example.keyEncoding);
      check(
        label,
        `the ${name} token verifies against the key its source publishes`,
        trust === 'verified',
        `${String(trust)}`,
      );

      /*
       * THE NEGATIVE CONTROL, AND IT IS THE POINT. `verified` above would mean
       * nothing if this page reached it with a signature the source did not
       * publish - and a decoder that ignored the signature entirely would
       * satisfy the line above on every token ever pasted into it.
       */
      const tampered = await jwtVerdict(example.key, example.tamperedToken, example.keyEncoding);
      check(
        label,
        `one flipped bit turns the ${name} verdict from verified to broken`,
        tampered === 'broken',
        `${String(tampered)}`,
      );

      /*
       * AND THE KEY IS BEING READ, not merely present. The same token against a
       * key of ANOTHER KIND must not verify: a `verified` that survives swapping
       * the key is a verdict about nothing. `unverified` rather than `broken` is
       * the right answer here and is asserted as such - an RSA key is not an EC
       * key, so nothing was checked, and saying "the signature does not match"
       * would be a stronger claim than this tool made.
       */
      const swapped = await jwtVerdict(example.wrongKindKey, example.token, example.keyEncoding);
      check(
        label,
        `the ${name} verdict does not survive swapping in a key of another kind`,
        swapped === 'unverified',
        `${String(swapped)}`,
      );

      /*
       * AND THE SHARPER HALF OF THE SAME QUESTION, which round five could not
       * ask because it had one key of each kind. A DIFFERENT KEY OF THE SAME
       * KIND imports perfectly, so a real check happens and loses: the verdict
       * has to be `broken`, not `unverified`. An `unverified` here would mean
       * the key was never read; a `verified` would mean the signature was not.
       */
      if (example.wrongKey !== null) {
        const wrongKey = await jwtVerdict(example.wrongKey, example.token, example.keyEncoding);
        check(
          label,
          `the ${name} token is checked and REJECTED against another key of the same kind`,
          wrongKey === 'broken',
          `${String(wrongKey)}`,
        );
      }
    }

    /* -- What an engine does with a signature of the wrong width -------- *
     *
     * A MEASUREMENT RATHER THAN AN ASSERTION, and it is here because a comment
     * in `verify.ts` makes a claim about engines that nothing could check from
     * inside one. The `try` around `subtle.verify` says a malformed signature
     * "throws rather than returning false"; measured against Node's WebCrypto
     * that is not so, and this is the only place that can ask Gecko and
     * WebKit.
     *
     * The verdict the tool shows is asserted either way - `invalid`, never an
     * exception escaping into a page with no verdict on it - so this line
     * cannot pass merely because an engine happens to be lenient. What is
     * REPORTED is which of the two an engine does, so the comment can be
     * written from a measurement.
     */
    {
      const es256 = JWS_UI_EXAMPLES.find((entry) => entry.name.endsWith('ES256'));
      const behaviour = await page.evaluate(async (pem) => {
        const body = /-----BEGIN PUBLIC KEY-----([\s\S]*?)-----END/.exec(pem)?.[1] ?? '';
        const raw = atob(body.replace(/\s+/g, ''));
        const spki = Uint8Array.from(raw, (character) => character.charCodeAt(0));
        const key = await crypto.subtle.importKey(
          'spki',
          spki,
          { name: 'ECDSA', namedCurve: 'P-256' },
          false,
          ['verify'],
        );
        const out = {};
        for (const width of [0, 32, 63, 65]) {
          try {
            out[width] = String(
              await crypto.subtle.verify(
                { name: 'ECDSA', hash: 'SHA-256' },
                key,
                new Uint8Array(width),
                new TextEncoder().encode('anything'),
              ),
            );
          } catch (error) {
            out[width] = `threw ${error instanceof Error ? error.name : 'unknown'}`;
          }
        }
        return out;
      }, es256.key);

      check(
        label,
        'a P-256 signature of the wrong width never verifies, however the engine reports it',
        Object.values(behaviour).every((outcome) => outcome !== 'true'),
        Object.entries(behaviour)
          .map(([width, outcome]) => `${width}B ${outcome}`)
          .join(', '),
      );

      /* And the tool's own verdict for the same bytes, through the worker. */
      // Half a P-256 signature: 32 bytes where the algorithm needs 64.
      const [header, payload, signature] = es256.token.split('.');
      const truncatedToken = `${header}.${payload}.${jwsToText(jwsToBytes(signature).subarray(0, 32))}`;
      const truncated = await jwtVerdict(es256.key, truncatedToken);
      check(
        label,
        'a truncated ES256 signature reaches a verdict rather than an unhandled error',
        truncated === 'broken',
        `${String(truncated)}`,
      );
    }

    /* -- What each engine can actually do with a published vector ------- *
     *
     * THE QUESTION THE LOOP ABOVE CANNOT REACH, for eight of the twelve
     * algorithms. `decodeToken` needs a JSON payload and almost no published
     * JOSE example has one, so HS384, HS512, RS384, RS512, PS384, PS512, ES384
     * and ES512 cannot be driven through the tool's own UI by anything anybody
     * has published. The unit suite settles what `verify.ts` does with them; it
     * runs on Node's WebCrypto, and cannot say a word about Gecko's or WebKit's.
     *
     * WHAT THIS ASKS INSTEAD, and it is a narrower question honestly put: does
     * THIS ENGINE, under the real CSP, import the key and reach the published
     * verdict for the published bytes? That is the failure this cannot
     * otherwise see - an engine with no RSA-PSS, or no P-384, or no P-521, in
     * which the tool would say `unverified` on a token CI calls verified.
     *
     * THE PARAMETERS ARE THE FIXTURE'S, NOT THIS FILE'S. Re-deriving "PS384
     * means RSA-PSS with a 48-byte salt" here would make this script's
     * expectations its own, which is the thing the whole exercise is against.
     * They are the parameters the generator proved the published signature
     * verifies under, with CPython and Node both agreeing, and they are read
     * out of the JSON.
     *
     * AND EACH ONE CARRIES ITS OWN NEGATIVE. The same engine, the same key, the
     * same call, one bit of the signature flipped: an engine that answered
     * `true` to everything would satisfy the positive half on every algorithm.
     */
    {
      const results = await page.evaluate(async (vectors) => {
        const out = [];
        for (const vector of vectors) {
          try {
            const material =
              vector.webcrypto.format === 'raw'
                ? vector.keyEncoding === 'base64url'
                  ? Uint8Array.from(
                      atob(vector.key.replace(/-/g, '+').replace(/_/g, '/')),
                      (character) => character.charCodeAt(0),
                    )
                  : new TextEncoder().encode(vector.key)
                : Uint8Array.from(
                    atob(
                      (/-----BEGIN PUBLIC KEY-----([\s\S]*?)-----END/.exec(vector.key)?.[1] ?? '')
                        .replace(/\s+/g, '')
                        .replace(/-/g, '+')
                        .replace(/_/g, '/'),
                    ),
                    (character) => character.charCodeAt(0),
                  );

            const key = await crypto.subtle.importKey(
              vector.webcrypto.format,
              material,
              vector.webcrypto.importKey,
              false,
              ['verify'],
            );

            const signature = Uint8Array.from(
              atob(vector.signature.replace(/-/g, '+').replace(/_/g, '/')),
              (character) => character.charCodeAt(0),
            );
            const message = new TextEncoder().encode(vector.message);
            const flipped = signature.slice();
            flipped[0] ^= 0x01;

            out.push({
              source: vector.source,
              algorithm: vector.algorithm,
              verified: await crypto.subtle.verify(
                vector.webcrypto.verify,
                key,
                signature,
                message,
              ),
              tampered: await crypto.subtle.verify(vector.webcrypto.verify, key, flipped, message),
            });
          } catch (error) {
            out.push({
              source: vector.source,
              algorithm: vector.algorithm,
              error: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown',
            });
          }
        }
        return out;
      }, JWS_ENGINE_VECTORS);

      for (const algorithm of JWS_ALGORITHMS) {
        const forAlgorithm = results.filter((entry) => entry.algorithm === algorithm);
        const good = forAlgorithm.filter(
          (entry) => entry.verified === true && entry.tampered === false,
        );
        check(
          label,
          `${algorithm}: this engine reaches the published verdict for a published vector`,
          good.length === forAlgorithm.length && forAlgorithm.length > 0,
          forAlgorithm
            .map(
              (entry) =>
                `${entry.source} ${entry.error ?? `verified=${String(entry.verified)} tampered=${String(entry.tampered)}`}`,
            )
            .join('; '),
        );
      }
    }

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
 *   4. SCALE INVARIANCE, as the same strip measured an octave apart. The whole
 *      ladder - the heavy rule included - steps in powers of two, so the view at
 *      63% and the view at 126% are the same five ranks at the same five screen
 *      pitches. `grid.test.ts` proves that about the numbers; this proves it
 *      about the pixels, which is where it was false before: the heavy rule used
 *      to be pinned to the world, so 25% showed a heavy rule every second line
 *      and 250% every sixteenth.
 *
 *   4. A WHEEL DETENT IS ONE NOTCH. `deltaMode` and the detent size are the
 *      engine's business, and Firefox's answer differs from Chromium's - three
 *      LINES rather than a hundred pixels. Asserting it here is asserting it in
 *      the only place the difference exists.
 *
 *   5. THE SCREEN IS THE BITMAP, at a phone's width. Everything above reads a
 *      strip of screenshot and asks whether it looks like a grid; this asks
 *      whether each rule reached the screen at the pixel the bitmap put it on,
 *      and at the width it was drawn. A bitmap that is not exactly its box is
 *      resampled by the engine, and a resampled grid is right in one part of
 *      the viewport and smeared in another - which is what it looked like on a
 *      phone, and which no strip-average could see.
 */

/**
 * Drives the zoom to a target through real ctrl+wheel events on the root.
 *
 * Every step waits two frames, so this hangs in a page whose frames have
 * stopped - which no page in this harness is.
 */
const INSTALL_SET_ZOOM = () => {
  const root = document.querySelector('[data-testid="canvas-root"]');
  window.__setZoom = async (target) => {
    const readout = () =>
      Number(
        document.querySelector('[data-testid="canvas-readout"]').textContent.match(/(\d+)%/)[1],
      ) / 100;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const current = readout();
      if (Math.abs(current - target) < 0.006) break;
      const box = root.getBoundingClientRect();
      let step = Math.max(-1, Math.min(1, Math.log2(target / current) * 6));
      // Half-steps near the target, or 59% and 71% are overshot for ever.
      if (Math.abs(step) < 0.3) step *= 0.5;
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
};

/**
 * Every rule along six lines across the grid, as the bitmap drew it and as the
 * screen shows it.
 *
 * THREE ROWS AND THREE COLUMNS, one in each third of the layer, because the
 * defect this exists for was a difference BETWEEN regions - smeared on the
 * right and crisp on the left, a band a third of the way down. Each line is the
 * quietest one in its third, so that a row does not run along a horizontal rule
 * and say nothing about the columns.
 *
 * Both are reported in the layer's own device pixels. A run is `[start, width,
 * peak]`, where the peak is the bitmap's alpha for a layer run and the distance
 * from the backdrop for a screen run.
 */
const INSTALL_GRID_LINES = () => {
  window.__gridLines = async (bytes) => {
    const canvas = document.querySelector('[data-testid="canvas-grid"]');
    const layer = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const bitmap = await createImageBitmap(
      new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
    );
    const surface = document.createElement('canvas');
    surface.width = bitmap.width;
    surface.height = bitmap.height;
    const context = surface.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const shot = context.getImageData(0, 0, bitmap.width, bitmap.height);

    const dpr = window.devicePixelRatio;
    const rect = canvas.getBoundingClientRect();
    const ox = Math.round(rect.left * dpr);
    const oy = Math.round(rect.top * dpr);
    /*
     * Only the pixels the HOST covers entirely. The layer overhangs a
     * fractional host by design, and the host's clip edge is a pixel the
     * backdrop only partly fills - which reads as ink nobody drew.
     */
    const host = canvas.parentElement.getBoundingClientRect();
    const width = Math.min(layer.width, shot.width - ox, Math.floor(host.right * dpr) - ox);
    const height = Math.min(layer.height, shot.height - oy, Math.floor(host.bottom * dpr) - oy);
    /*
     * And on the near sides too. At a fractional density the layer is placed
     * on a lattice several device pixels coarse (see `layerStep`), so it
     * overhangs the host's top and left as well, and that strip is clipped -
     * the header shows through it.
     */
    const startX = Math.max(0, Math.ceil(host.left * dpr) - ox);
    const startY = Math.max(0, Math.ceil(host.top * dpr) - oy);

    const alpha = (x, y) => layer.data[(y * layer.width + x) * 4 + 3];
    const lum = (x, y) => {
      const i = ((oy + y) * shot.width + ox + x) * 4;
      return 0.2126 * shot.data[i] + 0.7152 * shot.data[i + 1] + 0.0722 * shot.data[i + 2];
    };

    const quietest = (count, length, at) => {
      const lines = [];
      for (let third = 0; third < 3; third += 1) {
        let best = -1;
        let fewest = Infinity;
        // Clear of the layer's edges, where the host's clip and the header's
        // rule share pixels with the grid.
        const from = Math.floor((third * count) / 3) + Math.ceil(count / 30);
        const to = Math.floor(((third + 1) * count) / 3) - Math.ceil(count / 30);
        for (let line = from; line < to; line += 1) {
          let inked = 0;
          for (let p = 0; p < length; p += 1) if (at(line, p) > 0) inked += 1;
          if (inked < fewest) {
            fewest = inked;
            best = line;
          }
        }
        lines.push(best);
      }
      return lines;
    };

    const runsOf = (length, value, threshold, start = 0) => {
      const runs = [];
      for (let p = start; p < length; p += 1) {
        const v = value(p);
        if (v <= threshold) continue;
        const last = runs.at(-1);
        if (last && last[0] + last[1] === p) {
          last[1] += 1;
          last[2] = Math.max(last[2], v);
        } else {
          runs.push([p, 1, v]);
        }
      }
      // A run that begins on a clipped edge is part of a rule, on both sides.
      if (start > 0 && runs[0]?.[0] === start) runs.shift();
      return runs;
    };

    const backdropOf = (length, value) => {
      const counts = new Map();
      for (let p = 0; p < length; p += 1) {
        const v = Math.round(value(p));
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    };

    const line = (axis, at) => {
      const length = axis === 'row' ? width : height;
      const layerAt = axis === 'row' ? (p) => alpha(p, at) : (p) => alpha(at, p);
      const screenAt = axis === 'row' ? (p) => lum(p, at) : (p) => lum(at, p);
      const backdrop = backdropOf(length, screenAt);
      const start = axis === 'row' ? startX : startY;
      return {
        axis,
        at,
        length,
        layer: runsOf(length, layerAt, 0, start),
        screen: runsOf(length, (p) => Math.abs(screenAt(p) - backdrop), 2, start),
      };
    };

    return {
      dpr,
      bitmap: [canvas.width, canvas.height],
      lines: [
        ...quietest(height, width, (y, x) => alpha(x, y)).map((y) => line('row', y)),
        ...quietest(width, height, (x, y) => alpha(x, y)).map((x) => line('column', x)),
      ],
    };
  };
};

/**
 * Whether the screen shows the bitmap, and whether its spacing is one spacing.
 *
 * FAITHFUL: every rule the bitmap drew at more than half ink is on screen at
 * the same start and the same width, and nothing on screen is outside a rule
 * the bitmap drew. Resampling fails both halves - a smeared rule is wider and
 * starts early, and its ink lands where the bitmap has none.
 *
 * UNIFORM: the full-ink rules on screen - every rank coarser than the one
 * fading in, which together are one lattice at the finest full pitch - are
 * spaced at no more than two neighbouring whole numbers of device pixels, and
 * are all one rule wide. That is the per-rule rounding `grid.test.ts` bounds
 * and nothing else: a seam where the resampling phase slips is a gap one pixel
 * outside the pair, and a smeared rule is a second width.
 */
function judgeGridLines(reading) {
  const thickness = Math.max(1, Math.round(reading.dpr));
  const problems = [];
  let compared = 0;
  let spaced = 0;

  for (const line of reading.lines) {
    const where = `${line.axis} ${String(line.at)}`;
    const onScreen = new Map(line.screen.map((run) => [run[0], run]));

    for (const run of line.layer.filter((one) => one[2] >= 128)) {
      compared += 1;
      const seen = onScreen.get(run[0]);
      if (!seen || seen[1] !== run[1]) {
        problems.push(
          `${where}: drawn at ${String(run[0])}x${String(run[1])}, on screen ${seen ? `${String(seen[0])}x${String(seen[1])}` : 'not there'}`,
        );
      }
    }
    for (const run of line.screen) {
      const inside = line.layer.some(
        (drawn) => run[0] >= drawn[0] && run[0] + run[1] <= drawn[0] + drawn[1],
      );
      if (!inside) {
        problems.push(`${where}: ink at ${String(run[0])}x${String(run[1])} the bitmap never drew`);
      }
    }

    /*
     * A rule cut off by either end of the line is the viewport's width, not
     * the grid's: it reads narrower than it was drawn and its start is where
     * the edge is. Everything between the ends is judged.
     */
    const whole = (run) => run[0] > 0 && run[0] + run[1] < line.length;
    const full = line.screen.filter((run) => {
      const drawn = line.layer.find((one) => one[0] === run[0]);
      return whole(run) && drawn !== undefined && drawn[2] >= 250;
    });
    const gaps = full.slice(1).map((run, index) => run[0] - full[index][0]);
    spaced += full.length;
    if (gaps.length > 0 && Math.max(...gaps) - Math.min(...gaps) > 1) {
      problems.push(
        `${where}: full-ink gaps run ${String(Math.min(...gaps))} to ${String(Math.max(...gaps))}`,
      );
    }
    const widths = new Set(
      line.screen.filter((run) => whole(run) && run[2] > 8).map((run) => run[1]),
    );
    if ([...widths].some((w) => w !== thickness)) {
      problems.push(`${where}: rules ${[...widths].join('/')}px wide against ${String(thickness)}`);
    }
  }

  return { compared, spaced, problems };
}

/**
 * The canvas root, made a fractional number of pixels on both axes.
 *
 * A FIXTURE FOR A CONDITION THE VIEWPORT CANNOT PRODUCE. On a phone at 2.625x
 * - most Android phones - the CSS viewport is itself fractional (1080 device
 * px is 411.43 CSS px), so the canvas's box is not a whole number of CSS
 * pixels. Playwright can only ask for a whole-pixel viewport, so this makes
 * the host fractional directly, half a pixel off each axis.
 *
 * WHAT IT HOLDS IS THE PLACEMENT, NOT THE OLD DEFECT. The build before the
 * layer was placed passes it at 1x and 3x in both engines, because both snap a
 * canvas's paint rect to whole pixels and a half-pixel box snaps to the bitmap
 * the old arithmetic happened to make. What it failed was the first version
 * of the placement, which put a 3x layer on a device pixel that WebKit's
 * sixty-fourths of a CSS pixel cannot state: every horizontal rule came out
 * 4px wide where it was drawn 3.
 */
async function makeCanvasFractional(page) {
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="canvas-root"]');
    root.style.inlineSize = 'calc(100% - 0.5px)';
    root.style.blockSize = 'calc(100% - 0.5px)';
  });
  await page.waitForTimeout(150);
}

/**
 * A screenshot of the grid alone. Everything the canvas root draws over the
 * grid - the toolbar, the readout, the empty-state sentence - is hidden for
 * the capture and put back straight after it.
 *
 * THROUGH THE CSSOM, not Playwright's `style` option. That option injects a
 * stylesheet, and WebKit holds it to the page's own `style-src`, which admits
 * three hashed stylesheets and nothing else: the chrome stayed on screen there
 * and was read as grid. Gecko let it through, so one engine was measuring the
 * grid and the other the toolbar.
 */
async function gridShot(page, options = {}) {
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="canvas-root"]');
    for (const child of root.children) {
      if (child.getAttribute('data-testid') === 'canvas-grid') continue;
      child.dataset.gridShotVisibility = child.style.visibility;
      child.style.setProperty('visibility', 'hidden', 'important');
    }
  });
  try {
    return await page.screenshot(options);
  } finally {
    await page.evaluate(() => {
      const root = document.querySelector('[data-testid="canvas-root"]');
      for (const child of root.querySelectorAll(':scope > [data-grid-shot-visibility]')) {
        child.style.visibility = child.dataset.gridShotVisibility;
        delete child.dataset.gridShotVisibility;
      }
    });
  }
}

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
   * `deviceScaleFactor` is quietly ignored by Gecko - a context asked for 2x
   * reports `devicePixelRatio` of 1 and renders at 1x - so a sweep over it here
   * would assert the same thing twice and call it coverage. Which it did, until
   * the coverage figure was computed from the REQUESTED density and came out
   * against a 2x ideal on a 1x render. This used to say WebKit ignored it too;
   * measured in round twenty, WebKit's build honours it, and the phone-width
   * block at the end of this section uses that for a 3x pass.
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

      /*
       * The sweep is chosen so that five of these are OCTAVE PAIRS - 25/50,
       * 50/100, 63/126, 79/158 and 125/250 - because the strongest thing that
       * can be said about the grid is that the two halves of a pair are the
       * same picture. The rest fill in the gaps between them.
       */
      for (const zoom of [
        0.25, 0.33, 0.4, 0.5, 0.63, 0.79, 0.89, 1, 1.12, 1.25, 1.26, 1.41, 1.58, 2, 2.5,
      ]) {
        const reached = await page.evaluate((target) => window.__setZoom(target), zoom);
        await page.waitForTimeout(70);
        const shot = await page.screenshot({ clip: strip });
        const reading = await page.evaluate((bytes) => window.__gridMeasure(bytes), [...shot]);
        readings.push({ zoom: reached, ...reading });
      }

      /*
       * TEN, AND THE BUDGET IS SPENT RATHER THAN GUESSED. Mid-octave a strip
       * carries the backdrop, the minor ink, the major ink, the rank fading in,
       * the rank crossfading from minor to major, and the two crossings where
       * the translucent fading rank paints over each of the two heavy ranks -
       * seven, plus whatever a hairline of chrome clipped into the strip
       * contributes. It was 8 before the heavy rule cascaded and there was no
       * crossfade to account for; Gecko measures 8 now and WebKit 7.
       *
       * What this is really testing for is a CONTINUUM, which is what
       * antialiased rules give and what the banding was made of. That runs to
       * hundreds, so ten leaves the check its whole meaning and stops the
       * accounting above from being one theme tweak away from a false failure.
       */
      const worstShades = readings.reduce((a, b) => (a.shades > b.shades ? a : b));
      check(
        label,
        'a bare strip of grid is a handful of shades at every zoom',
        worstShades.shades <= 10,
        `worst ${worstShades.shades} shades at ${Math.round(worstShades.zoom * 100)}% - antialiased rules give a continuum, which is what the banding was`,
      );

      /*
       * Coverage against the geometry, at the zooms where every inked level is
       * at FULL ink and the pitch is therefore unambiguous. In between, a
       * part-drawn level adds rules of its own and the closed form stops
       * applying - which is why this is checked where it is exact rather than
       * with a tolerance wide enough to cover the fade.
       *
       * THE PITCH IS 8 AT ALL FOUR, and that is the cascade stated as a number
       * somebody can check by hand: the finest fully inked rank is `GRID` pixels
       * apart wherever the zoom folds to the bottom of an octave, whether that
       * is 25% or 200%. Before the heavy rule cascaded this was still true of
       * the fine rules and false of the picture, because the heavy rule was 16px
       * apart at 25% and 128px apart at 200%.
       */
      for (const [zoom, pitch] of [
        [0.25, 8],
        [0.5, 8],
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

      /*
       * ONE BOUND OVER THE WHOLE RANGE, where there used to be two.
       *
       * The pair of thresholds - 1.8 across the range and 1.3 between 40% and
       * 200% - existed because the ends of the range were genuinely worse than
       * the middle, and for one reason: the heavy rule was pinned to the world
       * while everything else cascaded, so the proportion of heavy rules on
       * screen swept from one in two to one in sixteen. Measured here that was
       * 8.25 to 14.18 luminance units, 1.72x, with 1.23x across the middle.
       *
       * The heavy rule cascades now, so there is no worse end to carve out and
       * nothing left that varies with the zoom except the half-pixel each rule
       * is rounded by and the phase the pan happens to sit at. What is left is
       * a few percent, and it is asserted as one number over every zoom sampled.
       */
      check(
        label,
        'the surface keeps its density across the whole zoom range',
        hi / lo < 1.12,
        `mean ink ${lo.toFixed(2)} to ${hi.toFixed(2)} luminance units, ${(hi / lo).toFixed(3)}x - the gradient build ran to 3.9x and the world-anchored heavy rule to 1.72x`,
      );

      /*
       * AND THE SAME PICTURE AN OCTAVE APART, which is the claim the density
       * bound is a consequence of rather than the other way round. Two zooms a
       * factor of two apart draw the same five ranks at the same five screen
       * pitches, so the strip they cover has to carry the same ink - and unlike
       * the bound above, this one does not average over the sweep, so a ladder
       * that stepped at the wrong zoom would show up here as one bad pair
       * rather than as a slightly wider range.
       */
      for (const [low, high] of [
        [0.25, 0.5],
        [0.5, 1],
        [0.63, 1.26],
        [0.79, 1.58],
        [1.25, 2.5],
      ]) {
        const under = readings.find((one) => Math.abs(one.zoom - low) < 0.02);
        const over = readings.find((one) => Math.abs(one.zoom - high) < 0.02);
        if (!under || !over) continue;

        const drift = Math.abs(under.ink - over.ink) / Math.min(under.ink, over.ink);

        check(
          label,
          `${low * 100}% and ${high * 100}% are the same picture`,
          drift < 0.06,
          `${under.ink.toFixed(2)} against ${over.ink.toFixed(2)} luminance units, ${(drift * 100).toFixed(1)}% apart`,
        );
      }
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
     *
     * WHICH ALSO RULES OUT THE CROSSFADE. The heavy rule cascades, so once an
     * octave a rank travels from the minor ink to the major one - and with no
     * minor ink to travel from, that rank would arrive as a translucent system
     * colour. So the crossfade is rounded to its nearer end and a rank here is
     * heavy or absent. Still two shades, which is what this counts.
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

  /* -- At a phone's width, the screen is the bitmap --------------------- */

  /*
   * 50%, 59% AND 71% ARE THE ZOOMS IT WAS REPORTED AT, and 100% is the one
   * with no fraction in it at all. Each is asserted twice: as the page comes,
   * and with the canvas made a fractional number of pixels, which is the
   * condition a fractional-density phone is always in - see
   * `makeCanvasFractional` for what that half does and does not hold.
   */
  const phoneZooms = [0.5, 0.59, 0.71, 1];

  const phonePass = async (context, density, width = 390) => {
    const phone = await context.newPage();
    try {
      await gotoCanvas(phone);
      await phone.locator('[data-testid="canvas-grid"]').waitFor({ timeout: 15_000 });
      // Past the once-per-load draw-in, which inks the ranks part-way while it runs.
      await phone.waitForTimeout(600);
      await phone.evaluate(INSTALL_SET_ZOOM);
      await phone.evaluate(INSTALL_GRID_LINES);

      /*
       * Read off the page under test rather than a blank one: Gecko reports
       * the density a context asked for on `about:blank` and 1 once a real
       * document has loaded, so a probe page said 3 and the canvas drew at 1x.
       */
      const reported = await phone.evaluate(() => window.devicePixelRatio);
      if (reported !== density && density !== 1) {
        skip(
          label,
          `${String(width)}px at ${String(density)}x: the screen is the bitmap`,
          `this engine renders at ${String(reported)}x whatever deviceScaleFactor asks for`,
        );
        return;
      }
      check(
        label,
        `${String(width)}px at ${String(density)}x: the page renders at the density it asked for`,
        reported === density,
        `devicePixelRatio ${String(reported)}`,
      );

      for (const fractional of [false, true]) {
        if (fractional) await makeCanvasFractional(phone);
        for (const zoom of phoneZooms) {
          const reached = await phone.evaluate((target) => window.__setZoom(target), zoom);
          await phone.waitForTimeout(100);
          const reading = await phone.evaluate(
            (bytes) => window.__gridLines(bytes),
            [...(await gridShot(phone))],
          );
          const verdict = judgeGridLines(reading);
          const where = `${String(width)}px at ${String(density)}x, ${String(Math.round(reached * 100))}%${fractional ? ', a fractional canvas' : ''}`;

          check(
            label,
            `${where}: every rule reaches the screen where the bitmap drew it`,
            verdict.compared >= 60 && verdict.problems.every((p) => !/drawn at|never drew/.test(p)),
            `${String(verdict.compared)} rules compared along six lines; ${
              verdict.problems
                .filter((p) => /drawn at|never drew/.test(p))
                .slice(0, 3)
                .join('; ') || 'all where they were drawn'
            }`,
          );
          check(
            label,
            `${where}: rule spacing is one spacing across the whole viewport`,
            verdict.spaced >= 30 && verdict.problems.every((p) => !/gaps run|wide against/.test(p)),
            `${String(verdict.spaced)} full-ink rules; ${
              verdict.problems
                .filter((p) => /gaps run|wide against/.test(p))
                .slice(0, 3)
                .join('; ') || 'gaps within one device pixel, every rule one width'
            }`,
          );
        }
      }
    } finally {
      await phone.close();
    }
  };

  const oneX = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  try {
    await phonePass(oneX, 1);
  } finally {
    await oneX.close();
  }

  /*
   * AND AT 3X, THE DENSITY OF A 390PX PHONE. WebKit's Playwright build honours
   * `deviceScaleFactor` now, which the comment at the top of this section used
   * to say it did not; Gecko's still reports 1 whatever it is asked for, so a
   * 3x pass there would be the 1x pass again under another name.
   */
  const threeX = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  try {
    await phonePass(threeX, 3);
  } finally {
    await threeX.close();
  }

  /*
   * AND AT FRACTIONAL DENSITIES, WHICH THIS SECTION USED TO SAY NO GATE
   * ENGINE COULD RENDER. WebKit's build does, and so does Chromium (opt-in,
   * `--engine=chromium`). 2.625x and 2.75x are Android phones and Chrome's
   * own phone emulation; 1.25x, 1.5x and 1.75x are Windows display scaling.
   * Placed on whole device pixels, as the layer was until round twenty-one,
   * every one of these failed in both - rules drawn 3px wide on screen 4px and
   * smeared, 80 of 80 comparisons in WebKit, because both lay out in
   * sixty-fourths of a CSS pixel - and on `layerStep`'s lattice none does.
   * Not Gecko, which renders at 1x whatever it is asked for.
   */
  if (browser.browserType().name() !== 'firefox') {
    for (const density of [1.25, 1.5, 1.75, 2.625, 2.75]) {
      const fractional = await browser.newContext({
        viewport: { width: 412, height: 915 },
        hasTouch: true,
        deviceScaleFactor: density,
      });
      try {
        await phonePass(fractional, density, 412);
      } finally {
        await fractional.close();
      }
    }
  }
}

/**
 * WHAT WAS ON SCREEN, FRAME BY FRAME, UNTIL THE DOCUMENT HAD PARSED.
 *
 * Installed as an init script, so the first `requestAnimationFrame` is asked
 * for before a byte of the document has been parsed, and every frame after it
 * is recorded until the parse is over - plus the first one after, which is
 * the first frame the app itself could have touched. A rendering update runs
 * its frame callbacks before it paints, so each record is what that paint
 * showed.
 *
 * WHY NOT `domcontentloaded`, which these checks used until round seventeen
 * with a comment saying it was "before the module script has run". It is not:
 * a module script is deferred, and deferred scripts run BEFORE
 * DOMContentLoaded fires. So a panel the app removed after it had been painted
 * passed exactly as well as one the inline script removed first, which is the
 * difference the checks exist to see.
 */
const RECORD_FRAMES = () => {
  const frames = [];
  window.__frames = frames;
  const record = () => {
    const root = document.documentElement;
    frames.push({
      panel: document.getElementById('cold-open') !== null,
      theme: root.getAttribute('data-theme'),
      accent: root.style.getPropertyValue('--pb-accent').trim(),
      parsing: document.readyState === 'loading',
    });
    if (document.readyState === 'loading') requestAnimationFrame(record);
    else window.__framesDone = true;
  };
  requestAnimationFrame(record);
};

async function framesOf(page) {
  await page.waitForFunction(() => window.__framesDone === true, undefined, { timeout: 15_000 });
  return page.evaluate(() => window.__frames);
}

const panelFrames = (frames) =>
  `${String(frames.filter((frame) => frame.panel).length)} of ${String(frames.length)} frame(s) showed the panel`;

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
      /*
       * WAITED FOR, NOT SNAPSHOTTED - AND THIS WAS MEASURING THE MACHINE.
       *
       * `isVisible()` does not wait. With JavaScript off this document has no
       * scripts at all, so Gecko fires DOMContentLoaded WITHOUT waiting for the
       * render-blocking stylesheet, and the snapshot can land before the first
       * layout. It cost a whole run to a FAIL on a page that was fine, in Gecko
       * only, on the same bytes WebKit passed on two lines further down the same
       * log.
       *
       * Produced on purpose rather than guessed at: delay the stylesheet by
       * 150ms and `isVisible()` is false on every run, while the box that
       * arrives a moment later is the UNSTYLED 1264x38 h1 - so the element was
       * always there and the answer was about timing.
       *
       * This still fails if the first screen never renders: the timeout is the
       * failure, and renaming the id in `dist/index.html` produces it.
       */
      const visible = await headline
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      const text = ((await headline.textContent().catch(() => '')) ?? '').trim();
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
    await fresh.addInitScript(RECORD_FRAMES);
    const freshPage = await fresh.newPage();
    try {
      await freshPage.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });

      /*
       * THE POSITIVE PARTNER of every "never painted" below: the recorder can
       * see the panel when there is one to see. Without this, a recorder whose
       * first frame came before the body was parsed would pass every negative
       * check by looking at an empty page.
       */
      const firstVisit = await framesOf(freshPage);
      check(
        label,
        'a first visit paints the panel, and the frame recorder sees it',
        firstVisit.length > 0 && firstVisit.some((frame) => frame.panel),
        panelFrames(firstVisit),
      );

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
       * Reloaded, and read from every frame painted while the document parsed
       * rather than after the app has booted. A panel that were merely
       * REMOVED BY REACT would still have been painted first, and "you saw the
       * introduction again for 200ms" is the failure this is here to rule out.
       */
      await freshPage.goto(`${ORIGIN}/`, { waitUntil: 'commit' });
      const reloaded = await framesOf(freshPage);
      check(
        label,
        'and a reload never paints it again',
        reloaded.length > 0 && !reloaded.some((frame) => frame.panel),
        panelFrames(reloaded),
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

      await freshPage.goto(`${ORIGIN}/`, { waitUntil: 'commit' });

      /*
       * Read from every frame painted while the document parsed - the earliest
       * moments a paint could have happened. Anything later would pass just as
       * happily on a panel that was shown and then withdrawn.
       */
      const withWork = await framesOf(freshPage);
      check(
        label,
        'a saved graph is enough on its own to suppress it',
        withWork.length > 0 && !withWork.some((frame) => frame.panel),
        panelFrames(withWork),
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

    /*
     * -- A share link, and a custom theme, from the first frame ----------
     *
     * Two claims the README and the skill made that nothing checked until
     * round seventeen. The README said a share link reaches
     * `domcontentloaded` with the panel already absent; the only share-link
     * check clicked an example and looked after the canvas had booted. The
     * skill said the bootstrap applies the stored theme before first paint;
     * for a custom theme it read the library from a key the editor had moved
     * it out of, so every custom theme's first frame was the system preset.
     */
    const early = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      colorScheme: 'light',
    });
    await early.addInitScript(RECORD_FRAMES);
    const earlyPage = await early.newPage();
    try {
      await earlyPage.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
      const href = await earlyPage
        .locator('#cold-open a[href^="/?p="]')
        .first()
        .getAttribute('href');
      await earlyPage.goto(`${ORIGIN}${href ?? '/?p='}`, { waitUntil: 'commit' });
      const shared = await framesOf(earlyPage);
      check(
        label,
        'a share link never paints the panel, not even for a frame',
        href !== null && shared.length > 0 && !shared.some((frame) => frame.panel),
        `${href === null ? 'no example link; ' : ''}${panelFrames(shared)}`,
      );

      /*
       * A base that is NOT the system preset in this context (light, so
       * vellum), and an override the base does not have - so both halves of
       * "a preset plus a handful of overridden tokens" have to arrive, and
       * neither can arrive by accident.
       */
      await earlyPage.evaluate(() => {
        window.localStorage.setItem('patchbay:cold-open:v1', String(Date.now()));
        window.localStorage.setItem(
          'patchbay:theme:v1',
          JSON.stringify({ version: 1, selection: { kind: 'custom', id: 'probe-theme' } }),
        );
        window.localStorage.setItem(
          'patchbay:themes:v1',
          JSON.stringify({
            version: 1,
            themes: [
              {
                id: 'probe-theme',
                label: 'Probe',
                base: 'graphite',
                overrides: { accent: '#ff00aa' },
              },
            ],
          }),
        );
      });
      await earlyPage.goto(`${ORIGIN}/`, { waitUntil: 'commit' });
      const themed = await framesOf(earlyPage);
      const wrong = themed.filter(
        (frame) => frame.theme !== 'graphite' || frame.accent !== '#ff00aa',
      );
      check(
        label,
        'a custom theme is on the document, base and overrides, from the first frame',
        themed.length > 0 && wrong.length === 0,
        wrong.length === 0
          ? `${String(themed.length)} frame(s)`
          : `first wrong frame: data-theme=${String(wrong[0].theme)}, --pb-accent=${wrong[0].accent || '(unset)'}`,
      );

      /* The control: a preset selection sets no override at all. */
      await earlyPage.evaluate(() => {
        window.localStorage.setItem(
          'patchbay:theme:v1',
          JSON.stringify({ version: 1, selection: { kind: 'preset', name: 'graphite' } }),
        );
      });
      await earlyPage.goto(`${ORIGIN}/`, { waitUntil: 'commit' });
      const preset = await framesOf(earlyPage);
      check(
        label,
        'and a preset selection paints the preset with nothing overridden',
        preset.length > 0 &&
          preset.every((frame) => frame.theme === 'graphite' && frame.accent === ''),
        `${String(preset.length)} frame(s); first: ${JSON.stringify(preset[0] ?? null)}`,
      );
    } finally {
      await early.close().catch(() => {});
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

/**
 * THE SMOKE CHECK: the canvas loads, the tokens resolve, a node drags, a tool
 * runs in a real worker, nothing leaves the origin, and a real PNG converts.
 *
 * It was the inline head of `runChecks` until round fifteen, which made it the
 * one part of a run no section filter could name.
 */
async function checkSmoke(browser, label) {
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

    /* -- The palette scrolls when its content overflows ------------------- */
    /*
     * THE PALETTE ONLY, since round fifteen. This block also claimed "the
     * shortcuts overlay can scroll", opened with a synthetic `?` after closing
     * the palette with a synthetic Escape - and neither key did anything. The
     * palette listens for Escape on its own dialog, not on the canvas root the
     * event was sent to, and the root ignores keys while an overlay is open, so
     * the palette stayed open and the "shortcuts" line measured the palette a
     * second time. Probed in both engines: the only dialog on screen after the
     * `?` was "Add a tool". The shortcuts overlay is held more strongly than
     * this ever held it by `checkDialogScroll`, which opens it with a real key
     * and scrolls it with a real wheel. The dialog measured here is named, so
     * a different one cannot stand in for it again.
     */
    await page.getByRole('button', { name: 'Add tool' }).click();
    const palette = page.getByRole('dialog', { name: 'Add a tool' });
    await palette.waitFor({ timeout: 10_000 });
    const paletteScroll = await palette.evaluate((dialog) => {
      const region = dialog.querySelector('[data-scroll-region]');
      if (!region) return null;
      return {
        overflowY: getComputedStyle(region).overflowY,
        overflows: region.scrollHeight > region.clientHeight + 1,
      };
    });
    check(
      label,
      'the palette overlay can scroll',
      paletteScroll !== null &&
        (paletteScroll.overflowY === 'auto' || paletteScroll.overflowY === 'scroll'),
      paletteScroll === null
        ? 'no scroll region in the palette'
        : `overflow-y ${paletteScroll.overflowY}, overflowing ${String(paletteScroll.overflows)}`,
    );
    await page.keyboard.press('Escape');
    await palette.waitFor({ state: 'detached', timeout: 10_000 });

    /* -- Zero network: nothing may leave the page ------------------------ */
    /*
     * THE `seen > 0` IS WHAT MAKES THIS AN ASSERTION.
     *
     * An absence proves nothing until you know the instrument was looking. If
     * the resource buffer were empty - cleared, never populated, or a timing
     * API that stopped recording - the filter below returns `[]` and a check
     * reading only that would report the zero-network guarantee as held
     * without having observed a single request either way. So the count of
     * what WAS recorded is asserted beside the count of what left.
     */
    const network = await page.evaluate((origin) => {
      const names = performance.getEntriesByType('resource').map((entry) => entry.name);
      return {
        seen: names.length,
        external: names.filter((name) => !name.startsWith(origin) && !name.startsWith('data:')),
      };
    }, ORIGIN);
    check(
      label,
      'no request left the origin, out of the requests this page really made',
      network.seen > 0 && network.external.length === 0,
      network.seen === 0
        ? 'no resource timings recorded at all - the instrument saw nothing'
        : `${String(network.seen)} request(s) seen${network.external.length > 0 ? `, off-origin: ${network.external.join(', ')}` : ''}`,
    );

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
        'this build has no OffscreenCanvas at all - measured here, not assumed: `typeof OffscreenCanvas` is undefined, so the branch this engine takes is the FALLBACK. Real Safari has had OffscreenCanvas since 16.4 and takes the worker path, which is therefore proved in Gecko and in no JavaScriptCore. What is no longer unproved is that the two branches agree - checkOffscreenFallback produces the missing API in Gecko and compares the decoded pixels. Six minutes on a Mac: docs/manual-checks.md',
      );
    }

    check(label, 'no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  } finally {
    await context.close();
  }
}

/* ========================================================================== *
 * THE BROWSER'S TAP HIGHLIGHT
 * ========================================================================== */

/**
 * No tap highlight on anything a finger can land on, at 390px under a finger.
 *
 * TAPPING A WIRE FLASHED A BLUE BOX. It was nobody's design: a mobile browser
 * paints its own box over whatever it thinks was tapped - Chromium's is
 * `rgba(51, 181, 229, 0.4)`, and it picks its target by the pointer cursor, so
 * the wire's grab band got one the shape of the path's bounding box, and so
 * did every button and link. `global.css` sets it transparent on `:root`, and
 * the property is inherited.
 *
 * WHAT THIS CAN AND CANNOT SEE. Neither engine here has a tap highlight at
 * all: Gecko does not implement the property, and this WebKit does not either
 * - `CSS.supports` is false in both, because WebKit has it on iOS only.
 * Chromium computes it, and neither headless nor headed Chromium could be made
 * to PAINT one when it was tried by hand, for a link, which a phone always
 * highlights. So the claim held in every engine is the served stylesheet's:
 * the reset is on `:root` and no rule sets the property back. Where an engine
 * does support it, every element in each document is also read - not a
 * hand-picked list, so a component that sets its own colour later is caught -
 * with the instrument shown reading a colour it is given, and the sweep shown
 * to have covered a wire, a node, a button and a link. Where it does not,
 * that half is recorded as a skip naming why, rather than as a pass.
 *
 * And the half that has to survive in both engines: the tap still selects the
 * wire and still draws the selection, because removing the browser's box must
 * not remove the application's own indicator.
 */
async function checkTapHighlight(engine, label) {
  const browser = await launchTouchBrowser(engine);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();

  const sweep = () =>
    page.evaluate(() => {
      const alpha = (colour) => {
        if (colour === 'transparent') return 0;
        const parts = /rgba?\(([^)]*)\)/
          .exec(colour)?.[1]
          .split(/[\s,/]+/)
          .filter(Boolean);
        if (!parts) return 1;
        return parts.length > 3 ? Number(parts[3]) : 1;
      };
      // The instrument, before anything is read with it: told red, it says red.
      const probe = document.createElement('span');
      probe.style.setProperty('-webkit-tap-highlight-color', 'rgb(255, 0, 0)');
      document.body.append(probe);
      const instrument = getComputedStyle(probe).getPropertyValue('-webkit-tap-highlight-color');
      probe.remove();

      const tappable = [...document.querySelectorAll('*')].filter(
        (element) =>
          element.matches(
            'button, a[href], summary, input, textarea, select, [role="tab"], [role="switch"], [role="combobox"], [data-node-id], [data-edge-id] path',
          ) || getComputedStyle(element).cursor === 'pointer',
      );
      const painted = tappable.filter(
        (element) =>
          alpha(getComputedStyle(element).getPropertyValue('-webkit-tap-highlight-color')) > 0,
      );
      const name = (element) =>
        `${element.tagName.toLowerCase()}${element.getAttribute('aria-label') ? `[${element.getAttribute('aria-label')}]` : ''} ${getComputedStyle(element).getPropertyValue('-webkit-tap-highlight-color')}`;
      return {
        instrument,
        count: tappable.length,
        wire: tappable.some((element) => element.closest('[data-edge-id]') !== null),
        node: tappable.some((element) => element.hasAttribute('data-node-id')),
        button: tappable.some((element) => element.tagName === 'BUTTON'),
        link: tappable.some((element) => element.tagName === 'A'),
        painted: painted.length,
        first: painted.slice(0, 3).map(name),
      };
    });

  // Every stylesheet the pages below link, lazy chunks included, by href.
  const sheets = new Set();
  const collectSheets = async () => {
    for (const href of await page.evaluate(() =>
      [...document.querySelectorAll('link[rel="stylesheet"]')].map((link) => link.href),
    )) {
      sheets.add(href);
    }
  };

  try {
    // A first visit, so the introduction's own links are in the sweep.
    await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
    await page.locator('#cold-open a[href]').first().waitFor({ timeout: 15_000 });
    const supported = await page.evaluate(() =>
      CSS.supports('-webkit-tap-highlight-color', 'transparent'),
    );
    const readings = [['the introduction', await sweep()]];
    await collectSheets();

    await page.goto(
      `${ORIGIN}/?p=${shareParam({
        v: 3,
        n: [
          ['a', 'base64', 0, 0, { mode: 'encode' }],
          ['b', 'hash', 520, 160, {}],
        ],
        e: [['a', 'output', 'b', 'input']],
      })}`,
      { waitUntil: 'networkidle' },
    );
    await page.locator('[data-testid="node-b"]').waitFor({ timeout: 15_000 });
    await setInspector(page, false);
    await page.getByRole('button', { name: 'Fit' }).click();
    await page.waitForTimeout(350);

    /*
     * The wire's midpoint from the root's rect and the plane's transform, the
     * one answer every engine agrees on - see `wireMidpoint` in checkTouch.
     */
    const midpoint = await page.evaluate(() => {
      const path = document.querySelector('[data-edge-id] path');
      const plane = document.querySelector('[data-testid="canvas-plane"]');
      const root = document.querySelector('[data-testid="canvas-root"]');
      if (!path || !plane || !root) return null;
      const transform = plane.style.transform;
      const zoom = Number(/scale\(([\d.]+)\)/.exec(transform)?.[1] ?? '1');
      const pan = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(transform);
      const mid = path.getPointAtLength(path.getTotalLength() / 2);
      const rect = root.getBoundingClientRect();
      return {
        x: Math.round(rect.left + Number(pan?.[1] ?? '0') + mid.x * zoom),
        y: Math.round(rect.top + Number(pan?.[2] ?? '0') + mid.y * zoom),
      };
    });
    const stroke = () =>
      page.evaluate(() => {
        const drawn = document.querySelectorAll('[data-edge-id] path')[1];
        return drawn ? getComputedStyle(drawn).stroke : null;
      });
    const before = await stroke();
    if (midpoint) await page.touchscreen.tap(midpoint.x, midpoint.y);
    await setInspector(page, false);
    const bar = page.getByTestId('canvas-selection-bar');
    const barText = (await bar.count()) > 0 ? (await bar.innerText()).replace(/\s+/g, ' ') : '';
    const after = await stroke();
    check(
      label,
      'at 390px a finger still selects a wire, and the wire still draws its selection',
      midpoint !== null && /1 wire/i.test(barText) && before !== null && after !== before,
      `bar "${barText}"; stroke ${String(before)} -> ${String(after)}`,
    );
    // Swept with the selection bar up, so its controls are in it.
    readings.push(['the canvas', await sweep()]);
    await collectSheets();

    await page.goto(`${ORIGIN}/tools`, { waitUntil: 'networkidle' });
    await page.locator('main a[href^="/tools/"]').first().waitFor({ timeout: 15_000 });
    readings.push(['/tools', await sweep()]);
    await collectSheets();
    await page.goto(`${ORIGIN}/tools/text-convert`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Run' }).waitFor({ timeout: 15_000 });
    readings.push(['a tool page', await sweep()]);
    await collectSheets();

    /*
     * WHAT THE PAINTER WOULD BE TOLD, from the bytes served. The property is
     * inherited, so the claim is two halves: `:root` sets it transparent, and
     * no rule anywhere sets it back. Read from the stylesheets themselves
     * rather than the CSSOM, which drops a property the engine does not know -
     * and here neither engine knows it. Fetched from this process, because the
     * page's own policy is `connect-src 'none'`.
     */
    const declarations = [];
    let resetOnRoot = false;
    for (const href of sheets) {
      const text = await (await fetch(href)).text();
      if (/(^|})\s*:root\s*{[^}]*-webkit-tap-highlight-color:\s*transparent/.test(text)) {
        resetOnRoot = true;
      }
      for (const match of text.matchAll(/-webkit-tap-highlight-color:\s*([^;}]+)/g)) {
        declarations.push(match[1].trim());
      }
    }
    const others = declarations.filter((value) => value !== 'transparent');
    check(
      label,
      'the served stylesheets set no tap highlight: transparent on :root, and nothing sets it back',
      sheets.size > 1 && resetOnRoot && others.length === 0,
      `${String(sheets.size)} stylesheets; on :root ${String(resetOnRoot)}; other values ${others.join(', ') || 'none'}`,
    );

    if (!supported) {
      skip(
        label,
        'no element at 390px computes a tap highlight',
        'this engine does not implement -webkit-tap-highlight-color (CSS.supports is false: Gecko has none, WebKit has it on iOS only), so no element can be read for one',
      );
      return;
    }

    const all = readings.map(([, reading]) => reading);
    check(
      label,
      'the tap-highlight sweep reads what it is given, and covered a wire, a node, a button and a link',
      all.every((reading) => reading.instrument === 'rgb(255, 0, 0)') &&
        all.some((reading) => reading.wire) &&
        all.some((reading) => reading.node) &&
        all.some((reading) => reading.button) &&
        all.some((reading) => reading.link),
      readings
        .map(
          ([where, reading]) =>
            `${where}: ${String(reading.count)} (probe ${reading.instrument}${reading.wire ? ', wire' : ''}${reading.node ? ', node' : ''})`,
        )
        .join('; '),
    );
    const painted = readings.filter(([, reading]) => reading.painted > 0);
    check(
      label,
      'no element at 390px computes a tap highlight',
      all.every((reading) => reading.count > 0) && painted.length === 0,
      painted.length === 0
        ? `${String(all.reduce((sum, reading) => sum + reading.count, 0))} tappable elements, every one transparent`
        : painted
            .map(
              ([where, reading]) =>
                `${where}: ${String(reading.painted)}, e.g. ${reading.first.join(' | ')}`,
            )
            .join('; '),
    );
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/* ========================================================================== *
 * A FOCUS RING IS FOR THE KEYBOARD
 * ========================================================================== */

/**
 * Nothing a POINTER does leaves a keyboard focus indicator behind, and the
 * keyboard still gets every one of them.
 *
 * Reported as "Copy as rich text keeps an orange outline after a click, and
 * its neighbours do not". It was never a focus ring: the button carried an
 * accent border on purpose (since removed), and the Button's hover rule outranked it, so the
 * accent vanished under the pointer and came back when it left - after a
 * click, exactly the look of a ring left behind. Looking for the real pattern
 * across the app, by clicking every control on five routes with the mouse and
 * reading `:focus-visible` afterwards, found two that did leave one:
 *
 *   - every Select trigger, after an option chosen with the mouse. Radix
 *     returns focus with a plain `focus()` and both engines' heuristics
 *     answered "visible";
 *   - the Share note, shown on `:focus-within`, which a click on Share
 *     satisfies in Gecko (and a tap does on a phone).
 *
 * Each negative here is paired with the positive that makes it mean
 * something: that focus really did land (a ring that is absent because focus
 * went nowhere is not the claim), and that the keyboard route to the same
 * control does show the indicator.
 */
async function checkPointerFocus(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const state = (locator) =>
    locator.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        border: style.borderTopColor,
        ink: style.color,
        outline: style.outlineStyle,
        focused: element === document.activeElement,
        visible: element.matches(':focus-visible'),
      };
    });
  const away = async () => {
    await page.mouse.move(2, 2);
    await page.waitForTimeout(250);
  };

  try {
    /* -- The rich-text copy and its two neighbours ------------------------ */

    await page.goto(`${ORIGIN}/tools/text-convert`, { waitUntil: 'networkidle' });
    const editor = page.locator('textarea').first();
    await editor.fill('# Pointer\n\nA *paragraph*.');
    await page.getByRole('combobox', { name: 'Target format' }).click();
    await page.getByRole('option', { name: 'HTML (normalised)', exact: true }).click();
    await page.getByRole('button', { name: 'Run' }).click();
    const group = page.getByRole('group', { name: /^Copy / });
    await group.waitFor({ timeout: 20_000 });
    const row = group.locator('..');
    const rich = row.getByRole('button', { name: 'Copy as rich text', exact: true });
    const html = row.getByRole('button', { name: 'Copy HTML', exact: true });
    const download = row.getByRole('button', { name: 'Download', exact: true });
    await away();

    const richRest = await state(rich);
    const htmlRest = await state(html);
    await rich.hover();
    await page.waitForTimeout(250);
    const richHover = await state(rich);

    const notifications = page.getByRole('region', { name: /notifications/i }).locator('li');
    const clickedStates = [];
    for (const [name, button, answer] of [
      ['Copy HTML', html, /^(Copied|Could not copy)$/],
      ['Copy as rich text', rich, /^(Copied as rich text|Could not copy as rich text)$/],
      ['Download', download, /^Downloaded$/],
    ]) {
      await button.click();
      /*
       * The partner of "no ring": the click really landed, and was answered.
       * By its own notification's title, not by the count going up - the run
       * has already raised one, so the third click lands on a full stack and
       * evicts, and a count reads the same before and after.
       */
      const answered = await notifications
        .filter({ has: page.locator('[class*="title"]', { hasText: answer }) })
        .first()
        .waitFor({ timeout: 5_000 })
        .then(
          () => true,
          () => false,
        );
      await away();
      clickedStates.push({ name, answered, ...(await state(button)) });
    }
    const richAfter = clickedStates[1];

    /*
     * DRAWN LIKE ITS NEIGHBOURS, at rest, under the pointer and after a click.
     * It used to carry an accent border on purpose, and that was reversed in
     * round twenty-one: in a row of plain controls it read as a leftover ring.
     * Compared against Copy HTML in the same state, so the claim is "the same
     * as the one beside it" rather than a colour this file would have to know.
     */
    await html.hover();
    await page.waitForTimeout(250);
    const htmlHover = await state(html);
    const htmlAfter = clickedStates[0];
    check(
      label,
      'the rich-text copy is drawn like Copy HTML beside it, at rest, under the pointer and after a click',
      richRest.border === htmlRest.border &&
        richRest.ink === htmlRest.ink &&
        richHover.border === htmlHover.border &&
        richAfter?.border === htmlAfter?.border,
      `rest ${richRest.border}/${htmlRest.border}, ink ${richRest.ink}/${htmlRest.ink}, hover ${richHover.border}/${htmlHover.border}, after a click ${String(richAfter?.border)}/${String(htmlAfter?.border)}`,
    );
    await away();
    const ringed = clickedStates.filter((entry) => entry.outline !== 'none' || entry.visible);
    check(
      label,
      'a pointer click on Copy HTML, Copy as rich text or Download leaves no focus ring',
      clickedStates.every((entry) => entry.answered) && ringed.length === 0,
      clickedStates
        .map(
          (entry) =>
            `${entry.name}: ${entry.answered ? 'answered' : 'NOT answered'}, outline ${entry.outline}, focus-visible ${String(entry.visible)}`,
        )
        .join('; '),
    );

    await html.focus();
    await page.keyboard.press('Tab');
    const richKeyed = await state(rich);
    await page.keyboard.press('Shift+Tab');
    const htmlKeyed = await state(html);
    check(
      label,
      'the keyboard still gets the ring on both copies',
      richKeyed.focused &&
        richKeyed.visible &&
        richKeyed.outline === 'solid' &&
        htmlKeyed.focused &&
        htmlKeyed.visible &&
        htmlKeyed.outline === 'solid',
      `rich: focused ${String(richKeyed.focused)}, outline ${richKeyed.outline}; html: focused ${String(htmlKeyed.focused)}, outline ${htmlKeyed.outline}`,
    );

    /* -- A Select, chosen with the pointer and with the keyboard ---------- */

    await page.goto(`${ORIGIN}/tools`, { waitUntil: 'networkidle' });
    const trigger = page.getByRole('combobox').first();
    await trigger.waitFor({ timeout: 15_000 });
    const firstValue = await trigger.innerText();
    await trigger.click();
    await page.getByRole('option').nth(1).click();
    await away();
    const picked = await state(trigger);
    const pickedValue = await trigger.innerText();
    check(
      label,
      'a Select given its value by the pointer takes focus back without a ring',
      pickedValue !== firstValue && picked.focused && !picked.visible && picked.outline === 'none',
      `"${firstValue}" -> "${pickedValue}"; focused ${String(picked.focused)}, focus-visible ${String(picked.visible)}, outline ${picked.outline}`,
    );

    /*
     * STRAIGHT AFTER THE POINTER PICK, ON PURPOSE. That sequence is the one
     * the first version of the fix broke: Gecko carried "no ring" from the
     * pointer's return into the keyboard's, and a keyboard pick on its own
     * would not have shown it. Each key waits for the state it causes - Radix
     * moves focus between options a task later, and WebKit reads the old one.
     */
    await trigger.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('role') === 'option',
      null,
      { timeout: 5_000 },
    );
    const highlighted = await page.evaluate(() => document.activeElement?.textContent ?? '');
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(
      (was) =>
        document.activeElement?.getAttribute('role') === 'option' &&
        document.activeElement.textContent !== was,
      highlighted,
      { timeout: 5_000 },
    );
    await page.keyboard.press('Enter');
    await page.getByRole('listbox').waitFor({ state: 'detached', timeout: 5_000 });
    const keyed = await state(trigger);
    const keyedValue = await trigger.innerText();
    check(
      label,
      'and one given its value by the keyboard takes it back with the ring',
      keyedValue !== pickedValue && keyed.focused && keyed.visible && keyed.outline === 'solid',
      `"${pickedValue}" -> "${keyedValue}"; focused ${String(keyed.focused)}, focus-visible ${String(keyed.visible)}, outline ${keyed.outline}`,
    );

    /* -- The Share note ---------------------------------------------------- */

    await page.goto(
      `${ORIGIN}/?p=${shareParam({ v: 3, n: [['a', 'base64', 0, 0, { mode: 'encode' }]], e: [] })}`,
      { waitUntil: 'networkidle' },
    );
    const share = page.getByRole('button', { name: 'Share', exact: true });
    await share.waitFor({ timeout: 15_000 });
    const noteShown = (shown) =>
      page
        .waitForFunction(
          (want) => {
            const note = document.querySelector('[class*="shareNote"]');
            return note !== null && (getComputedStyle(note).visibility === 'visible') === want;
          },
          shown,
          { timeout: 3_000 },
        )
        .then(
          () => true,
          () => false,
        );

    await share.hover();
    const onHover = await noteShown(true);
    await share.click();
    await away();
    const afterClick = await noteShown(false);
    await share.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const shareKeyed = await state(share);
    const onKeyboard = await noteShown(true);
    check(
      label,
      'the Share note shows on hover and on keyboard focus, and is gone once a clicking pointer leaves',
      onHover && afterClick && shareKeyed.focused && onKeyboard,
      `hover ${String(onHover)}; hidden after a click ${String(afterClick)}; keyboard ${String(onKeyboard)} (focused ${String(shareKeyed.focused)})`,
    );
  } finally {
    await context.close().catch(() => {});
  }
}

/* ========================================================================== *
 * NO STYLE IS DECIDED BY WHICH STYLESHEET LOADED LAST
 * ========================================================================== */

/**
 * Every place two CSS modules' rules tie for a property on the same element.
 *
 * A tie in specificity is decided by order, and the order of two CSS modules'
 * rules is not something this code base states: the build links chunk
 * stylesheets in whatever order its chunks come out, and the dev server
 * injects one `<style>` per module in the order modules run. It has decided
 * three things here by luck - the input editor that was 200px built and 87px
 * in dev, its own hover rule, and the rich-text copy button's accent border -
 * and each was found by somebody looking at a screen.
 *
 * THE MODULE, NOT THE STYLESHEET, IS WHAT A RULE BELONGS TO. Two modules can
 * land in one built chunk, where their order is fixed in the build and is
 * still not fixed in dev. A CSS module's class names carry the hash of the file
 * they came from (Button's ghost ships as _ghost_, the hash, a line number) - so
 * that is the origin compared. A rule
 * with no module class is the document's own stylesheet, which the document
 * links before anything a module can add in both dev and the build, so its
 * order against a module is fixed by construction and is not a tie.
 *
 * STATES ARE COUNTED AS POSSIBLE. `:hover`, `:active`, `:focus`,
 * `:focus-visible`, `:focus-within` and the styleguide's `[data-force]` are
 * matched as though they held, because two of the three ties above were
 * between hover rules. Specificity is taken from the selector as written.
 * Rules on pseudo-elements are not matched, and only rules whose media query
 * currently applies are; both are limits on what this can see.
 */
const FIND_CASCADE_TIES = () => {
  const splitList = (text) => {
    const out = [];
    let depth = 0;
    let current = '';
    let quote = null;
    for (const character of text) {
      if (quote) {
        current += character;
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        current += character;
        continue;
      }
      if (character === '(' || character === '[') depth += 1;
      if (character === ')' || character === ']') depth -= 1;
      if (character === ',' && depth === 0) {
        out.push(current.trim());
        current = '';
        continue;
      }
      current += character;
    }
    if (current.trim()) out.push(current.trim());
    return out;
  };
  const compare = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  /* Selectors 4: `:is`, `:not` and `:has` take their most specific argument, `:where` none. */
  const specificity = (selector) => {
    let a = 0;
    let b = 0;
    let c = 0;
    let i = 0;
    const word = (from) => {
      let j = from;
      while (j < selector.length && /[\w-]/.test(selector[j])) j += 1;
      return j;
    };
    while (i < selector.length) {
      const character = selector[i];
      if (character === '#') {
        a += 1;
        i = word(i + 1);
      } else if (character === '.') {
        b += 1;
        i = word(i + 1);
      } else if (character === '[') {
        b += 1;
        i = selector.indexOf(']', i) + 1 || selector.length;
      } else if (character === ':') {
        const element = selector[i + 1] === ':';
        const start = i + (element ? 2 : 1);
        let j = word(start);
        const name = selector.slice(start, j);
        let argument = null;
        if (selector[j] === '(') {
          let depth = 0;
          const open = j;
          for (; j < selector.length; j += 1) {
            if (selector[j] === '(') depth += 1;
            if (selector[j] === ')' && (depth -= 1) === 0) break;
          }
          argument = selector.slice(open + 1, j);
          j += 1;
        }
        if (element || ['before', 'after', 'marker', 'placeholder', 'selection'].includes(name)) {
          c += 1;
        } else if (['is', 'not', 'has'].includes(name) && argument !== null) {
          const best = splitList(argument)
            .map(specificity)
            .reduce((x, y) => (compare(x, y) >= 0 ? x : y), [0, 0, 0]);
          a += best[0];
          b += best[1];
          c += best[2];
        } else if (name !== 'where') {
          b += 1;
        }
        i = j;
      } else if (/[a-zA-Z]/.test(character) && (i === 0 || /[\s>+~(]/.test(selector[i - 1]))) {
        c += 1;
        i = word(i);
      } else {
        i += 1;
      }
    }
    return [a, b, c];
  };
  const asPossible = (selector) =>
    selector
      .replace(/:(hover|active|focus-visible|focus-within|focus)(?![\w-])/g, ':is(*)')
      .replace(/\[data-force=['"]?\w+['"]?\]/g, ':is(*)');
  const moduleOf = (selector) => {
    const files = [...selector.matchAll(/\._[A-Za-z0-9-]+?_([a-z0-9]{5})_\d+/g)].map((m) => m[1]);
    return files.length > 0 ? [...new Set(files)].sort().join('+') : null;
  };

  const rules = [];
  const walk = (list, sheet) => {
    for (const rule of list) {
      if (rule instanceof CSSMediaRule) {
        if (window.matchMedia(rule.media.mediaText).matches) walk(rule.cssRules, sheet);
      } else if (rule instanceof CSSSupportsRule) {
        if (CSS.supports(rule.conditionText)) walk(rule.cssRules, sheet);
      } else if (rule instanceof CSSStyleRule) {
        const declarations = [];
        for (let k = 0; k < rule.style.length; k += 1) {
          const property = rule.style[k];
          declarations.push([
            property,
            rule.style.getPropertyValue(property).trim(),
            rule.style.getPropertyPriority(property),
          ]);
        }
        for (const selector of splitList(rule.selectorText)) {
          const origin = moduleOf(selector);
          if (origin === null || selector.includes('::')) continue;
          const test = asPossible(selector);
          try {
            document.querySelector(test);
          } catch {
            continue;
          }
          rules.push({ selector, test, origin, sheet, spec: specificity(selector), declarations });
        }
      }
    }
  };
  const sheets = [...document.styleSheets, ...document.adoptedStyleSheets];
  sheets.forEach((sheet, index) => {
    try {
      walk(sheet.cssRules, sheet.href ? sheet.href.split('/').pop() : `sheet ${String(index)}`);
    } catch {
      /* a sheet whose rules cannot be read is not one this app wrote */
    }
  });

  const onElement = new Map();
  for (const rule of rules) {
    for (const element of document.querySelectorAll(rule.test)) {
      const list = onElement.get(element) ?? [];
      list.push(rule);
      onElement.set(element, list);
    }
  }

  const ties = new Map();
  for (const [element, list] of onElement) {
    const byProperty = new Map();
    for (const rule of list) {
      for (const [property, value, priority] of rule.declarations) {
        const candidates = byProperty.get(property) ?? [];
        candidates.push({ rule, value, important: priority === 'important' });
        byProperty.set(property, candidates);
      }
    }
    for (const [property, all] of byProperty) {
      const pool = all.some((one) => one.important) ? all.filter((one) => one.important) : all;
      const top = pool.reduce(
        (best, one) => (compare(one.rule.spec, best) > 0 ? one.rule.spec : best),
        [0, 0, 0],
      );
      const tied = pool.filter((one) => compare(one.rule.spec, top) === 0);
      const clash = tied.some((x) =>
        tied.some((y) => x.rule.origin !== y.rule.origin && x.value !== y.value),
      );
      if (!clash) continue;
      const key = `${property} ${tied
        .map((one) => one.rule.selector)
        .sort()
        .join(' | ')}`;
      if (!ties.has(key)) {
        ties.set(key, {
          property,
          at: top.join(','),
          element: `${element.tagName.toLowerCase()}${typeof element.className === 'string' && element.className ? `.${element.className.trim().split(/\s+/).join('.')}` : ''}`,
          rules: tied.map(
            (one) => `${one.rule.selector} { ${property}: ${one.value} } in ${one.rule.sheet}`,
          ),
        });
      }
    }
  }
  return {
    rules: rules.length,
    elements: document.querySelectorAll('*').length,
    ties: [...ties.values()],
  };
};

/**
 * Two rules that tie on purpose, from two made-up modules, on one element.
 *
 * Installed through `adoptedStyleSheets`, the CSSOM, which `style-src` does
 * not govern. It is the instrument's own control: a pass over a page that
 * cannot find THIS tie proves nothing about the page's.
 */
const INSTALL_TIE_CONTROL = () => {
  const one = new CSSStyleSheet();
  one.replaceSync('._tieProbe_aaaaa_1 { color: rgb(1, 2, 3); }');
  const two = new CSSStyleSheet();
  two.replaceSync('._tieProbe_bbbbb_1 { color: rgb(4, 5, 6); }');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, one, two];
  const probe = document.createElement('span');
  probe.className = '_tieProbe_aaaaa_1 _tieProbe_bbbbb_1';
  probe.dataset.tieControl = '';
  document.body.append(probe);
  window.__removeTieControl = () => {
    probe.remove();
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
      (sheet) => sheet !== one && sheet !== two,
    );
  };
};

async function checkCascadeTies(browser, label) {
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    const where = `at ${String(width)}px`;
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    const visited = [];
    const read = async (name) => {
      await page.waitForTimeout(250);
      visited.push({ name, ...(await page.evaluate(FIND_CASCADE_TIES)) });
    };

    try {
      await page.goto(`${ORIGIN}/tools`, { waitUntil: 'networkidle' });
      const tools = await page
        .locator('a[href^="/tools/"]')
        .evaluateAll((links) => [...new Set(links.map((link) => link.getAttribute('href')))]);

      /* -- The control, first, on a real page ----------------------------- */
      await page.evaluate(INSTALL_TIE_CONTROL);
      const control = await page.evaluate(FIND_CASCADE_TIES);
      await page.evaluate(() => window.__removeTieControl());
      check(
        label,
        `${where}: the tie detector finds a tie planted for it`,
        control.ties.some((tie) => tie.property === 'color' && tie.element.includes('_tieProbe_')),
        `${String(control.ties.length)} tie(s) found with the control installed`,
      );

      /* -- Every route, and the canvas states with the most components ---- */
      await read('/tools');
      for (const path of [...tools, '/styleguide', '/no-such-page']) {
        await page.goto(`${ORIGIN}${path}`, { waitUntil: 'networkidle' });
        await read(path);
      }

      // A pipeline, which opens the inspector on its first node.
      await page.goto(
        `${ORIGIN}/?p=${shareParam({
          v: 3,
          n: [
            ['n1', 'base64', 0, 0, { mode: 'encode' }],
            ['n2', 'hash', 260, 0, {}],
          ],
          e: [],
        })}`,
        { waitUntil: 'networkidle' },
      );
      await page.locator('[data-testid="node-n2"]').waitFor({ timeout: 15_000 });
      await read('the canvas, a share link with its inspector');
      await page.locator('[role="application"]').first().focus();
      await page.keyboard.press('k');
      await page.locator('[role="dialog"]').first().waitFor({ timeout: 10_000 });
      await read('the canvas, its palette open');
      await page.keyboard.press('Escape');
      await page.keyboard.press('?');
      await page.locator('[role="dialog"]').first().waitFor({ timeout: 10_000 });
      await read('the canvas, its shortcuts open');
      await page.keyboard.press('Escape');

      // Where the rich-text copy button lives, which was the third tie.
      await page.goto(`${ORIGIN}/tools/text-convert`, { waitUntil: 'networkidle' });
      await page.locator('textarea').first().fill('# Ties\n\nA *paragraph*.');
      await page.getByRole('combobox', { name: 'Target format' }).click();
      await page.getByRole('option', { name: 'HTML (normalised)', exact: true }).click();
      await page.getByRole('button', { name: 'Run' }).click();
      await page.getByRole('button', { name: 'Copy as rich text' }).waitFor({ timeout: 20_000 });
      await read('text-convert, with a rendered result');
    } finally {
      await context.close().catch(() => {});
    }

    const thin = visited.filter((state) => state.rules < 50 || state.elements < 40);
    check(
      label,
      `${where}: the tie detector read every state it visited`,
      visited.length >= 16 && thin.length === 0,
      `${String(visited.length)} states; ${thin.length === 0 ? 'every one with module rules and elements to match' : `thin: ${thin.map((state) => state.name).join(', ')}`}`,
    );

    const found = new Map();
    for (const state of visited) {
      for (const tie of state.ties) {
        const key = tie.rules.join(' | ');
        if (!found.has(key)) found.set(key, { ...tie, state: state.name });
      }
    }
    const first = [...found.values()][0];
    check(
      label,
      `${where}: no two CSS modules tie for a property and leave the winner to load order`,
      found.size === 0,
      found.size === 0
        ? `${String(visited.reduce((sum, state) => sum + state.rules, 0))} module selectors matched across ${String(visited.length)} states`
        : `${String(found.size)} tie(s); first on ${first.element} (${first.state}): ${first.rules.join(' AGAINST ')}`,
    );
  }
}

/*
 * EVERY SECTION OF A RUN, IN THE ORDER A FULL RUN DRIVES THEM.
 *
 * One list, so that `--only` can name a section and a full run and a partial
 * one cannot disagree about what exists. Every section opens its own context,
 * so none depends on another having run - but the order is kept, because the
 * lost fill of round eleven needed a page reused deep into a long run, and a
 * full run is the only place that condition exists.
 */
const SECTIONS = [
  checkSmoke,
  checkColdOpen,
  checkChromeWidths,
  checkCanvasGrid,
  checkRunnerLayout,
  checkInspector,
  checkInspectorMotion,
  checkCanvasMotion,
  checkInspectorTouch,
  checkDialogScroll,
  checkRouteFeedback,
  checkOffline,
  checkAxe,
  checkConsoleSilence,
  checkDeepLinks,
  checkStructuredData,
  checkFileExtension,
  checkTimestampZones,
  checkLossReports,
  checkLossCorpus,
  checkValueModel,
  checkColourContrast,
  checkPastedCensus,
  checkClaimsAndHue,
  checkSerialisedFaces,
  checkLossAlongWires,
  checkDiff,
  checkRegex,
  checkOutputViews,
  checkHead,
  checkTouch,
  checkTapHighlight,
  checkMobileLayout,
  checkPopovers,
  checkPointerFocus,
  checkCascadeTies,
  checkSoftKeyboard,
  checkBackgroundedTab,
  checkTwoTabs,
  checkRichTextClipboard,
  checkTruncation,
  checkOptionNotes,
  checkRunProgress,
  checkWorkerWarmth,
  checkToolIndex,
  checkNodeSummaryBox,
  checkPreviewSandbox,
  checkPipeline,
  checkWireFidelity,
  checkCanvasFileInput,
  checkFileInputTouch,
  checkImageConvert,
  checkOffscreenFallback,
  checkVideoRemux,
  checkLargeVideo,
  checkThemeEditor,
  checkNotifications,
];

/** The sections that launch their own browser, for touch or a phone viewport. */
const ON_ENGINE = new Set([
  checkInspectorTouch,
  checkTouch,
  checkTapHighlight,
  checkMobileLayout,
  checkPopovers,
  checkSoftKeyboard,
  checkFileInputTouch,
]);

/** Seconds each section took, per engine, printed at the end of the run. */
const timings = [];

async function runChecks(engine, label, sections) {
  console.log(`\n${label}`);
  const browser = await engine.launch();

  try {
    for (const section of sections) {
      const started = performance.now();
      await section(ON_ENGINE.has(section) ? engine : browser, label);
      const seconds = (performance.now() - started) / 1000;
      timings.push({ engine: label, section: section.name, seconds });
      // A measurement for whoever is choosing what to run, and never asserted:
      // how long a section takes is a fact about this machine.
      console.log(`  time ${section.name} ${seconds.toFixed(1)}s`);
    }
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
    /*
     * Which worker each execution started on, and which workers were
     * terminated: what "the next run is not queued behind the worker the
     * runaway wedged" means, observed rather than timed. See the last step.
     */
    const startedOn = [];
    const terminated = [];
    let workers = 0;
    Object.assign(window, { __execution: { posted, started, startedOn, terminated } });

    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(url, options) {
        super(url, options);
        const worker = workers;
        workers += 1;
        this.__index = worker;
        this.addEventListener('message', (event) => {
          if (event.data?.kind === 'started') {
            started.push(event.data.requestId);
            startedOn.push(worker);
          }
        });
      }
      postMessage(message, transfer) {
        if (message?.kind === 'execute') posted.push(message.requestId);
        return super.postMessage(message, transfer);
      }
      terminate() {
        terminated.push(this.__index);
        return super.terminate();
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
      // `check` prints the detail whether or not it passed, so this line is a
      // measurement in every log rather than only in a red one - which matters
      // here, because the threshold hid a real defect for a round. What the
      // number separates is 2.4s from 3.7s, not 2.4s from 15s.
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

    /* -- A second worker death the bystander also did not cause ----------- */

    /*
     * THE SAME TWO NODES, WITH A PAUSE BETWEEN THE TWO EDITS. THAT IS THE
     * WHOLE DIFFERENCE, AND IT USED TO BE THE DIFFERENCE BETWEEN PASS AND A
     * NODE FAILING FOR SOMETHING IT DID NOT DO.
     *
     * The check above types into both nodes as fast as the driver can, so the
     * pipeline's 300 ms debounce absorbs the two edits into ONE run and the
     * runaway is posted once. A person does not type that fast. Pause past the
     * debounce and there are two runs: the second cancels the first, and
     * because a cancelled run is deliberately not cached, it RE-POSTS the
     * runaway. Two copies, two worker deaths - and the bystander's replay
     * budget used to be one.
     *
     * Measured before the fix, idle, no load, 10 runs out of 10 in both
     * engines: `n2` reported `error` at ~3.6s with "This run was interrupted
     * before it could finish.", `n3` reported `upstream`, and the worker had
     * never started the base64 request at all. Round one saw this under CPU
     * load and recorded it as 29,370ms, which was its own polling budget
     * rather than anything the node did.
     *
     * The gap is 800ms rather than 400: it has to clear the debounce with
     * room, and it has to stay well inside the regex tool's 2s deadline, or
     * the runaway settles first and there is only one copy again.
     */
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
    await page.waitForTimeout(800);

    const pausedAt = Date.now();
    await typeInto('n2', 'eyJuYW1lIjoiYWRhIn0=');
    const paused = await untilStatus('n2', 'ok', 30_000);
    const pausedMs = Date.now() - pausedAt;
    const pausedDownstream = await untilStatus('n3', 'ok', 30_000);

    check(
      label,
      'a node edited a moment after a runaway one still produces its own answer',
      paused === 'ok',
      `${String(paused)} after ${String(pausedMs)}ms`,
    );
    /*
     * AND WHAT IT COST, AS AN ASSERTION RATHER THAN A NUMBER IN THE LOG.
     *
     * The line above passes at any speed, and the speed is the whole subject of
     * this block: the bystander waits out TWO worker deaths, because the second
     * edit re-posts the runaway and the engine replays the copy ahead of it. At
     * the regex tool's 2s deadline that is about 4 seconds, measured at 3.7.
     * Bounded, correct, and the price of not caching a cancelled run - but a
     * THIRD death would be a new defect, and the only thing that separates two
     * from three is a number nothing was checking.
     *
     * The bound is stated against the deadline rather than as a measurement,
     * so it moves when the tool's own limit moves.
     */
    check(
      label,
      'and waits out two worker deaths rather than three',
      paused === 'ok' && pausedMs < 3 * 2_000,
      `${String(pausedMs)}ms against a 2s tool deadline`,
    );
    check(
      label,
      'and the node downstream of it is not told its input failed',
      pausedDownstream === 'ok',
      String(pausedDownstream),
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
     *
     * OBSERVED, NOT TIMED, SINCE ROUND SEVENTEEN. This asserted the next run
     * finished inside 10s, sized to fail the 10.8s the defect took in WebKit.
     * But it drove the 26-branch pattern, which the note on `WEDGE_PATTERN`
     * measures giving up by itself in 1.5s in JavaScriptCore - and the defect's
     * Gecko figure, 4.1s, was under the threshold from the start. So the check
     * could not fail in either engine: found by the documentation audit,
     * reading the two numbers side by side. No threshold fixes that, because
     * the defect's cost is the regex's own running time, which an engine can
     * shorten. What the fix does, and the defect does not, is terminate the
     * worker the runaway is spinning in - so the next run starts on a NEW
     * worker. That is asserted, with the wide pattern so the regex is still
     * running when its deadline arrives in both engines.
     */
    await page.goto(
      link(
        [
          ['n1', 'regex-tester', 0, 0, { pattern: WEDGE_PATTERN, mode: 'match' }],
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
    // The worker the runaway started on: the latest start, now that it is running.
    const wedgedOn = await page.evaluate(() => window.__execution.startedOn.at(-1) ?? null);

    // Escape leaves the editor and puts focus back on the node, which is where
    // Delete is handled - the canvas root never sees a key typed in the panel.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Delete');
    await page.locator('[data-testid="node-n1"]').waitFor({ state: 'detached', timeout: 10_000 });

    const editedAt = Date.now();
    await typeInto('n2', 'eyJuYW1lIjoiYWRhIn0=');
    const afterEdit = await untilStatus('n2', 'ok', 25_000);
    const afterEditMs = Date.now() - editedAt;

    const after = await page.evaluate(() => ({
      ranOn: window.__execution.startedOn.at(-1) ?? null,
      terminated: [...window.__execution.terminated],
    }));
    check(
      label,
      'the run after a cancelled one is not left queued behind the worker it wedged',
      afterEdit === 'ok' &&
        wedgedOn !== null &&
        after.ranOn !== wedgedOn &&
        after.terminated.includes(wedgedOn),
      `${String(afterEdit)} after ${String(afterEditMs)}ms; the runaway ran on worker ${String(wedgedOn)}, the next run on worker ${String(after.ranOn)}, terminated: [${after.terminated.join(', ')}]`,
    );
  } finally {
    await context.close();
  }
}

/* ========================================================================== *
 * WHAT A REAL postMessage DOES TO A STRING
 * ========================================================================== */

/**
 * THE WORKER BOUNDARY, WITH TEXT NO ENCODER WOULD EVER PRODUCE.
 *
 * `wireFidelity.integration.test.ts` asks what a wire does to a value and
 * answers it exactly - sixteen payloads, compared by the diff tool against the
 * same string typed in by hand, with six negative controls. It runs entirely
 * on the MAIN THREAD, because jsdom has no Worker, so the one thing it cannot
 * say anything about is the structured clone that a `strategy: 'worker'` tool
 * actually crosses. docs/conversion-matrix.md has listed that gap under "still
 * unverified" since round two.
 *
 * It also cannot carry the payload that matters most. Every payload there
 * arrives as base64 decoded to UTF-8, and a LONE SURROGATE has no UTF-8
 * encoding at all - `TextDecoder` replaces it with U+FFFD before any tool sees
 * it. A JavaScript string can hold one, structured clone is specified to carry
 * one, and any hand-rolled serialisation between the two is where it would be
 * lost. That is precisely the case a round trip cannot reach and a clone can.
 *
 * SO THE PAYLOADS ARE BUILT FROM CODE UNITS, IN THE PAGE. Nothing here sends a
 * string over the Playwright protocol in either direction: the page builds each
 * payload from an array of numbers, seeds the graph itself, and every
 * comparison is `===` between two strings that have never left the browser.
 * Only numbers and booleans come back.
 *
 * THE CARRIER is `regex-tester` in replace mode with `(?!)`, a pattern that is
 * valid and can never match, so the tool's output is its subject unchanged.
 * It is a worker tool, its `unicode` option is `none` so nothing forces
 * well-formedness, and it is the only tool here whose text output is its text
 * input. What is asserted is therefore the whole path: the store, the clone
 * into the worker, the tool, and the clone back.
 */
async function checkWireFidelity(browser, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    await page.addInitScript(() => {
      /*
       * Every payload as UTF-16 code units, because writing them as string
       * literals would mean this file containing a lone surrogate - which is
       * exactly the character no tool in the chain between here and the page
       * can be trusted to carry.
       */
      const PAYLOADS = [
        { name: 'a lone high surrogate', units: [0x61, 0xd800, 0x62] },
        { name: 'a lone low surrogate', units: [0x61, 0xdc00, 0x62] },
        { name: 'a reversed surrogate pair', units: [0xdc00, 0xd800] },
        { name: 'a high surrogate at the very end', units: [0x61, 0x62, 0xd83d] },
        { name: 'a NUL byte', units: [0x62, 0x65, 0x66, 0x00, 0x61, 0x66] },
        { name: 'an astral character', units: [0x78, 0xd834, 0xdd1e, 0x79] },
        {
          name: 'an emoji with a zero-width joiner',
          units: [0xd83d, 0xdc68, 0x200d, 0xd83d, 0xdc69, 0x200d, 0xd83d, 0xdc67],
        },
        { name: 'a combining sequence', units: [0x65, 0x0301, 0x20, 0x00e9] },
        { name: 'a non-breaking space', units: [0x74, 0x65, 0x6e, 0x00a0, 0x6b, 0x67] },
        { name: 'a right-to-left override', units: [0x61, 0x202e, 0x62, 0x202c, 0x63] },
        { name: 'CRLF and a lone CR', units: [0x61, 0x0d, 0x0a, 0x62, 0x0d, 0x63] },
        { name: 'a byte order mark in the middle', units: [0x61, 0xfeff, 0x62] },
        { name: 'control characters', units: [0x07, 0x1b, 0x5b, 0x41, 0x7f] },
        { name: 'an unassigned plane 15 code point', units: [0x61, 0xdbc0, 0xdc00] },
      ];

      const build = (units) => units.map((unit) => String.fromCharCode(unit)).join('');
      const expected = PAYLOADS.map((payload) => build(payload.units));

      window.__wire = {
        names: PAYLOADS.map((payload) => payload.name),
        expected,
        sent: {},
        pairs: [],
      };

      /*
       * The graph is seeded through the app's own saved-canvas route rather
       * than typed in: a share link carries structure and never a node's
       * input, which is the privacy guarantee working as intended. A save that
       * the schema rejects loads nothing at all, so the node count asserted
       * below is what tells us the version literal here is still current.
       */
      const graph = {
        version: 6,
        nodes: PAYLOADS.map((payload, index) => ({
          id: `n${String(index)}`,
          toolId: 'regex-tester',
          position: { x: index * 40, y: index * 40 },
          options: {
            pattern: '(?!)',
            mode: 'replace',
            replacement: 'X',
            global: true,
            ignoreCase: false,
            multiline: false,
            dotAll: false,
            unicode: 'none',
            sticky: false,
          },
          inputs: { input: expected[index] },
          fileInputs: {},
        })),
        edges: [],
        nextId: PAYLOADS.length + 1,
      };

      try {
        window.localStorage.setItem('patchbay:graph:v3', JSON.stringify(graph));
      } catch {
        /* A context that refuses storage fails the node count below, loudly. */
      }

      const Native = window.Worker;
      window.Worker = class extends Native {
        constructor(url, options) {
          super(url, options);
          this.addEventListener('message', (event) => {
            const data = event.data;
            if (data?.kind !== 'settled') return;
            const sent = window.__wire.sent[data.requestId];
            if (sent === undefined) return;
            const got = data.result?.ok === true ? data.result.value?.output?.text : null;
            window.__wire.pairs.push({ sent, got: typeof got === 'string' ? got : null });
          });
        }
        postMessage(message, transfer) {
          if (message?.kind === 'execute' && typeof message.inputs?.input?.text === 'string') {
            window.__wire.sent[message.requestId] = message.inputs.input.text;
          }
          return super.postMessage(message, transfer);
        }
      };
    });

    await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });

    /*
     * THE INSTRUMENT HAS TO BE LOOKING. A save the schema rejected, a key that
     * moved, or a `version` literal that went stale all produce an empty canvas
     * - and an empty canvas posts nothing, which every assertion below about
     * what came back would then satisfy by having nothing to disagree with.
     */
    const nodes = await page.locator('[data-testid^="node-n"]').count();
    const wanted = await page.evaluate(() => window.__wire.names.length);
    check(
      label,
      'the seeded canvas really loaded every node',
      nodes === wanted,
      `${String(nodes)} of ${String(wanted)}`,
    );
    if (nodes !== wanted) return;

    const settled = await page
      .waitForFunction((count) => window.__wire.pairs.length >= count, wanted, { timeout: 60_000 })
      .then(() => true)
      .catch(() => false);

    check(
      label,
      'every payload crossed into a real worker and came back',
      settled,
      settled ? '' : 'the worker never answered for all of them',
    );
    if (!settled) return;

    /*
     * Compared in the page, returned as numbers. `sent` is what the engine
     * handed to `postMessage` and `got` is what came back off it, so the two
     * halves say different things: whether the payload survived the store, and
     * whether it survived the clone.
     */
    const verdict = await page.evaluate(() => {
      const wire = window.__wire;
      const units = (text) =>
        text === null ? [] : [...Array(text.length).keys()].map((index) => text.charCodeAt(index));

      return wire.expected.map((want, index) => {
        const pair = wire.pairs.find((candidate) => candidate.sent === want);
        const other = wire.expected[(index + 1) % wire.expected.length];
        return {
          name: wire.names[index],
          left: pair !== undefined,
          returned: pair?.got === want,
          // The comparison has to be able to say no: the same answer against a
          // different payload must not also be equal.
          discriminates: pair?.got !== other,
          wantUnits: units(want),
          gotUnits: units(pair?.got ?? null),
        };
      });
    });

    const notSent = verdict.filter((entry) => !entry.left);
    check(
      label,
      'each payload reached the worker as the string the node held',
      notSent.length === 0,
      notSent.map((entry) => `${entry.name} [${entry.wantUnits.join(' ')}]`).join('; '),
    );

    const mangled = verdict.filter((entry) => entry.left && !entry.returned);
    check(
      label,
      'and came back from it code unit for code unit',
      verdict.length > 0 && mangled.length === 0,
      mangled
        .map(
          (entry) =>
            `${entry.name}: wanted [${entry.wantUnits.join(' ')}] got [${entry.gotUnits.join(' ')}]`,
        )
        .join('; ') || `${String(verdict.length)} payloads`,
    );

    check(
      label,
      'and the comparison can tell one payload from another',
      verdict.length > 0 && verdict.every((entry) => entry.discriminates),
      verdict
        .filter((entry) => !entry.discriminates)
        .map((entry) => entry.name)
        .join(', ') || 'all',
    );
  } finally {
    await context.close();
  }
}

/* ========================================================================== *
 * THE OFFSCREENCANVAS FALLBACK, IN AN ENGINE THAT HAS OFFSCREENCANVAS
 * ========================================================================== */

/**
 * THE SKIP THIS EXISTS TO SHRINK.
 *
 * `image-convert` declares `requiresOffscreenCanvas`, and `resolveExecutionMeta`
 * downgrades it from `worker` to `main` on a browser without one. So the two
 * engines here take DIFFERENT branches, and each proves only its own: Gecko has
 * OffscreenCanvas and runs the tool in the worker, Playwright's WebKit has none
 * and runs it on the main thread.
 *
 * That leaves a hole neither green line shows. Real Safari has had
 * OffscreenCanvas since 16.4, so a Safari user takes the WORKER path - the one
 * WebKit here never reaches - and the fallback WebKit does reach is a path
 * almost nobody is on. Nothing had ever asked the question that decides whether
 * the downgrade is safe, which is whether the two branches produce the same
 * file.
 *
 * NAMING THE MECHANISM RATHER THAN THE SITUATION, which is the rule in
 * CONTRIBUTING.md. "A browser without OffscreenCanvas" cannot be obtained. THE
 * ABSENCE OF THE GLOBAL, which is the entirety of what such a browser does to
 * this app, can be: `addInitScript` deletes it before the bundle runs, so the
 * downgrade happens where it really happens - when the manifest entry is
 * resolved - rather than being simulated further down.
 *
 * So this runs one PNG through one tool twice in one engine, once down each
 * branch, and compares the decoded pixels. It runs only where the API is
 * present, because producing its absence is the whole point; where it is
 * absent already there is nothing to remove, and the ordinary image checks in
 * that engine are the fallback's coverage.
 */
async function checkOffscreenFallback(browser, label) {
  const png = makePng();

  /** Converts the fixture PNG and returns the branch taken and the pixels. */
  const convert = async (removeOffscreen) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

    if (removeOffscreen) {
      // BEFORE THE BUNDLE. The global is read once, when the manifest entry is
      // resolved, so an override applied afterwards would arrive to find the
      // strategy already chosen and would prove nothing.
      await context.addInitScript(() => {
        delete window.OffscreenCanvas;
      });
    }
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

      const present = await page.evaluate(() => typeof OffscreenCanvas !== 'undefined');

      await page.locator('input[type="file"]').setInputFiles({
        name: 'fixture.png',
        mimeType: 'image/png',
        buffer: png,
      });
      await page.getByRole('button', { name: 'Run' }).click();
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

      // WHICH BRANCH ACTUALLY RAN, read from the timeline rather than inferred
      // from the global. Only the worker path emits this span, so a downgrade
      // that silently failed to happen would be visible here rather than
      // hiding behind two identical answers.
      const usedWorker = await page.evaluate(() =>
        performance
          .getEntriesByType('measure')
          .some((entry) => entry.name === 'patchbay:execute:image-convert'),
      );

      await page.getByRole('button', { name: 'Download' }).first().click();
      const pixels = await page.evaluate(async () => {
        const blob = window.__lastBlob;
        if (!blob) return null;
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context2d = canvas.getContext('2d');
        context2d.drawImage(bitmap, 0, 0);
        const data = context2d.getImageData(0, 0, bitmap.width, bitmap.height).data;
        return { width: bitmap.width, height: bitmap.height, data: [...data] };
      });

      return { present, usedWorker, report, pixels };
    } finally {
      await context.close();
    }
  };

  const withApi = await convert(false);
  if (!withApi.present) {
    /*
     * NOT A SILENT RETURN, AND NOT A SKIP EITHER.
     *
     * There is nothing to remove in an engine that has no OffscreenCanvas - so
     * the comparison belongs in the other engine, which is where it runs. What
     * CAN be asserted here is the claim the skip beside the image checks makes
     * about this engine, which is otherwise taken on trust: that the missing
     * API really does put the tool on the main thread. A check that vanishes
     * leaves a summary reading as full coverage, which is the failure this
     * file has had before.
     */
    check(
      label,
      'with no OffscreenCanvas at all, image conversion really runs on the main thread',
      !withApi.usedWorker,
      `usedWorker=${String(withApi.usedWorker)}`,
    );
    return;
  }

  const withoutApi = await convert(true);

  check(
    label,
    'removing OffscreenCanvas really moves image conversion off the worker',
    withApi.usedWorker && !withoutApi.usedWorker,
    `with=${String(withApi.usedWorker)}, without=${String(withoutApi.usedWorker)}`,
  );

  /*
   * The comparison, which is the reason for all of the above. A fallback that
   * RUNS is not a fallback that AGREES: the two paths reach different encoder
   * entry points, and "it produced an image" is satisfied by a wrong one.
   */
  const left = withApi.pixels;
  const right = withoutApi.pixels;
  const samePixels =
    left !== null &&
    right !== null &&
    left.width === right.width &&
    left.height === right.height &&
    left.data.length === right.data.length &&
    left.data.every((value, index) => value === right.data[index]);

  const firstDifference =
    samePixels || left === null || right === null
      ? -1
      : left.data.findIndex((value, index) => value !== right.data[index]);

  check(
    label,
    'the main-thread fallback decodes to the same pixels as the worker path',
    samePixels,
    samePixels
      ? `${String(left.width)}x${String(left.height)}, ${String(left.data.length)} samples equal`
      : `first difference at sample ${String(firstDifference)}`,
  );

  check(
    label,
    'and reports the same dimensions and format down either branch',
    withApi.report?.to?.width === withoutApi.report?.to?.width &&
      withApi.report?.to?.height === withoutApi.report?.to?.height &&
      withApi.report?.to?.format === withoutApi.report?.to?.format,
    `${String(withApi.report?.to?.format)} ${String(withApi.report?.to?.width)}x${String(withApi.report?.to?.height)} vs ` +
      `${String(withoutApi.report?.to?.format)} ${String(withoutApi.report?.to?.width)}x${String(withoutApi.report?.to?.height)}`,
  );
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
     * a link is something people paste into chat.
     *
     * A WRAPPER OVER THE THING THAT ACTUALLY CARRIES THE LINK, AND A DECODE.
     *
     * What stood here read `window.location.href` after clicking Share, and
     * asserted the word `holiday` was not in it. It could not fail, for two
     * independent reasons, and it is the privacy claim:
     *
     *  1. `onShare` never touches `window.location`. It builds the URL and
     *     hands it to `navigator.clipboard.writeText` - which this check used
     *     to replace with a STUB that discarded its argument. The address bar
     *     has never held the share link at any point in this flow, so the
     *     assertion was made against the canvas URL, which is
     *     `http://127.0.0.1:4319/` and contains no filenames by construction.
     *  2. Even reading the right string would not have helped. The payload is
     *     `deflate-raw` then base64url - so a filename inside it cannot appear
     *     as the literal bytes `holiday` in the URL whether it is there or
     *     not. The absence being asserted was an absence the ENCODING
     *     guarantees, not one the app does.
     *
     * It would have passed against a build that put the whole file in the
     * link. So: capture what is really copied, prove it really is a share
     * link, and look inside the decoded payload - which is the only place the
     * filename could ever have been.
     */
    await page.evaluate(() => {
      window.__shareUrl = null;
      navigator.clipboard.writeText = (text) => {
        window.__shareUrl = String(text);
        return Promise.resolve();
      };
    });
    await page.getByRole('button', { name: /Share/i }).click();
    const copied = await page
      .waitForFunction(() => window.__shareUrl !== null, undefined, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const shareUrl = copied ? await page.evaluate(() => window.__shareUrl) : '';

    const param = /[?&]p=([^&#]+)/.exec(shareUrl)?.[1] ?? '';
    /*
     * POSITIVE FIRST. A link with no payload trivially carries no filename,
     * and that is the failure this check kept mistaking for a pass.
     */
    check(
      label,
      'the Share button copies a link that really carries the pipeline',
      param.length > 0,
      copied ? shareUrl.slice(0, 80) : 'nothing was copied',
    );

    let decoded = '';
    try {
      decoded = inflateRawSync(
        Buffer.from(param.replaceAll('-', '+').replaceAll('_', '/'), 'base64'),
      ).toString('utf8');
    } catch (error) {
      decoded = `<undecodable: ${String(error).slice(0, 60)}>`;
    }

    check(
      label,
      'and the decoded payload is a share payload, not an opaque blob',
      /"v":\s*\d/.test(decoded) && decoded.includes('image-convert'),
      decoded.slice(0, 100),
    );

    check(
      label,
      'a share link built from a canvas with a file carries no filename',
      param.length > 0 && !decoded.includes('holiday') && !decoded.includes('.png'),
      decoded.slice(0, 160),
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
      (upright.report?.from?.metadata ?? []).includes('GPS location'),
      JSON.stringify(upright.report?.from?.metadata ?? null),
    );

    /*
     * AND WHAT THE ENCODER PUT BACK, WHICH THE TOOL USED TO ASSERT AWAY.
     *
     * `to.metadata` was the literal `[]`. It is now read back out of the
     * bytes, so this check is a comparison rather than a restatement: the
     * report has to agree with the file, whatever the file turns out to be.
     * In Firefox the answer is nothing; in Playwright's WebKit it is an ICC
     * profile, and both are correct reports of what happened.
     */
    const carried = pngMetadataChunks(uprightBytes);
    const reportedTo = upright.report?.to?.metadata ?? [];
    const saysIcc = reportedTo.includes('ICC colour profile');
    check(
      label,
      'the output metadata it reports is the output metadata it produced',
      saysIcc === carried.includes('iCCP') &&
        (carried.includes('eXIf') ? reportedTo.includes('EXIF') : !reportedTo.includes('EXIF')),
      `chunks [${carried.join(', ')}] against report ${JSON.stringify(reportedTo)}`,
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

    /* -- 6b. And the downscale is compared with a reference resampler ------ */

    /*
     * THE ONE CONVERSION IN THIS APP THAT HAD NO REFERENCE AT ALL.
     *
     * The resize is `drawImage` onto a smaller canvas, which is the BROWSER's
     * resampler. No specification says what it produces, engines differ, and
     * the matrix has carried image resampling as `not verified` since round
     * one on exactly that ground. The check above it is real but narrow: one
     * pattern, one question, "is this an average rather than a sample".
     *
     * WHAT MAKES A REFERENCE POSSIBLE. At an integer reduction, a region that
     * is constant over a wide neighbourhood has one correct answer and every
     * filter gives it. So the pattern is 64x64 blocks of flat colour reduced
     * 4x, and the generator MEASURES which output pixels Pillow's box,
     * bilinear, Hamming and Lanczos all agree about - 2927 of 4096 - rather
     * than arguing that they must. Those are the pixels asserted on. The other
     * 1169 are where the filters themselves differ by up to 57 levels, and a
     * browser is entitled to be anywhere in that spread; what happens there is
     * REPORTED and not asserted, because an assertion over them would be a
     * claim about which kernel an engine chose.
     *
     * WHAT TOLERANCE IS HONEST, MEASURED RATHER THAN GUESSED. `drawImage` is
     * unspecified and engines could reasonably round differently, so the first
     * version of this check allowed twelve levels. Measured against the
     * reference on this pattern, at `imageSmoothingQuality` high, medium and
     * low alike: Gecko is within ONE level and WebKit is exact - on every
     * pixel, not only the settled ones. Both engines do an exact area average
     * at an integer reduction.
     *
     * So the bound is two, which is the measurement plus the smallest headroom
     * that means anything, and it is asserted only on the settled pixels. An
     * engine that moved to a different kernel tomorrow would still pass there,
     * because a settled pixel is one every kernel agrees about - and that is
     * the difference between holding this tool to correctness and holding an
     * engine to a particular filter.
     *
     * The control carries it: nearest-neighbour sits 128 levels from the
     * reference on these same pixels. A tolerance loosened until it passed
     * would take the control with it, and the control is asserted here rather
     * than described.
     *
     * SHOWN FAILING, TWICE, BEFORE IT WAS TRUSTED. Measured in Gecko with the
     * same fixture: `createImageBitmap`'s own `resizeQuality: 'pixelated'`
     * lands 128 levels from the reference, and drawing the bitmap at its own
     * size into the smaller canvas - a crop instead of a scale, which is a
     * plausible edit to `paint` - lands 255. Worth knowing what does NOT break
     * it: setting `imageSmoothingEnabled` to false changes nothing at all in
     * Gecko at this factor, so that line in `convert.ts` is insurance against
     * an engine that is not one of these two rather than something either of
     * them needs.
     */
    const RESAMPLE_TOLERANCE = 2;

    const pattern = {
      name: 'blocks.png',
      mimeType: 'image/png',
      buffer: Buffer.from(RESAMPLE.source.pngBase64, 'base64'),
    };
    const resampled = await run(pattern, {
      format: 'PNG (lossless)',
      maxEdge: RESAMPLE.downscale.width,
    });

    const against = await page.evaluate(
      async ([got, expected, nearest, settled]) => {
        const decode = async (base64) => {
          const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([bytes]));
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const context2d = canvas.getContext('2d');
          context2d.drawImage(bitmap, 0, 0);
          return {
            width: bitmap.width,
            height: bitmap.height,
            data: context2d.getImageData(0, 0, bitmap.width, bitmap.height).data,
          };
        };

        const ours = await decode(got);
        const reference = await decode(expected);
        const control = await decode(nearest);

        const compare = (a, b, indices) => {
          let worst = 0;
          let total = 0;
          for (const index of indices) {
            for (let channel = 0; channel < 3; channel += 1) {
              const error = Math.abs(a.data[index * 4 + channel] - b.data[index * 4 + channel]);
              worst = Math.max(worst, error);
              total += error;
            }
          }
          return { worst, mean: indices.length === 0 ? 0 : total / (indices.length * 3) };
        };

        const settledSet = new Set(settled);
        const unsettled = [];
        for (let index = 0; index < reference.width * reference.height; index += 1) {
          if (!settledSet.has(index)) unsettled.push(index);
        }

        return {
          width: ours.width,
          height: ours.height,
          onSettled: compare(ours, reference, settled),
          onUnsettled: compare(ours, reference, unsettled),
          // The control, measured against OUR output rather than against the
          // reference: the question is whether this engine could be mistaken
          // for a point sampler, not whether Pillow could.
          versusNearest: compare(ours, control, settled),
        };
      },
      [
        resampled.encoded,
        RESAMPLE.expectedPngBase64,
        RESAMPLE.nearestPngBase64,
        RESAMPLE.agreement.settled,
      ],
    );

    check(
      label,
      'a 4x downscale matches a reference resampler wherever four filters agree',
      against.width === RESAMPLE.downscale.width && against.onSettled.worst <= RESAMPLE_TOLERANCE,
      `${String(against.width)}x${String(against.height)}, worst ${String(against.onSettled.worst)} levels on ${String(RESAMPLE.agreement.settled.length)} settled pixels (mean ${against.onSettled.mean.toFixed(2)}), tolerance ${String(RESAMPLE_TOLERANCE)}`,
    );

    check(
      label,
      'and that tolerance is nowhere near wide enough to accept point sampling',
      against.versusNearest.worst > RESAMPLE_TOLERANCE * 16,
      `this engine is ${String(against.versusNearest.worst)} levels from nearest-neighbour on the same pixels (mean ${against.versusNearest.mean.toFixed(2)})`,
    );

    /*
     * AND THE PIXELS THE REFERENCE FILTERS THEMSELVES DISAGREE ABOUT, bounded
     * by that disagreement rather than by the tolerance above. A browser is
     * entitled to be anywhere box, bilinear, Hamming and Lanczos are; it is
     * not entitled to be outside all four. Both engines measured at one level
     * and zero here, which is to say they are doing the box average on these
     * pixels too - but asserting THAT would be asserting a choice of kernel,
     * so the bound is the spread and the number is in the detail.
     */
    check(
      label,
      'the engine stays within the spread of the reference filters where they disagree',
      against.onUnsettled.worst <= RESAMPLE.agreement.widestDisagreement,
      `worst ${String(against.onUnsettled.worst)} levels where the four filters themselves span ${String(RESAMPLE.agreement.widestDisagreement)} (mean ${against.onUnsettled.mean.toFixed(2)})`,
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

    /* -- 5. AND SOMETHING PLAYS IT ---------------------------------------- */

    await checkVideoPlays(context, label, run);
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * THE FILE THIS TOOL MADE, DECODED BY A REAL DECODER.
 *
 * `docs/manual-checks.md` has carried one line since the video tool landed:
 * "nothing here has ever played a file that tool made." Everything else in this
 * repository is about bytes - the coded pictures survive, the index is in front
 * of the media, the parameter set says 640x480 - and every one of those is true
 * of files no player will open. A container is a contract with a decoder.
 *
 * SO IT ASKS A DECODER. Twelve frames of flat colour, encoded once by a real
 * x264 and committed as `src/tools/video-remux/spec/playback.json`, through the
 * whole product, and then the OUTPUT and the SOURCE are both decoded by this
 * engine and compared frame by frame.
 *
 * THE COMPARISON IS SOURCE AGAINST OUTPUT IN THE SAME ENGINE, not against the
 * colours that were encoded and not against ffmpeg's decode. Gecko returns
 * rgb(237, 39, 19) where ffmpeg returns rgb(219, 18, 18) for the same coded
 * frame - a different YUV-to-RGB matrix, which is a decoder's business and not
 * a remuxer's. What a remuxer must not change is anything, so the assertion is
 * equality between two files through one decoder.
 *
 * AND EQUALITY IS THE EASIEST THING IN THE WORLD TO GET FOR THE WRONG REASON.
 * Two videos that decode to nothing are equal; twelve samples of one frame are
 * equal. So the frames are also required to be pairwise DISTINCT, and each one
 * is required to be nearest to its OWN colour among the twelve - which is a
 * frame count, an ordering and a drop check in one line.
 *
 * ON A NEUTRAL PAGE, not the tool's. `public/_headers` ships a CSP with no
 * `media-src blob:`, so a `<video>` created inside a Patchbay page fails with
 * `MEDIA_ERR_SRC_NOT_SUPPORTED` whatever the bytes are - which would look
 * exactly like a broken remuxer.
 */
async function checkVideoPlays(context, label, run) {
  const clip = Buffer.from(VIDEO_PLAYBACK.clip.mp4Base64, 'base64');
  const { width, height, frames, frameRate } = VIDEO_PLAYBACK.clip;

  const page = await context.newPage();

  /** Decodes `frames` samples out of an MP4, in this engine, on a blank page. */
  const decode = async (base64) =>
    page.evaluate(
      async ([data, count, rate, w, h]) => {
        const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        document.body.append(video);

        const ready = await new Promise((resolve) => {
          video.addEventListener('loadeddata', () => resolve('loadeddata'), { once: true });
          video.addEventListener('error', () => resolve(`error ${String(video.error?.code)}`), {
            once: true,
          });
          setTimeout(() => resolve('timeout'), 20_000);
          // Assigned AFTER the listeners and inside the promise: a cached blob
          // can reach `loadeddata` before a listener attached on the next line
          // would have seen it.
          video.src = url;
        });

        if (ready !== 'loadeddata') {
          URL.revokeObjectURL(url);
          video.remove();
          return { ready };
        }

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const context2d = canvas.getContext('2d', { willReadFrequently: true });

        const centres = [];
        for (let index = 0; index < count; index += 1) {
          // Mid-frame rather than on a boundary: a seek to exactly 1/12 is a
          // question about rounding, and this check is not about rounding.
          await new Promise((resolve) => {
            video.addEventListener('seeked', resolve, { once: true });
            video.currentTime = (index + 0.5) / rate;
          });
          context2d.drawImage(video, 0, 0, w, h);
          const pixel = context2d.getImageData(Math.floor(w / 2), Math.floor(h / 2), 1, 1).data;
          centres.push([pixel[0], pixel[1], pixel[2]]);
        }

        const out = {
          ready,
          duration: video.duration,
          width: video.videoWidth,
          height: video.videoHeight,
          centres,
        };
        URL.revokeObjectURL(url);
        video.remove();
        return out;
      },
      [base64, count(frames), frameRate, width, height],
    );

  try {
    await page.goto('about:blank');

    /*
     * THE CONTROL RUNS FIRST, AND IT IS THE REASON THIS CHECK CAN BE TRUSTED
     * OR HONESTLY SKIPPED. Playwright's WebKit on Windows answers "probably"
     * to `canPlayType` for H.264 and then refuses every H.264 file it is given,
     * including ones ffmpeg wrote thirty seconds earlier. Without playing the
     * SOURCE first, that engine's refusal of our output would read as a defect
     * in the remuxer.
     */
    const source = await decode(VIDEO_PLAYBACK.clip.mp4Base64);

    if (source.ready !== 'loadeddata') {
      skip(
        label,
        'the file the video tool made is decoded by a real decoder',
        `this engine will not play the SOURCE clip either (${String(source.ready)}), so it cannot answer the question - a real x264 file, ${String(clip.length)} bytes`,
      );
      return;
    }

    check(
      label,
      'the control clip decodes to twelve frames this engine can tell apart',
      source.centres.length === frames &&
        source.centres.every((a, index) =>
          source.centres.every(
            (b, other) =>
              index === other ||
              Math.max(...[0, 1, 2].map((channel) => Math.abs(a[channel] - b[channel]))) >= 20,
          ),
        ),
      `${String(source.centres.length)} frames, ${JSON.stringify(source.centres[0])} first`,
    );

    const repackaged = await run(
      { name: 'colours.mp4', mimeType: 'video/mp4', buffer: clip },
      'Repackage as MP4',
    );

    const played = await decode(repackaged.encoded ?? '');

    check(
      label,
      'the file the video tool made is opened by a real decoder',
      played.ready === 'loadeddata' &&
        played.width === width &&
        played.height === height &&
        Math.abs(played.duration - frames / frameRate) < 0.2,
      `${String(played.ready)}, ${String(played.width)}x${String(played.height)}, ${String(played.duration)}s`,
    );

    check(
      label,
      'and every frame it decodes to is the frame the source decodes to',
      played.centres !== undefined &&
        played.centres.length === frames &&
        played.centres.every(
          (got, index) =>
            got[0] === source.centres[index][0] &&
            got[1] === source.centres[index][1] &&
            got[2] === source.centres[index][2],
        ),
      played.centres === undefined
        ? 'nothing decoded'
        : `${String(played.centres.length)} frames, worst channel difference ${String(
            Math.max(
              0,
              ...played.centres.flatMap((got, index) =>
                [0, 1, 2].map((channel) => Math.abs(got[channel] - source.centres[index][channel])),
              ),
            ),
          )}`,
    );

    /*
     * THE ANTI-TAUTOLOGY. Two files that decode to nothing are equal, and so
     * are twelve samples of one frame. Each decoded frame has to be nearest to
     * its OWN encoded colour among the twelve - which says the count is right,
     * the order is right, and none was dropped or repeated, in one comparison.
     */
    const nearest = (pixel) => {
      let best = -1;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const [index, colour] of VIDEO_PLAYBACK.encodedCentres.entries()) {
        const distance = Math.max(
          ...[0, 1, 2].map((channel) => Math.abs(pixel[channel] - colour[channel])),
        );
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
      return best;
    };

    const order = (played.centres ?? []).map((pixel) => nearest(pixel));
    check(
      label,
      'in the order they were encoded, with none dropped or repeated',
      order.length === frames && order.every((got, index) => got === index),
      `frames resolved to ${JSON.stringify(order)}`,
    );

    /*
     * AND THE DECODER HAS TO BE ABLE TO SAY NO, or "it played" means only that
     * something was handed a URL. The same bytes with the sample table's entry
     * count overwritten cannot be decoded by anything, and an engine that
     * reports `loadeddata` for them is not reading the file at all.
     */
    const damaged = Buffer.from(repackaged.encoded ?? '', 'base64');
    const stsz = damaged.indexOf('stsz');
    if (stsz > 0) {
      // The sample count, four bytes past the version/flags and the uniform
      // size field. Set to something the media cannot support.
      damaged.writeUInt32BE(0xffff_ff00, stsz + 12);
    }

    const refused = await decode(damaged.toString('base64'));
    check(
      label,
      'and a decoder that accepts a damaged copy of it would have been the wrong witness',
      stsz > 0 && refused.ready !== 'loadeddata',
      stsz > 0 ? `damaged copy: ${String(refused.ready)}` : 'no sample table to damage',
    );
  } finally {
    await page.close().catch(() => {});
  }
}

/** Reads a count that must be a number, so a missing field is loud. */
function count(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`cross-browser: expected a frame count, got ${JSON.stringify(value)}`);
  }
  return value;
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
    /*
     * `> 0` PROVES THE COUNTER IS LIVE. The interesting half of this is the
     * ceiling, but a ceiling alone is satisfied by an instrument that recorded
     * nothing - a wrapper that failed to install reads 0, and 0 is `<= 8192`.
     * The sniff genuinely needs 4 kB, so a run that read none of the file did
     * not measure it.
     */
    check(
      label,
      'choosing a 320 MB video reads 4 kB of it and no more',
      afterChoosing > 0 && afterChoosing <= 8192,
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
      duringRun > 0 && duringRun <= 8192,
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

/* ========================================================================== *
 * WHICH TREE THIS RUN IS ABOUT
 * ========================================================================== */

/**
 * The newest modification time under a set of roots, and the file that carries it.
 *
 * Follows directories, skips nothing: a source file is anything a build reads,
 * and deciding which ones matter is how a staleness check acquires a hole.
 */
async function newestUnder(roots, skip = () => false) {
  let newest = { at: 0, file: null };

  const walk = async (path) => {
    const info = await stat(path).catch(() => null);
    if (info === null) return;
    if (info.isDirectory()) {
      const entries = await readdir(path).catch(() => []);
      for (const entry of entries) await walk(join(path, entry));
      return;
    }
    if (skip(path)) return;
    if (info.mtimeMs > newest.at) newest = { at: info.mtimeMs, file: path };
  };

  for (const root of roots) await walk(join(ROOT, root));
  return newest;
}

/**
 * The one exclusion, and it is a fact rather than a judgement.
 *
 * A `*.test.ts` is reachable from no entry point, so Rollup never puts one in
 * `dist` and editing one cannot make the build stale. Excluding it is what
 * stops this check turning every test edit into a mandatory rebuild - which is
 * the kind of friction that gets a check deleted. Nothing else is excluded:
 * deciding which ordinary source files "probably do not matter" is how a
 * staleness check acquires a hole.
 */
/*
 * AND THE EXCLUSION IS A PATTERN OVER FILE NAMES, NOT A LIST OF FILES, which
 * is what stops it acquiring an exception per awkward case. The one thing it
 * must never reach is this harness - and it does not, because `scripts/` is not
 * a source root at all: no edit to a check can make `dist` stale, which is
 * correct, and no edit to a check is invisible either, because the harness
 * hashes itself. See `harnessDigest`.
 */
const isTestFile = (path) => /\.test\.[cm]?[jt]sx?$/.test(path);

/**
 * THE RUN HAS TO SAY WHICH CODE IT RAN AGAINST, AND NOTHING DID.
 *
 * This script drives `dist/`, which is whatever `pnpm build` last wrote. Every
 * instruction about it - run it before committing, do not change code while it
 * is running, run it again if anything changed - is a process rule, and a
 * process rule is not a check. Round four could not confirm from the repository
 * that round three's run had covered round three's final tree, because nothing
 * anywhere records the two facts together: no log is committed, the summary
 * names no commit, and a build from an hour ago drives exactly as green as a
 * build from a second ago.
 *
 * So the rule becomes an assertion. A source file newer than the newest file in
 * `dist/` means the build under test does not contain it - which is true
 * whether somebody forgot to rebuild, or edited a file while the run was in
 * flight. It is asserted BEFORE the browsers start, so a stale run fails in a
 * second rather than in twenty minutes, and again at the END, which is the half
 * that catches an edit made while it ran.
 *
 * `dist/` is compared by its NEWEST file rather than its oldest: Vite writes the
 * whole directory in one pass, and a build interrupted half way through is a
 * different failure that every other check in this file would report anyway.
 */
const SOURCE_ROOTS = ['src', 'public', 'vite', 'index.html', 'vite.config.ts', 'package.json'];

/**
 * THE OTHER HALF OF "WHICH TREE THIS RUN IS ABOUT", AND IT IS NOT THE BUILD.
 *
 * `checkBuildIsCurrent` asks whether `dist` contains the source it was made
 * from. It cannot ask anything about THIS SCRIPT, because a harness is not
 * built into `dist` and never will be - `scripts/` is not in `SOURCE_ROOTS`
 * and should not be, or every edit to a check would demand a rebuild of the
 * app.
 *
 * But harness code changes what a run MEANS. A check edited while a run is in
 * flight produces a summary about a mixture of two harnesses, and the failure
 * is silent in the direction that matters: the half that ran first is the half
 * whose assertions were the old ones. Round four's staleness check closed that
 * hole for the app and left it open for the thing doing the checking.
 *
 * So the harness records its own identity. The digest is over this file and
 * everything it loads, printed at the start so a run can be matched to a tree,
 * and asserted unchanged at the end.
 */
const HARNESS_FILES = ['scripts/cross-browser-check.mjs', 'scripts/serve-dist.mjs'];

async function harnessDigest() {
  const digest = createHash('sha256');
  for (const path of HARNESS_FILES) {
    digest.update(path);
    digest.update('\0');
    digest.update(await readFile(join(ROOT, path)));
    digest.update('\0');
  }
  return digest.digest('hex');
}

async function checkBuildIsCurrent(label, when) {
  const built = await newestUnder(['dist']);
  const source = await newestUnder(SOURCE_ROOTS, isTestFile);
  const stale = source.at > built.at;

  check(
    'Build output',
    `the build under test is ${when} the source it was made from`,
    !stale && built.at > 0,
    stale
      ? `${relative(ROOT, source.file ?? '')} is ${Math.round((source.at - built.at) / 1000).toString()}s newer than dist - rebuild and run this again`
      : `dist at ${new Date(built.at).toISOString()}, newest source ${relative(ROOT, source.file ?? '')}`,
  );

  return { built, source, stale, label };
}

/* ========================================================================== */

/*
 * WHAT TO RUN, FOR ITERATION ONLY.
 *
 *   --only=<name>[,<name>...]   the sections whose function name contains any
 *                               of these, case-insensitively, `check` optional:
 *                               `--only=popovers,valuemodel`
 *   --engine=firefox|webkit     one engine rather than both
 *   --engine=chromium           opt-in, and never part of a full run
 *   --list                      the section names, and exit
 *
 * A full run is ~2,900 checks in both engines and every round runs it several
 * times, so a round iterating on one section paid for fifty-one it could not
 * have affected; the CSP round built a throwaway runner outside the tree to
 * get round that. This is that runner, in the tree.
 *
 * IT IS NOT THE PRE-COMMIT RUN, AND IT SAYS SO. The findings this harness is
 * proudest of came from failures that exist only deep in a FULL run - the lost
 * fill needed a page reused across a long sequence and sixty-four iterations -
 * and a filtered run removes exactly that condition. So a partial run can fail,
 * and can pass, but it never prints the line a full run prints on success: its
 * verdict begins `PARTIAL` and names the command a commit still needs.
 *
 * A filter that matches nothing is an error rather than an empty run, because
 * an empty run has no failures and would otherwise read as a pass.
 */
const ENGINES = {
  firefox: [firefox, 'Firefox (Gecko)'],
  webkit: [webkit, 'WebKit - the engine behind Safari, not Safari itself'],
  /*
   * OPT-IN AND NEVER PART OF A FULL RUN. Added in round twenty-one for one
   * question the two gate engines could not answer: Chromium honours a
   * fractional `deviceScaleFactor`, and a fractional density is where the
   * grid's bitmap stopped matching its box (see `layerStep`). Only
   * `checkCanvasGrid` has been run here; nothing else is claimed.
   */
  chromium: [chromium, 'Chromium - opt-in, not a gate engine'],
};

function sectionsToRun(argv) {
  const flags = new Map();
  for (const arg of argv) {
    const match = /^--(only|engine|list)(?:=(.*))?$/.exec(arg);
    if (!match) {
      console.error(`cross-browser: unknown argument ${arg} - use --only=, --engine= or --list`);
      process.exit(2);
    }
    flags.set(match[1], match[2] ?? '');
  }

  if (flags.has('list')) {
    console.log(SECTIONS.map((section) => section.name).join('\n'));
    process.exit(0);
  }

  const engineName = flags.get('engine');
  if (engineName !== undefined && !(engineName in ENGINES)) {
    console.error(`cross-browser: --engine=${engineName} - use firefox, webkit or chromium`);
    process.exit(2);
  }

  let sections = SECTIONS;
  const only = flags.get('only');
  if (only !== undefined) {
    const terms = only.split(',').map((term) =>
      term
        .trim()
        .toLowerCase()
        .replace(/^check/, ''),
    );
    const unmatched = terms.filter(
      (term) =>
        term === '' || !SECTIONS.some((section) => section.name.toLowerCase().includes(term)),
    );
    if (unmatched.length > 0) {
      console.error(
        `cross-browser: --only matched no section for ${unmatched.map((term) => `"${term}"`).join(', ')}. Sections:\n  ${SECTIONS.map((section) => section.name).join('\n  ')}`,
      );
      process.exit(2);
    }
    sections = SECTIONS.filter((section) =>
      terms.some((term) => section.name.toLowerCase().includes(term)),
    );
  }

  const engines = engineName === undefined ? ['firefox', 'webkit'] : [engineName];
  return { sections, engines, partial: sections.length < SECTIONS.length || engines.length < 2 };
}

const selection = sectionsToRun(process.argv.slice(2));
if (selection.partial) {
  console.log(
    `cross-browser: PARTIAL run - ${selection.sections.map((section) => section.name).join(', ')} in ${selection.engines.join(' and ')}`,
  );
}

const before = await checkBuildIsCurrent('start', 'no older than');
if (before.stale) {
  console.error('cross-browser: refusing to drive a stale build.');
  process.exitCode = 1;
  process.exit();
}

const harnessAtStart = await harnessDigest();
console.log(
  `cross-browser: harness ${harnessAtStart.slice(0, 12)} over ${HARNESS_FILES.join(', ')}`,
);

const server = await serveDist(PORT);

try {
  // Engine-independent: these are assertions about the files the build emits.
  await checkDeployment('Build output', await readHeaders());
  await checkLiveAssets('Build output');

  for (const name of selection.engines) {
    const [engine, label] = ENGINES[name];
    await runChecks(engine, label, selection.sections);
  }
} finally {
  server.close();
}

// The half that catches an edit made WHILE this ran, which is the case the
// instruction "do not change code while check:browsers is running" is about.
await checkBuildIsCurrent('end', 'still no older than');

const harnessAtEnd = await harnessDigest();
check(
  'Build output',
  'the harness that finished this run is the one that started it',
  harnessAtEnd === harnessAtStart,
  harnessAtEnd === harnessAtStart
    ? `harness ${harnessAtStart.slice(0, 12)}`
    : `started as ${harnessAtStart.slice(0, 12)} and ended as ${harnessAtEnd.slice(0, 12)} - the checks above are a mixture of two`,
);

console.log('');
console.log(
  `cross-browser: time per section, slowest first\n  ${[...timings]
    .sort((a, b) => b.seconds - a.seconds)
    .map(
      (entry) =>
        `${entry.seconds.toFixed(1).padStart(6)}s  ${entry.section}  (${entry.engine.split(' ')[0]})`,
    )
    .join('\n  ')}`,
);
console.log('');
if (skipped.length > 0) {
  console.log(`cross-browser: ${skipped.length} skipped\n  ${skipped.join('\n  ')}`);
  console.log('');
}
const scope = selection.partial
  ? `PARTIAL - ${selection.sections.length.toString()} of ${SECTIONS.length.toString()} sections in ${selection.engines.join(' and ')}. Not the pre-commit run: \`pnpm check:browsers\` with no arguments still has to pass before a commit.`
  : null;
if (failures.length > 0) {
  console.error(
    `cross-browser: ${failures.length} failure(s)\n  ${failures.join('\n  ')}${scope === null ? '' : `\ncross-browser: ${scope}`}`,
  );
  process.exitCode = 1;
} else if (scope !== null) {
  console.log(
    `cross-browser: ${scope} Nothing failed${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}.`,
  );
} else {
  console.log(
    `cross-browser: OK - Firefox and WebKit both pass${
      skipped.length > 0 ? `, with ${skipped.length} check(s) skipped as listed above` : ''
    }.`,
  );
}
