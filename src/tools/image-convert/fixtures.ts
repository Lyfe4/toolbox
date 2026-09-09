/**
 * IMAGE FIXTURES, BUILT RATHER THAN COMMITTED.
 *
 * Every file the image tests use is constructed here, byte by byte, for the
 * same reason the cross-browser harness builds its PNG rather than checking
 * one in: a committed binary is a fixture nobody can read in a diff, and a
 * corrupt one makes a test pass for the wrong reason. Building them also means
 * a test can say "a PNG whose colour type is 3 with a tRNS chunk" and get
 * exactly that, which is not something you can find lying around.
 *
 * WHY THERE IS A DEFLATE IN HERE. `tsconfig.app.json` deliberately has no Node
 * types, so `node:zlib` is unavailable to anything under `src/`. The encoder
 * below emits STORED deflate blocks - BTYPE 00, the literal bytes with a
 * length in front - which is a valid, if pointless, member of the format. The
 * PNGs it writes are real PNGs that a real browser decodes; they are simply
 * larger than they need to be, which no test cares about.
 *
 * These are structural fixtures. Nothing here is a photograph, and nothing
 * here should be used to make a claim about how an image LOOKS: that question
 * needs a decoder and belongs in `scripts/cross-browser-check.mjs`, which runs
 * in engines that have one.
 */

/* ========================================================================== *
 * Deflate and CRC
 * ========================================================================== */

const CRC_TABLE = /* @__PURE__ */ (() =>
  Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  }))();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function u32be(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

export function u32le(value: number): Uint8Array {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
}

export function u16be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

export function u16le(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

export function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) out[index] = text.charCodeAt(index) & 0xff;
  return out;
}

/** A zlib stream of stored deflate blocks. Valid, and deliberately dumb. */
function zlibStored(data: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [];
  const MAX = 0xffff;
  for (let offset = 0; offset < Math.max(data.length, 1); offset += MAX) {
    const slice = data.subarray(offset, offset + MAX);
    const final = offset + MAX >= data.length ? 1 : 0;
    blocks.push(new Uint8Array([final]), u16le(slice.length), u16le(~slice.length & 0xffff), slice);
  }
  return concat([new Uint8Array([0x78, 0x01]), ...blocks, u32be(adler32(data))]);
}

/* ========================================================================== *
 * PNG
 * ========================================================================== */

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = concat([ascii(type), data]);
  return concat([u32be(data.length), body, u32be(crc32(body))]);
}

export const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngOptions {
  readonly width?: number;
  readonly height?: number;
  /** 0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA. */
  readonly colourType?: number;
  /** Inserted between IHDR and IDAT, which is where ancillary chunks live. */
  readonly before?: readonly Uint8Array[];
  /** Pixel bytes, if a decodable image is wanted. Defaults to opaque black. */
  readonly pixels?: (x: number, y: number) => readonly [number, number, number, number];
}

/**
 * A PNG. Real enough for a browser when `pixels` is given, and structurally
 * real always - which is all `inspect.ts` ever looks at.
 */
