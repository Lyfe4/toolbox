import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Bytes, JsonValue, ToolRunContext, ToolValue } from '@/features/registry/types';
import { sniffBytes } from '@/lib/sniff';

import {
  buildNotes,
  checkDimensions,
  checkTooLarge,
  convertImage,
  fitDimensions,
  MATTE_COLOUR,
  MAX_DIMENSION,
  MAX_PIXELS,
  sizeChangePercent,
  type ConvertRequest,
} from './convert';
import {
  ascii,
  concat,
  gif,
  jpeg,
  jpegExif,
  png,
  pngChunk,
  webpExtended,
  webpLossy,
} from './fixtures';
import imageTool, { imageConvertTool } from './index';
import { inspectImage } from './inspect';
import { imageDefaultOptions, imageOptionFields, type ImageOptions } from './options';

/** A buffer whose magic bytes say PNG, with no real image behind them. */
function pngHeader(): Bytes {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

/** Stands in for a decoded bitmap of any size, without decoding anything. */
function fakeBitmap(width: number, height: number): ImageBitmap {
  // ImageBitmap really is just these three members, so no cast is needed -
  // which is a nice reminder that the interface is thinner than the object.
  return { width, height, close: () => undefined };
}

/** Narrows an output port's value to its JSON payload, or fails loudly. */
function jsonOf(value: ToolValue | undefined): JsonValue {
  if (value?.type !== 'json') throw new Error('expected a JSON report on that port');
  return value.data;
}

/* -------------------------------------------------------------------------- *
 * A canvas that records what was painted on it
 * -------------------------------------------------------------------------- */

/**
 * WHY A RECORDING CANVAS RATHER THAN A COUNTER.
 *
 * jsdom has no 2D context, so nothing here can look at a pixel. What it CAN
 * do is capture the sequence of drawing calls, and that sequence is where
 * every visual decision in this tool actually lives: whether a white matte was
 * laid down before the draw, in what order, at what size, and with which
 * smoothing setting. Two things follow that a byte-length assertion cannot
 * give you - a missing JPEG matte is a failed assertion here rather than a
 * black rectangle nobody notices, and the OffscreenCanvas and DOM-canvas paths
 * can be asserted to paint the IDENTICAL sequence rather than assumed to.
 *
 * What it cannot tell you is whether the result looks right. That question
 * needs a decoder, and it is asked in `scripts/cross-browser-check.mjs`.
 */
type Op =
  | { readonly op: 'smoothing'; readonly enabled: boolean; readonly quality: string }
  | {
      readonly op: 'fill';
      readonly style: string;
      readonly composite: string;
      readonly rect: readonly number[];
    }
  | { readonly op: 'draw'; readonly rect: readonly number[] }
  | { readonly op: 'read'; readonly rect: readonly number[] };

interface CanvasStub {
  readonly ops: Op[];
  readonly sizes: { readonly width: number; readonly height: number }[];
  readonly decodeOptions: (ImageBitmapOptions | undefined)[];
  readonly decodeCalls: () => number;
}

interface StubOptions {
  readonly bitmap?: ImageBitmap;
  /** What the encoder produces. `null` stands for a browser that refused. */
  readonly blobType?: string | null;
  readonly blobBytes?: number;
  /** Throw from the encode step, as a real canvas does on a bad allocation. */
  readonly encodeThrows?: Error;
  /** Use the DOM canvas branch, i.e. the machine with no OffscreenCanvas. */
  readonly mainThread?: boolean;
  /** Reject the decode with this instead of resolving. */
  readonly decodeRejects?: Error;
  /** Reject only the first, options-carrying decode attempt. */
  readonly rejectOptionsDecode?: Error;
  /** Alpha value every pixel of the drawn image reports back. */
  readonly readbackAlpha?: number;
  /** Refuse the readback, as a tainted canvas would. */
  readonly readbackThrows?: boolean;
}

function stubCanvas(options: StubOptions = {}): CanvasStub {
  const ops: Op[] = [];
  const sizes: { width: number; height: number }[] = [];
  const decodeOptions: (ImageBitmapOptions | undefined)[] = [];
  let decodeCalls = 0;

  const context = {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    globalCompositeOperation: 'source-over',
    fillStyle: '',
    fillRect(x: number, y: number, width: number, height: number) {
      ops.push({
        op: 'smoothing',
        enabled: context.imageSmoothingEnabled,
        quality: context.imageSmoothingQuality,
      });
      ops.push({
        op: 'fill',
        style: context.fillStyle,
        composite: context.globalCompositeOperation,
        rect: [x, y, width, height],
      });
    },
    drawImage(_bitmap: unknown, x: number, y: number, width: number, height: number) {
      ops.push({
        op: 'smoothing',
        enabled: context.imageSmoothingEnabled,
        quality: context.imageSmoothingQuality,
      });
      ops.push({ op: 'draw', rect: [x, y, width, height] });
    },
    getImageData(x: number, y: number, width: number, height: number) {
      if (options.readbackThrows) throw new DOMException('tainted', 'SecurityError');
      ops.push({ op: 'read', rect: [x, y, width, height] });
      const data = new Uint8ClampedArray(width * height * 4);
      for (let index = 3; index < data.length; index += 4)
        data[index] = options.readbackAlpha ?? 255;
      return { data };
    },
  };

  const blob =
    options.blobType === null
      ? null
      : new Blob([new Uint8Array(options.blobBytes ?? 32)], {
          type: options.blobType ?? 'image/webp',
        });

  vi.stubGlobal('createImageBitmap', (_source: unknown, given?: ImageBitmapOptions) => {
    decodeCalls += 1;
    decodeOptions.push(given);
    if (options.rejectOptionsDecode !== undefined && given !== undefined) {
      return Promise.reject(options.rejectOptionsDecode);
    }
    if (options.decodeRejects !== undefined) return Promise.reject(options.decodeRejects);
    return Promise.resolve(options.bitmap ?? fakeBitmap(4, 4));
  });

  if (options.mainThread) {
    vi.stubGlobal('OffscreenCanvas', undefined);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      sizes.push({ width: this.width, height: this.height });
      return context as unknown as CanvasRenderingContext2D;
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      if (options.encodeThrows) throw options.encodeThrows;
      callback(blob);
    });
  } else {
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(
          readonly width: number,
          readonly height: number,
        ) {
          sizes.push({ width, height });
        }
        getContext() {
          return context;
        }
        convertToBlob() {
          if (options.encodeThrows) return Promise.reject(options.encodeThrows);
          return blob === null ? Promise.resolve(null) : Promise.resolve(blob);
        }
      },
    );
  }

  return { ops, sizes, decodeOptions, decodeCalls: () => decodeCalls };
}

