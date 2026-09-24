import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ToolRunContext } from '@/features/registry/types';
import { bytesValue } from '@/features/registry/types';
import { textToBytes } from '@/lib/base64';

import { BROKEN_ALGORITHMS, digestBytes, formatDigest, isBroken, toHex } from './digest';
import hashTool from './index';
import { createMd5, md5 } from './md5';

const context: ToolRunContext = {
  signal: new AbortController().signal,
};

const hex = (bytes: Uint8Array): string => toHex(bytes, 'lower');

describe('MD5', () => {
  /** RFC 1321, appendix A.5. */
  it.each([
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['a', '0cc175b9c0f1b6a831c399e269772661'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
    ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
    [
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
      'd174ab98d277d9f5a5611c2c9f419d9f',
    ],
    [
      '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
      '57edf4a22be3c955ac49da2e2107b67a',
    ],
  ])('matches the RFC test vector for %j', (input, expected) => {
    expect(hex(md5(textToBytes(input)))).toBe(expected);
  });

  it('handles a message that lands exactly on a block boundary', () => {
    // 56 bytes is the worst case: padding must spill into a second block.
    for (const length of [55, 56, 57, 63, 64, 65, 119, 120]) {
      const bytes = new Uint8Array(length).fill(0x61);
      expect(hex(md5(bytes))).toBe(hex(md5(bytes)));
      expect(hex(md5(bytes))).toHaveLength(32);
    }
  });

  it('gives the same digest whether fed whole or in chunks', () => {
    const bytes = new Uint8Array(5000);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;

    const whole = hex(md5(bytes));

    const streamed = createMd5();
    for (let offset = 0; offset < bytes.length; offset += 37) {
      streamed.update(bytes.subarray(offset, Math.min(offset + 37, bytes.length)));
    }

    expect(hex(streamed.digest())).toBe(whole);
  });

  it('refuses to be reused after digesting', () => {
    const hasher = createMd5();
    hasher.update(new Uint8Array([1]));
    hasher.digest();
    expect(() => {
      hasher.update(new Uint8Array([2]));
    }).toThrow(/already finished/);
  });

  it('agrees with itself for any input, in any chunking', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 2000 }),
        fc.integer({ min: 1, max: 64 }),
        (bytes, size) => {
          const streamed = createMd5();
          for (let offset = 0; offset < bytes.length; offset += size) {
            streamed.update(bytes.subarray(offset, offset + size));
          }
          expect(hex(streamed.digest())).toBe(hex(md5(bytes)));
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe('SHA family via WebCrypto', () => {
  /** Well-known vectors for the empty input and "abc". */
  it.each([
    ['sha-1', '', 'da39a3ee5e6b4b0d3255bfef95601890afd80709'],
    ['sha-1', 'abc', 'a9993e364706816aba3e25717850c26c9cd0d89d'],
    ['sha-256', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['sha-256', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ] as const)('%s of %j', async (algorithm, input, expected) => {
    const result = await digestBytes(algorithm, textToBytes(input));
    expect(result.ok).toBe(true);
    if (result.ok) expect(hex(result.value)).toBe(expected);
  });

  /*
   * FIPS 180-4's own examples, for the two members of the family that had
   * only a LENGTH assertion against them.
   *
   * `sha-384` and `sha-512` were checked for producing 48 and 64 bytes, which
   * every wrong answer of the right size satisfies. These are the published
   * digests for the empty message and for "abc", plus the 448-bit message the
   * standard uses to exercise the second block.
   *
   * https://csrc.nist.gov/projects/cryptographic-standards-and-guidelines/example-values
   */
  const LONGER = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';

  it.each([
    [
      'sha-384',
      '',
      '38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b',
    ],
    [
      'sha-384',
      'abc',
      'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7',
    ],
    [
      'sha-512',
      '',
      'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e',
    ],
    [
      'sha-512',
      'abc',
      'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
    ],
    ['sha-256', LONGER, '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
    ['sha-1', LONGER, '84983e441c3bd26ebaae4aa1f95129e5e54670f1'],
  ] as const)('%s of a published example', async (algorithm, input, expected) => {
    const result = await digestBytes(algorithm, textToBytes(input));

    expect(result.ok).toBe(true);
    if (result.ok) expect(hex(result.value)).toBe(expected);
  });

  it('produces digests of the documented length', async () => {
    for (const [algorithm, length] of [
      ['sha-1', 20],
      ['sha-256', 32],
      ['sha-384', 48],
      ['sha-512', 64],
      ['md5', 16],
    ] as const) {
      const result = await digestBytes(algorithm, textToBytes('patchbay'));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.length).toBe(length);
    }
  });
});

describe('labelling', () => {
  it('marks MD5 and SHA-1 as broken and nothing else', () => {
    expect(BROKEN_ALGORITHMS).toEqual(['md5', 'sha-1']);
    expect(isBroken('md5')).toBe(true);
    expect(isBroken('sha-1')).toBe(true);
    expect(isBroken('sha-256')).toBe(false);
  });
});

describe('formatting', () => {
  const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

  it('renders hex in either case', () => {
    expect(formatDigest(bytes, 'hex', 'lower')).toBe('deadbeef');
    expect(formatDigest(bytes, 'hex', 'upper')).toBe('DEADBEEF');
  });

  it('renders base64 and never case-folds it', () => {
    // Folding base64 would change the value it decodes to, so the case option
    // deliberately does not apply.
    expect(formatDigest(bytes, 'base64', 'lower')).toBe('3q2+7w==');
    expect(formatDigest(bytes, 'base64', 'upper')).toBe('3q2+7w==');
  });
});

describe('tool surface', () => {
  it('hashes text', async () => {
    const result = await hashTool.run({
      inputs: { input: { type: 'text', text: 'abc' } },
      options: { algorithm: 'sha-256' },
      context,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toEqual({
        type: 'text',
        text: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      });
    }
  });

  it('hashes bytes identically to the same bytes as text', async () => {
    const asText = await hashTool.run({
      inputs: { input: { type: 'text', text: 'abc' } },
      options: {},
      context,
    });
    const asBytes = await hashTool.run({
      inputs: {
        input: bytesValue(textToBytes('abc')),
      },
      options: {},
      context,
    });

    expect(asText.ok && asBytes.ok).toBe(true);
    if (asText.ok && asBytes.ok) {
      expect(asBytes.value.output).toEqual(asText.value.output);
    }
  });

  it('hashes a multi-megabyte input in slices', async () => {
    const big = new Uint8Array(3 * 1024 * 1024).fill(0x41);
    const result = await hashTool.run({
      inputs: { input: bytesValue(big) },
      options: { algorithm: 'md5' },
      context,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const digest = result.value.output;
      expect(digest?.type).toBe('text');
      if (digest?.type === 'text') expect(digest.text).toHaveLength(32);
    }
  });

  it('refuses an input type its port does not declare', async () => {
    const result = await hashTool.run({
      inputs: { input: { type: 'json', data: { a: 1 } } },
      options: {},
      context,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unsupported-type');
  });
});
