import { fail, ok, type Bytes, type ToolResult } from '@/features/registry/types';
import { positionFromOffset } from '@/lib/textPosition';

/**
 * Base64 encoder and decoder working on bytes.
 *
 * Deliberately not built on btoa/atob. Those operate on "binary strings" where
 * every code unit must be <= 0xFF, so calling btoa on ordinary text throws the
 * moment a non-Latin-1 character appears - the classic broken emoji bug. Going
 * through bytes means text is encoded with TextEncoder first and every code
 * point survives.
 */

const STANDARD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const URL_SAFE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export interface EncodeOptions {
  readonly urlSafe: boolean;
  readonly padding: boolean;
  /** Insert a line break every N characters. 0 disables wrapping. */
  readonly wrapAt: number;
}

/**
 * Lookup table from character code to its 6-bit value.
 *
 * Both alphabets are loaded into one table, and '-'/'_' map to the same values
 * as '+'/'/'. That makes decoding alphabet-agnostic: a URL-safe string decodes
 * without the caller having to say so, which is what people actually expect
 * when they paste a JWT segment in.
 */
const DECODE_TABLE = new Int16Array(128).fill(-1);
for (let index = 0; index < STANDARD_ALPHABET.length; index += 1) {
  DECODE_TABLE[STANDARD_ALPHABET.charCodeAt(index)] = index;
  DECODE_TABLE[URL_SAFE_ALPHABET.charCodeAt(index)] = index;
}

export function encodeBase64(bytes: Uint8Array, options: EncodeOptions): string {
  const alphabet = options.urlSafe ? URL_SAFE_ALPHABET : STANDARD_ALPHABET;
  const parts: string[] = [];

  // Three bytes (24 bits) become four 6-bit characters.
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const triple =
      ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    parts.push(
      alphabet.charAt((triple >> 18) & 63) +
        alphabet.charAt((triple >> 12) & 63) +
        alphabet.charAt((triple >> 6) & 63) +
        alphabet.charAt(triple & 63),
    );
  }

  // The tail is 0, 1 or 2 bytes; each contributes 2 or 3 characters.
  const remaining = bytes.length - index;
  if (remaining === 1) {
    const chunk = (bytes[index] ?? 0) << 16;
    parts.push(alphabet.charAt((chunk >> 18) & 63) + alphabet.charAt((chunk >> 12) & 63));
    if (options.padding) parts.push('==');
  } else if (remaining === 2) {
    const chunk = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8);
    parts.push(
      alphabet.charAt((chunk >> 18) & 63) +
        alphabet.charAt((chunk >> 12) & 63) +
        alphabet.charAt((chunk >> 6) & 63),
    );
    if (options.padding) parts.push('=');
  }

  const encoded = parts.join('');
  return options.wrapAt > 0 ? wrap(encoded, options.wrapAt) : encoded;
}

function wrap(text: string, width: number): string {
  const lines: string[] = [];
  for (let index = 0; index < text.length; index += width) {
    lines.push(text.slice(index, index + width));
  }
  return lines.join('\n');
}

/**
 * Decodes base64, tolerating whitespace, either alphabet, and missing padding.
 *
 * Returns a ToolResult rather than throwing, and points at the exact offending
 * character when the input is malformed.
 */
export function decodeBase64(input: string): ToolResult<Bytes> {
  // Collect the significant characters, remembering where each came from so an
  // error can be reported against the original text the user actually sees.
  const values: number[] = [];
  const offsets: number[] = [];
  let padding = 0;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === undefined) continue;

    // Whitespace is layout, not data: wrapped MIME and PEM blocks are common.
    if (char === '\n' || char === '\r' || char === ' ' || char === '\t') continue;

    if (char === '=') {
      padding += 1;
      if (padding > 2) {
        return fail('parse-error', 'Too much padding: more than two "=" characters.', {
          position: positionFromOffset(input, index),
        });
      }
      continue;
    }

    if (padding > 0) {
      return fail('parse-error', 'Found data after the padding characters.', {
        position: positionFromOffset(input, index),
      });
    }

    const code = char.charCodeAt(0);
    const value = code < 128 ? (DECODE_TABLE[code] ?? -1) : -1;
    if (value < 0) {
      return fail('parse-error', `"${char}" is not a valid base64 character.`, {
        position: positionFromOffset(input, index),
        detail: 'Expected A-Z, a-z, 0-9 and either +/ or -_ for the URL-safe alphabet.',
      });
    }

    values.push(value);
    offsets.push(index);
  }

  // 4 characters carry 3 bytes; a remainder of exactly 1 cannot happen, because
  // a single 6-bit character does not complete even one byte.
  const remainder = values.length % 4;
  if (remainder === 1) {
    return fail('parse-error', 'Truncated base64: one stray character at the end.', {
      position: positionFromOffset(input, offsets[offsets.length - 1] ?? input.length),
      detail: 'Base64 data comes in groups of four characters.',
    });
  }

  const byteLength = Math.floor((values.length * 3) / 4);
  const bytes = new Uint8Array(byteLength);

  let write = 0;
  for (let read = 0; read < values.length; read += 4) {
    const a = values[read] ?? 0;
    const b = values[read + 1] ?? 0;
    const c = values[read + 2] ?? 0;
    const d = values[read + 3] ?? 0;
    const chunk = (a << 18) | (b << 12) | (c << 6) | d;

    if (write < byteLength) bytes[write++] = (chunk >> 16) & 255;
    if (write < byteLength) bytes[write++] = (chunk >> 8) & 255;
    if (write < byteLength) bytes[write++] = chunk & 255;
  }

  return ok(bytes);
}

/** UTF-8 encode. Handles every code point, including astral-plane characters. */
export function textToBytes(text: string): Bytes {
  return new TextEncoder().encode(text);
}

/**
 * UTF-8 decode, non-fatal.
 *
 * Invalid sequences become U+FFFD rather than throwing: decoded base64 is
 * frequently not text at all, and showing replacement characters is more
 * useful than refusing to show anything.
 */
export function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/** Strict UTF-8 decode. Reports whether the bytes really are valid UTF-8. */
export function bytesToTextStrict(bytes: Uint8Array): ToolResult<string> {
  try {
    return ok(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail('parse-error', 'The decoded bytes are not valid UTF-8 text.', {
      detail: 'Download the result instead, or view it as raw bytes.',
    });
  }
}
