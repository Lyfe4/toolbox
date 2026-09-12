import { describe, expect, it } from 'vitest';

import { GRID, MAX_ZOOM, MIN_ZOOM } from './geometry';
import {
  GRID_MAJOR_EVERY,
  GRID_PITCH_FULL,
  GRID_PITCH_MIN,
  GRID_RANKS,
  gridLevels,
  gridLevelStrength,
  gridLevelWeight,
  gridOctave,
  gridPitches,
  gridRules,
  gridStrengths,
  gridWeights,
} from './grid';
import { zoomFactorForNotches } from './wheel';

/**
 * THE GRID.
 *
 * Four defects have been fixed here in turn, and every one of them was
 * invisible to the whole gate until a person photographed it. The groups below
 * are named for which one they hold down, because the later fixes subsumed the
 * MECHANISM of the earlier ones and it is worth saying what still needs
 * checking.
 *
 * 1. PHASE-LOCK. A minor pair tiled at `GRID * zoom` and a major pair at eight
 *    times that are rasterised independently, each rounded to device pixels on
 *    its own, so the major rule stops landing on a minor one. That was fixed by
 *    one tile with the subdivisions as fractions of it, and there is no tile at
 *    all now - every rule is placed individually. What survives is the
 *    PROPERTY: the rules form one lattice with nothing missing and nothing
 *    extra, and the heavy rule always sits on it.
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
 *
 * 4. THE HEAVY RULE DID NOT CASCADE. Everything else about the ladder was
 *    anchored to the screen and the major square was anchored to the world, so
 *    the PROPORTION of heavy rules on screen swept from one in two at 25% to
 *    one in sixteen at 250%: the same ink arranged into a different picture at
 *    each end of the range. Fixed by moving the whole ladder in octaves, which
 *    is what the scale-invariance group asserts and what makes the density
 *    group exact rather than bounded.
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

/**
 * A rank named by the world it measures rather than by its slot in the array.
 *
 * WHICH IS THE ONLY WAY TO COMPARE TWO ZOOMS NOW THE LADDER MOVES. Index 4 is
 * the finest rank at whatever octave the zoom folds to, so it names a 16-world-
 * unit rule at 49% and an 8-world-unit rule at 51% - and an assertion that
 * compares index against index across that boundary reads a continuous picture
 * as a jump from full ink to none. `key` is `log2(pitch / GRID)`, an integer
 * that names the same rule at every zoom.
 *
 * Off the end of the ladder the answer is the rank's limit rather than nothing:
 * anything coarser than the heavy rule would be drawn heavy, anything finer
 * than the finest is not drawn at all. Those are the values that make the
 * comparison continuous, and they are also simply true.
 */
function rankAt(zoom: number, key: number): { strength: number; weight: number } {
  const levels = gridLevels(zoom);
  const keys = levels.map((level) => Math.round(Math.log2(level.pitch / GRID)));
  const found = levels[keys.indexOf(key)];

  if (found) return found;
  return key > Math.max(...keys) ? { strength: 1, weight: 1 } : { strength: 0, weight: 0 };
}

