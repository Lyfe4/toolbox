import { fail, ok, type Bytes, type ToolResult } from '@/features/registry/types';
import { sniffBytes } from '@/lib/sniff';

import { inspectImage, type DecodableType, type ImageHeader } from './inspect';

/**
 * Image decoding and re-encoding.
 *
 * DECOMPRESSION BOMBS, AND WHY THE GUARD MOVED
 *
 * A 40 kB PNG can decode to a 60000x60000 canvas, which is 14 GB of RGBA. The
 * file size limit the engine enforces is therefore no protection at all: the
 * dangerous number is the pixel count.
 *
 * This used to be checked on the DECODED bitmap, before allocating a canvas.
 * That reads as safe and is not. Measured in `pnpm check:browsers`, a 48 kB
 * 20000x20000 PNG decodes SUCCESSFULLY in about two seconds in both Firefox
 * and WebKit - so by the time `bitmap.width` could be read, the browser had
 * already committed 1.6 GB. The canvas was never the expensive allocation.
 *
 * So the limits are now applied to the dimensions in the CONTAINER HEADER,
 * before `createImageBitmap` is called at all. `inspect.ts` reads about forty
 * bytes to get them. The post-decode check is still here as a backstop, for a
 * header that lies and for a format whose header we failed to parse - the
 * header may only ever REFUSE a file, never approve one.
 *
 * The format is taken from the magic bytes, never from the declared MIME type.
 * `createImageBitmap` would happily be handed a renamed file; refusing early,
 * by signature, gives a clear message instead of an opaque decode error.
 */

export const OUTPUT_FORMATS = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** Formats we will decode. AVIF and SVG are deliberately absent - see README. */
const DECODABLE: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/**
 * A type predicate rather than a cast: narrowing the sniffed media type here
 * is what lets `inspectImage` take a union of four literals and exhaust it,
 * instead of taking a string and needing an unreachable default branch.
 */
function isDecodable(mediaType: string): mediaType is DecodableType {
  return DECODABLE.has(mediaType);
}

/** Neither axis may exceed this. */
export const MAX_DIMENSION = 16_384;

/** And the product of both may not exceed this - 50 megapixels, ~200 MB RGBA. */
export const MAX_PIXELS = 50_000_000;

/**
 * What transparency becomes when the target format has none.
 *
 * White rather than black, and not configurable. Black is what an unfilled
 * canvas gives you and it is almost never what anyone wanted - a transparent
 * logo converted to JPEG comes back as a black rectangle with a logo cut into
 * it, which reads as corruption rather than as a choice. White matches every
 * other converter, matches paper, and matches the page most images end up on.
 * The tool says it did this rather than offering a colour picker for it.
 */
export const MATTE_COLOUR = '#ffffff';

export const EXTENSION: Record<OutputFormat, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** A change to the image the user did not ask for and has to be told about. */
export interface ConvertNote {
  readonly level: 'warn' | 'info';
  readonly title: string;
  readonly body: string;
}

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
  readonly header: ImageHeader;
  /**
   * Whether any pixel was really transparent, or null when nothing looked.
   *
   * Only examined when the answer changes what the user is told - that is, a
   * source declaring alpha on its way to a JPEG.
   */
  readonly usedAlpha: boolean | null;
  readonly notes: readonly ConvertNote[];
}

/**
 * A one-line description of something that was thrown, without `instanceof`.
 *
 * The canvas and the decoder both fail with a DOMException, and `instanceof
 * Error` is the wrong question to ask about one. It is true in Firefox, WebKit
 * and Node - and false under jsdom, which is how this was found: the detail on
 * an IndexSizeError silently vanished in the unit suite while looking correct
 * in a browser. It is also false for any error that crossed a realm boundary,
 * which a worker is. Reading the two fields that every error-shaped object has
 * asks the question that was actually meant.
 */
function describeError(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const named = error as { readonly name?: unknown; readonly message?: unknown };
  const name = typeof named.name === 'string' ? named.name : '';
  const message = typeof named.message === 'string' ? named.message : '';
  if (name && message) return `${name}: ${message}`;
  return name || message || undefined;
}

/**
 * Whether the fast path is available.
 *
 * OffscreenCanvas plus `convertToBlob` is what lets this run in a worker at
 * all; a DOM canvas needs a document. Safari only shipped it in 16.4 and
 * Firefox behind a flag until 105, so the main-thread fallback below is not
 * theoretical - Playwright's WebKit, which `pnpm check:browsers` drives, has
 * no OffscreenCanvas at all, so that harness exercises both branches for free.
 */
