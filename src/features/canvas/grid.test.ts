import { describe, expect, it } from 'vitest';

import { GRID, MAX_ZOOM, MIN_ZOOM } from './geometry';
import {
  GRID_MAJOR_EVERY,
  GRID_PITCH_FULL,
  GRID_PITCH_MIN,
  GRID_SUBDIVISIONS,
  gridLevels,
  gridLevelStrength,
  gridPitches,
  gridRules,
  gridStrengths,
} from './grid';
import { zoomFactorForNotches } from './wheel';

/**
 * THE GRID.
 *
 * Three defects have been fixed here in turn, and every one of them was
 * invisible to the whole gate until a person photographed it. The groups below
 * are named for which one they hold down, because the third fix subsumed the
 * MECHANISM of the first and it is worth saying what still needs checking.
 *
 * 1. PHASE-LOCK. A minor pair tiled at `GRID * zoom` and a major pair at eight
 *    times that are rasterised independently, each rounded to device pixels on
 *    its own, so the major rule stops landing on a minor one. That was fixed by
 *    one tile with the subdivisions as fractions of it, and there is no tile at
 *    all now - every rule is placed individually. What survives is the
 *    PROPERTY: the rules form one lattice with nothing missing and nothing
 *    extra, and the major always sits on it.
 *
 * 2. THE SCALE CASCADE. A grid at a fixed world pitch is a wash at one end of
 *    the range and bare rules at the other, and the answer had been an
 *    `opacity` step that dimmed the whole surface instead of thinning the grid.
 *    Still entirely live below, plus the density group, which is the half of it
 *    that the second pass got wrong.
 *
 * 3. DEVICE PIXELS. A CSS gradient cannot put a one-pixel rule on a device
 *    pixel, so at fractional zoom some rules were crisp and some split across
 *    two pixels at half ink - and the difference between them aliased into
 *    bands at a period unrelated to the grid. Fixed by drawing the grid with
 *    every rule rounded to a whole device pixel; the last group is about that
 *    rounding, including the price it charges.
 */

/** Every zoom in the range, at a given resolution. The bugs were never at the round numbers. */
function sweep(from: number, to: number, steps: number): readonly number[] {
  return Array.from({ length: steps + 1 }, (_, index) => from + ((to - from) * index) / steps);
}

const SWEEP = sweep(MIN_ZOOM, MAX_ZOOM, 400);

/** Zoom levels worth naming: the ends, the round ones, and the reported ones. */
const ZOOMS = [
  MIN_ZOOM,
  0.28,
  0.3,
  0.33,
  0.4,
  0.45,
  0.5,
  0.6,
  0.66,
  0.7,
  0.75,
  0.79,
  0.89,
  0.9,
  0.95,
  1,
  1 / 3,
  7 / 9,
  1.06,
  1.12,
  1.25,
  1.5,
  1.59,
  1.75,
  2,
  2.25,
  MAX_ZOOM,
];

/** Pan offsets, including the large ones where float precision degrades. */
const OFFSETS = [0, 1, -1, 7.5, -7.5, 137.25, -137.25, 1024, -4096, 123456.789, -987654.321, 1e7];

/** The pitches of the levels that are inked at all, in CSS px. */
function inkedPitches(zoom: number): readonly number[] {
  const levels = gridLevels(zoom);
  return gridPitches(zoom).filter((_, index) => (levels[index]?.strength ?? 0) > 0);
}

