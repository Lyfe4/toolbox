import {
  defineStreamingTool,
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
export const videoRemuxTool = defineStreamingTool({
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
      description:
        'MP4, MOV, M4V, 3GP, Matroska (MKV or WebM), an MPEG transport stream (TS, M2TS or MTS) or AVI. The container is read from the bytes, never from the name.',
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
     * Thirty seconds of fixed budget, plus time per megabyte of input.
     *
     * A DEADLINE HAS TO SCALE WITH THE FILE NOW, and that is new. While the
     * ceiling was 256 MB a constant was honest: the work is parsing an index
     * and copying bytes, both linear in the size of the file, and a fraction
     * of a second was the measurement. A four-gigabyte tuner recording is
     * sixteen times that file and is walked several times over - once for the
     * tables, once to measure each stream, once to read each - so a constant
     * that fits a phone clip either strangles a film or is meaningless for the
     * clip.
     *
     * Twenty milliseconds per MiB is 50 MB/s, which is an order of magnitude
     * under the 868-4163 MB/s a windowed read of a blob was measured at, and
     * therefore has room for the parsing between the reads. It gives a phone
     * clip about a minute and a four-gigabyte recording about twenty-three.
     */
    timeoutMs: 30_000,
    timeoutMsPerMiB: 20,
    /*
     * 4 GiB, against 256 MB before this tool read its input through a window.
     *
     * THE OLD NUMBER WAS ABOUT MEMORY AND THIS ONE IS NOT. A run used to hold
     * the input three times over - the page kept the chosen file's bytes for
     * the session, the worker got a structured clone because inputs are
     * borrowed rather than transferred, and the output was built beside that
     * clone - and a transport stream cost a fourth copy, because its frames
     * are not contiguous and had to be gathered before they could be indexed.
     * 256 MB was where three times that stopped being something a laptop
     * shrugs at.
     *
     * None of those copies exists now. The page holds the `File` and not its
     * contents; the worker is handed a blob by reference; the readers walk it
     * in windows; what a transport stream gathers goes to blob storage as it
     * fills; and the output is written the same way. So the limit stopped
     * being a statement about memory and became a statement about what this
     * tool will agree to walk.
     *
     * 4 GiB is chosen from the formats rather than from the machine: AVCHD
     * splits its clips at 2 GB, an OpenDML AVI exists because the format
     * cannot address past 2 GB, and an hour of tuner recording is 2 to 4 GB.
     * That is the size the files this tool exists for actually reach.
     *
     * WHAT STILL HAS A CEILING IS THE ANSWER, not the input - see
     * `MAX_BLOB_BYTES` and `refuseOversizedOutput`. A four-gigabyte recording
     * can have its audio extracted here and cannot be repackaged whole,
     * because a browser will not hand back a two-gigabyte blob; the refusal
     * says so in those terms, before any of it is copied.
     */
    maxInputBytes: 4 * 1024 * 1024 * 1024,
  },

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
          })),
        },
      } as const,
    });
  },
});

const erased: ErasedTool = eraseTool(videoRemuxTool);
export default erased;
