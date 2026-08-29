import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ColorPayload, ToolRunContext } from '@/features/registry/types';
import { bestLevel, contrastRatio, relativeLuminance } from '@/lib/wcag';

import { formatColor, hslToRgb, oklchToRgb, parseColor, rgbToHsl, rgbToOklch } from './color';
import colorTool from './index';

const context: ToolRunContext = {
  signal: new AbortController().signal,
  reportProgress: () => undefined,
};

function parse(input: string): ColorPayload {
  const result = parseColor(input);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** 8-bit channel comparison: colours are only ever displayed at that depth. */
const to255 = (value: number): number => Math.round(value * 255);

describe('parsing', () => {
  it.each([
    ['#fff', [255, 255, 255, 1]],
    ['#000', [0, 0, 0, 1]],
    ['#3b82f6', [59, 130, 246, 1]],
    ['3b82f6', [59, 130, 246, 1]],
    ['#3b82f680', [59, 130, 246, 128 / 255]],
    ['#f00f', [255, 0, 0, 1]],
  ])('reads %s', (input, expected) => {
    const color = parse(input);
    expect([to255(color.r), to255(color.g), to255(color.b), color.a]).toEqual(expected);
  });

  it.each([
    'rgb(59 130 246)',
    'rgb(59, 130, 246)',
    'rgba(59, 130, 246, 1)',
    'rgb(59 130 246 / 100%)',
  ])('reads %s in every accepted syntax', (input) => {
    const color = parse(input);
    expect([to255(color.r), to255(color.g), to255(color.b)]).toEqual([59, 130, 246]);
  });

  it('reads hsl()', () => {
    const color = parse('hsl(0 100% 50%)');
    expect([to255(color.r), to255(color.g), to255(color.b)]).toEqual([255, 0, 0]);
  });

  it('reads oklch()', () => {
    // Pure white is L=1, C=0 in OKLCH, whatever the hue.
    const color = parse('oklch(1 0 0)');
    expect([to255(color.r), to255(color.g), to255(color.b)]).toEqual([255, 255, 255]);
  });

  it.each([
    ['#12345', 'an ambiguous five-digit hex'],
    ['rgb(1 2)', 'a missing channel'],
    ['cmyk(0 0 0 1)', 'an unsupported notation'],
    ['rebeccapurple', 'a named colour, which is deliberately not supported'],
    ['', 'nothing at all'],
  ])('refuses %s (%s)', (input) => {
    expect(parseColor(input).ok).toBe(false);
  });
});

describe('formatting', () => {
  const blue = parse('#3b82f6');

  it('writes hex back exactly', () => {
    expect(formatColor(blue, 'hex', 3)).toBe('#3b82f6');
  });

  it('writes modern space-separated rgb()', () => {
    expect(formatColor(blue, 'rgb', 3)).toBe('rgb(59 130 246)');
  });

  it('includes alpha only when there is any', () => {
    expect(formatColor(blue, 'rgb', 3)).not.toContain('/');
    expect(formatColor({ ...blue, a: 0.5 }, 'rgb', 3)).toContain('/ 0.5');
    expect(formatColor({ ...blue, a: 0.5 }, 'hex', 3)).toBe('#3b82f680');
  });

  it('honours the precision option where it applies', () => {
    expect(formatColor(blue, 'oklch', 1).split(' ')[0]).toMatch(/^oklch\(0\.\d$/);
    expect(formatColor(blue, 'oklch', 4).split(' ')[0]).toMatch(/^oklch\(0\.\d{1,4}$/);
  });
});

/*
 * Round-tripping is the property that matters for a converter: going out to
 * another colour space and back must land on the same colour, or the tool is
 * quietly corrupting people's design tokens. The tolerance is one 8-bit step,
 * which is the finest distinction a screen can show.
 */
describe('round trips', () => {
  const channel = fc.integer({ min: 0, max: 255 }).map((value) => value / 255);

  it('survives sRGB -> HSL -> sRGB', () => {
    fc.assert(
      fc.property(channel, channel, channel, (r, g, b) => {
        const { h, s, l } = rgbToHsl(r, g, b);
        const [r2, g2, b2] = hslToRgb(h, s, l);

        expect(to255(r2)).toBe(to255(r));
        expect(to255(g2)).toBe(to255(g));
        expect(to255(b2)).toBe(to255(b));
      }),
      { numRuns: 500 },
    );
  });

  it('survives sRGB -> OKLCH -> sRGB', () => {
    fc.assert(
      fc.property(channel, channel, channel, (r, g, b) => {
        const { l, c, h } = rgbToOklch(r, g, b);
        const { rgb, inGamut } = oklchToRgb(l, c, h);

        // A colour that came FROM sRGB is by definition inside sRGB.
        expect(inGamut).toBe(true);
        expect(Math.abs(to255(rgb[0]) - to255(r))).toBeLessThanOrEqual(1);
        expect(Math.abs(to255(rgb[1]) - to255(g))).toBeLessThanOrEqual(1);
        expect(Math.abs(to255(rgb[2]) - to255(b))).toBeLessThanOrEqual(1);
      }),
      { numRuns: 500 },
    );
  });

  it('survives a full parse -> format -> parse cycle in every notation', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffffff }),
        fc.constantFrom('hex' as const, 'rgb' as const, 'hsl' as const, 'oklch' as const),
        (value, format) => {
          const source = `#${value.toString(16).padStart(6, '0')}`;
          const color = parse(source);
          const back = parse(formatColor(color, format, 6));

          expect(Math.abs(to255(back.r) - to255(color.r))).toBeLessThanOrEqual(1);
          expect(Math.abs(to255(back.g) - to255(color.g))).toBeLessThanOrEqual(1);
          expect(Math.abs(to255(back.b) - to255(color.b))).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('reports an OKLCH colour outside sRGB as out of gamut', () => {
    // Maximum chroma at mid lightness is far outside anything sRGB can show.
    const { inGamut } = oklchToRgb(0.7, 0.37, 150);
    expect(inGamut).toBe(false);
  });
});

describe('contrast', () => {
  it('gives black on white the maximum 21:1', () => {
    expect(contrastRatio(relativeLuminance(0, 0, 0), relativeLuminance(1, 1, 1))).toBeCloseTo(
      21,
      5,
    );
  });

  it('gives a colour against itself 1:1', () => {
    const luminance = relativeLuminance(0.2, 0.4, 0.6);
    expect(contrastRatio(luminance, luminance)).toBeCloseTo(1, 10);
  });

  it('is symmetric', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (a, b) => {
          expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
        },
      ),
    );
  });

  it.each([
    [21, 'AAA'],
    [7, 'AAA'],
    [6.9, 'AA'],
    [4.5, 'AA'],
    [4.4, 'AA large'],
    [3, 'AA large'],
    [2.9, null],
  ])('places %s at %s', (ratio, expected) => {
    expect(bestLevel(ratio)).toBe(expected);
  });
});

describe('the tool', () => {
  it('emits the converted string, a colour value and every notation', async () => {
    const result = await colorTool.run({
      inputs: { input: { type: 'text', text: '#3b82f6' } },
      options: { target: 'oklch', precision: 3 },
      context,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const text = result.value.output;
    expect(text?.type === 'text' ? text.text : '').toMatch(/^oklch\(/);

    // The colour output is a real colour value, not a string: that is what the
    // preview swatch and the contrast table read, and what a wire carries.
    expect(result.value.swatch?.type).toBe('color');
    expect(result.value.all?.type).toBe('json');
  });

  it('accepts a colour wired in from another node without re-parsing text', async () => {
    const result = await colorTool.run({
      inputs: { input: { type: 'color', color: { r: 1, g: 0, b: 0, a: 1 } } },
      options: { target: 'hex', precision: 3 },
      context,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = result.value.output;
    expect(text?.type === 'text' ? text.text : '').toBe('#ff0000');
  });

  it('reports an unparseable colour as an error', async () => {
    const result = await colorTool.run({
      inputs: { input: { type: 'text', text: 'not a colour' } },
      options: { target: 'hex', precision: 3 },
      context,
    });

    expect(result.ok).toBe(false);
  });
});
