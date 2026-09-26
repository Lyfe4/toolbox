import type { ToolManifestEntry } from '@/features/registry/types';

/**
 * What the rest of the app knows about this tool without loading its code:
 * the manifest imports this file eagerly and `index.ts` spreads it into the
 * definition, so the two cannot disagree. Data only - no import may bring
 * code into the initial bundle (`registry.test.ts` holds that).
 */
export const videoRemuxMeta = {
  id: 'video-remux',
  name: 'Video',
  summary: 'Repackage a video into an MP4 without re-encoding it, or extract its audio.',
  category: 'encoding',
  keywords: [
    'mp4',
    'mkv',
    'mov',
    'webm',
    'matroska',
    'remux',
    'container',
    'm4a',
    'mp3',
    'extract audio',
    'h264',
    'h265',
    'hevc',
    'aac',
    'quicktime',
    'rotate',
  ],

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

  execution: {
    strategy: 'worker',
    requiresOffscreenCanvas: false,
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
} as const satisfies ToolManifestEntry;
