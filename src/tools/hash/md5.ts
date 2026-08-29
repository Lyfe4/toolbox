import type { Bytes } from '@/features/registry/types';

/**
 * MD5, implemented here because WebCrypto does not offer it.
 *
 * MD5 IS BROKEN for any security purpose. Practical collisions have been
 * public since 2004 and chosen-prefix collisions since 2009, so it must never
 * be used for signatures, integrity against an adversary, or password
 * handling. It stays available because checksums in the wild - package
 * manifests, S3 ETags, legacy file listings - are still MD5, and being unable
 * to check one is a real gap in a developer toolbox. The UI labels it broken.
 *
 * The implementation is incremental: `update` can be called repeatedly with
 * chunks, so a large input never needs a second full copy in memory. That is
 * the one place this beats WebCrypto, whose digest() is one-shot.
 */

/** Per-round left-rotation amounts. */
const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** K[i] = floor(abs(sin(i + 1)) * 2^32), as the RFC specifies. */
const K = (() => {
  const table = new Uint32Array(64);
  for (let index = 0; index < 64; index += 1) {
    table[index] = Math.floor(Math.abs(Math.sin(index + 1)) * 4294967296);
  }
  return table;
})();

function rotateLeft(value: number, count: number): number {
  return (value << count) | (value >>> (32 - count));
}

export interface Md5Hasher {
  readonly update: (chunk: Uint8Array) => void;
  readonly digest: () => Bytes;
}

export function createMd5(): Md5Hasher {
  // The four 32-bit state words, at their RFC 1321 initial values.
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const block = new Uint8Array(64);
  const words = new Uint32Array(16);
  let blockLength = 0;
  let totalBytes = 0;
  let finished = false;

  function processBlock(): void {
    // MD5 reads its message words little-endian.
    for (let index = 0; index < 16; index += 1) {
      const offset = index * 4;
      words[index] =
        (block[offset] ?? 0) |
        ((block[offset + 1] ?? 0) << 8) |
        ((block[offset + 2] ?? 0) << 16) |
        ((block[offset + 3] ?? 0) << 24);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let g: number;

      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }

      const rotated = (f + a + (K[index] ?? 0) + (words[g] ?? 0)) | 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotateLeft(rotated, SHIFTS[index] ?? 0)) | 0;
    }

    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  return {
    update(chunk) {
      if (finished) throw new Error('MD5 hasher already finished');
      totalBytes += chunk.length;

      let offset = 0;
      while (offset < chunk.length) {
        const take = Math.min(64 - blockLength, chunk.length - offset);
        block.set(chunk.subarray(offset, offset + take), blockLength);
        blockLength += take;
        offset += take;

        if (blockLength === 64) {
          processBlock();
          blockLength = 0;
        }
      }
    },

    digest() {
      finished = true;

      // Padding: a single 1 bit, zeros, then the 64-bit little-endian length.
      const bitLength = totalBytes * 8;
      block[blockLength] = 0x80;
      blockLength += 1;

      if (blockLength > 56) {
        block.fill(0, blockLength);
        processBlock();
        blockLength = 0;
      }
      block.fill(0, blockLength, 56);

      // Length as 64 bits little-endian. Split so that inputs above 512 MB
      // still record the high word correctly rather than overflowing.
      const low = bitLength >>> 0;
      const high = Math.floor(bitLength / 4294967296) >>> 0;
      for (let index = 0; index < 4; index += 1) {
        block[56 + index] = (low >>> (index * 8)) & 0xff;
        block[60 + index] = (high >>> (index * 8)) & 0xff;
      }
      processBlock();

      const out = new Uint8Array(16);
      for (const [index, word] of [a0, b0, c0, d0].entries()) {
        out[index * 4] = word & 0xff;
        out[index * 4 + 1] = (word >>> 8) & 0xff;
        out[index * 4 + 2] = (word >>> 16) & 0xff;
        out[index * 4 + 3] = (word >>> 24) & 0xff;
      }
      return out;
    },
  };
}

/** One-shot convenience over the incremental core. */
export function md5(bytes: Uint8Array): Bytes {
  const hasher = createMd5();
  hasher.update(bytes);
  return hasher.digest();
}
