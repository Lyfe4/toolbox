import { fail, ok, type Bytes, type ToolResult } from '@/features/registry/types';
import { sniffBytes } from '@/lib/sniff';

/**
 * Image decoding and re-encoding.
 *
 * DECOMPRESSION BOMBS
 *
 * A 40 kB PNG can decode to a 60000x60000 canvas, which is 14 GB of RGBA. The
 * file size limit the engine enforces is therefore no protection at all: the
 * dangerous number is the pixel count, and it is only knowable after the
 * header is read. So the bitmap's dimensions are checked the moment it exists
 * and before a canvas is allocated, and both a per-axis limit and a total
 * pixel limit are applied - one large axis is as fatal as two medium ones.
 *
 * The format is taken from the magic bytes, never from the declared MIME type.
 * `createImageBitmap` would happily be handed a renamed file; refusing early,
 * by signature, gives a clear message instead of an opaque decode error.
 */

export const OUTPUT_FORMATS = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** Formats we will decode. AVIF and SVG are deliberately absent - see README. */
const DECODABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Neither axis may exceed this. */
export const MAX_DIMENSION = 16_384;

/** And the product of both may not exceed this - 50 megapixels, ~200 MB RGBA. */
export const MAX_PIXELS = 50_000_000;

export const EXTENSION: Record<OutputFormat, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export interface ConvertRequest {
  readonly bytes: Bytes;
  readonly format: OutputFormat;
  /** 0-1. Ignored by PNG, which is lossless. */
  readonly quality: number;
  /** Longest edge after scaling, or 0 to keep the original size. */
  readonly maxEdge: number;
}

export interface ConvertResult {
  readonly bytes: Bytes;
  readonly mediaType: OutputFormat;
  readonly sourceMediaType: string;
  readonly width: number;
  readonly height: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly sourceBytes: number;
}

/**
 * Whether the fast path is available.
 *
 * OffscreenCanvas plus `convertToBlob` is what lets this run in a worker at
 * all; a DOM canvas needs a document. Safari only shipped it in 16.4 and
 * Firefox behind a flag until 105, so the main-thread fallback below is not
 * theoretical.
 */
export function hasOffscreenCanvas(): boolean {
  return typeof OffscreenCanvas !== 'undefined';
}

/**
 * The dimension guard, on its own so it can be tested without a decoder.
 *
 * Both limits matter independently: 60000x100 blows the per-axis limit while
 * staying under the pixel budget, and 8000x8000 does the reverse.
 */
export function checkDimensions(width: number, height: number): ToolResult<null> {
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    return fail(
      'limit-exceeded',
      `That image is ${width.toString()}x${height.toString()}, which is larger than this tool will open.`,
      { detail: `Neither edge may exceed ${MAX_DIMENSION.toLocaleString('en')} pixels.` },
    );
  }

  if (width * height > MAX_PIXELS) {
    return fail(
      'limit-exceeded',
      `That image is ${((width * height) / 1_000_000).toFixed(1)} megapixels, which is larger than this tool will open.`,
      {
        detail: `The limit is ${(MAX_PIXELS / 1_000_000).toString()} megapixels. A small file can decode to an enormous bitmap, so the limit is on pixels rather than on file size.`,
      },
    );
  }

  return ok(null);
}

/** Scaled dimensions that preserve the aspect ratio. */
export function fitDimensions(
  width: number,
  height: number,
  maxEdge: number,
): { readonly width: number; readonly height: number } {
  if (maxEdge <= 0) return { width, height };
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };

  const scale = maxEdge / longest;
  return {
    // At least one pixel: a 4000x1 image scaled to 512 would otherwise round
    // its height to zero, and a zero-height canvas throws.
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Draws a bitmap and encodes it, on whichever canvas this context has.
 *
 * The two branches are genuinely different APIs - `convertToBlob` returns a
 * promise, `toBlob` takes a callback - which is why they are not unified
 * behind one variable.
 */
async function encode(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  format: OutputFormat,
  quality: number,
): Promise<Blob | null> {
  if (hasOffscreenCanvas()) {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) return null;

    // JPEG has no alpha channel. Without this, a transparent PNG converts to
    // JPEG with black where the transparency was, which looks like corruption.
    if (format === 'image/jpeg') {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
    }

    context.drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type: format, quality });
  }

  // Main-thread fallback. Reached only when the engine has downgraded this
  // tool to `strategy: 'main'` because OffscreenCanvas is missing - see
  // `requiresOffscreenCanvas` in the manifest and createDefaultEngine.
  if (typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;

  if (format === 'image/jpeg') {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
  }

  context.drawImage(bitmap, 0, 0, width, height);

  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, format, quality);
  });
}

export async function convertImage(request: ConvertRequest): Promise<ToolResult<ConvertResult>> {
  const sniff = sniffBytes(request.bytes);

  if (sniff.mediaType === null || !DECODABLE.has(sniff.mediaType)) {
    return fail(
      'unsupported-type',
      `That file is ${sniff.label.toLowerCase()}, not an image this tool can read.`,
      {
        detail:
          'Supported input: PNG, JPEG, GIF and WebP. The format is read from the file itself, not its name.',
      },
    );
  }

  let bitmap: ImageBitmap;
  try {
    // A Blob rather than the Uint8Array so the browser decodes from its own
    // copy; the caller's buffer stays valid for a fan-out on the canvas.
    bitmap = await createImageBitmap(new Blob([request.bytes], { type: sniff.mediaType }));
  } catch (error) {
    return fail('parse-error', 'That image could not be decoded.', {
      detail: error instanceof Error ? error.message : undefined,
    });
  }

  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;

  try {
    // Checked the instant the dimensions are knowable, and before a canvas of
    // that size is allocated.
    const withinLimits = checkDimensions(sourceWidth, sourceHeight);
    if (!withinLimits.ok) return withinLimits;

    const { width, height } = fitDimensions(sourceWidth, sourceHeight, request.maxEdge);

    const blob = await encode(bitmap, width, height, request.format, request.quality);
    if (!blob) {
      return fail('internal', 'This browser could not encode that image.', {
        detail: `No 2D canvas was available, or ${request.format} is not supported here.`,
      });
    }

    // Some browsers silently fall back to PNG for a format they cannot encode.
    // Saying so beats handing the user a .webp file that is really a PNG.
    if (blob.type !== request.format) {
      return fail('unsupported-type', `This browser cannot write ${request.format}.`, {
        detail: `It produced ${blob.type || 'an unknown format'} instead.`,
      });
    }

    const encoded = new Uint8Array(await blob.arrayBuffer());

    return ok({
      bytes: encoded,
      mediaType: request.format,
      sourceMediaType: sniff.mediaType,
      width,
      height,
      sourceWidth,
      sourceHeight,
      sourceBytes: request.bytes.byteLength,
    });
  } finally {
    // Bitmaps hold decoded pixels outside the JS heap; the GC will not hurry.
    bitmap.close();
  }
}

/** Signed percentage change in size, e.g. -62.4 for a file that shrank. */
export function sizeChangePercent(before: number, after: number): number {
  if (before === 0) return 0;
  return ((after - before) / before) * 100;
}
