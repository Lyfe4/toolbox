import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ToolRunContext } from '@/features/registry/types';

import { bytesToText, decodeBase64, encodeBase64, textToBytes, type EncodeOptions } from './codec';
import base64Tool from './index';

const context: ToolRunContext = {
  signal: new AbortController().signal,
  reportProgress: () => undefined,
};

const DEFAULTS: EncodeOptions = { urlSafe: false, padding: true, wrapAt: 0 };

function enc(text: string, options: Partial<EncodeOptions> = {}): string {
  return encodeBase64(textToBytes(text), { ...DEFAULTS, ...options });
}

function decodeToText(input: string): string {
  const result = decodeBase64(input);
  if (!result.ok) throw new Error(`expected success, got ${result.error.message}`);
  return bytesToText(result.value);
}

describe('encoding', () => {
  it('matches the RFC 4648 test vectors', () => {
    expect(enc('')).toBe('');
    expect(enc('f')).toBe('Zg==');
    expect(enc('fo')).toBe('Zm8=');
    expect(enc('foo')).toBe('Zm9v');
    expect(enc('foob')).toBe('Zm9vYg==');
    expect(enc('fooba')).toBe('Zm9vYmE=');
    expect(enc('foobar')).toBe('Zm9vYmFy');
  });

  it('handles full Unicode, not just Latin-1', () => {
    // btoa throws on every one of these. Going through TextEncoder does not.
    expect(decodeToText(enc('héllo'))).toBe('héllo');
    expect(decodeToText(enc('日本語'))).toBe('日本語');
    expect(decodeToText(enc('🎛️ patch 🎚️'))).toBe('🎛️ patch 🎚️');
    // An astral-plane character is a surrogate pair in UTF-16 and four bytes
    // in UTF-8; both survive.
    expect(decodeToText(enc('𝄞'))).toBe('𝄞');
  });

  it('omits padding when asked', () => {
    expect(enc('f', { padding: false })).toBe('Zg');
    expect(enc('fo', { padding: false })).toBe('Zm8');
    expect(enc('foo', { padding: false })).toBe('Zm9v');
  });

  it('uses the URL-safe alphabet when asked', () => {
    const bytes = new Uint8Array([251, 255, 190]);
    expect(encodeBase64(bytes, DEFAULTS)).toBe('+/++');
    expect(encodeBase64(bytes, { ...DEFAULTS, urlSafe: true })).toBe('-_--');
  });

  it('wraps at the requested column', () => {
    const wrapped = encodeBase64(new Uint8Array(48), { ...DEFAULTS, wrapAt: 16 });
    expect(wrapped.split('\n').every((line) => line.length <= 16)).toBe(true);
    expect(wrapped.split('\n')).toHaveLength(4);
  });

  it('encodes an empty input to an empty string', () => {
    expect(encodeBase64(new Uint8Array(0), DEFAULTS)).toBe('');
  });

  it('preserves a UTF-8 BOM as data', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    const result = decodeBase64(encodeBase64(withBom, DEFAULTS));
    expect(result.ok).toBe(true);
    if (result.ok) expect(Array.from(result.value)).toEqual([0xef, 0xbb, 0xbf, 0x68, 0x69]);
  });

  it('handles a megabyte without complaint', () => {
    const big = new Uint8Array(1024 * 1024);
    for (let index = 0; index < big.length; index += 1) big[index] = index % 256;

    const encoded = encodeBase64(big, DEFAULTS);
    const decoded = decodeBase64(encoded);

    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.length).toBe(big.length);
      expect(decoded.value[0]).toBe(0);
      expect(decoded.value[big.length - 1]).toBe(big[big.length - 1]);
    }
  });
});

