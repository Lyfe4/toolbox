import { defineTool, eraseTool, ok, type ErasedTool } from '@/features/registry/types';
import { lossLine, lost, notesToJson, type ToolNote } from '@/lib/notes';

import { bytesToText, encodeBase64, readBase64, textToBytes } from './codec';
import { base64DefaultOptions, base64OptionFields, base64OptionsSchema } from './options';

/**
 * Base64 encode/decode.
 *
 * This tool exists to prove two things about the type system:
 *
 *   1. The binary path. Its decode output is real bytes, never a string
 *      pretending to be bytes, so a file can go in and a file can come out.
 *   2. The multi-type input path. One port accepts text OR bytes, and the run
 *      function has to narrow on the tag before it can touch the payload.
 */
export const base64Tool = defineTool({
  id: 'base64',
  name: 'Base64',
  summary: 'Encode text or files to base64, and decode base64 back to bytes.',
  category: 'encoding',

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

  optionsSchema: base64OptionsSchema,
  defaultOptions: base64DefaultOptions,
  optionFields: base64OptionFields,

  execution: {
    // Worker, not main: this accepts files up to 32 MB and encoding one on the
    // main thread would drop frames.
    strategy: 'worker',
    requiresOffscreenCanvas: false,
    reportsProgress: false,
    timeoutMs: 15_000,
    maxInputBytes: 32 * 1024 * 1024,
  },

  run: ({ inputs, options }) => {
    const { input } = inputs;

    if (options.mode === 'encode') {
      // Narrowing on the tag. In this branch TypeScript knows `input.text`
      // exists; in the other it knows `input.bytes` does.
      const bytes = input.type === 'text' ? textToBytes(input.text) : input.bytes;

      const encoded = encodeBase64(bytes, {
        urlSafe: options.urlSafe,
        padding: options.padding,
        wrapAt: options.wrapAt,
      });

      return ok({
        output: { type: 'text', text: encoded } as const,
        report: {
          type: 'json',
          // Encoding has nothing to report: every byte has exactly one
          // canonical spelling, which is the whole asymmetry between the two
          // directions.
          data: { summary: `${bytes.length.toString()} bytes encoded`, notes: [] },
        } as const,
      });
    }

    // Decoding. A dropped file is read as UTF-8 first, because base64 arrives
    // as a text file (a .txt, a PEM block) far more often than as raw bytes.
    const source = input.type === 'text' ? input.text : bytesToText(input.bytes);
    const decoded = readBase64(source);
    if (!decoded.ok) return decoded;

    const { bytes, report } = decoded.value;
    const notes: ToolNote[] = [];

    if (report.nonCanonicalTail) {
      notes.push(
        lost(
          'The last character was not canonical',
          `It is written "${report.writtenTail ?? ''}" and carries bits no byte of the result uses; the canonical spelling of the same bytes is "${report.canonicalTail ?? ''}". RFC 4648 section 3.5 allows a decoder to ignore those bits and this one does, so the bytes are right - but re-encoding them gives a different string from the one that went in, which matters if you are comparing signatures.`,
          // The decoded bytes. Base64 has one data port, and this loss is in
          // the only thing that leaves it.
          ['output'],
        ),
      );
    }

    const losses = lossLine(notes);

    return ok({
      output: {
        type: 'bytes',
        bytes,
        // Base64 carries no type information, so nothing is claimed here.
        mediaType: null,
        filename: null,
      } as const,
      report: {
        type: 'json',
        data: {
          summary: `${bytes.length.toString()} bytes decoded${losses === null ? '' : ` · ${losses}`}`,
          notes: notesToJson(notes),
        },
      } as const,
    });
  },
});

const erased: ErasedTool = eraseTool(base64Tool);
export default erased;
