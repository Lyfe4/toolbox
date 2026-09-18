#!/usr/bin/env node
/**
 * Generates the image-resampling oracle: a fixed pattern, downscaled by a
 * reference resampler, committed as expected pixels.
 *
 * WHY THERE WAS NOTHING HERE. `image-convert`'s resize is `drawImage` onto a
 * smaller canvas - the BROWSER's resampler, which no specification pins down.
 * The matrix has carried image resampling as `not verified` since round one for
 * exactly that reason: there is no published answer to compare against, and an
 * expected value written by reading the code would be a test that the file
 * agrees with the module beside it.
 *
 * WHAT MAKES AN ANSWER POSSIBLE ANYWAY. A downscale by an integer factor of a
 * region that is CONSTANT over a wide neighbourhood has one answer, and every
 * reasonable filter gives it: the constant. Box, bilinear, Hamming and Lanczos
 * differ only where the source changes within their support. So the pattern
 * below is built from 64x64 blocks of flat colour, reduced 4x, and the
 * generator MEASURES which output pixels the four filters agree about rather
 * than arguing that they must. Those are the pixels the harness asserts on; the
 * rest are reported as a number.
 *
 * ONE BLOCK IS A ONE-PIXEL CHECKERBOARD, and it is the point of the exercise.
 * Its correct answer is the mean, for any symmetric normalised kernel, and a
 * resampler that POINT-SAMPLES gives black or white instead - an image that
 * looks fine as a thumbnail and is wrong. Whether the four filters really do
 * agree about it is measured like everything else here, not assumed.
 *
 * Regenerate with:
 *
 *     node scripts/generate-resample-oracle.mjs > src/tools/image-convert/spec/resample.json && pnpm format
 *
 * Needs Python 3 with Pillow; nothing at test time does.
 */
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';

const SIZE = 256;
const BLOCK = 64;
const FACTOR = 4;
const OUT = SIZE / FACTOR;

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

function rgbaPng(width, height, at) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    raw[cursor] = 0;
    cursor += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = at(x, y);
      raw[cursor] = r;
      raw[cursor + 1] = g;
      raw[cursor + 2] = b;
      raw[cursor + 3] = a;
      cursor += 4;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ========================================================================== *
 * The pattern
 * ========================================================================== */

/**
 * A 4x4 grid of 64x64 blocks: fourteen flat colours, one one-pixel
 * checkerboard, one two-pixel checkerboard.
 *
 * The colours are fixed literals rather than generated, so the fixture's source
 * image is a thing somebody can read rather than the output of a seed nobody
 * will re-run. Fully opaque throughout: alpha is `usesTransparency`'s subject
 * and it has its own checks, and a partly transparent block would make every
 * comparison here a question about premultiplication instead.
 */
const BLOCKS = [
  [0, 0, 0],
  [255, 255, 255],
  [230, 30, 30],
  [30, 230, 30],
  [30, 30, 230],
  [255, 220, 0],
  [0, 220, 255],
  [220, 0, 220],
  [128, 128, 128],
  [64, 96, 192],
  [192, 96, 64],
  [16, 16, 16],
  [239, 239, 239],
  [90, 160, 90],
  'checker1',
  'checker2',
];

function pixelAt(x, y) {
  const block = BLOCKS[Math.floor(y / BLOCK) * 4 + Math.floor(x / BLOCK)];
  if (block === 'checker1') {
    return (x + y) % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255];
  }
  if (block === 'checker2') {
    return (Math.floor(x / 2) + Math.floor(y / 2)) % 2 === 0
      ? [20, 40, 200, 255]
      : [240, 200, 40, 255];
  }
  return [block[0], block[1], block[2], 255];
}

const source = rgbaPng(SIZE, SIZE, pixelAt);

/* ========================================================================== *
 * Pillow, doing the same downscale four ways
 * ========================================================================== */

const PYTHON = `
import base64, io, json, sys
from PIL import Image
import PIL

request = json.load(sys.stdin)
image = Image.open(io.BytesIO(base64.b64decode(request["source"]))).convert("RGBA")
size = (request["out"], request["out"])

filters = {
    "box": Image.BOX,
    "bilinear": Image.BILINEAR,
    "hamming": Image.HAMMING,
    "lanczos": Image.LANCZOS,
    "nearest": Image.NEAREST,
}

out = {}
for name, how in filters.items():
    resized = image.resize(size, how)
    out[name] = list(resized.tobytes())

json.dump({"library": "Pillow", "version": PIL.__version__, "python": sys.version.split()[0], "planes": out}, sys.stdout)
`;