describe('the scale cascade', () => {
  it('never inks a level whose rules are closer than the legibility floor', () => {
    /*
     * THE 33% BUG, AS A PROPERTY. A level that is inked at all has to be
     * resolvable as lines, or it is a tint pretending to be a grid.
     */
    for (const zoom of SWEEP) {
      const pitches = gridPitches(zoom);
      gridLevels(zoom).forEach((level, index) => {
        if (level.strength > 0) {
          expect(
            pitches[index] ?? 0,
            `zoom ${zoom.toString()}: a level ${(pitches[index] ?? 0).toString()}px apart is inked`,
          ).toBeGreaterThan(GRID_PITCH_MIN);
        }
      });
    }
  });

  it('always has a fully drawn level, between 8 and 20 px apart', () => {
    /*
     * THE 250% BUG, AS A PROPERTY. At every zoom SOME level must be at full ink
     * and its pitch has to stay inside a narrow band, or the backdrop is either
     * bare major rules or a haze of half-drawn ones.
     *
     * Both ends are derived. It can never be finer than `GRID_PITCH_FULL` - the
     * pitch the grid is authored at - and never coarser than `GRID * MAX_ZOOM`,
     * which is what an eighth of a major square measures at the top of the
     * range.
     */
    for (const zoom of SWEEP) {
      const levels = gridLevels(zoom);
      const full = gridPitches(zoom).filter((_, index) => (levels[index]?.strength ?? 0) >= 1);

      expect(full.length, `zoom ${zoom.toString()}: no level is at full ink`).toBeGreaterThan(0);

      const finest = Math.min(...full);
      expect(
        finest,
        `zoom ${zoom.toString()}: the finest full level is ${finest.toFixed(1)}px apart`,
      ).toBeGreaterThanOrEqual(GRID_PITCH_FULL - 1e-9);
      expect(finest).toBeLessThanOrEqual(GRID * MAX_ZOOM + 1e-9);
    }
  });

  it('has at most one level part-drawn at any zoom', () => {
    /*
     * The reason `GRID_PITCH_FULL` is exactly twice `GRID_PITCH_MIN` rather
     * than a number somebody liked. The levels are an octave apart, so a
     * one-octave transition band can hold only one of them: if a level is
     * mid-fade, the next one out is past the top of the band and the next one in
     * is under the bottom. One soft edge at a time, never a general haze.
     */
    for (const zoom of SWEEP) {
      const partial = gridStrengths(zoom).filter((value) => value > 0 && value < 1);
      expect(
        partial.length,
        `zoom ${zoom.toString()}: ${partial.length.toString()} levels part-drawn`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it('brings every level in coarsest first, and never out of order', () => {
    // A finer level must never be inked more heavily than a coarser one, or the
    // grid would show its subdivisions before the squares they subdivide.
    for (const zoom of SWEEP) {
      const strengths = gridStrengths(zoom);
      for (let index = 1; index < strengths.length; index += 1) {
        expect(strengths[index] ?? 0).toBeLessThanOrEqual((strengths[index - 1] ?? 0) + 1e-9);
      }
    }
  });

  it('cannot be switched on or off by one notch of the wheel', () => {
    /*
     * WHY THE FADE EXISTS, MEASURED IN THE UNIT THE USER IS ACTUALLY MOVING IN.
     *
     * "Continuous" is not a property of the strength curve on its own - any
     * curve is continuous if you sample it finely enough. The question is
     * whether a level can visibly appear in ONE STEP OF THE GESTURE, and the
     * gesture's step is a notch.
     *
     * A third is the number with room to spare: a level's fade spans an octave,
     * six notches cover an octave, and the ramp is linear - so a sixth is the
     * worst case. A hard switch would score 1.0 here, which is what this is
     * really testing for, and the smoothstep this replaced scored a quarter.
     */
    const step = zoomFactorForNotches(1);
    for (let zoom = MIN_ZOOM; zoom <= MAX_ZOOM; zoom *= step ** 0.25) {
      const before = gridStrengths(zoom);
      const after = gridStrengths(Math.min(zoom * step, MAX_ZOOM));

      after.forEach((value, index) => {
        expect(
          Math.abs(value - (before[index] ?? 0)),
          `level ${index.toString()} moves too far in one notch from ${zoom.toFixed(3)}`,
        ).toBeLessThan(1 / 3);
      });
    }
  });

  it('fades each level over exactly one octave of zoom', () => {
    /*
     * Stated directly rather than inferred from a sweep: the zoom at which a
     * level reaches full ink is exactly twice the zoom at which it starts to
     * appear. That doubling is what makes "at most one level part-drawn" true,
     * and it is the one relationship in the cascade that has to be exact.
     */
    for (const multiple of GRID_SUBDIVISIONS) {
      const worldPitch = GRID * multiple;
      const starts = GRID_PITCH_MIN / worldPitch;
      const completes = GRID_PITCH_FULL / worldPitch;

      expect(completes / starts).toBeCloseTo(2, 12);
      expect(gridLevelStrength(worldPitch, starts)).toBe(0);
      expect(gridLevelStrength(worldPitch, completes)).toBe(1);
      expect(gridLevelStrength(worldPitch, Math.sqrt(starts * completes))).toBeGreaterThan(0);
    }
  });

  it('keeps the major square the same world size at every zoom', () => {
    // The reference the user measures against does not move under them; it is
    // the subdivisions inside it that come and go.
    for (const zoom of SWEEP) {
      expect(gridLevels(zoom)[0]).toEqual({ pitch: GRID * GRID_MAJOR_EVERY, strength: 1 });
    }
  });
});

/**
 * APPARENT DENSITY
 *
 * The complaint that outlived the first two fixes: at 40% the surface read
 * lighter and grainier than at 89%, and the whole range was asked to look the
 * same in character. Most of that was rasterisation - a split rule is
 * composited in sRGB and reads lighter than a crisp one carrying identical ink
 * - but not all of it. The ladder used to stop at `GRID`, so above 100% the
 * cascade stopped too and the grid simply thinned: the finest rules went from
 * 8px apart to 20px apart between 100% and 250%, which is three fifths of the
 * ink.
 *
 * Ink per unit length is the thing to hold, and it can be computed exactly
 * rather than photographed. A level's rules land every `pitch`, but half of
 * them are claimed by the level above, so each level below the major
 * contributes `strength / (2 * pitch)`.
 */
function inkPerHundredPixels(zoom: number, levels = gridLevels(zoom)): number {
  const major = levels[0];
  if (!major) return 0;

  let ink = 1 / (major.pitch * zoom);
  for (const level of levels.slice(1)) ink += level.strength / (2 * level.pitch * zoom);

  return ink * 100;
}

describe('apparent density', () => {
  it('is exactly the authored density from the minimum zoom to 200%', () => {
    /*
     * EXACTLY, not approximately, and that is what fixes the fade's shape. The
     * linear ramp is the unique strength curve that conserves ink while a level
     * fades - the derivation is on `gridLevelStrength` - so from `MIN_ZOOM` up
     * to the zoom where the ladder runs out, the surface carries precisely the
     * ink it is authored with: one hairline every `GRID` pixels.
     *
     * Smoothstep put this up to 5% over, peaking around 45%, which is what was
     * left of "the whole surface goes lighter at one zoom than another" once
     * the rasterisation was dealt with.
     */
    for (const zoom of sweep(MIN_ZOOM, 2, 400)) {
      expect(inkPerHundredPixels(zoom), `zoom ${zoom.toFixed(4)}`).toBeCloseTo(100 / GRID, 9);
    }
  });

  it('thins by no more than a quarter above 200%, where the ladder runs out', () => {
    /*
     * THE HONEST BOUND. Past 200% every level is at full ink, so there is
     * nothing left to fade in and the grid can only spread: at 250% the finest
     * rules are 10px apart rather than 8, which is 10 units of ink per 100px
     * against 12.5. That is the one stretch of the range where the density is
     * not flat, it is a fifth of the range, and the alternative is a rule finer
     * than half a snap step.
     */
    const inks = sweep(MIN_ZOOM, MAX_ZOOM, 400).map((zoom) => inkPerHundredPixels(zoom));
    const lo = Math.min(...inks);
    const hi = Math.max(...inks);

    expect(hi).toBeCloseTo(100 / GRID, 9);
    expect(hi / lo, `ink runs ${lo.toFixed(2)} to ${hi.toFixed(2)} per 100px`).toBeLessThanOrEqual(
      1.25 + 1e-9,
    );
  });

  it('would have varied by more than half without the finest level', () => {
    /*
     * THE REASON THE LADDER GOES BELOW THE SNAP STEP, stated as the number it
     * buys. Dropping the sixteenth-of-a-major rule is exactly the old ladder,
     * and it is what made 250% a different surface from 100%.
     */
    const inks = SWEEP.map((zoom) => inkPerHundredPixels(zoom, gridLevels(zoom).slice(0, -1)));

    expect(Math.max(...inks) / Math.min(...inks)).toBeGreaterThan(2);
  });

  it.each(ZOOMS)('is close to the authored density at zoom %s', (zoom) => {
    expect(inkPerHundredPixels(zoom)).toBeGreaterThan(9.5);
  });
});

/**
 * DEVICE PIXELS
 *
 * What the drawn grid buys, and what it costs. Everything here is about
 * `gridRules`, which is the only place a rule's position is decided.
 */
describe('where the rules land', () => {
  const CASES = ZOOMS.flatMap((zoom) =>
    OFFSETS.flatMap((origin) => [1, 1.25, 1.5, 2, 3].map((dpr) => ({ zoom, origin, dpr }))),
  );

  /** The world coordinate a rule is standing in for, recovered from its pixel. */
  function worldOf(rule: { at: number }, origin: number, zoom: number, dpr: number): number {
    const step = Math.min(...inkedPitches(zoom)) / zoom;
    return Math.round((rule.at / dpr - origin) / (step * zoom)) * step;
  }

  it('puts every rule on a whole device pixel', () => {
    /*
     * THE WHOLE POINT. A rule at a fractional device pixel is antialiased
     * across two at half the ink each; the same rule half a pixel along is
     * crisp; and the difference between them, repeated across a canvas, is the
     * banding. There is no fractional position to be had here.
     */
    for (const { zoom, origin, dpr } of CASES) {
      for (const rule of gridRules(origin, 1440, zoom, dpr)) {
        expect(
          Number.isInteger(rule.at),
          `zoom ${zoom.toString()} origin ${origin.toString()} dpr ${dpr.toString()}: ${rule.at.toString()}`,
        ).toBe(true);
      }
    }
  });

  it('never puts a rule more than half a device pixel from the world', () => {
    /*
     * THE PROPERTY THAT MAKES INDEPENDENT ROUNDING SAFE, and the reason the
     * alternatives were rejected. Snapping the TILE to a whole device pixel
     * fixes the rasterisation too, and it scales the whole grid by up to 3% at
     * the bottom of the range - which across a wide viewport is tens of pixels
     * of drift between the grid and the nodes standing on it, sliding as you
     * pan. Rounding each rule on its own cannot accumulate, and this is that
     * stated as a bound, at every offset including the very large ones.
     */
    for (const { zoom, origin, dpr } of CASES) {
      for (const rule of gridRules(origin, 1440, zoom, dpr)) {
        const truth = (worldOf(rule, origin, zoom, dpr) * zoom + origin) * dpr;
        expect(
          Math.abs(rule.at - truth),
          `zoom ${zoom.toString()} origin ${origin.toString()} dpr ${dpr.toString()}: ${rule.at.toString()} against ${truth.toFixed(3)}`,
        ).toBeLessThanOrEqual(0.5 + 1e-6);
      }
    }
  });

  it('never lands two rules on the same device pixel', () => {
    /*
     * Which is what the floor under the cascade buys: the finest inked level is
     * never closer than `GRID_PITCH_MIN` CSS pixels, so after rounding there is
     * always at least one whole device pixel between two rules. Without it two
     * rules would collapse onto one and the grid would drop lines at the bottom
     * of the range.
     */
    for (const { zoom, origin, dpr } of CASES) {
      const positions = gridRules(origin, 1440, zoom, dpr).map((rule) => rule.at);
      expect(new Set(positions).size).toBe(positions.length);

      for (let index = 1; index < positions.length; index += 1) {
        expect(positions[index] ?? 0).toBeGreaterThan(positions[index - 1] ?? 0);
      }
    }
  });

  it('keeps every gap within one device pixel of the true pitch', () => {
    /*
     * THE PRICE, ASSERTED SO IT CANNOT QUIETLY GROW. Rounding each rule on its
     * own means the gaps are not all equal: at a pitch of 7.1 device pixels
     * they run 7, 7, 7, 7, 8, 7, 7.
     *
     * The bound is PER GAP rather than on the spread, because the spread can be
     * two where the pitch happens to be a whole number of device pixels and the
     * phase sits on a rounding tie - gaps then alternate either side of it.
     * Which is the same one-pixel ripple, and stating it per gap is what stays
     * true at every zoom rather than at most of them.
     */
    for (const { zoom, origin, dpr } of CASES) {
      const rules = gridRules(origin, 1440, zoom, dpr);
      const ideal = Math.min(...inkedPitches(zoom)) * dpr;
      const positions = rules.map((rule) => rule.at);

      for (let index = 1; index < positions.length; index += 1) {
        const gap = (positions[index] ?? 0) - (positions[index - 1] ?? 0);
        expect(
          Math.abs(gap - ideal),
          `zoom ${zoom.toString()} dpr ${dpr.toString()}: a gap of ${gap.toString()} against ${ideal.toFixed(3)}`,
        ).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('gives each rule to the coarsest level that lands on it', () => {
    /*
     * PHASE-LOCK, RESTATED FOR A GRID WITH NO TILE. World 64 is a multiple of 4,
     * 8, 16 and 32 as well, so without this every major rule would also be
     * drawn as an eighth, a quarter and a half - four inks stacked, making every
     * eighth rule heavier than its token asks for. That is the same visual
     * defect the original bug produced, by a different route.
     */
    for (const { zoom, origin, dpr } of CASES) {
      const levels = gridLevels(zoom);

      for (const rule of gridRules(origin, 1440, zoom, dpr)) {
        const world = worldOf(rule, origin, zoom, dpr);
        const own = levels[rule.level]?.pitch ?? 0;

        expect(Number.isInteger(world / own)).toBe(true);
        for (let coarser = 0; coarser < rule.level; coarser += 1) {
          if ((levels[coarser]?.strength ?? 0) === 0) continue;
          expect(Number.isInteger(world / (levels[coarser]?.pitch ?? 1))).toBe(false);
        }
      }
    }
  });

  it('draws one lattice with nothing missing and nothing extra', () => {
    // Every position at the finest inked pitch gets exactly one rule, which is
    // the invariant the two-tile grid broke by dropping whole runs of lines.
    for (const zoom of ZOOMS) {
      const rules = gridRules(0, 1440, zoom, 1);
      const finest = Math.min(...inkedPitches(zoom));

      expect(rules.length).toBe(Math.ceil(1440 / finest) + 1);
      expect(rules[0]?.at).toBe(0);
      expect(rules[0]?.level).toBe(0);
    }
  });

  it('covers the layer from edge to edge', () => {
    for (const { zoom, origin, dpr } of CASES) {
      const extent = 1440;
      const rules = gridRules(origin, extent, zoom, dpr);

      expect(rules[0]?.at ?? 1).toBeLessThanOrEqual(0);
      expect(rules.at(-1)?.at ?? 0).toBeGreaterThanOrEqual(extent * dpr);
    }
  });

  it('refuses a nonsense viewport rather than looping', () => {
    expect(gridRules(0, 0, 1, 1)).toEqual([]);
    expect(gridRules(0, 100, 0, 1)).toEqual([]);
    expect(gridRules(0, 100, Number.NaN, 1)).toEqual([]);
    expect(gridRules(0, 100, -1, 1)).toEqual([]);
  });
});
