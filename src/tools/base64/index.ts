import { defineTool, eraseTool, ok, type ErasedTool } from '@/features/registry/types';

import { bytesToText, decodeBase64, encodeBase64, textToBytes } from './codec';
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
      label: 'Output',
      // Encoding produces text; decoding produces bytes. One port, two types.
      types: ['text', 'bytes'],
    },
  ],

  optionsSchema: base64OptionsSchema,
  defaultOptions: base64DefaultOptions,
  optionFields: base64OptionFields,

  execution: {
    // Worker, not main: this accepts files up to 32 MB and encoding one on the
    // main thread would drop frames.
    strategy: 'worker',
    requiresWasm: false,
    wasmModules: [],
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

      return ok({ output: { type: 'text', text: encoded } as const });
    }

    // Decoding. A dropped file is read as UTF-8 first, because base64 arrives
    // as a text file (a .txt, a PEM block) far more often than as raw bytes.
    const source = input.type === 'text' ? input.text : bytesToText(input.bytes);
    const decoded = decodeBase64(source);
    if (!decoded.ok) return decoded;

    return ok({
      output: {
        type: 'bytes',
        bytes: decoded.value,
        // Base64 carries no type information, so nothing is claimed here.
        mediaType: null,
        filename: null,
      } as const,
    });
  },
});

const erased: ErasedTool = eraseTool(base64Tool);
export default erased;
