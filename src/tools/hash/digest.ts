import { fail, ok, type Bytes, type ToolResult } from '@/features/registry/types';
import { encodeBase64 } from '@/lib/base64';

import { createMd5 } from './md5';

export const HASH_ALGORITHMS = ['md5', 'sha-1', 'sha-256', 'sha-384', 'sha-512'] as const;
export type HashAlgorithm = (typeof HASH_ALGORITHMS)[number];

/**
 * Algorithms that are broken for security purposes.
 *
 * Both have practical collision attacks - MD5 since 2004, SHA-1 since the 2017
 * SHAttered work - so neither may be used for signatures, integrity against an
 * adversary, or anything password-shaped. They remain available because the
 * world is full of MD5 and SHA-1 checksums that still need checking, and the
 * UI marks them accordingly rather than hiding them.
 */
export const BROKEN_ALGORITHMS: readonly HashAlgorithm[] = ['md5', 'sha-1'];

export function isBroken(algorithm: HashAlgorithm): boolean {
  return BROKEN_ALGORITHMS.includes(algorithm);
}

/** Digest length in bytes, used for output-size hints. */
export const DIGEST_BYTES: Record<HashAlgorithm, number> = {
  md5: 16,
  'sha-1': 20,
  'sha-256': 32,
  'sha-384': 48,
  'sha-512': 64,
};

/** WebCrypto's spelling of the SHA family. MD5 is not among them. */
const SUBTLE_NAMES: Partial<Record<HashAlgorithm, string>> = {
  'sha-1': 'SHA-1',
  'sha-256': 'SHA-256',
  'sha-384': 'SHA-384',
  'sha-512': 'SHA-512',
};

/**
 * Hashes a sequence of chunks.
 *
 * MD5 is streamed: each chunk is folded into the running state and never
 * retained, so a large input costs no extra memory.
 *
 * The SHA family cannot be streamed. WebCrypto's `crypto.subtle.digest` is
 * one-shot - there is no incremental digest API on the platform - so the
 * chunks have to be joined first. That is a limitation of the Web Crypto spec,
 * not of this tool, and it is why the fast path only exists for MD5. The
 * alternative would be shipping our own SHA implementations, which would be
 * both slower and far more security-sensitive code to own.
 */
export async function digestChunks(
  algorithm: HashAlgorithm,
  chunks: Iterable<Uint8Array>,
): Promise<ToolResult<Bytes>> {
  if (algorithm === 'md5') {
    const hasher = createMd5();
    for (const chunk of chunks) hasher.update(chunk);
    return ok(hasher.digest());
  }

  const name = SUBTLE_NAMES[algorithm];
  if (name === undefined) {
    return fail('invalid-input', `Unknown hash algorithm "${algorithm}".`);
  }

  // `crypto.subtle` is typed as always present, but it is genuinely absent
  // outside a secure context, so this is a runtime guard the types do not model.
  /*
   * The DOM types declare `crypto.subtle` as always present. It is not: outside
   * a secure context it is genuinely undefined. Widening the type here is the
   * honest way to say "the platform can lie about this" without suppressing a
   * rule that is right in every other case.
   */
  const subtle = globalThis.crypto.subtle as SubtleCrypto | undefined;
  if (subtle === undefined) {
    return fail('internal', 'WebCrypto is unavailable, so SHA hashing cannot run here.', {
      detail: 'This usually means the page is not in a secure context.',
    });
  }

  const joined = concat(chunks);

  try {
    const buffer = await subtle.digest(name, joined);
    return ok(new Uint8Array(buffer));
  } catch (error) {
    return fail('internal', `Could not compute a ${algorithm} digest.`, {
      detail: error instanceof Error ? error.message : undefined,
    });
  }
}

/** One-shot digest over a single buffer. */
export function digestBytes(
  algorithm: HashAlgorithm,
  bytes: Uint8Array,
): Promise<ToolResult<Bytes>> {
  return digestChunks(algorithm, [bytes]);
}

function concat(chunks: Iterable<Uint8Array>): Bytes {
  const list = [...chunks];
  if (list.length === 1 && list[0]) return asOwnedBytes(list[0]);

  const total = list.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of list) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Copies only when the view is not already backed by a plain ArrayBuffer. */
function asOwnedBytes(chunk: Uint8Array): Bytes {
  if (chunk.buffer instanceof ArrayBuffer && chunk.byteOffset === 0) {
    return chunk as Bytes;
  }
  const copy = new Uint8Array(chunk.length);
  copy.set(chunk);
  return copy;
}

export type DigestEncoding = 'hex' | 'base64';
export type DigestCase = 'lower' | 'upper';

const HEX = '0123456789abcdef';

export function toHex(bytes: Uint8Array, digestCase: DigestCase): string {
  let out = '';
  for (const byte of bytes) {
    out += HEX.charAt(byte >> 4) + HEX.charAt(byte & 15);
  }
  return digestCase === 'upper' ? out.toUpperCase() : out;
}

export function formatDigest(
  bytes: Uint8Array,
  encoding: DigestEncoding,
  digestCase: DigestCase,
): string {
  if (encoding === 'hex') return toHex(bytes, digestCase);

  const base64 = encodeBase64(bytes, { urlSafe: false, padding: true, wrapAt: 0 });
  // Case-folding base64 would corrupt it, so the case option only applies to
  // hex. Returned unchanged rather than silently mangled.
  return base64;
}