describe('decoding', () => {
  it('ignores whitespace, including CRLF-wrapped blocks', () => {
    expect(decodeToText('Zm9v\r\nYmFy')).toBe('foobar');
    expect(decodeToText('Zm9v YmFy')).toBe('foobar');
    expect(decodeToText('  Zm9vYmFy  ')).toBe('foobar');
    expect(decodeToText('Zm9v\nYm\tFy')).toBe('foobar');
  });

  it('accepts the URL-safe alphabet without being told', () => {
    const result = decodeBase64('-_--');
    expect(result.ok).toBe(true);
    if (result.ok) expect(Array.from(result.value)).toEqual([251, 255, 190]);
  });

  it('accepts missing padding', () => {
    expect(decodeToText('Zg')).toBe('f');
    expect(decodeToText('Zm8')).toBe('fo');
  });

  it('reports an invalid character with its position', () => {
    const result = decodeBase64('Zm9v\nYm*Fy');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('parse-error');
      expect(result.error.message).toContain('"*"');
      // Second line, third character.
      expect(result.error.position).toEqual({ line: 2, column: 3, offset: 7 });
    }
  });

  it('rejects a truncated group', () => {
    const result = decodeBase64('Zm9vY');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('parse-error');
      expect(result.error.message).toContain('Truncated');
    }
  });

  it('rejects data after the padding', () => {
    const result = decodeBase64('Zm8=Zg==');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('after the padding');
  });

  it('rejects excessive padding', () => {
    const result = decodeBase64('Zg===');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('Too much padding');
  });

  it('decodes an empty string to zero bytes', () => {
    const result = decodeBase64('');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.length).toBe(0);
  });

  it('replaces invalid UTF-8 rather than throwing when shown as text', () => {
    // 0xFF is never valid UTF-8. Decoding still succeeds - the bytes are the
    // result; only the textual PREVIEW contains a replacement character.
    const result = decodeBase64(encodeBase64(new Uint8Array([0xff, 0xfe]), DEFAULTS));
    expect(result.ok).toBe(true);
    if (result.ok) expect(bytesToText(result.value)).toBe('��');
  });
});

/**
 * PROPERTY-BASED TESTS
 *
 * The example tests above check the cases a person thought of. These state a
 * RULE that must hold for every input, and fast-check then generates hundreds
 * of inputs trying to break it - including the ones nobody thinks of: empty
 * values, lengths that land exactly on a boundary, astral-plane characters,
 * bytes that look like structure. When it finds a failure it shrinks it to the
 * smallest input that still fails, so the report is a minimal reproduction
 * rather than a 4 kB blob.
 */
describe('round-trip properties', () => {
  it('decode(encode(bytes)) returns the original bytes, for any bytes', () => {
    fc.assert(
      fc.property(
        fc.uint8Array(),
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 0, max: 76 }),
        (bytes, urlSafe, padding, wrapAt) => {
          const encoded = encodeBase64(bytes, { urlSafe, padding, wrapAt });
          const decoded = decodeBase64(encoded);
          expect(decoded.ok).toBe(true);
          if (decoded.ok) expect(Array.from(decoded.value)).toEqual(Array.from(bytes));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('decode(encode(text)) returns the original text, for any well-formed string', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), (text) => {
        expect(decodeToText(enc(text))).toBe(text);
      }),
      { numRuns: 300 },
    );
  });

  it('encoded output only ever uses the declared alphabet', () => {
    fc.assert(
      fc.property(fc.uint8Array(), fc.boolean(), (bytes, urlSafe) => {
        const encoded = encodeBase64(bytes, { ...DEFAULTS, urlSafe });
        const allowed = urlSafe ? /^[A-Za-z0-9\-_=]*$/ : /^[A-Za-z0-9+/=]*$/;
        expect(encoded).toMatch(allowed);
      }),
      { numRuns: 200 },
    );
  });
});

describe('tool definition', () => {
  it('encodes text through the tool surface', async () => {
    const result = await base64Tool.run({
      inputs: { input: { type: 'text', text: 'foobar' } },
      options: { mode: 'encode' },
      context,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.output).toEqual({ type: 'text', text: 'Zm9vYmFy' });
  });

  it('encodes dropped bytes without treating them as text', async () => {
    const result = await base64Tool.run({
      inputs: {
        input: {
          type: 'bytes',
          bytes: new Uint8Array([0xff, 0x00, 0x10]),
          mediaType: null,
          filename: 'x.bin',
        },
      },
      options: { mode: 'encode' },
      context,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.output).toEqual({ type: 'text', text: '/wAQ' });
  });

  it('decodes to bytes, not to a string', async () => {
    const result = await base64Tool.run({
      inputs: { input: { type: 'text', text: 'Zm9vYmFy' } },
      options: { mode: 'decode' },
      context,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const output = result.value.output;
      expect(output?.type).toBe('bytes');
      if (output?.type === 'bytes') expect(bytesToText(output.bytes)).toBe('foobar');
    }
  });

  it('returns a structured error rather than throwing on bad input', async () => {
    const result = await base64Tool.run({
      inputs: { input: { type: 'text', text: '!!!!' } },
      options: { mode: 'decode' },
      context,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('parse-error');
      expect(result.error.position?.line).toBe(1);
    }
  });

  it('refuses an input type its port does not declare', async () => {
    const result = await base64Tool.run({
      inputs: { input: { type: 'json', data: { nope: true } } },
      options: { mode: 'encode' },
      context,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unsupported-type');
  });
});