export function hasOffscreenCanvas(): boolean {
  return typeof OffscreenCanvas !== 'undefined';
}

/**
 * The upper limits, on their own so they can be applied to a header.
 *
 * Both matter independently: 60000x100 blows the per-axis limit while staying
 * under the pixel budget, and 8000x8000 does the reverse.
 *
 * This is the ONLY check applied to header-derived dimensions, and that is
 * deliberate. A parser bug that read a plausible-but-wrong small number would
 * otherwise refuse a file the browser could have opened perfectly well; a
 * header may refuse an image for being too big and may never approve one.
 */
export function checkTooLarge(width: number, height: number): ToolResult<null> {
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
        detail: `The limit is ${(MAX_PIXELS / 1_000_000).toString()} megapixels. A small file can decode to an enormous bitmap, so the limit is on pixels rather than on file size - and resizing cannot help, because the cost is paid decoding the original.`,
      },
    );
  }

  return ok(null);
}

/**
 * The full guard, for dimensions that came from a real decode.
 *
 * The lower bound is not paranoia. A malformed file can decode to a bitmap
 * with a zero axis, and the canvas that follows is not merely useless: in
 * Firefox `convertToBlob` on a 0x0 canvas throws IndexSizeError, and in WebKit
 * `toBlob` hands back null. Neither is a sensible thing to show someone.
 */
export function checkDimensions(width: number, height: number): ToolResult<null> {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return fail('parse-error', 'That image decoded to no pixels.', {
      detail: `The decoder reported ${String(width)}x${String(height)}, which is not an image that can be drawn.`,
    });
  }

  return checkTooLarge(width, height);
}

/** Scaled dimensions that preserve the aspect ratio. Never enlarges. */
export function fitDimensions(
  width: number,
  height: number,
  maxEdge: number,
): { readonly width: number; readonly height: number } {
  if (maxEdge <= 0) return { width, height };
  const longest = Math.max(width, height);
  // Upscaling is not what "longest edge" means to anyone: it is a ceiling, and
  // enlarging invents detail that is not in the file.
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
 * Whether any pixel on the canvas is not fully opaque.
 *
 * The header can only say that the format HAS an alpha channel, and plenty of
 * files carry one without using it - every screenshot saved as RGBA, for one.
 * Warning that transparency was flattened on an image that had none is noise,
 * and noise is how a warning gets ignored on the day it matters. So the claim
 * is made exactly as strong as the evidence, and the evidence costs one
 * readback of a canvas that has already been allocated.
 *
 * Reading at the OUTPUT size rather than the source is not a compromise: a
 * downscale averages any transparent pixel into its neighbours, and an average
 * that includes anything below 255 is itself below 255. Shrinking makes
 * transparency easier to detect, not harder.
 *
 * Returns null if the readback is refused, in which case the header's answer
 * stands - over-warning beats staying quiet.
 */
function usesTransparency(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
): boolean | null {
  try {
    const { data } = context.getImageData(0, 0, width, height);
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] !== 255) return true;
    }
    return false;
  } catch {
    return null;
  }
}

/**
 * Paints the bitmap, and answers whether its transparency was real.
 *
 * The white matte for JPEG is the one thing here that changes pixels, and
 * without it a transparent PNG converts with black where the transparency was,
 * which looks like corruption rather than like a choice.
 *
 * When the source declares alpha the matte goes on with `destination-over`
 * AFTER the draw instead of with a plain fill before it. The result is
 * identical - white behind the image either way - and it leaves a window in
 * which the drawn alpha can still be read. The alternative was drawing twice.
 */
function paint(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  bitmap: ImageBitmap,
  width: number,
  height: number,
  format: OutputFormat,
  declaresAlpha: boolean,
): boolean | null {
  /*
   * Measured as a no-op on both engines the harness drives: a 512px image of
   * 1px stripes downscaled 8x and 16x comes back uniform mid-grey at 'low' and
   * at 'high' alike, so `drawImage` is already area-averaging rather than
   * point-sampling. It is set anyway as insurance on an engine that is not -
   * the failure it prevents is moire in a downscaled screenshot, which is
   * exactly the kind of plausible-looking wrong output nobody reports.
   *
   * `createImageBitmap`'s own resizeQuality: 'high' was measured too and is
   * WORSE here: it rings, giving 122-132 where the correct answer is 127.
   */
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  if (format !== 'image/jpeg') {
    context.drawImage(bitmap, 0, 0, width, height);
    return null;
  }

  if (!declaresAlpha) {
    context.fillStyle = MATTE_COLOUR;
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    return null;
  }

  context.drawImage(bitmap, 0, 0, width, height);
  const used = usesTransparency(context, width, height);
  context.globalCompositeOperation = 'destination-over';
  context.fillStyle = MATTE_COLOUR;
  context.fillRect(0, 0, width, height);
  context.globalCompositeOperation = 'source-over';
  return used;
}

