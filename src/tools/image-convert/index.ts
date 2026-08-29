import { defineTool, eraseTool, ok, type ErasedTool } from '@/features/registry/types';
import { formatBytes } from '@/lib/sniff';

import { convertImage, EXTENSION, sizeChangePercent } from './convert';
import { imageDefaultOptions, imageOptionFields, imageOptionsSchema } from './options';

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

    const base = inputs.input.filename?.replace(/\.[^.]+$/, '') ?? 'image';

    return ok({
      output: {
        type: 'bytes',
        bytes: result.bytes,
        mediaType: result.mediaType,
        filename: `${base}.${EXTENSION[result.mediaType]}`,
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
          },
          to: {
            format: result.mediaType,
            width: result.width,
            height: result.height,
            bytes: result.bytes.byteLength,
            size: formatBytes(result.bytes.byteLength),
          },
          // Signed, and rounded to one place: "-62.4%" is the number people
          // actually want from a converter.
          changePercent: Number(change.toFixed(1)),
          summary: `${formatBytes(result.sourceBytes)} → ${formatBytes(result.bytes.byteLength)} (${change >= 0 ? '+' : ''}${change.toFixed(1)}%)`,
        },
      } as const,
    });
  },
});

const erased: ErasedTool = eraseTool(imageConvertTool);
export default erased;
