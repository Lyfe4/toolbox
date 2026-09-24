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

  /*
   * 56 bytes is the worst case: padding must spill into a second block. Until
   * round seventeen this compared md5 with itself and checked the length, so a
   * wrong digest at every boundary passed - the README said these lengths were
   * "tested". The expected digests are another implementation's, run as an
   * oracle and pasted in:
   *
   *   node -e "const c=require('crypto');for(const n of [55,56,57,63,64,65,119,120])
   *     console.log(n,c.createHash('md5').update('a'.repeat(n)).digest('hex'))"
   */
  it.each([
    [55, 'ef1772b6dff9a122358552954ad0df65'],
    [56, '3b0c8ac703f828b04c6c197006d17218'],
    [57, '652b906d60af96844ebd21b674f35e93'],
    [63, 'b06521f39153d618550606be297466d5'],
    [64, '014842d480b571495a4a0363793f7367'],
    [65, 'c743a45e0d2e6a95cb859adae0248435'],
    [119, '8a7bd0732ed6a28ce75f6dabc90e1613'],
    [120, '5f61c0ccad4cac44c75ff505e1f1e537'],
  ])('agrees with node:crypto on %i bytes, either side of a block boundary', (length, expected) => {
    expect(hex(md5(new Uint8Array(length).fill(0x61)))).toBe(expected);
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
   * digests for the empty message and for "abc", plus - for SHA-1 and SHA-256 -
   * the 448-bit message, and for SHA-384 and SHA-512 the 896-bit one, which is
   * what the standard uses to exercise their second block. Until round
   * seventeen this comment claimed the long message for all four and the two
   * wider ones had none.
   *
   * https://csrc.nist.gov/projects/cryptographic-standards-and-guidelines/example-values
   */
  const LONGER = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
  /** FIPS 180-4's 896-bit message, for the two members with a 1024-bit block. */
  const LONGEST =
    'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu';

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
    [
      'sha-384',
      LONGEST,
      '09330c33f71147e83d192fc782cd1b4753111b173b3b05d22fa08086e3b0f712fcc7c71a557e2db966c3e9fa91746039',
    ],
    [
      'sha-512',
      LONGEST,
      '8e959b75dae313da8cf4f72814fc143f8f7779c6eb9f7fa17299aeadb6889018501d289e4900f7e4331b99dec4b5433ac7d329eeb6dd26545e96e55b874be909',
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