const pillow = JSON.parse(
  execFileSync('py', ['-3', '-c', PYTHON], {
    input: JSON.stringify({ source: source.toString('base64'), out: OUT }),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  }),
);

const planes = pillow.planes;
for (const [name, plane] of Object.entries(planes)) {
  if (plane.length !== OUT * OUT * 4) {
    throw new Error(
      `${name} came back ${String(plane.length)} bytes, expected ${String(OUT * OUT * 4)}`,
    );
  }
}

/* ========================================================================== *
 * Which pixels the filters agree about
 * ========================================================================== */

/*
 * THE AGREEMENT IS MEASURED, NOT ARGUED.
 *
 * A pixel is "settled" when box, bilinear, Hamming and Lanczos all give the
 * same answer to within one level on every channel. Four filters with four
 * different supports landing on one value is not a coincidence of this
 * pattern - it is what a region constant over a wide neighbourhood forces -
 * and it is the only basis on which a browser's own, unspecified resampler can
 * be held to a number at all.
 *
 * NEAREST is excluded from the agreement on purpose. It is the control: the
 * thing the assertion has to be able to reject.
 */
const AGREEING = ['box', 'bilinear', 'hamming', 'lanczos'];

const settled = [];
let widestAgreement = 0;
for (let index = 0; index < OUT * OUT; index += 1) {
  let spread = 0;
  for (let channel = 0; channel < 3; channel += 1) {
    const values = AGREEING.map((name) => planes[name][index * 4 + channel]);
    spread = Math.max(spread, Math.max(...values) - Math.min(...values));
  }
  if (spread <= 1) settled.push(index);
  else widestAgreement = Math.max(widestAgreement, spread);
}

if (settled.length < OUT * OUT * 0.5) {
  throw new Error(
    `only ${String(settled.length)} of ${String(OUT * OUT)} pixels are settled; the pattern is too busy to be an oracle`,
  );
}

/*
 * AND THE CONTROL HAS TO BE FAR AWAY. If nearest-neighbour were within the
 * tolerance on the settled pixels, the assertion would pass for a resampler
 * that point-samples, which is the failure this whole fixture exists to catch.
 */
let nearestWorst = 0;
for (const index of settled) {
  for (let channel = 0; channel < 3; channel += 1) {
    nearestWorst = Math.max(
      nearestWorst,
      Math.abs(planes.nearest[index * 4 + channel] - planes.box[index * 4 + channel]),
    );
  }
}

if (nearestWorst < 64) {
  throw new Error(
    `nearest-neighbour is only ${String(nearestWorst)} levels from box on the settled pixels; there is nothing for a tolerance to separate`,
  );
}

/* ========================================================================== */

/** The expected image as a PNG, so the fixture is readable and small. */
const expected = rgbaPng(OUT, OUT, (x, y) => {
  const at = (y * OUT + x) * 4;
  return [planes.box[at], planes.box[at + 1], planes.box[at + 2], planes.box[at + 3]];
});

const nearest = rgbaPng(OUT, OUT, (x, y) => {
  const at = (y * OUT + x) * 4;
  return [
    planes.nearest[at],
    planes.nearest[at + 1],
    planes.nearest[at + 2],
    planes.nearest[at + 3],
  ];
});

process.stdout.write(
  `${JSON.stringify(
    {
      generator: 'Pillow, downscaling a fixed pattern by an integer factor',
      reference: `Pillow ${pillow.version} on CPython ${pillow.python}`,
      source: {
        width: SIZE,
        height: SIZE,
        blockSize: BLOCK,
        pngBase64: source.toString('base64'),
      },
      downscale: { factor: FACTOR, width: OUT, height: OUT },
      /** Pillow's BOX result: an exact area average at an integer factor. */
      expectedPngBase64: expected.toString('base64'),
      /** The control: what point-sampling the same pattern gives. */
      nearestPngBase64: nearest.toString('base64'),
      agreement: {
        filters: AGREEING,
        /** Pixel indices where all four filters agree to within one level. */
        settled,
        settledCount: settled.length,
        totalPixels: OUT * OUT,
        /** The widest disagreement among them, on the pixels left out. */
        widestDisagreement: widestAgreement,
        /** How far nearest-neighbour is from box on the settled pixels. */
        nearestWorstOnSettled: nearestWorst,
      },
    },
    null,
    2,
  )}\n`,
);