export function png(options: PngOptions = {}): Uint8Array<ArrayBuffer> {
  const width = options.width ?? 4;
  const height = options.height ?? 4;
  const colourType = options.colourType ?? 6;

  const ihdr = concat([u32be(width), u32be(height), new Uint8Array([8, colourType, 0, 0, 0])]);

  /*
   * NO PIXELS MEANS NO PIXEL BUFFER, and that is load-bearing rather than an
   * optimisation. The bomb fixtures declare 20000x20000 in IHDR, and building
   * a real scanline buffer for one would allocate 1.6 GB inside the test
   * runner - which is the very allocation those tests exist to prove nothing
   * makes. A header-only PNG is structurally valid and deliberately not
   * decodable; every test that uses one asserts the decoder is never reached.
   */
  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : colourType === 4 ? 2 : 1;
  const raw = new Uint8Array(options.pixels ? height * (width * channels + 1) : 0);
  if (options.pixels) {
    let at = 0;
    for (let y = 0; y < height; y += 1) {
      raw[at] = 0;
      at += 1;
      for (let x = 0; x < width; x += 1) {
        const [r, g, b, a] = options.pixels(x, y);
        for (const value of [r, g, b, a].slice(0, channels)) {
          raw[at] = value;
          at += 1;
        }
      }
    }
  }

  return concat([
    PNG_MAGIC,
    pngChunk('IHDR', ihdr),
    ...(options.before ?? []),
    pngChunk('IDAT', zlibStored(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

/* ========================================================================== *
 * EXIF
 * ========================================================================== */

/**
 * A big-endian TIFF block with an Orientation tag and, optionally, a pointer
 * to a GPS IFD.
 *
 * The GPS pointer is the whole point of the GPS half: a photograph from a
 * phone with location services on carries tag 0x8825, and that one tag is what
 * makes an image a privacy problem rather than a picture.
 */
export function exifBlock(
  options: { readonly orientation?: number; readonly gps?: boolean } = {},
): Uint8Array {
  const entries: Uint8Array[] = [];
  const entry = (tag: number, type: number, count: number, value: Uint8Array) =>
    concat([u16be(tag), u16be(type), u32be(count), value]);

  entries.push(entry(0x0112, 3, 1, concat([u16be(options.orientation ?? 1), u16be(0)])));
  // A GPS IFD pointer, pointing at an empty IFD past the end of IFD0.
  if (options.gps) entries.push(entry(0x8825, 4, 1, u32be(8 + 2 + 12 * 2 + 4)));

  return concat([
    ascii('MM'),
    u16be(42),
    u32be(8),
    u16be(entries.length),
    ...entries,
    u32be(0),
    u16be(0),
    u32be(0),
  ]);
}

/* ========================================================================== *
 * JPEG
 * ========================================================================== */

export function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  return concat([new Uint8Array([0xff, marker]), u16be(payload.length + 2), payload]);
}

export interface JpegOptions {
  readonly width?: number;
  readonly height?: number;
  /** Segments inserted between SOI and SOF0. */
  readonly segments?: readonly Uint8Array[];
  /** Which SOFn marker to use. 0xc2 is progressive, 0xc0 baseline. */
  readonly sofMarker?: number;
  /** Omit the start of scan, for a truncated-file test. */
  readonly withoutScan?: boolean;
}

export function jpeg(options: JpegOptions = {}): Uint8Array<ArrayBuffer> {
  const width = options.width ?? 4;
  const height = options.height ?? 4;
  const sof = jpegSegment(
    options.sofMarker ?? 0xc0,
    concat([new Uint8Array([8]), u16be(height), u16be(width), new Uint8Array([1, 1, 0x11, 0])]),
  );

  return concat([
    new Uint8Array([0xff, 0xd8]),
    ...(options.segments ?? []),
    sof,
    ...(options.withoutScan
      ? []
      : [
          jpegSegment(0xda, new Uint8Array([1, 1, 0, 0, 63, 0])),
          new Uint8Array([0x12, 0x34, 0xff, 0xd9]),
        ]),
  ]);
}

/** An APP1 EXIF segment, as a phone camera writes it. */
export function jpegExif(
  options: { readonly orientation?: number; readonly gps?: boolean } = {},
): Uint8Array {
  return jpegSegment(0xe1, concat([ascii('Exif'), new Uint8Array([0, 0]), exifBlock(options)]));
}

/* ========================================================================== *
 * GIF
 * ========================================================================== */

export interface GifFrame {
  readonly left?: number;
  readonly top?: number;
  readonly width: number;
  readonly height: number;
}

export interface GifOptions {
  readonly screenWidth?: number;
  readonly screenHeight?: number;
  readonly frames?: readonly GifFrame[];
  readonly transparent?: boolean;
  readonly comment?: boolean;
}

export function gif(options: GifOptions = {}): Uint8Array<ArrayBuffer> {
  const screenWidth = options.screenWidth ?? 8;
  const screenHeight = options.screenHeight ?? 8;
  const frames = options.frames ?? [{ width: screenWidth, height: screenHeight }];
  const parts: Uint8Array[] = [
    ascii('GIF89a'),
    u16le(screenWidth),
    u16le(screenHeight),
    // Global colour table flag set, two entries.
    new Uint8Array([0x80, 0, 0]),
    new Uint8Array([0, 0, 0, 255, 255, 255]),
  ];

  if (options.comment) {
    parts.push(new Uint8Array([0x21, 0xfe, 0x03]), ascii('hey'), new Uint8Array([0]));
  }

  for (const frame of frames) {
    parts.push(
      // Graphic control extension; bit 0 of the flags byte is transparency.
      new Uint8Array([0x21, 0xf9, 0x04, options.transparent ? 0x01 : 0x00, 0, 0, 0, 0]),
      new Uint8Array([0x2c]),
      u16le(frame.left ?? 0),
      u16le(frame.top ?? 0),
      u16le(frame.width),
      u16le(frame.height),
      new Uint8Array([0]),
      // LZW minimum code size, one empty sub-block, terminator.
      new Uint8Array([0x02, 0x00]),
    );
  }

  parts.push(new Uint8Array([0x3b]));
  return concat(parts);
}

/* ========================================================================== *
 * WebP
 * ========================================================================== */

export function riffChunk(id: string, payload: Uint8Array): Uint8Array {
  const pad = payload.length % 2 === 1 ? new Uint8Array(1) : new Uint8Array(0);
  return concat([ascii(id), u32le(payload.length), payload, pad]);
}

function riff(payload: Uint8Array): Uint8Array<ArrayBuffer> {
  return concat([ascii('RIFF'), u32le(payload.length + 4), ascii('WEBP'), payload]);
}

/** A lossy WebP: a VP8 keyframe whose dimensions live behind the start code. */
export function webpLossy(width = 8, height = 8): Uint8Array<ArrayBuffer> {
  const body = concat([
    new Uint8Array([0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a]),
    u16le(width & 0x3fff),
    u16le(height & 0x3fff),
    new Uint8Array(4),
  ]);
  return riff(riffChunk('VP8 ', body));
}

/** A lossless WebP: 14-bit dimensions and an alpha flag packed into 32 bits. */
export function webpLossless(width = 8, height = 8, alpha = false): Uint8Array<ArrayBuffer> {
  const packed = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14) | (alpha ? 1 << 28 : 0);
  return riff(
    riffChunk('VP8L', concat([new Uint8Array([0x2f]), u32le(packed >>> 0), new Uint8Array(4)])),
  );
}

export interface WebpExtendedOptions {
  readonly width?: number;
  readonly height?: number;
  readonly alpha?: boolean;
  readonly animated?: boolean;
  readonly frames?: number;
  readonly icc?: boolean;
  readonly exif?: boolean;
  readonly xmp?: boolean;
}

/** An extended WebP, whose VP8X flags byte carries every feature it has. */
export function webpExtended(options: WebpExtendedOptions = {}): Uint8Array<ArrayBuffer> {
  const width = options.width ?? 8;
  const height = options.height ?? 8;
  const flags =
    (options.icc ? 0x20 : 0) |
    (options.alpha ? 0x10 : 0) |
    (options.exif ? 0x08 : 0) |
    (options.xmp ? 0x04 : 0) |
    (options.animated ? 0x02 : 0);

  const u24le = (value: number) =>
    new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff]);

  const parts: Uint8Array[] = [
    riffChunk(
      'VP8X',
      concat([new Uint8Array([flags, 0, 0, 0]), u24le(width - 1), u24le(height - 1)]),
    ),
  ];

  if (options.animated) {
    parts.push(riffChunk('ANIM', new Uint8Array([0, 0, 0, 0, 0, 0])));
    for (let index = 0; index < (options.frames ?? 2); index += 1) {
      parts.push(
        riffChunk('ANMF', concat([new Uint8Array(16), riffChunk('VP8 ', new Uint8Array(8))])),
      );
    }
  } else {
    parts.push(riffChunk('VP8 ', new Uint8Array(16)));
  }

  // ICCP belongs immediately after VP8X, before the image data.
  if (options.icc) parts.splice(1, 0, riffChunk('ICCP', new Uint8Array(4)));
  if (options.exif) parts.push(riffChunk('EXIF', exifBlock({ gps: true })));
  if (options.xmp) parts.push(riffChunk('XMP ', ascii('<x/>')));

  return riff(concat(parts));
}
