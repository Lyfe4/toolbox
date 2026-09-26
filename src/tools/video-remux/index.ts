import {
  defineStreamingTool,
  eraseTool,
  ok,
  type ErasedTool,
  type JsonValue,
} from '@/features/registry/types';
import { formatBytes } from '@/lib/sniff';

import { videoRemuxMeta } from './meta';
import { videoDefaultOptions, videoOptionFields, videoOptionsSchema } from './options';
import { remux, type StreamFacts } from './remux';

/**
 * The download name, derived from the input's.
 *
 * The same rule `image-convert` follows and for the same reason: stripping the
 * extension from `.gitignore` leaves the empty string, which produces a
 * download called `.mp4` - a dotfile on every Unix machine and invisible in
 * most file pickers. An empty name is not caught by `??`, because '' is not
 * nullish.
 */
function outputBase(filename: string | null): string {
  const stripped = (filename ?? '').replace(/\.[^.]+$/, '').trim();
  return stripped === '' ? 'video' : stripped;
}

/** The report's own view of one side, in the shape `ReportView` reads. */
function facts(side: StreamFacts): JsonValue {
  return {
    format: side.format,
    width: side.width,
    height: side.height,
    duration: side.duration,
    frames: side.frames,
    bytes: side.bytes,
    size: formatBytes(side.bytes),
    metadata: [...side.metadata],
  };
}

/**
 * Change a video's container without re-encoding it, or lift its audio out.
 *
 * Runs in the worker like every other binary tool. It has no `OffscreenCanvas`
 * branch and no WASM: both readers and the writer are ordinary TypeScript over
 * a `Uint8Array`, which is what makes a one-minute 1080p clip a fraction of a
 * second's work rather than the four and three quarter minutes the feasibility
 * investigation measured for the same clip re-encoded.
 */
export const videoRemuxTool = defineStreamingTool({
  ...videoRemuxMeta,

  optionsSchema: videoOptionsSchema,
  defaultOptions: videoDefaultOptions,
  optionFields: videoOptionFields,

  run: ({ inputs, options }) => {
    const converted = remux(inputs.input.source, options.operation);
    if (!converted.ok) return converted;

    const result = converted.value;
    const warnings = result.notes.filter((note) => note.level === 'warn').map((note) => note.title);
    const headline = `${result.from.format} → ${result.to.format} · ${formatBytes(result.to.bytes)}`;

    return ok({
      output: {
        type: 'bytes',
        data: result.bytes,
        mediaType: result.mediaType,
        filename: `${outputBase(inputs.input.filename)}.${result.extension}`,
      } as const,
      report: {
        type: 'json',
        data: {
          from: facts(result.from),
          to: facts(result.to),
          // The warn-level titles are repeated here because the summary is the
          // line that reaches the node on the canvas, where nothing else does.
          summary: `${headline}${warnings.length > 0 ? ` · ${warnings.join(' · ')}` : ''}`,
          notes: result.notes.map((note) => ({
            level: note.level,
            title: note.title,
            body: note.body,
            // The remuxed file is the only data port, so a loss is in it. See
            // `lib/notes.ts`, and `notePorts.test.ts` for the check.
            reaches: note.level === 'warn' ? ['output'] : [],
          })),
        },
      } as const,
    });
  },
});

const erased: ErasedTool = eraseTool(videoRemuxTool);
export default erased;
