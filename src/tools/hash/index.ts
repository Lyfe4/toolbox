import { defineTool, eraseTool, ok, type ErasedTool } from '@/features/registry/types';
import { textToBytes } from '@/lib/base64';

import { digestChunks, formatDigest, isBroken } from './digest';
import { hashDefaultOptions, hashOptionFields, hashOptionsSchema } from './options';

/** 1 MB slices, so MD5 folds a large input in without a second copy. */
const CHUNK_SIZE = 1024 * 1024;

function* sliceOf(bytes: Uint8Array): Generator<Uint8Array> {
  if (bytes.length <= CHUNK_SIZE) {
    yield bytes;
    return;
  }
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    yield bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, bytes.length));
  }
}

/**
 * Hash text or bytes.
 *
 * Exists to make the canvas genuinely useful rather than a demo: a file can be
 * decoded from base64 and fingerprinted, or a CSV converted to JSON and
 * fingerprinted, in one pipeline.
 */
export const hashTool = defineTool({
  id: 'hash',
  name: 'Hash',
  summary: 'MD5, SHA-1, SHA-256, SHA-384 and SHA-512 digests of text or files.',
  category: 'hashing',

  inputs: [
    {
      id: 'input',
      label: 'Input',
      types: ['text', 'bytes'],
      required: true,
      description: 'Text or a file to fingerprint.',
    },
  ],

  /*
   * `output`, not `digest`, and the rename cost a migration.
   *
   * Every other tool in the set calls its first output `output`, and that
   * ordering is load-bearing: `resultSummary` shows the FIRST declared output
   * on a node because "the first port is the tool's answer and the rest are
   * its working". One tool spelling it differently made that a per-tool lookup
   * instead of a structural fact, and `registry.test.ts` now asserts the
   * convention for every tool at once. The LABEL stays "Digest" - the id is
   * the wiring identity, the label is the human word for the value.
   */
  outputs: [
    {
      id: 'output',
      label: 'Digest',
      types: ['text'],
      description: 'The fingerprint, in the chosen encoding and case.',
    },
  ],

  optionsSchema: hashOptionsSchema,
  defaultOptions: hashDefaultOptions,
  optionFields: hashOptionFields,

  execution: {
    strategy: 'worker',
    requiresOffscreenCanvas: false,
    reportsProgress: false,
    timeoutMs: 30_000,
    maxInputBytes: 64 * 1024 * 1024,
  },

  run: async ({ inputs, options }) => {
    const { input } = inputs;
    // Text is hashed as UTF-8, which is what every other tool means by "the
    // bytes of this string".
    const bytes = input.type === 'text' ? textToBytes(input.text) : input.bytes;

    const digest = await digestChunks(options.algorithm, sliceOf(bytes));
    if (!digest.ok) return digest;

    const text = formatDigest(digest.value, options.encoding, options.outputCase);
    return ok({ output: { type: 'text', text } as const });
  },
});

export { isBroken };

const erased: ErasedTool = eraseTool(hashTool);
export default erased;