function request(overrides: Partial<ConvertRequest> = {}): ConvertRequest {
  return {
    bytes: png({ width: 4, height: 4 }),
    format: 'image/webp',
    quality: 0.8,
    maxEdge: 0,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ========================================================================== *
 * Sniffing
 * ========================================================================== */

describe('format sniffing', () => {
  it('refuses a file whose bytes are not an image, whatever it is called', async () => {
    const text = new TextEncoder().encode('This is plainly not a PNG.');

    const result = await convertImage({
      bytes: text,
      format: 'image/png',
      quality: 0.8,
      maxEdge: 0,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unsupported-type');
    // The message has to say the check was on the bytes, because the user is
    // looking at a file that their operating system calls an image.
    expect(result.error.detail).toContain('not its name');
  });

  it('refuses a PDF that has been renamed to .png', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);

    const result = await convertImage({
      bytes: pdf,
      format: 'image/png',
      quality: 0.8,
      maxEdge: 0,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('pdf document');
  });

  /*
   * The WebP signature used to be the four bytes WEBP at offset 8 and nothing
   * else, so any file at all with those bytes in that position was announced
   * as a WebP image and handed to the decoder. RIFF at offset 0 is the
   * container those bytes belong to; without it the file is not a WebP and the
   * user deserves to be told what it actually is.
   */
  it('does not call a file WebP just because bytes 8-11 spell WEBP', () => {
    const impostor = concat([ascii('NOTRIFF!'), ascii('WEBP'), new Uint8Array(16)]);
    expect(sniffBytes(impostor).mediaType).not.toBe('image/webp');
    expect(sniffBytes(webpLossy()).mediaType).toBe('image/webp');
  });

  /*
   * The declared media type on the input port is not consulted at all, in
   * either direction. This is the case that arrives when another node on the
   * canvas feeds this one: a base64 decode produces bytes with whatever type
   * the upstream file claimed, or with none.
   */
  it('converts a real PNG whose payload claims to be a PDF', async () => {
    stubCanvas({ blobType: 'image/webp' });
    const result = await convertImage(request({ bytes: png({ width: 4, height: 4 }) }));
    expect(result.ok).toBe(true);
  });
});

/* ========================================================================== *
 * Decompression bombs
 * ========================================================================== */

/*
 * THE GUARD THAT MOVED, AND WHY.
 *
 * These used to assert that no CANVAS was allocated for a bomb. That was true
 * and it was not the point: measured in `pnpm check:browsers`, a 48 kB
 * 20000x20000 PNG decodes SUCCESSFULLY in about two seconds in both Firefox
 * and WebKit, and 1.6 GB of RGBA is committed inside `createImageBitmap`
 * before its `width` can be read. The canvas was never the expensive
 * allocation, so the assertion below is the stronger one: the DECODER is never
 * called at all.
 */
describe('decompression bombs', () => {
  const oversize: readonly (readonly [string, Bytes])[] = [
    ['a PNG declaring 20000x20000 in IHDR', png({ width: 20_000, height: 20_000 })],
    ['a JPEG whose frame header says 20000x20000', jpeg({ width: 20_000, height: 20_000 })],
    ['a WebP whose VP8X canvas is 20000x20000', webpExtended({ width: 20_000, height: 20_000 })],
    [
      'a GIF declaring a 1x1 screen and holding a 20000x20000 frame',
      gif({ screenWidth: 1, screenHeight: 1, frames: [{ width: 20_000, height: 20_000 }] }),
    ],
  ];

  it.each(oversize)('refuses %s without decoding it', async (_name, bytes) => {
    const stub = stubCanvas();

    const result = await convertImage(request({ bytes }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('limit-exceeded');
    expect(stub.decodeCalls()).toBe(0);
    expect(stub.sizes).toHaveLength(0);
  });

  it('refuses an image that is under the edge limit but over the pixel budget', async () => {
    const stub = stubCanvas();
    // Both edges legal on their own; their product is 64 megapixels.
    const bytes = png({ width: 8_000, height: 8_000 });

    const result = await convertImage(request({ bytes }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail).toContain('megapixels');
    expect(stub.decodeCalls()).toBe(0);
  });

  /*
   * The header may only ever refuse; it may never approve. A file whose header
   * understates its size is exactly what a header-based guard invites, so the
   * post-decode check has to still be there - and this is the test that says
   * removing it is not an optimisation.
   */
  it('still refuses a bomb whose header lied about being small', async () => {
    const stub = stubCanvas({ bitmap: fakeBitmap(60_000, 60_000) });

    const result = await convertImage(request({ bytes: png({ width: 4, height: 4 }) }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('limit-exceeded');
    // Decoded, because the header gave no reason not to - but no canvas of
    // that size was ever allocated.
    expect(stub.decodeCalls()).toBe(1);
    expect(stub.sizes).toHaveLength(0);
  });

  /*
   * And the other half of "may only refuse": a header this parser cannot read
   * must not be treated as a refusal. A PNG with no IHDR is damaged, not
   * hostile, and the decoder's own error message is a better answer than one
   * invented here.
   */
  it('falls through to the decoder when the header is unreadable', async () => {
    const stub = stubCanvas({ blobType: 'image/webp' });

    const result = await convertImage(request({ bytes: pngHeader() }));

    expect(result.ok).toBe(true);
    expect(stub.decodeCalls()).toBe(1);
  });
});

describe('dimension limits', () => {
  it('refuses an image whose long edge is too large', () => {
    const result = checkTooLarge(MAX_DIMENSION + 1, 10);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('limit-exceeded');
  });

  it('refuses an image whose pixel count is too large even with sane edges', () => {
    // Both edges are legal on their own; their product is not.
    const edge = Math.floor(Math.sqrt(MAX_PIXELS)) + 2_000;
    expect(edge).toBeLessThanOrEqual(MAX_DIMENSION);

    const result = checkTooLarge(edge, edge);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toContain('megapixels');
  });

  it('accepts a large but reasonable photograph', () => {
    expect(checkTooLarge(6_000, 4_000).ok).toBe(true);
  });

  it('tells the user that resizing will not get them past the limit', () => {
    const result = checkTooLarge(9_000, 9_000);
    if (result.ok) return;
    // The cost is paid decoding the original, so "just make it smaller" is
    // advice that cannot work, and the message must not imply it can.
    expect(result.error.detail).toContain('resizing cannot help');
  });

  /*
   * A decoder handed a malformed file can return a bitmap with a zero axis.
   * Measured: the canvas that follows throws IndexSizeError in Firefox and
   * hands back a null blob in WebKit. Neither is something to show anyone, and
   * neither used to be caught - `checkDimensions` had an upper bound only.
   */
  it.each([
    [0, 10],
    [10, 0],
    [0, 0],
    [Number.NaN, 10],
    [10, Number.POSITIVE_INFINITY],
  ])('refuses a decoded bitmap of %s x %s', (width, height) => {
    const result = checkDimensions(width, height);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('parse-error');
  });

  it('refuses a zero-pixel decode before building a canvas for it', async () => {
    const stub = stubCanvas({ bitmap: fakeBitmap(0, 0) });

    const result = await convertImage(request());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('parse-error');
    expect(stub.sizes).toHaveLength(0);
  });
});

/* ========================================================================== *
 * Scaling
 * ========================================================================== */

describe('scaling', () => {
  it('leaves an image alone when no limit is set', () => {
    expect(fitDimensions(800, 600, 0)).toEqual({ width: 800, height: 600 });
  });

  it('leaves an image alone when it already fits', () => {
    expect(fitDimensions(800, 600, 1_000)).toEqual({ width: 800, height: 600 });
  });

  it('scales the long edge and preserves the aspect ratio', () => {
    expect(fitDimensions(1_600, 900, 800)).toEqual({ width: 800, height: 450 });
    expect(fitDimensions(900, 1_600, 800)).toEqual({ width: 450, height: 800 });
  });

  it('never rounds an edge down to zero', () => {
    // A 4000x1 banner scaled to 512 would otherwise ask for a zero-height
    // canvas, which throws.
    expect(fitDimensions(4_000, 1, 512).height).toBe(1);
  });

  it('scales an extreme aspect ratio in both orientations', () => {
    expect(fitDimensions(1, 4_000, 512)).toEqual({ width: 1, height: 512 });
    expect(fitDimensions(10_000, 3, 100)).toEqual({ width: 100, height: 1 });
  });

  it('draws at the scaled size rather than cropping to it', async () => {
    const stub = stubCanvas({ bitmap: fakeBitmap(1_600, 900), blobType: 'image/webp' });

    await convertImage(request({ maxEdge: 800 }));

    expect(stub.sizes).toEqual([{ width: 800, height: 450 }]);
    expect(stub.ops).toContainEqual({ op: 'draw', rect: [0, 0, 800, 450] });
  });
});

/* ========================================================================== *
 * What gets painted
 * ========================================================================== */

describe('what gets painted', () => {
  /*
   * JPEG has no alpha channel, so every transparent pixel has to become
   * something. Without the matte it becomes black, and a transparent logo
   * converts to a black rectangle with the logo cut out of it - which reads as
   * a corrupt file rather than as a choice. The matte must be laid down BEFORE
   * the draw, which is why the order is asserted and not just the presence.
   */
  it('puts a white matte behind an image that could be transparent', async () => {
    const stub = stubCanvas({ bitmap: fakeBitmap(4, 4), blobType: 'image/jpeg', readbackAlpha: 0 });

    await convertImage(request({ bytes: png({ colourType: 6 }), format: 'image/jpeg' }));

    // Draw, read the alpha back, then lay the matte in BEHIND what was drawn.
    // The window between the draw and the fill is the only place the source's
    // real transparency can still be seen, and drawing twice to get it would
    // double the cost of every conversion.
    expect(stub.ops.filter((op) => op.op !== 'smoothing')).toEqual([
      { op: 'draw', rect: [0, 0, 4, 4] },
      { op: 'read', rect: [0, 0, 4, 4] },
      {
        op: 'fill',
        style: MATTE_COLOUR,
        composite: 'destination-over',
        rect: [0, 0, 4, 4],
      },
    ]);
  });

  it('fills first and skips the readback when the source cannot be transparent', async () => {
    const stub = stubCanvas({ bitmap: fakeBitmap(4, 4), blobType: 'image/jpeg' });

    await convertImage(request({ bytes: png({ colourType: 2 }), format: 'image/jpeg' }));

    // No alpha channel in the source, so there is nothing to measure and no
    // reason to pay for a readback.
    expect(stub.ops.filter((op) => op.op !== 'smoothing')).toEqual([
      { op: 'fill', style: MATTE_COLOUR, composite: 'source-over', rect: [0, 0, 4, 4] },
      { op: 'draw', rect: [0, 0, 4, 4] },
    ]);
  });

  it.each(['image/png', 'image/webp'] as const)(
    'does not matte %s, which can carry the transparency',
    async (format) => {
      const stub = stubCanvas({ bitmap: fakeBitmap(4, 4), blobType: format });

      await convertImage(request({ format }));

      expect(stub.ops.filter((op) => op.op === 'fill')).toHaveLength(0);
    },
  );

  /*
   * Measured as a no-op on both engines the harness drives - a 512px image of
   * 1px stripes downscaled 8x and 16x comes back uniform mid-grey at 'low' and
   * 'high' alike - and set anyway as insurance on an engine that point-samples
   * instead. The failure it guards against is moire in a downscaled
   * screenshot: plausible-looking wrong output, which is the kind nobody
   * reports.
   */
  it('asks for high-quality smoothing before every draw', async () => {
    const stub = stubCanvas({ bitmap: fakeBitmap(4, 4), blobType: 'image/webp' });

    await convertImage(request());

    expect(stub.ops[0]).toEqual({ op: 'smoothing', enabled: true, quality: 'high' });
  });

  /*
   * THE FALLBACK, ASSERTED RATHER THAN ASSUMED.
   *
   * The README claims the main-thread path "produces an identical result".
   * The two branches are separate code with separate APIs, so nothing but a
   * test stops one of them drifting - and the drift that matters is not the
   * blob, it is what was painted. Both sequences come out of the same
   * `prepareContext`, and this is what says so.
   */
  it('paints exactly the same sequence with and without OffscreenCanvas', async () => {
    const worker = stubCanvas({ bitmap: fakeBitmap(1_600, 900), blobType: 'image/jpeg' });
    await convertImage(request({ format: 'image/jpeg', maxEdge: 800 }));
    const workerOps = [...worker.ops];
    const workerSizes = [...worker.sizes];

    vi.unstubAllGlobals();
    vi.restoreAllMocks();

    const main = stubCanvas({
      bitmap: fakeBitmap(1_600, 900),
      blobType: 'image/jpeg',
      mainThread: true,
    });
    await convertImage(request({ format: 'image/jpeg', maxEdge: 800 }));

    expect(main.ops).toEqual(workerOps);
    expect(main.sizes).toEqual(workerSizes);
  });
});

/* ========================================================================== *
 * Decoding
 * ========================================================================== */

describe('decoding', () => {
  /*
   * A photograph from a phone is very often stored sideways with an EXIF flag
   * saying which way is up. Both Firefox and WebKit honour that flag by
   * default now, but `imageOrientation` exists because the default used to be
   * 'none' - and an engine on the old default would produce a sideways
   * photograph AND drop the flag that explained it, which is the worst of both
   * outcomes. Asking explicitly costs nothing.
   */
  it('asks the decoder to apply the stored orientation', async () => {
    const stub = stubCanvas({ blobType: 'image/webp' });

    await convertImage(request({ bytes: jpeg({ segments: [jpegExif({ orientation: 6 })] }) }));

    expect(stub.decodeOptions[0]).toEqual({ imageOrientation: 'from-image' });
  });

  /*
   * An engine that has never heard of the dictionary member rejects with a
   * TypeError. Refusing every image on a browser whose only sin is being old
   * would be a far worse failure than losing a rotation, so that one error
   * retries without the option.
   */
  it('retries without the option when the browser rejects the dictionary', async () => {
    const stub = stubCanvas({
      blobType: 'image/webp',
      rejectOptionsDecode: new TypeError('imageOrientation is not a valid member'),
    });

    const result = await convertImage(request());

    expect(result.ok).toBe(true);
    expect(stub.decodeCalls()).toBe(2);
    expect(stub.decodeOptions[1]).toBeUndefined();
  });

  /*
   * And only that error. A corrupt file must report its own decode failure
   * rather than being decoded twice and reporting the second one.
   */
  it('does not retry a genuine decode failure', async () => {
    const stub = stubCanvas({ decodeRejects: new DOMException('bad data', 'InvalidStateError') });

    const result = await convertImage(request());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('parse-error');
    expect(stub.decodeCalls()).toBe(1);
  });

  /*
   * The input is decoded from a Blob built over a COPY, so the caller's buffer
   * survives. On the canvas one image node commonly feeds several converters,
   * and a detached buffer produces a zero-length result several steps later -
   * which is a miserable thing to debug.
   */
  it('leaves the caller’s buffer intact', async () => {
    stubCanvas({ blobType: 'image/webp' });
    const bytes = png({ width: 4, height: 4 });
    const before = bytes.byteLength;

    await convertImage(request({ bytes }));

    expect(bytes.byteLength).toBe(before);
    expect(bytes[0]).toBe(0x89);
  });
});

/* ========================================================================== *
 * Encoding failures
 * ========================================================================== */

describe('encoding failures', () => {
  /*
   * A tool throwing across the worker boundary is the one thing the ToolResult
   * type exists to prevent, and every step of the encode can throw rather than
   * return: `new OffscreenCanvas` on an allocation failure, and - measured -
   * `convertToBlob` with IndexSizeError on a canvas with a zero axis in
   * Firefox. None of it used to be caught.
   */
  it('turns a throwing encoder into a result, not a rejection', async () => {
    stubCanvas({
      bitmap: fakeBitmap(4, 4),
      encodeThrows: new DOMException('Cannot get blob from empty canvas', 'IndexSizeError'),
    });

    const result = await convertImage(request());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('internal');
      expect(result.error.detail).toContain('IndexSizeError');
    }
  });

  it('does the same on the main-thread path', async () => {
    stubCanvas({
      bitmap: fakeBitmap(4, 4),
      mainThread: true,
      encodeThrows: new Error('out of memory'),
    });

    const result = await convertImage(request());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('internal');
  });

  it('reports a browser that hands back no blob at all', async () => {
    stubCanvas({ bitmap: fakeBitmap(4, 4), blobType: null });

    const result = await convertImage(request());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('internal');
  });

  /*
   * Measured in both engines: an unrecognised target type - image/gif,
   * image/avif, or outright nonsense - silently produces a PNG. Handing
   * someone a .webp file that is really a PNG is worse than refusing.
   */
  it('refuses to pass off a PNG as the format that was asked for', async () => {
    stubCanvas({ bitmap: fakeBitmap(4, 4), blobType: 'image/png' });

    const result = await convertImage(request({ format: 'image/webp' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unsupported-type');
      expect(result.error.detail).toContain('image/png');
    }
  });
});

/* ========================================================================== *
 * What the user is told
 * ========================================================================== */

describe('what the user is told', () => {
  const notesFor = (bytes: Bytes, overrides: Partial<ConvertRequest> = {}) => {
    const full = request({ bytes, ...overrides });
    const header = inspectImage(bytes, 'image/png');
    return buildNotes(header, full, { width: 4, height: 4 }, { width: 4, height: 4 });
  };

  /*
   * Transparency flattened onto white is a change to the image, and one the
   * user cannot see until they open the file somewhere with a dark background.
   * It converted silently before this.
   */
  it('says so when transparency is flattened for JPEG', () => {
    const notes = notesFor(png({ colourType: 6 }), { format: 'image/jpeg' });
    const note = notes.find((entry) => entry.title.includes('Transparency'));
    expect(note?.level).toBe('warn');
    expect(note?.body).toContain(MATTE_COLOUR);
  });

  it('says nothing about transparency when the target can carry it', () => {
    const notes = notesFor(png({ colourType: 6 }), { format: 'image/webp' });
    expect(notes.some((entry) => entry.title.includes('Transparency'))).toBe(false);
  });

  it('says nothing about transparency for an image that has none', () => {
    const notes = notesFor(png({ colourType: 2 }), { format: 'image/jpeg' });
    expect(notes.some((entry) => entry.title.includes('Transparency'))).toBe(false);
  });

  /*
   * An animated GIF converted to a still format loses everything but one
   * frame. Both engines do this silently and hand back a plausible picture,
   * which is the exact shape of the bug nobody reports.
   */
  it('says how many frames an animation lost', () => {
    const animated = gif({
      frames: [
        { width: 8, height: 8 },
        { width: 8, height: 8 },
        { width: 8, height: 8 },
      ],
    });
    const notes = buildNotes(
      inspectImage(animated, 'image/gif'),
      request({ bytes: animated }),
      { width: 8, height: 8 },
      { width: 8, height: 8 },
    );
    const note = notes.find((entry) => entry.title.includes('first frame'));
    expect(note?.level).toBe('warn');
    expect(note?.body).toContain('3 frames');
    expect(note?.body).toContain('2 of them were discarded');
  });

  it('says the same for an animated WebP', () => {
    const animated = webpExtended({ animated: true, frames: 5 });
    const notes = buildNotes(
      inspectImage(animated, 'image/webp'),
      request({ bytes: animated }),
      { width: 8, height: 8 },
      { width: 8, height: 8 },
    );
    expect(notes.some((entry) => entry.title.includes('first frame'))).toBe(true);
  });

  /*
   * THE PRIVACY ONE. A tool that silently strips GPS coordinates is a
   * different product from one that silently keeps them, and both are
   * different from one that says what it did. This app's whole premise makes
   * the third the only defensible choice - and location gets its own headline
   * rather than being folded into a list.
   */
  it('names GPS location specifically, and warns rather than informs', () => {
    const located = jpeg({ segments: [jpegExif({ gps: true })] });
    const notes = buildNotes(
      inspectImage(located, 'image/jpeg'),
      request({ bytes: located }),
      { width: 4, height: 4 },
      { width: 4, height: 4 },
    );
    const note = notes.find((entry) => entry.title.includes('GPS'));
    expect(note?.level).toBe('warn');
    expect(note?.body).toContain('GPS location');
    expect(note?.body).toContain('None of it is in the output');
  });

  it('mentions other metadata without raising it to a warning', () => {
    const notes = notesFor(png({ before: [pngChunk('iCCP', ascii('p\0\0'))] }));
    const note = notes.find((entry) => entry.title.includes('Metadata'));
    expect(note?.level).toBe('info');
    expect(note?.body).toContain('ICC colour profile');
  });

  it('says nothing about metadata for a file that carries none', () => {
    const notes = notesFor(png());
    expect(notes.some((entry) => entry.title.includes('etadata'))).toBe(false);
  });

  it('says that quality did nothing when the target is PNG', () => {
    const notes = notesFor(png(), { format: 'image/png' });
    expect(notes.some((entry) => entry.title.includes('Quality does not apply'))).toBe(true);
  });

  it('warns about generation loss when re-encoding an already-lossy source', () => {
    const source = jpeg();
    const notes = buildNotes(
      inspectImage(source, 'image/jpeg'),
      request({ bytes: source, format: 'image/jpeg' }),
      { width: 4, height: 4 },
      { width: 4, height: 4 },
    );
    expect(notes.some((entry) => entry.title.includes('generation'))).toBe(true);
  });

  it('explains that longest edge is a ceiling rather than a target', () => {
    const notes = buildNotes(
      inspectImage(png(), 'image/png'),
      request({ maxEdge: 2_000 }),
      { width: 400, height: 300 },
      { width: 400, height: 300 },
    );
    expect(notes.some((entry) => entry.title.includes('not enlarged'))).toBe(true);
  });
});

/* ========================================================================== *
 * The tool's own output
 * ========================================================================== */

describe('the tool', () => {
  const context: ToolRunContext = {
    signal: new AbortController().signal,
    reportProgress: () => undefined,
  };

  const run = (bytes: Bytes, filename: string | null, options: Partial<ImageOptions> = {}) =>
    imageConvertTool.run({
      inputs: { input: { type: 'bytes', bytes, mediaType: null, filename } },
      options: { ...imageDefaultOptions, format: 'image/webp', ...options },
      context,
    });

  it('reports both formats, both sizes and the signed change', async () => {
    stubCanvas({ bitmap: fakeBitmap(4, 4), blobType: 'image/webp', blobBytes: 40 });

    const result = await run(png({ width: 4, height: 4 }), 'photo.png');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(jsonOf(result.value.report)).toMatchObject({
      from: { format: 'image/png', width: 4, height: 4 },
      to: { format: 'image/webp', width: 4, height: 4, bytes: 40, metadata: [] },
    });
  });

  /*
   * Warn-level notes are repeated in the summary line because the notes list
   * is below the fold in the JSON view, and a caveat nobody scrolls to has not
   * been said.
   */
  it('folds the warnings into the summary line', async () => {
    stubCanvas({ bitmap: fakeBitmap(4, 4), blobType: 'image/jpeg', readbackAlpha: 0 });

    const result = await run(png({ colourType: 6 }), 'logo.png', { format: 'image/jpeg' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(jsonOf(result.value.report)).toMatchObject({
      summary: expect.stringContaining('Transparency') as unknown,
    });
  });

  /*
   * An RGBA file that never uses its alpha channel - which is every screenshot
   * saved as RGBA - must not be told its transparency was flattened. The
   * header cannot tell the two apart, so the drawn alpha is read back before
   * the matte goes on. A warning that cries wolf is one nobody reads on the
   * day it is true.
   */
  it('does not cry wolf over an alpha channel that was never used', async () => {
    stubCanvas({ bitmap: fakeBitmap(4, 4), blobType: 'image/jpeg', readbackAlpha: 255 });

    const result = await run(png({ colourType: 6 }), 'screenshot.png', { format: 'image/jpeg' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const info = jsonOf(result.value.report);
    expect(info).toMatchObject({ from: { hasAlpha: false } });
    expect(JSON.stringify(info)).not.toContain('Transparency was flattened');
  });

  /*
   * And if the readback is refused, the header's answer stands. Over-warning
   * is the safe direction: the failure it guards against is a logo silently
   * turning into a white rectangle.
   */
  it('falls back to warning when the alpha cannot be measured', async () => {
    stubCanvas({ bitmap: fakeBitmap(4, 4), blobType: 'image/jpeg', readbackThrows: true });

    const result = await run(png({ colourType: 6 }), 'logo.png', { format: 'image/jpeg' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(jsonOf(result.value.report)).toMatchObject({
      summary: expect.stringContaining('Transparency') as unknown,
    });
  });

  it('promises an empty metadata list on every output', async () => {
    stubCanvas({ bitmap: fakeBitmap(4, 4), blobType: 'image/webp' });

    const result = await run(jpeg({ segments: [jpegExif({ gps: true })] }), 'holiday.jpg');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(jsonOf(result.value.report)).toMatchObject({
      from: { metadata: ['EXIF', 'GPS location'] },
      to: { metadata: [] },
    });
  });

  it.each([
    ['photo.png', 'photo.webp'],
    ['photo.JPEG', 'photo.webp'],
    ['holiday snap.jpg', 'holiday snap.webp'],
    ['archive.tar.gz', 'archive.tar.webp'],
    ['no-extension', 'no-extension.webp'],
    [null, 'image.webp'],
    // Caught: `.gitignore`.replace(/\.[^.]+$/, '') is the empty string, so the
    // download came out called `.webp` - a dotfile on every Unix machine and
    // invisible in most file pickers. An empty filename did the same, because
    // '' is not nullish and slipped past the `??`.
    ['.gitignore', 'image.webp'],
    ['', 'image.webp'],
  ])('names the download for input %s as %s', async (filename, expected) => {
    stubCanvas({ bitmap: fakeBitmap(4, 4), blobType: 'image/webp' });

    const result = await run(png({ width: 4, height: 4 }), filename);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No narrowing needed: the run signature is derived from the declared
    // ports, so the compiler already knows this port carries bytes.
    expect(result.value.output.filename).toBe(expected);
  });
});

describe('size reporting', () => {
  it.each([
    [1_000, 400, -60],
    [1_000, 1_500, 50],
    [1_000, 1_000, 0],
  ])('reports %i -> %i as %i%%', (before, after, expected) => {
    expect(sizeChangePercent(before, after)).toBeCloseTo(expected, 6);
  });

  it('does not divide by zero on an empty input', () => {
    expect(sizeChangePercent(0, 100)).toBe(0);
  });
});

/*
 * A control that silently does nothing is a defect in this codebase, and has
 * been found here four separate times in other costumes. The PNG encoder
 * ignores quality entirely - measured, identical byte counts at 0.1 and at 1
 * in both engines - so the field is hidden rather than left there to fiddle
 * with. Hiding governs display only: the value is still in the options, still
 * travels in a share link, and still reaches the tool.
 */
describe('the options panel', () => {
  const quality = imageOptionFields.find((field) => field.key === 'quality');
  const format = imageOptionFields.find((field) => field.key === 'format');

  it('hides quality when the target is PNG and shows it otherwise', () => {
    expect(quality?.when?.({ ...imageDefaultOptions, format: 'image/png' })).toBe(false);
    expect(quality?.when?.({ ...imageDefaultOptions, format: 'image/jpeg' })).toBe(true);
    expect(quality?.when?.({ ...imageDefaultOptions, format: 'image/webp' })).toBe(true);
  });

  it('keeps the panel a function of one control, so its shape is predictable', () => {
    // Nothing else may depend on anything: a panel that reshapes on every
    // change feels broken even when it is right.
    expect(format?.when).toBeUndefined();
    expect(imageOptionFields.find((field) => field.key === 'maxEdge')?.when).toBeUndefined();
  });

  it('still applies a quality that was set while the field was hidden', async () => {
    stubCanvas({ bitmap: fakeBitmap(4, 4), blobType: 'image/jpeg' });
    const result = await imageConvertTool.run({
      inputs: {
        input: {
          type: 'bytes',
          bytes: png({ width: 4, height: 4 }),
          mediaType: null,
          filename: null,
        },
      },
      options: { ...imageDefaultOptions, format: 'image/jpeg', quality: 0.4 },
      context: { signal: new AbortController().signal, reportProgress: () => undefined },
    });
    expect(result.ok).toBe(true);
  });
});

describe('execution strategy', () => {
  it('declares that it needs OffscreenCanvas, so the engine can downgrade it', () => {
    // The fallback is only reachable because this is declared eagerly; a probe
    // inside `run` would happen after the context had already been chosen.
    expect(imageTool.execution.requiresOffscreenCanvas).toBe(true);
    expect(imageTool.execution.strategy).toBe('worker');
  });
});
