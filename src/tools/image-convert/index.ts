import { defineTool, eraseTool, ok, type ErasedTool } from '@/features/registry/types';
import { formatBytes } from '@/lib/sniff';

import { convertImage, EXTENSION, sizeChangePercent } from './convert';
import { imageDefaultOptions, imageOptionFields, imageOptionsSchema } from './options';

/**
 * The download name, derived from the input's.
 *
 * `.gitignore`.replace(/\.[^.]+$/, '') is the empty string, which produced a
 * download called `.png` - a dotfile on every Unix machine and invisible in
 * most file pickers. An empty filename does the same and is not caught by `??`,
 * because '' is not nullish.
 */
function outputBase(filename: string | null): string {
  const stripped = (filename ?? '').replace(/\.[^.]+$/, '').trim();
  return stripped === '' ? 'image' : stripped;
}

/**
 * Convert an image between PNG, JPEG and WebP.
 *
 * Runs in a worker on `OffscreenCanvas` where the browser has it, and on the
 * main thread where it does not - the choice is made by the engine from
 * `requiresOffscreenCanvas` below, not guessed at inside the tool, because by
 * the time `run` executes it is already too late to change context.
 */
export const imageConvertTool = defineTool({
  id: 'image-convert',
  name: 'Image',
  summary: 'Convert and resize images between PNG, JPEG and WebP.',
  category: 'encoding',

  inputs: [
    {
      id: 'input',
      label: 'Image',
      types: ['bytes'],
      required: true,
      description: 'A PNG, JPEG, GIF or WebP file. The format is read from the bytes.',
    },
  ],

  outputs: [
    { id: 'output', label: 'Converted image', types: ['bytes'] },
    {
      id: 'info',
      label: 'Details',
      types: ['json'],
      description: 'Dimensions and sizes before and after.',
    },
  ],

  optionsSchema: imageOptionsSchema,
  defaultOptions: imageDefaultOptions,
  optionFields: imageOptionFields,

  execution: {
    strategy: 'worker',
    requiresWasm: false,
    wasmModules: [],
    /** Downgrades to the main thread when the browser lacks OffscreenCanvas. */
    requiresOffscreenCanvas: true,
    reportsProgress: false,
    timeoutMs: 60_000,
    // Generous, because a raw camera-sized PNG is genuinely tens of megabytes.
    // The limit that actually protects memory is the pixel cap in convert.ts.
    maxInputBytes: 64 * 1024 * 1024,
  },

  run: async ({ inputs, options }) => {
    const converted = await convertImage({
      bytes: inputs.input.bytes,
      format: options.format,
      quality: options.quality,
      maxEdge: options.maxEdge,
    });
    if (!converted.ok) return converted;

    const result = converted.value;
    const change = sizeChangePercent(result.sourceBytes, result.bytes.byteLength);
    const size = `${formatBytes(result.sourceBytes)} → ${formatBytes(result.bytes.byteLength)} (${change >= 0 ? '+' : ''}${change.toFixed(1)}%)`;
    const warnings = result.notes.filter((note) => note.level === 'warn').map((note) => note.title);

    return ok({
      output: {
        type: 'bytes',
        bytes: result.bytes,
        mediaType: result.mediaType,
        filename: `${outputBase(inputs.input.filename)}.${EXTENSION[result.mediaType]}`,
      } as const,
      info: {
        type: 'json',
        data: {
          from: {
            format: result.sourceMediaType,
            width: result.sourceWidth,
            height: result.sourceHeight,
            bytes: result.sourceBytes,
            size: formatBytes(result.sourceBytes),
            // The measured answer when anything measured it, and the
            // container's declaration otherwise. They differ for every
            // screenshot saved as RGBA that never uses the channel.
            hasAlpha: result.usedAlpha ?? result.header.hasAlpha,
            frames: result.header.frames,
            // Named rather than counted: "EXIF, GPS location" is the answer to
            // the question someone about to share a photograph is asking.
            metadata: result.header.metadata,
          },
          to: {
            format: result.mediaType,
            width: result.width,
            height: result.height,
            bytes: result.bytes.byteLength,
            size: formatBytes(result.bytes.byteLength),
            hasAlpha: result.mediaType !== 'image/jpeg' && result.header.hasAlpha,
            frames: 1,
            /*
             * Not "what we happened to drop" but a promise about every output
             * this tool produces. A canvas re-encode carries pixels and
             * nothing else: no EXIF, no GPS, no timestamps, no ICC profile, no
             * maker notes. `image.test.ts` asserts it byte by byte rather than
             * trusting the sentence.
             */
            metadata: [],
          },
          // Signed, and rounded to one place: "-62.4%" is the number people
          // actually want from a converter.
          changePercent: Number(change.toFixed(1)),
          summary: `${size}${warnings.length > 0 ? ` · ${warnings.join(' · ')}` : ''}`,
          /*
           * The same shape the regex tool uses. Everything here is a change to
           * the image the user did not ask for - transparency flattened, frames
           * dropped, location data removed - and the whole point of listing
           * them is that a converter which hands back a plausible image is
           * believed. The warn-level titles are repeated in `summary` above,
           * because a note nobody scrolls to has not been said.
           */
          notes: result.notes.map((note) => ({
            level: note.level,
            title: note.title,
            body: note.body,
          })),
        },
      } as const,
    });
  },
});

const erased: ErasedTool = eraseTool(imageConvertTool);
export default erased;