/** Every rank on screen at either of two zooms, named the same way in both. */
function keysAcross(...zooms: readonly number[]): readonly number[] {
  return [
    ...new Set(
      zooms.flatMap((zoom) =>
        gridLevels(zoom).map((level) => Math.round(Math.log2(level.pitch / GRID))),
      ),
    ),
  ];
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

  it('always has a fully drawn level, between 8 and 16 px apart', () => {
    /*
     * THE 250% BUG, AS A PROPERTY. At every zoom SOME level must be at full ink
     * and its pitch has to stay inside a narrow band, or the backdrop is either
     * bare heavy rules or a haze of half-drawn ones.
     *
     * Both ends are derived and the band is now exactly an octave: the finest
     * fully inked rank can never be finer than `GRID_PITCH_FULL` - the pitch the
     * grid is authored at - and never coarser than twice that, because at twice
     * that the ladder has already stepped an octave. It used to run to
     * `GRID * MAX_ZOOM`, which is 20px, because above 200% the ladder ran out.
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
      expect(finest).toBeLessThan(2 * GRID_PITCH_FULL);
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

  it('has at most one level part-major, and never the one that is part-drawn', () => {
    /*
     * WHAT LETS `GridLayer` PAINT THE CROSSFADE AS ONE FILL OVER ANOTHER.
     *
     * A rank on its way from the minor ink to the major one is drawn twice: the
     * minor ink at full alpha, then the major over it at the weight. That is
     * exactly a mix of the two ONLY while the rank underneath is opaque. If a
     * rank could be part-inked and part-heavy at once, the second fill would
     * land on rules the first had already made translucent and the result would
     * read lighter than either ink - a rank that dips as it changes weight.
     *
     * It cannot happen, and not by luck: the two ramps are `GRID_MAJOR_EVERY`
     * apart in pitch, which is three doublings, on a ladder five ranks long.
     */
    for (const zoom of SWEEP) {
      const levels = gridLevels(zoom);
      const partlyHeavy = levels.filter((level) => level.weight > 0 && level.weight < 1);

      expect(
        partlyHeavy.length,
        `zoom ${zoom.toString()}: ${partlyHeavy.length.toString()} levels part-major`,
      ).toBeLessThanOrEqual(1);

      for (const level of levels) {
        const both = level.strength > 0 && level.strength < 1 && level.weight > 0;
        expect(both, `zoom ${zoom.toString()}: a level is part-drawn and heavy at once`).toBe(
          false,
        );
      }
    }
  });

  it('brings every level in coarsest first, and never out of order', () => {
    // A finer level must never be inked more heavily, or weighted more heavily,
    // than a coarser one - or the grid would show its subdivisions before the
    // squares they subdivide.
    for (const zoom of SWEEP) {
      for (const ladder of [gridStrengths(zoom), gridWeights(zoom)]) {
        for (let index = 1; index < ladder.length; index += 1) {
          expect(ladder[index] ?? 0).toBeLessThanOrEqual((ladder[index - 1] ?? 0) + 1e-9);
        }
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
     *
     * THE WEIGHT IS HELD TO THE SAME BOUND, because a rule changing weight is
     * exactly as visible as one appearing, and it is the new thing the cascade
     * introduced. Both ramps are linear over an octave, so both score a sixth.
     *
     * AND IT IS ASKED RANK BY RANK, NOT SLOT BY SLOT - see `rankAt`. The whole
     * ladder shifts by one slot every time the zoom crosses a power of two, so
     * comparing index against index across that boundary would report the
     * smoothest moment in the range as the most violent one.
     */
    const step = zoomFactorForNotches(1);
    for (let zoom = MIN_ZOOM; zoom <= MAX_ZOOM; zoom *= step ** 0.25) {
      const next = Math.min(zoom * step, MAX_ZOOM);

      for (const key of keysAcross(zoom, next)) {
        const before = rankAt(zoom, key);
        const after = rankAt(next, key);

        for (const measure of ['strength', 'weight'] as const) {
          expect(
            Math.abs(after[measure] - before[measure]),
            `${measure} of the ${(GRID * 2 ** key).toString()}-unit rule moves too far in one notch from ${zoom.toFixed(3)}`,
          ).toBeLessThan(1 / 3);
        }
      }
    }
  });

  it('fades a rank in, and changes its weight, over exactly one octave each', () => {
    /*
     * Stated directly rather than inferred from a sweep: the zoom at which a
     * rank reaches full ink is exactly twice the zoom at which it starts to
     * appear, and the same is true of its weight. That doubling is what makes
     * "at most one level part-drawn" true, and it is the one relationship in the
     * cascade that has to be exact.
     */
    for (const multiple of GRID_RANKS) {
      const worldPitch = GRID * multiple;

      for (const [ramp, over] of [
        [gridLevelStrength, worldPitch],
        [gridLevelWeight, worldPitch / GRID_MAJOR_EVERY],
      ] as const) {
        const starts = GRID_PITCH_MIN / over;
        const completes = GRID_PITCH_FULL / over;

        expect(completes / starts).toBeCloseTo(2, 12);
        expect(ramp(worldPitch, starts)).toBe(0);
        expect(ramp(worldPitch, completes)).toBe(1);
        expect(ramp(worldPitch, Math.sqrt(starts * completes))).toBeGreaterThan(0);
      }
    }
  });

  it('refuses a nonsense zoom rather than returning nonsense pitches', () => {
    /*
     * `gridOctave` raises two to a computed power, so a zoom of zero would put
     * every world pitch at infinity and `gridRules` would then step the lattice
     * by NaN. The guard is in the octave rather than at each caller because it
     * is the only place a zoom becomes an exponent.
     */
    for (const zoom of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(gridOctave(zoom)).toBe(1);
      for (const level of gridLevels(zoom)) expect(Number.isFinite(level.pitch)).toBe(true);
    }
  });
});

/**
 * SCALE INVARIANCE
 *
 * The point of the whole ladder, and the thing the fourth fix bought. Everything
 * about the grid used to be anchored to the screen except the heavy rule, which
 * was anchored to the world at `GRID * GRID_MAJOR_EVERY`. So a major square was
 * 16px across at 25%, where every second rule on screen was heavy, and 160px at
 * 250%, where one in sixteen was - the same ink arranged into two different
 * pictures.
 *
 * Now the heavy rule cascades with the rest, and what falls out is stronger than
 * "looks similar": the picture depends on `log2(zoom)` MOD 1 and on nothing
 * else, so the view at any zoom is pixel-for-pixel the ladder at twice that
 * zoom. What it costs is the property this replaced - a major square is 32 snap
 * steps at the bottom of the range and 4 at the top - and that is asserted too,
 * because a price that is not written down gets paid twice.
 */
describe('scale invariance', () => {
  it('draws the same picture at every octave', () => {
    // The headline. Same screen pitches, same ink, same weights, at z and 2z.
    for (const zoom of [...SWEEP, ...ZOOMS]) {
      const here = gridLevels(zoom);
      const octaveUp = gridLevels(zoom * 2);

      expect(octaveUp.length).toBe(here.length);
      here.forEach((level, index) => {
        const other = octaveUp[index];
        const at = `zoom ${zoom.toFixed(4)}, level ${index.toString()}`;

        expect((other?.pitch ?? 0) * zoom * 2, `${at}: screen pitch`).toBeCloseTo(
          level.pitch * zoom,
          9,
        );
        expect(other?.strength, `${at}: ink`).toBeCloseTo(level.strength, 9);
        expect(other?.weight, `${at}: weight`).toBeCloseTo(level.weight, 9);
      });
    }
  });

  it('keeps the ladder inside one octave of the zoom', () => {
    // `gridOctave` is the only thing that varies with zoom, and all it does is
    // fold the zoom into [1, 2). Everything downstream reads that fold.
    for (const zoom of [...SWEEP, ...ZOOMS]) {
      const folded = zoom * gridOctave(zoom);

      expect(Number.isInteger(Math.log2(gridOctave(zoom))), `zoom ${zoom.toString()}`).toBe(true);
      expect(folded, `zoom ${zoom.toString()}`).toBeGreaterThanOrEqual(1 - 1e-12);
      expect(folded, `zoom ${zoom.toString()}`).toBeLessThanOrEqual(2 + 1e-12);
    }
  });

  it('puts a heavy rule every eight fully drawn squares, at every zoom', () => {
    /*
     * WHAT THE MAJOR SQUARE MEANS NOW. Not a fixed amount of world - a fixed
     * amount of SCREEN, measured in the squares that are actually on it. The
     * heavy rank is `GRID_MAJOR_EVERY` times the finest rank at full ink, which
     * is the sentence "eight squares to a major square" said about the picture
     * instead of about the document.
     */
    for (const zoom of [...SWEEP, ...ZOOMS]) {
      const levels = gridLevels(zoom);
      const heavy = levels[0];
      const finestFull = levels.filter((level) => level.strength >= 1).at(-1);

      expect(heavy?.strength).toBe(1);
      expect(heavy?.weight).toBe(1);
      expect((heavy?.pitch ?? 0) / (finestFull?.pitch ?? 1), `zoom ${zoom.toString()}`).toBeCloseTo(
        GRID_MAJOR_EVERY,
        9,
      );
    }
  });

  it('no longer means a fixed number of snap steps, which is the price', () => {
    /*
     * THE COST, ASSERTED SO IT IS NOT REDISCOVERED AS A BUG. A major square was
     * always eight snap steps and now it is 32 at the bottom of the range and 4
     * at the top. Nothing reads it: there is no ruler, no readout in squares,
     * and `snap` is `GRID` whatever the grid is drawing. If something ever does
     * read it, this test is where the conflict shows up.
     */
    const steps = (zoom: number): number => (gridLevels(zoom)[0]?.pitch ?? 0) / GRID;

    expect(steps(MIN_ZOOM)).toBe(32);
    expect(steps(1)).toBe(GRID_MAJOR_EVERY);
    expect(steps(MAX_ZOOM)).toBe(4);
  });
});

/**
 * APPARENT DENSITY
 *
 * The complaint that outlived the first two fixes: at 40% the surface read
 * lighter and grainier than at 89%, and the whole range was asked to look the
 * same in character. Most of that was rasterisation - a split rule is
 * composited in sRGB and reads lighter than a crisp one carrying identical ink
 * - but not all of it, and the residue took two more passes. The ladder used to
 * stop at `GRID`, so above 100% the cascade stopped too and the grid simply
 * thinned; then, once it did not, what was left was the heavy rule being
 * anchored to the world while everything else was anchored to the screen.
 *
 * Ink per unit length is the thing to hold, and it can be computed exactly
 * rather than photographed. A rank's rules land every `pitch`, but half of them
 * are claimed by the rank above, so each rank below the heaviest contributes
 * `strength / (2 * pitch)` - weighted by how heavy its own ink is.
 */
function inkPerHundredPixels(
  zoom: number,
  levels = gridLevels(zoom),
  major = 1,
  minor = 1,
): number {
  const heavy = levels[0];
  if (!heavy) return 0;

  /** A rank's ink per screen pixel: how often it lands, times how dark it is. */
  const contribution = (level: (typeof levels)[number], every: number): number =>
    (level.strength * (minor + (major - minor) * level.weight)) / (every * zoom);

  let ink = contribution(heavy, heavy.pitch);
  for (const level of levels.slice(1)) ink += contribution(level, 2 * level.pitch);

  return ink * 100;
}

describe('apparent density', () => {
  it('is exactly the authored density across the whole zoom range', () => {
    /*
     * EXACTLY, not approximately, and ACROSS THE WHOLE RANGE rather than up to
     * 200%. Two separate facts hold it there:
     *
     *   - the linear ramp is the unique ink curve that conserves ink while a
     *     rank fades, derived on `gridLevelStrength`;
     *   - the ladder is anchored to the screen, so it never runs out. It used to
     *     stop at `GRID * 0.5` in the world, and above 200% there was nothing
     *     left to fade in: the grid could only spread, to 10px at 250% against
     *     the 8px it is authored at, which was a fifth of the range at 80% of
     *     the right density. That stretch is gone rather than bounded.
     *
     * Smoothstep, for its part, put this up to 5% over, peaking around 45%.
     */
    for (const zoom of SWEEP) {
      expect(inkPerHundredPixels(zoom), `zoom ${zoom.toFixed(4)}`).toBeCloseTo(100 / GRID, 9);
    }
  });

  it('holds it whatever the two inks weigh', () => {
    /*
     * THE CROSSFADE'S SHAPE, AS THE REASON IT IS NOT A FREE CHOICE. A rank
     * changing from minor to major changes the surface's ink unless the ramp is
     * exactly linear in the folded zoom - and that is true for ANY pair of inks,
     * which is what keeps a theme from being able to break the density by
     * picking a heavier major rule. `themes.css` can, and does, vary the ratio.
     */
    for (const [major, minor] of [
      [1, 1],
      [2, 1],
      [3, 1],
      [1.4, 0.9],
      [8, 1],
    ]) {
      const authored = (100 * ((major ?? 1) + 7 * (minor ?? 1))) / (GRID * GRID_MAJOR_EVERY);

      for (const zoom of SWEEP) {
        expect(
          inkPerHundredPixels(zoom, gridLevels(zoom), major, minor),
          `zoom ${zoom.toFixed(4)} at major ${String(major)} / minor ${String(minor)}`,
        ).toBeCloseTo(authored, 9);
      }
    }
  });

  it('would swing by an octave without the finest rank', () => {
    /*
     * THE REASON THE LADDER GOES BELOW THE SNAP STEP, stated as the number it
     * buys. Drop the finest rank and there is nothing fading in, so the grid
     * spreads from 8px to 16px across every octave and snaps back - a factor of
     * two in density at every power of two, rather than the once-across-the-
     * range it used to be.
     */
    const inks = SWEEP.map((zoom) => inkPerHundredPixels(zoom, gridLevels(zoom).slice(0, -1)));

    expect(Math.max(...inks) / Math.min(...inks)).toBeGreaterThan(1.9);
  });

  it.each(ZOOMS)('is the authored density at zoom %s', (zoom) => {
    expect(inkPerHundredPixels(zoom)).toBeCloseTo(100 / GRID, 9);
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
     * PHASE-LOCK, RESTATED FOR A GRID WITH NO TILE. A multiple of 64 is a
     * multiple of 4, 8, 16 and 32 as well, so without this every heavy rule
     * would also be drawn as an eighth, a quarter and a half - four inks
     * stacked, making every eighth rule darker than its token asks for. That is
     * the same visual defect the original bug produced, by a different route.
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
