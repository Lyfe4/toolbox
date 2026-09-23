import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ColorPayload, ToolRunContext } from '@/features/registry/types';
import { bestLevel, contrastRatio, relativeLuminance } from '@/lib/wcag';

import {
  formatAll,
  formatColor,
  hslToRgb,
  oklchToRgb,
  parseColor,
  rgbToHsl,
  rgbToOklch,
} from './color';
import colorTool from './index';
import { colorDefaultOptions, MAX_PRECISION } from './options';

const context: ToolRunContext = {
  signal: new AbortController().signal,
  reportProgress: () => undefined,
};

function parse(input: string): ColorPayload {
  const result = parseColor(input);
  if (!result.ok) throw new Error(result.error.message);
  return result.value.color;
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

  /*
   * A HUE OF 360, WHICH ONLY ROUNDING CAN PRODUCE.
   *
   * `rgbToHsl` and `rgbToOklch` both promise [0, 360) and both keep that
   * promise - one adds 360 to a negative, the other takes `% 360`. The
   * FORMATTER broke it: 359.996 at two decimal places is `360`, which is a
   * wrap point printed as the value it wraps to, and the one number the range
   * those functions document excludes.
   *
   * The exposing input is a real one rather than a constructed float. `#800000`
   * written as `oklch()` and read back is a colour whose HSL hue is 359.996,
   * and it was printed `hsl(360 100% 25.1%)` beside every other red in the same
   * report starting at 0.
   */
  it('prints a hue that rounds to 360 as 0, in both notations', () => {
    const maroon = parse(formatColor(parse('#800000'), 'oklch', 5));

    // The control first: this really is the >= 359.995 case, so the assertions
    // below are about the wrap and not about some other colour.
    expect(rgbToHsl(maroon.r, maroon.g, maroon.b).h).toBeGreaterThan(359.99);
    expect(formatColor(maroon, 'hsl', 5)).toBe('hsl(0 100% 25.1%)');

    // And the same question of oklch(), whose hue goes through the same helper.
    const wrapped = { r: 1, g: 0, b: 0.0000001, a: 1 };
    expect(formatColor(wrapped, 'oklch', 5)).not.toContain(' 360)');
  });

  /*
   * CC-5a, round thirteen. This test used to assert the opposite - that
   * 359.98 was left exactly as it was - as the negative partner of the 360
   * wrap, with a note that snapping it needed a tolerance and a tolerance was a
   * decision. The decision is taken in `hslHue`: the report's own 8-bit
   * resolution. So the drifted red is 0, and so is a typed 359.98, which is
   * the stated cost.
   */
  it('prints a red that drifted to 359.98 as 0, because its hex says it is #ff0000', () => {
    const red = parse(formatColor(parse('#ff0000'), 'oklch', 5));

    // The control: this really is the drift, not the wrap next door.
    expect(rgbToHsl(red.r, red.g, red.b).h).toBeGreaterThan(359.9);
    expect(rgbToHsl(red.r, red.g, red.b).h).toBeLessThan(359.995);
    expect(formatColor(red, 'hex', 5)).toBe('#ff0000');

    expect(formatColor(red, 'hsl', 5)).toBe('hsl(0 100% 50%)');
    expect(formatColor(parse('hsl(359.98 100% 50%)'), 'hsl', 5)).toBe('hsl(0 100% 50%)');
  });

  /*
   * THE NEGATIVE PARTNERS: a hue one 8-bit step away is a different colour
   * and is left alone, and so is everything nowhere near 0.
   */
  it('leaves a hue alone once its hex is no longer pure red, and every hue far from 0', () => {
    expect(formatColor(parse('hsl(359.7 100% 50%)'), 'hex', 5)).toBe('#ff0001');
    expect(formatColor(parse('hsl(359.7 100% 50%)'), 'hsl', 5)).toBe('hsl(359.7 100% 50%)');
    expect(formatColor(parse('hsl(0.3 100% 50%)'), 'hsl', 5)).toBe('hsl(0.3 100% 50%)');
    expect(formatColor(parse('hsl(359 100% 50%)'), 'hsl', 5)).toBe('hsl(359 100% 50%)');
    expect(formatColor(parse('hsl(180 100% 50%)'), 'hsl', 5)).toBe('hsl(180 100% 50%)');
  });

  /*
   * AND THE CLAIM THAT MAKES IT SAFE: an 8-bit colour's hue is untouched,
   * because for those the rule's condition and a hue of exactly 0 are the same
   * fact. A fixed stride through the whole cube, so it either passes for
   * everybody or fails for everybody.
   */
  it('moves no 8-bit colour at all', () => {
    let checked = 0;
    for (let index = 0; index < 0x1000000; index += 997) {
      const [r, g, b] = [(index >> 16) & 255, (index >> 8) & 255, index & 255];
      const color = { r: r / 255, g: g / 255, b: b / 255, a: 1 };
      const raw = rgbToHsl(color.r, color.g, color.b).h;
      const printed = formatColor(color, 'hsl', 2).slice(4).split(' ')[0];
      const expected = Number(raw.toFixed(2)) === 360 ? '0' : String(Number(raw.toFixed(2)));
      expect(printed, `#${index.toString(16).padStart(6, '0')}`).toBe(expected);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(16_000);
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

  /*
   * THIS REPLACES A PROPERTY TEST THAT GUARDED NOTHING ANYBODY USES.
   *
   * It drew 300 random colours, wrote each in one notation AT PRECISION 6, read
   * it back, and allowed a tolerance of one 8-bit step. Three things were wrong
   * with that as evidence:
   *
   *   - Six is not the default. The default is five, and the stride test below
   *     already covers five EXACTLY, with no tolerance, over 166,112 colours in
   *     all four notations - so the random test was strictly weaker everywhere
   *     it overlapped.
   *   - The tolerance made it weaker still. "Within one 8-bit step" is the
   *     assertion that was passing while 13,626 colours came back a different
   *     colour at the then-default precision of four.
   *   - Random meant it could pass for one person and fail for another, which
   *     is the thing CONTRIBUTING.md has a paragraph about.
   *
   * What it was the only cover for is the TOP of the option's range: six is the
   * schema's maximum, and a user can select it. So the question it was asking
   * badly is asked properly here - the same fixed stride, at every precision
   * from the default to the maximum, exact rather than within a step.
   */
  it('round-trips exactly at every precision from the default to the maximum', () => {
    const { precision: lowest } = colorDefaultOptions;
    const highest = MAX_PRECISION;
    expect(highest).toBeGreaterThan(lowest);

    const wrong: string[] = [];

    for (let precision = lowest; precision <= highest; precision += 1) {
      // A coarser stride than the default-precision test below, because this
      // walks the cube once per precision. 1009 is prime, so it still visits
      // all three channels rather than holding any of them still.
      for (let value = 0; value < 0x1000000; value += 1009) {
        const source = `#${value.toString(16).padStart(6, '0')}`;
        const color = parse(source);

        for (const format of ['hex', 'rgb', 'hsl', 'oklch'] as const) {
          const back = parse(formatColor(color, format, precision));
          const returned = formatColor(back, 'hex', precision);
          if (returned !== source && wrong.length < 10) {
            wrong.push(
              `${source} as ${format} at precision ${precision.toString()} came back ${returned}`,
            );
          }
        }
      }
    }

    expect(wrong).toEqual([]);
  });

  /*
   * THE NEGATIVE CONTROL FOR BOTH SWEEPS.
   *
   * Every assertion above is satisfied by a comparison that cannot fail. Four
   * is BELOW the default and is known to lose 13,626 colours, so a stride that
   * can see a failure must see one here - and if it ever stops, the default
   * could come down and this is what says so.
   */
  it('can still see the failures that set the default, one precision lower', () => {
    const wrong: string[] = [];

    for (let value = 0; value < 0x1000000; value += 1009) {
      const source = `#${value.toString(16).padStart(6, '0')}`;
      if (formatColor(parse(formatColor(parse(source), 'oklch', 4)), 'hex', 4) !== source) {
        wrong.push(source);
      }
    }

    expect(wrong.length).toBeGreaterThan(0);
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

/* ========================================================================== *
 * rgb() with percentages
 * ========================================================================== */

describe('a percentage channel in rgb()', () => {
  /*
   * `rgb(50% 50% 50%)` IS EXACTLY 127.5, AND THAT MADE ONE REPORT DISAGREE
   * WITH ITSELF.
   *
   * The payload kept the half. Hex rounds, so it printed `#808080`; oklch is
   * computed from the payload, so it printed the value for 127.5. Every row of
   * one report is supposed to describe the same colour, and two of them
   * described colours one 8-bit step apart - cosmetic, undisclosed, and exactly
   * the kind of thing nobody checks digit by digit.
   *
   * The fix is to quantise ONCE, at the parse, because that is what a browser
   * does: `rgb()` serialises to 8-bit integers, so `getComputedStyle` on
   * `rgb(50% 50% 50%)` returns `rgb(128, 128, 128)`. That claim is checked
   * against two real engines in `scripts/cross-browser-check.mjs`; what is
   * checked here is that every row now agrees.
   */
  it('agrees with itself across every notation', () => {
    const color = parse('rgb(50% 50% 50%)');
    const all = formatAll(color, colorDefaultOptions.precision);

    expect(all.hex).toBe('#808080');
    expect(all.rgb).toBe('rgb(128 128 128)');
    // The oklch row read back as hex must be the same colour as the hex row.
    expect(formatColor(parse(all.oklch), 'hex', colorDefaultOptions.precision)).toBe(all.hex);
    expect(formatColor(parse(all.hsl), 'hex', colorDefaultOptions.precision)).toBe(all.hex);
  });

  it('rounds the half up, which is what a browser reports', () => {
    expect(formatColor(parse('rgb(50% 50% 50%)'), 'rgb', 3)).toBe('rgb(128 128 128)');
  });

  it.each([
    ['rgb(0% 0% 0%)', '#000000'],
    ['rgb(100% 100% 100%)', '#ffffff'],
    ['rgb(20% 40% 60%)', '#336699'],
  ])('%s is exactly %s', (source, hex) => {
    expect(formatColor(parse(source), 'hex', colorDefaultOptions.precision)).toBe(hex);
  });

  /*
   * THE NEGATIVE CONTROLS. Quantising is scoped to `rgb()` on purpose: hsl()
   * and oklch() are continuous in CSS, and rounding them to 8 bits would break
   * the round trips the stride test asserts. These say the scope held.
   */
  it('leaves an hsl() colour unquantised', () => {
    const color = parse('hsl(217 91% 60%)');
    // 8-bit quantising would make every channel a multiple of 1/255 exactly.
    const eighths = [color.r, color.g, color.b].map((value) => value * 255);
    expect(eighths.some((value) => Math.abs(value - Math.round(value)) > 1e-9)).toBe(true);
  });

  it('leaves an oklch() colour unquantised', () => {
    const color = parse('oklch(0.62 0.19 259)');
    const eighths = [color.r, color.g, color.b].map((value) => value * 255);
    expect(eighths.some((value) => Math.abs(value - Math.round(value)) > 1e-9)).toBe(true);
  });

  it('still reads bare numbers in rgb() as 0-255', () => {
    // The other spelling, unaffected: `rgb(59 130 246)` is already integral.
    expect(formatColor(parse('rgb(59 130 246)'), 'hex', 3)).toBe('#3b82f6');
  });
});

/* ========================================================================== *
 * What the parser had to change, and whether anybody is told
 * ========================================================================== */

/**
 * CC-1, CC-2 AND CC-3: THE TOOL THAT COULD NOT SPEAK.
 *
 * `inGamut` has been computed correctly since `e56bd2f` and discarded at its
 * one call site ever since, and the clamps were never recorded at all. The
 * conversion matrix carried the out-of-gamut cell as `lossy, told` throughout.
 *
 * These are the assertions that hold the wiring rather than the maths: the
 * maths already had its own tests and they passed honestly, because the
 * function was right and nothing read it. Every one of them has a negative
 * control beside it, because a note that fires on an ordinary colour is worse
 * than no note - it is the one people learn to scroll past.
 */
describe('the parser says what it had to change', () => {
  function adjustments(input: string) {
    const result = parseColor(input);
    if (!result.ok) throw new Error(result.error.message);
    return { clamped: result.value.clamped, outOfGamut: result.value.outOfGamut };
  }

  it('carries the out-of-gamut verdict out of oklchToRgb instead of dropping it', () => {
    expect(adjustments('oklch(0.7 0.4 150)').outOfGamut).toBe(true);
  });

  it.each([
    ['an in-gamut oklch()', 'oklch(0.7 0.1 150)'],
    ['a hex colour', '#00d600'],
    ['an rgb() colour', 'rgb(0 214 0)'],
    ['an hsl() colour', 'hsl(217 91% 60%)'],
  ])('does not call %s out of gamut', (_name, input) => {
    expect(adjustments(input).outOfGamut).toBe(false);
  });

  it.each([
    ['hsl(361 110% -5%)', ['saturation 110%', 'lightness -5%']],
    ['rgb(300 -20 50)', ['red 300', 'green -20']],
    ['rgb(0 0 0 / 2)', ['alpha 2']],
    ['oklch(1.5 0.1 150)', ['lightness 1.5']],
    ['oklch(0.5 -0.1 150)', ['chroma -0.1']],
  ])('names every component it clamped in %s', (input, expected) => {
    expect(adjustments(input).clamped).toEqual(expected);
  });

  /*
   * THE HUE IS NOT ON THAT LIST, and it is the case that decides whether the
   * note is worth reading. `hsl(361 …)` is `hsl(1 …)` exactly - CSS wraps a
   * hue and so does `hslToRgb` - so a clamp note naming it would be a note
   * about a loss that did not happen.
   */
  it.each([
    ['a hue past 360', 'hsl(361 50% 50%)'],
    ['a negative hue', 'hsl(-20 50% 50%)'],
    ['a hue past 360 in oklch()', 'oklch(0.5 0.1 400)'],
  ])('treats %s as a wrap rather than a clamp', (_name, input) => {
    expect(adjustments(input).clamped).toEqual([]);
  });

  it.each([
    ['#aabbcc', '#aabbcc'],
    ['#aabbccdd', '#aabbccdd'],
    ['rgb(59 130 246)', 'rgb(59 130 246)'],
    ['hsl(217 91% 60%)', 'hsl(217 91% 60%)'],
    ['oklch(0.62 0.19 259)', 'oklch(0.62 0.19 259)'],
    // 50% is 127.5, rounded to 128 by a decision recorded in round three. A
    // rounding is not a clamp and must not be reported as one.
    ['rgb(50% 50% 50%)', 'rgb(50% 50% 50%)'],
  ])('clamps nothing in %s', (_name, input) => {
    expect(adjustments(input).clamped).toEqual([]);
  });
});

describe('the report port', () => {
  async function report(text: string) {
    const result = await colorTool.run({
      inputs: { input: { type: 'text', text } },
      options: { ...colorDefaultOptions, target: 'hex' },
      context,
    });
    if (!result.ok) throw new Error(result.error.message);
    const port = result.value.report;
    if (port?.type !== 'json' || port.data === null || typeof port.data !== 'object') {
      throw new Error('no report');
    }
    const data = port.data as { summary?: unknown; notes?: unknown };
    const notes = Array.isArray(data.notes) ? data.notes : [];
    return {
      summary: typeof data.summary === 'string' ? data.summary : '',
      notes: notes as { level: string; title: string; body: string; reaches: string[] }[],
    };
  }

  it('names the input and the nearest sRGB colour when a colour is out of gamut', async () => {
    const { notes } = await report('oklch(0.7 0.4 150)');
    const warn = notes.filter((note) => note.level === 'warn');

    expect(warn).toHaveLength(1);
    expect(warn[0]?.title).toContain('oklch(0.7 0.4 150)');
    // #00d600 is the measured answer, and it is the colour the contrast table
    // is really describing - which is the half of CC-1 that matters.
    expect(warn[0]?.title).toContain('#00d600');
  });

  it.each([
    ['hsl(361 110% -5%)', '#000000', ['saturation 110%', 'lightness -5%']],
    ['rgb(300 -20 50)', '#ff0032', ['red 300', 'green -20']],
  ])(
    'names the input and the nearest sRGB colour when %s is clamped',
    async (input, hex, named) => {
      const { notes } = await report(input);
      const warn = notes.filter((note) => note.level === 'warn');

      expect(warn).toHaveLength(1);
      expect(warn[0]?.title).toContain(input);
      expect(warn[0]?.title).toContain(hex);
      for (const component of named) {
        expect(`${warn[0]?.title ?? ''} ${warn[0]?.body ?? ''}`).toContain(component);
      }
    },
  );

  /*
   * THE NEGATIVE CONTROL, and it covers the new port as well as the new notes:
   * an ordinary colour produces a report with nothing in it.
   */
  it.each(['#aabbcc', '#aabbccdd', 'rgb(59 130 246)', 'hsl(217 91% 60%)', 'oklch(0.62 0.19 259)'])(
    '%s produces no note at all',
    async (input) => {
      const { notes } = await report(input);
      expect(notes).toEqual([]);
    },
  );

  /*
   * A colour arriving on the `color` port has already been parsed into sRGB,
   * so there is no text to have been out of range and nothing to report. It is
   * the one path that reaches the note builder without an input string.
   */
  it('says nothing about a colour wired in from another node', async () => {
    const result = await colorTool.run({
      inputs: { input: { type: 'color', color: { r: 1, g: 0, b: 0, a: 1 } } },
      options: { ...colorDefaultOptions, target: 'hex' },
      context,
    });
    if (!result.ok) throw new Error('refused');
    const port = result.value.report;
    const data = port?.type === 'json' ? (port.data as { notes?: unknown }) : {};
    expect(data.notes).toEqual([]);
  });

  it('summarises the run even when nothing was adjusted', async () => {
    expect((await report('#aabbcc')).summary).toBe('#aabbcc as hex');
  });

  /*
   * WHICH PORTS THE LOSS IS IN. All three data ports, because the adjustment
   * happened in the READ half - there is no `data`-shaped escape hatch here
   * the way there is in `structured-data`. `notePorts.test.ts` holds this to
   * the manifest; this holds it to the intent.
   */
  it('marks the loss as reaching every port that carries the colour', async () => {
    const { notes } = await report('oklch(0.7 0.4 150)');
    expect(notes[0]?.reaches).toEqual(['output', 'swatch', 'all']);
  });
});
