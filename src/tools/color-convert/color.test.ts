import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ColorPayload, ToolRunContext } from '@/features/registry/types';
import { bestLevel, contrastRatio, relativeLuminance } from '@/lib/wcag';

import { formatColor, hslToRgb, oklchToRgb, parseColor, rgbToHsl, rgbToOklch } from './color';
import colorTool from './index';
import { colorDefaultOptions } from './options';

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

  /*
   * CSS COLOR 4 GIVES hsl()'s SATURATION AND LIGHTNESS AS `<percentage> |
   * <number>`, AND A BARE NUMBER MEANS THAT MANY PERCENT.
   *
   * https://www.w3.org/TR/css-color-4/#the-hsl-notation
   *
   * They used to be read as though they were already 0-1 fractions, so 91 and
   * 60 were clamped to 1 and `hsl(217 91 60)` came back WHITE - a plausible
   * colour, no error, and nothing anywhere to say the numbers had been
   * thrown away. It is the spelling every Tailwind theme and every CSS custom
   * property that stores a colour as three numbers uses.
   */
  it.each([
    ['hsl(217 91% 60%)', 'hsl(217 91 60)'],
    ['hsl(0 100% 50%)', 'hsl(0 100 50)'],
    ['hsl(120 50% 25%)', 'hsl(120 50 25)'],
    ['hsl(0 0% 0%)', 'hsl(0 0 0)'],
  ])('reads %s and %s as the same colour', (withUnits, without) => {
    expect(parse(without)).toEqual(parse(withUnits));
  });

  it.each([
    ['hsl(50% 100% 50%)', 'a percentage where hsl() wants a hue'],
    ['oklch(0.6 0.2 50%)', 'a percentage where oklch() wants a hue'],
  ])('refuses %s (%s)', (input) => {
    /*
     * A hue is `<number> | <angle>` in every notation here, and a percentage
     * used to be scaled by 360 - so this was silently read as 180deg rather
     * than refused.
     */
    expect(parseColor(input).ok).toBe(false);
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

  /*
   * THIS USED TO BE A LOTTERY, AND IT HAD BEEN LOSING ABOUT ONE RUN IN FOUR.
   *
   * The same assertion was made through `fc.assert` over 400 randomly chosen
   * colours, with a fresh seed on every run. 13,626 of the 16,777,216 sRGB
   * colours did not survive oklch() at the then-default precision of four -
   * one in 1,231 - so a 400-case run found one about 28% of the time. An
   * intermittent failure in a property test reads as flakiness in fast-check;
   * it was the tool being wrong about roughly fourteen thousand colours.
   *
   * A FIXED STRIDE THROUGH THE CUBE, not a random sample: it is the same
   * 166,112 colours every run, so this either passes for everybody or fails
   * for everybody. 101 is coprime with 2^24, so the stride walks all three
   * channels rather than holding any of them still.
   *
   * The stride is a sample, and the number it is calibrated against is not:
   * all 16,777,216 were swept offline, precision by precision, and the counts
   * are in the comment on `precision` in options.ts. At four this stride sees
   * about 135 of the failures, which is what makes it a test rather than a
   * hope; at five it sees none, because there are none.
   */
  it('round-trips every notation exactly at the default precision', () => {
    const { precision } = colorDefaultOptions;
    const wrong: string[] = [];

    for (let value = 0; value < 0x1000000; value += 101) {
      const source = `#${value.toString(16).padStart(6, '0')}`;
      const color = parse(source);

      for (const format of ['hex', 'rgb', 'hsl', 'oklch'] as const) {
        const back = parse(formatColor(color, format, precision));
        const returned = formatColor(back, 'hex', precision);
        if (returned !== source && wrong.length < 10) {
          wrong.push(`${source} as ${format} came back ${returned}`);
        }
      }
    }

    expect(wrong).toEqual([]);
  });

  it.each([
    ['#ff00ff', 'the magenta corner, worst at three places'],
    ['#00ffff', 'the cyan corner'],
    ['#bf8700', 'a saturated amber with a channel pinned at zero'],
    ['#10301f', 'a dark green from this repo’s own primitives'],
    /*
     * The four below are from the exhaustive sweep, and they are the reason
     * the default is five rather than four. Every one is a saturated cyan or
     * teal whose red channel is exactly zero, which is the corner of the cube
     * the old 266-colour corpus had nothing in: `#00bec7` wrote as
     * `oklch(0.729 0.1239 200.83)` and read back `#01bec7`.
     */
    ['#00bec7', 'a cyan that four decimal places got wrong'],
    ['#00bfa7', 'a teal that four decimal places got wrong'],
    ['#00c3ea', 'a sky blue that four decimal places got wrong'],
    ['#00c287', 'a green that four decimal places got wrong'],
  ])('%s survives oklch at the default precision (%s)', (hex) => {
    const written = formatColor(parse(hex), 'oklch', colorDefaultOptions.precision);
    expect(formatColor(parse(written), 'hex', colorDefaultOptions.precision)).toBe(hex);
  });

  it('is the lowest precision that round-trips, so the default is not arbitrary', () => {
    // Wrong at four places, right at five. If that ever stops being true the
    // default could come down, and this is what says so.
    const sample = ['#00bec7', '#00bfa7', '#00c3ea', '#00c287'];
    const survives = (hex: string, precision: number): boolean =>
      formatColor(parse(formatColor(parse(hex), 'oklch', precision)), 'hex', precision) === hex;

    expect(sample.filter((hex) => survives(hex, 4))).toEqual([]);
    expect(sample.filter((hex) => survives(hex, 5))).toEqual(sample);
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
