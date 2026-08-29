/**
 * The base64 tool's codec.
 *
 * The implementation itself lives in `@/lib/base64` because the hash tool
 * renders digests with the same encoder. Re-exported here so the tool reads as
 * a self-contained unit.
 */
export {
  bytesToText,
  bytesToTextStrict,
  decodeBase64,
  encodeBase64,
  textToBytes,
  type EncodeOptions,
} from '@/lib/base64';
