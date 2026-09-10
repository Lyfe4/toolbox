import {
  defineTool,
  eraseTool,
  ok,
  type ErasedTool,
  type JsonValue,
} from '@/features/registry/types';
import { formatBytes } from '@/lib/sniff';

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
export const videoRemuxTool = defineTool({
  id: 'video-remux',
  name: 'Video',
  summary: 'Repackage a video into an MP4 without re-encoding it, or extract its audio.',
  category: 'encoding',

  inputs: [
    {
      id: 'input',
      label: 'Video',
      types: ['bytes'],
      required: true,
      description: 'An MP4, MOV, M4V, 3GP or Matroska file. The container is read from the bytes.',
    },
  ],

  outputs: [
    {
      id: 'output',
      // 'Repackaged' rather than 'Converted': nothing was converted, and the
      // one word that could mislead somebody about what this tool did is the
      // one word every other converter here uses.
      label: 'Repackaged',
      types: ['bytes'],
      description: 'The same compressed frames in a new container, byte for byte.',
    },
    {
      id: 'report',
      label: 'Report',
      types: ['json'],
      description: 'What travelled, what did not, and the streams before and after.',
      /*
       * The same bargain the image tool strikes. Everything in `notes` is a
       * change to the file the user did not ask for - a dropped subtitle
       * track, a second language left behind, the location a phone recorded -
       * and a caveat rendered as `JSON.stringify` two panels down has not been
       * said. See ReportView.
       */
      presentation: 'report',
    },
  ],

  optionsSchema: videoOptionsSchema,
  defaultOptions: videoDefaultOptions,
  optionFields: videoOptionFields,

  execution: {
    strategy: 'worker',
    requiresOffscreenCanvas: false,
    reportsProgress: false,
    /*
     * Thirty seconds, against a measured fraction of one.
     *
     * The work is parsing an index and copying bytes, both linear in the size
     * of the file, so the honest budget is "enough for the largest input this
     * tool accepts, several times over". The engine's guarantee is at most
     * this long waiting and then this long running, so the real worst case a
     * user can see is a minute.
     */
    timeoutMs: 30_000,
    /*
     * 256 MB, which is four times the largest limit in the set, and the number
     * is a memory decision rather than a video one.
     *
     * A run holds the input three times over: the page keeps the chosen file's
     * bytes for the session, the worker gets a structured clone of them
     * because inputs are borrowed rather than transferred, and the output is
     * built beside that clone. So the peak is about three times the input, and
     * 256 MB is where that stops being something a laptop shrugs at.
     *
     * WHAT THAT MEANS IN PRACTICE, said here because it is the tool's most
     * important limitation: about four minutes of 1080p phone video fits, and
     * a feature-length film does not. The files people most want to repackage
     * are two-gigabyte films, and no browser tool can hold one of those in
     * memory - not this one, and not a WASM ffmpeg either, whose own heap
     * ceiling is 2 GiB before the file is counted. Doing those needs the input
     * streamed from disk in pieces and the output written out in pieces, which
     * is a change to the execution engine's value model rather than to this
     * tool. See the README.
     */
    maxInputBytes: 256 * 1024 * 1024,
  },

  run: ({ inputs, options }) => {
    const converted = remux(inputs.input.bytes, options.operation);
    if (!converted.ok) return converted;

    const result = converted.value;
    const warnings = result.notes.filter((note) => note.level === 'warn').map((note) => note.title);
    const headline = `${result.from.format} → ${result.to.format} · ${formatBytes(result.to.bytes)}`;

    return ok({
      output: {
        type: 'bytes',
        bytes: result.bytes,
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
          })),
        },
      } as const,
    });
  },
});

const erased: ErasedTool = eraseTool(videoRemuxTool);
export default erased;
