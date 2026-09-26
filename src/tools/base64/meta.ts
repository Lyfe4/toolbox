import type { ToolManifestEntry } from '@/features/registry/types';

/**
 * What the rest of the app knows about this tool without loading its code:
 * the manifest imports this file eagerly and `index.ts` spreads it into the
 * definition, so the two cannot disagree. Data only - no import may bring
 * code into the initial bundle (`registry.test.ts` holds that).
 */
export const base64Meta = {
  id: 'base64',
  name: 'Base64',
  summary: 'Encode text or files to base64, and decode base64 back to bytes.',
  category: 'encoding',
  keywords: ['b64', 'atob', 'btoa', 'url-safe', 'data uri', 'jwt'],

  inputs: [
    {
      id: 'input',
      label: 'Input',
      // Two admissible types. Because of this, `inputs.input` below is a union
      // and the compiler forces the `.type` check before either payload is read.
      types: ['text', 'bytes'],
      required: true,
      description: 'Text to encode, base64 to decode, or a dropped file.',
    },
  ],

  outputs: [
    {
      id: 'output',
      /*
       * 'Result', where it was 'Output' - and the rename is forced by the port
       * beside it rather than by taste.
       *
       * Every other converter in the set names its first output for the value
       * it carries - 'Converted', 'Digest', 'Decoded' - and this one cannot,
       * because what it carries depends on the mode: base64 text one way,
       * decoded bytes the other. 'Output' was the honest answer to that while
       * this tool had ONE output, because the runner prints a port's label only
       * when there is more than one to tell apart.
       *
       * There are two now, so the label is drawn - under a panel whose heading
       * is the word "Output". Two labels for one value is the exact duplication
       * `ToolRunner.layout.test.tsx` exists to prevent, and it was found by that
       * test rather than by reading this file. 'Result' is mode-neutral for the
       * same reason 'Output' was, and it is the word `regex-tester` already
       * uses for a value whose kind depends on a setting.
       *
       * A LABEL, NOT AN ID. The id is still `output`, so no share link, no
       * saved canvas and no preset changes - see retiredPorts.ts for what a
       * rename of the other kind costs.
       */
      label: 'Result',
      // Encoding produces text; decoding produces bytes. One port, two types.
      types: ['text', 'bytes'],
      description: 'Base64 text when encoding, the decoded bytes when decoding.',
    },
    {
      /*
       * THE ONE THING A DECODE CAN CHANGE ABOUT THE TEXT.
       *
       * `QQ==` and `QR==` both decode to the byte `A`, because the last
       * character's unused bits are ignored rather than required to be zero -
       * which RFC 4648 section 3.5 permits and most decoders do. The bytes are
       * right either way; what is not right is that `base64 -> bytes -> base64`
       * silently returns a DIFFERENT STRING from the one that went in, and the
       * input is usually a signature or a digest somebody is comparing.
       *
       * A second port rather than an error, because nothing is wrong: the
       * decode succeeded and the bytes are correct. It is a fact about the
       * input, and it needed somewhere to be said.
       */
      id: 'report',
      label: 'Report',
      types: ['json'],
      description: 'Anything about the input worth knowing that the output cannot carry.',
      presentation: 'report',
    },
  ],

  execution: {
    // Worker, not main: this accepts files up to 32 MB and encoding one on the
    // main thread would drop frames.
    strategy: 'worker',
    requiresOffscreenCanvas: false,
    timeoutMs: 15_000,
    maxInputBytes: 32 * 1024 * 1024,
  },
} as const satisfies ToolManifestEntry;
