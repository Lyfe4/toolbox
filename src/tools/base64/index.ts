import { defineTool, eraseTool, ok, type ErasedTool } from '@/features/registry/types';
import { lossLine, lost, notesToJson, type ToolNote } from '@/lib/notes';

import { bytesToText, encodeBase64, readBase64, textToBytes } from './codec';
import { base64Meta } from './meta';
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
  ...base64Meta,

  optionsSchema: base64OptionsSchema,
  defaultOptions: base64DefaultOptions,
  optionFields: base64OptionFields,

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