/** What an encode produced, and what it learned on the way. */
interface Encoded {
  readonly blob: Blob | null;
  /** Whether any pixel was actually transparent, or null if not examined. */
  readonly usedAlpha: boolean | null;
}

async function encode(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  format: OutputFormat,
  quality: number,
  declaresAlpha: boolean,
): Promise<Encoded> {
  if (hasOffscreenCanvas()) {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) return { blob: null, usedAlpha: null };

    const usedAlpha = paint(context, bitmap, width, height, format, declaresAlpha);
    return { blob: await canvas.convertToBlob({ type: format, quality }), usedAlpha };
  }

  // Main-thread fallback. Reached only when the engine has downgraded this
  // tool to `strategy: 'main'` because OffscreenCanvas is missing - see
  // `requiresOffscreenCanvas` in the manifest and createDefaultEngine.
  if (typeof document === 'undefined') return { blob: null, usedAlpha: null };

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return { blob: null, usedAlpha: null };

  const usedAlpha = paint(context, bitmap, width, height, format, declaresAlpha);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, format, quality);
  });
  return { blob, usedAlpha };
}

/**
 * Decodes, with EXIF orientation pinned on rather than left to the default.
 *
 * A phone photograph is very often stored sideways with a flag saying which
 * way is up. `imageOrientation` defaults to 'from-image' in the current spec
 * and both Firefox and WebKit honour it - but the option was added because the
 * default USED to be 'none', and an engine still on the old default would
 * produce a sideways photograph with the flag discarded, which is the worst of
 * both. Asking for it explicitly costs nothing and removes the question.
 *
 * The retry exists because an engine that has never heard of the dictionary
 * member rejects with a TypeError, and refusing every image on a browser whose
 * only sin is being old would be a much worse failure than losing a rotation.
 * Only a TypeError retries: a genuinely corrupt file must report its own error
 * rather than being decoded twice.
 */
async function decode(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return createImageBitmap(blob);
  }
}

/**
 * What this conversion is about to change that the user did not ask for.
 *
 * Every one of these is a silent alteration otherwise, and silent is the
 * problem: a converter that hands back a plausible image is believed. The
 * warn-level ones are also folded into the summary line, because a note nobody
 * scrolls to has not been said.
 */
export function buildNotes(
  header: ImageHeader,
  request: ConvertRequest,
  scaled: { readonly width: number; readonly height: number },
  source: { readonly width: number; readonly height: number },
  /** From `usesTransparency`. Null means it was not examined. */
  usedAlpha: boolean | null = null,
): readonly ConvertNote[] {
  const notes: ConvertNote[] = [];

  /*
   * `usedAlpha === false` is the case worth the trouble: a file that declares
   * an alpha channel and never uses one, which is every screenshot saved as
   * RGBA. Warning that its transparency was flattened would be false, and a
   * warning that cries wolf is one nobody reads on the day it is true.
   */
  if (header.hasAlpha && request.format === 'image/jpeg' && usedAlpha !== false) {
    notes.push({
      level: 'warn',
      title: 'Transparency was flattened onto white',
      body: `JPEG has no alpha channel, so every transparent pixel was composited onto ${MATTE_COLOUR}. Convert to PNG or WebP to keep the transparency.`,
    });
  }

  if (header.animated) {
    const count = header.frames;
    notes.push({
      level: 'warn',
      title: 'Only the first frame was kept',
      body:
        count === null
          ? 'The source is animated, and PNG, JPEG and WebP are written here as still images. Every frame after the first was discarded.'
          : `The source has ${count.toString()} frames and the output is a still image, so ${(count - 1).toString()} of them were discarded.`,
    });
  }

  if (header.metadata.length > 0) {
    const carriesLocation = header.metadata.includes('GPS location');
    notes.push({
      level: carriesLocation ? 'warn' : 'info',
      title: carriesLocation ? 'GPS location was removed' : 'Metadata was removed',
      body: `The source carried ${header.metadata.join(', ')}. None of it is in the output - re-encoding through a canvas keeps the pixels and nothing else.`,
    });
  }

  if (request.format === 'image/png') {
    notes.push({
      level: 'info',
      title: 'Quality does not apply to PNG',
      body: 'PNG is lossless, so the quality setting was ignored. Use WebP for a lossless format that is usually smaller, or JPEG for a lossy one.',
    });
  } else if (!header.lossless) {
    notes.push({
      level: 'info',
      title: 'Re-encoding a lossy image costs a generation',
      body: 'The source is already lossily compressed, so this conversion discards detail a second time. Converting from the original is always better than converting a conversion.',
    });
  }

  if (request.maxEdge > 0 && scaled.width === source.width && scaled.height === source.height) {
    notes.push({
      level: 'info',
      title: 'The image was not enlarged',
      body: `Longest edge is a ceiling, not a target: this image's longest edge is already ${Math.max(source.width, source.height).toString()} pixels, below the ${request.maxEdge.toString()} asked for.`,
    });
  }

  return notes;
}

