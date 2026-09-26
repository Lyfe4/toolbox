import { defineTool, eraseTool, ok, type ErasedTool } from '@/features/registry/types';
import { textToBytes } from '@/lib/base64';

import { digestChunks, formatDigest, isBroken } from './digest';
import { hashMeta } from './meta';
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
  ...hashMeta,

  optionsSchema: hashOptionsSchema,
  defaultOptions: hashDefaultOptions,
  optionFields: hashOptionFields,

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