export async function convertImage(request: ConvertRequest): Promise<ToolResult<ConvertResult>> {
  const sniff = sniffBytes(request.bytes);

  if (sniff.mediaType === null || !isDecodable(sniff.mediaType)) {
    return fail(
      'unsupported-type',
      `That file is ${sniff.label.toLowerCase()}, not an image this tool can read.`,
      {
        detail:
          'Supported input: PNG, JPEG, GIF and WebP. The format is read from the file itself, not its name.',
      },
    );
  }

  const header = inspectImage(request.bytes, sniff.mediaType);

  /*
   * THE LIMIT CHECK THAT ACTUALLY PROTECTS ANYTHING.
   *
   * Before `createImageBitmap`, because the decode is what commits the memory.
   * Only when both dimensions were readable, and only ever to refuse - see
   * `checkTooLarge`.
   */
  if (header.width !== null && header.height !== null) {
    const withinLimits = checkTooLarge(header.width, header.height);
    if (!withinLimits.ok) return withinLimits;
  }

  let bitmap: ImageBitmap;
  try {
    // A Blob rather than the Uint8Array so the browser decodes from its own
    // copy; the caller's buffer stays valid for a fan-out on the canvas.
    bitmap = await decode(new Blob([request.bytes], { type: sniff.mediaType }));
  } catch (error) {
    return fail('parse-error', 'That image could not be decoded.', {
      detail: describeError(error),
    });
  }

  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;

  try {
    // The backstop: a header that lied, a header we could not read, and the
    // zero-pixel case a header cannot report at all.
    const withinLimits = checkDimensions(sourceWidth, sourceHeight);
    if (!withinLimits.ok) return withinLimits;

    const { width, height } = fitDimensions(sourceWidth, sourceHeight, request.maxEdge);

    /*
     * The encode is wrapped because every step of it can throw rather than
     * return: `new OffscreenCanvas` on an allocation failure, `convertToBlob`
     * with an EncodingError, and - measured - with IndexSizeError on a canvas
     * with a zero axis in Firefox. A tool that throws across the worker
     * boundary is the one thing the ToolResult type exists to prevent, so a
     * platform exception has to become a result here rather than escaping.
     */
    let encoded: Encoded;
    try {
      encoded = await encode(
        bitmap,
        width,
        height,
        request.format,
        request.quality,
        header.hasAlpha,
      );
    } catch (error) {
      return fail('internal', 'This browser could not encode that image.', {
        detail: describeError(error),
      });
    }

    const blob = encoded.blob;
    if (!blob) {
      return fail('internal', 'This browser could not encode that image.', {
        detail: `No 2D canvas was available, or ${request.format} is not supported here.`,
      });
    }

    // Some browsers silently fall back to PNG for a format they cannot encode.
    // Measured: every unrecognised type - image/gif, image/avif, and outright
    // nonsense - comes back as image/png in both Firefox and WebKit. Saying so
    // beats handing the user a .webp file that is really a PNG.
    if (blob.type !== request.format) {
      return fail('unsupported-type', `This browser cannot write ${request.format}.`, {
        detail: `It produced ${blob.type || 'an unknown format'} instead.`,
      });
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());

    return ok({
      bytes,
      mediaType: request.format,
      sourceMediaType: sniff.mediaType,
      width,
      height,
      sourceWidth,
      sourceHeight,
      sourceBytes: request.bytes.byteLength,
      header,
      usedAlpha: encoded.usedAlpha,
      notes: buildNotes(
        header,
        request,
        { width, height },
        { width: sourceWidth, height: sourceHeight },
        encoded.usedAlpha,
      ),
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
