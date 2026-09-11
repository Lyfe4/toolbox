import { describe, expect, it } from 'vitest';

import {
  GRID,
  GRID_MAJOR_EVERY,
  GRID_PITCH_FULL,
  GRID_PITCH_MIN,
  GRID_SUBDIVISIONS,
  gridLevelStrength,
  gridPitches,
  gridStrengths,
  gridStyle,
  MAX_ZOOM,
  MIN_ZOOM,
  wrapToTile,
} from './geometry';
import { zoomFactorForNotches } from './wheel';

/**
 * GRID PHASE-LOCK
 *
 * The grid used to be four background layers - a minor pair tiled at
 * `GRID * zoom` and a major pair at eight times that. Eight times a number IS
 * eight times that number, so the maths was never wrong; what broke was
 * rasterisation. Two tiles, rounded to device pixels independently, stop
 * agreeing about where the eighth line falls. At 90% the minor tile is 7.2px
 * and the major 57.6px, and the result was clustered rules and whole runs of
 * missing minor lines.
 *
 * There is one tile now, at the major size, with the minor rules drawn inside
 * it as fractions (see canvas.module.css). These tests hold the contract that
 * makes that work: one tile size, exactly `GRID_MAJOR_EVERY` minor squares to
 * it, and an offset anchored to the world origin.
 */

/** Zoom levels to sweep: the ends, the round ones, and the awkward ones. */
const ZOOMS = [
  MIN_ZOOM,
  0.25,
  0.3,
  0.33,
  0.4,
  0.5,
  0.6,
  0.66,
  0.7,
  0.75,
  0.8,
  // 0.9 is the one that was reported, and 1/3 and 7/9 are the worst binary
  // fractions in range.
  0.9,
  0.95,
  1,
  1 / 3,
  7 / 9,
  1.1,
  1.25,
  1.5,
  1.75,
  2,
  2.25,
  MAX_ZOOM,
];

/** Every zoom in the range, at a given resolution. The visual bugs were not at the round numbers. */
function sweep(from: number, to: number, steps: number): readonly number[] {
  return Array.from({ length: steps + 1 }, (_, i) => from + ((to - from) * i) / steps);
}

/** Pan offsets, including the large ones where float precision degrades. */
const OFFSETS = [0, 1, -1, 7, -7, 137, -137, 1024, -4096, 123456.789, -987654.321, 1e7, -1e7];

function tileFrom(style: { backgroundSize: string }): number {
  const first = style.backgroundSize.split(',')[0]?.trim().split(' ')[0] ?? '';
  return Number.parseFloat(first);
}

function positionsFrom(style: { backgroundPosition: string }): readonly number[] {
  const first = style.backgroundPosition.split(',')[0] ?? '';
  return first
    .trim()
    .split(' ')
    .map((part) => Number.parseFloat(part));
}

describe('the grid tile', () => {
  it.each(ZOOMS)('is exactly the major square at zoom %s', (zoom) => {
    const tile = tileFrom(gridStyle({ x: 0, y: 0, zoom }));
    expect(tile).toBeCloseTo(GRID * GRID_MAJOR_EVERY * zoom, 3);
  });

  it.each(ZOOMS)('holds a whole number of minor squares at zoom %s', (zoom) => {
    const tile = tileFrom(gridStyle({ x: 0, y: 0, zoom }));
    const minor = GRID * zoom;

    /*
     * Phase-lock, stated as arithmetic: the major rule lands on a minor rule
     * because the tile is a whole number of minor squares.
     *
     * To three places, because that is the precision the style is emitted at.
     * The tile's own rounding cannot break the lock in any case - the minor
     * rules are drawn as PERCENTAGES of whatever tile the browser ends up
     * with, so they follow it wherever it lands. That is the whole reason for
     * one tile instead of two.
     */
    expect(tile / minor).toBeCloseTo(GRID_MAJOR_EVERY, 3);
  });

  it('emits exactly one size, which is what stops the layers diverging', () => {
    const style = gridStyle({ x: 0, y: 0, zoom: 0.9 });
    const sizes = style.backgroundSize.split(',').map((part) => part.trim());

    /*
     * ONE value, not one per layer. There are eight background layers now -
     * the major pair and three subdivision pairs - and `background-size`
     * repeats its value list to cover them, so a single value applies to all
     * eight. That is stronger than emitting eight equal values: there is no
     * second number in the string that could ever come out different.
     */
    expect(sizes).toHaveLength(1);

    // Square tiles: the same value twice.
    const [width, height] = (sizes[0] ?? '').split(' ');
    expect(width).toBe(height);
  });

  it('emits exactly one offset, for the same reason', () => {
    const positions = gridStyle({ x: 13, y: -70, zoom: 1.1 })
      .backgroundPosition.split(',')
      .map((part) => part.trim());

    expect(positions).toHaveLength(1);
  });
});

/**
 * THE SCALE CASCADE
 *
 * Separate from the phase-lock contract above, and checked to be separate: the
 * phase-lock fix was about one tile instead of two, and this is about how many
 * of that tile's fractions are inked. The tests below hold the tile invariant
 * as well, at every rung, because a cascade that broke it would put the bug
 * back.
 *
 * What went wrong before was not arithmetic. The minor rules were drawn at a
 * fixed world pitch at every zoom, so their on-screen pitch ran from 2px at the
 * minimum to 20px at the maximum - a wash at one end and bare rules at the
 * other - and the only thing that changed with scale was a single
 * `opacity: 0.4` step below half zoom, which dimmed the whole layer instead of
 * thinning the grid. Three zooms, three surfaces.
 */
describe('the scale cascade', () => {
  const SWEEP = sweep(MIN_ZOOM, MAX_ZOOM, 400);

  it('never draws a level whose rules are closer than the legibility floor', () => {
    /*
     * THE 33% BUG, AS A PROPERTY. A level that is inked at all has to be
     * resolvable as lines, or it is a tint pretending to be a grid.
     */
    for (const zoom of SWEEP) {
      const pitches = gridPitches(zoom);
      const strengths = gridStrengths(zoom);

      pitches.forEach((pitch, index) => {
        if ((strengths[index] ?? 0) > 0) {
          expect(
            pitch,
            `zoom ${zoom.toString()}: a level at ${pitch.toString()}px is inked`,
          ).toBeGreaterThan(GRID_PITCH_MIN);
        }
      });
    }
  });

  it('always has a fully drawn level, between 8 and 20 px apart', () => {
    /*
     * THE 250% BUG, AS A PROPERTY, AND THE WHOLE POINT OF THE CASCADE.
     *
     * At 250% the minor rules had not actually vanished - they were 20px apart
     * and the ink was too faint to see, which is the colour half of this fix -
     * but the geometry has to hold up its end too. At EVERY zoom some
     * subdivision must be at full ink, and its pitch has to stay inside a
     * narrow band, or the backdrop is either bare major rules or a haze of
     * half-drawn ones.
     *
     * The band's ends are both derived. It can never be finer than
     * `GRID_PITCH_FULL`, which is `GRID` - the pitch the grid is authored at -
     * because that is where the ladder's floor is: `GRID` is the snap step and
     * a rule finer than it is a line nothing can land on. And it can never be
     * coarser than `GRID * MAX_ZOOM`, for the same reason read the other way -
     * the finest level is `GRID` world units, so at the maximum zoom that is
     * exactly how far apart it is. Neither end is a number anyone chose.
     */
    for (const zoom of SWEEP) {
      const pitches = gridPitches(zoom);
      const strengths = gridStrengths(zoom);

      const full = pitches.filter((_, index) => (strengths[index] ?? 0) >= 1);
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
     * is under the bottom. One soft edge, never a general haze.
     */
    for (const zoom of SWEEP) {
      const partial = gridStrengths(zoom).filter((value) => value > 0 && value < 1);
      expect(
        partial.length,
        `zoom ${zoom.toString()}: ${partial.length.toString()} part-drawn`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it('brings every level in coarsest first, and never out of order', () => {
    // A finer level must never be inked more heavily than a coarser one, or the
    // grid would show its subdivisions before the squares they subdivide.
    for (const zoom of SWEEP) {
      const strengths = gridStrengths(zoom);
      for (let i = 1; i < strengths.length; i += 1) {
        expect(strengths[i] ?? 0).toBeLessThanOrEqual((strengths[i - 1] ?? 0) + 1e-9);
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
     * gesture's step is a notch. So the sweep is multiplicative, by notches,
     * and the bound is on what one notch can do.
     *
     * A third is the number because a level's fade spans an octave, six notches
     * cover an octave, and smoothstep's steepest slope is 1.5 - so 1.5/6 is the
     * worst case and everything else is gentler. A hard switch would score 1.0
     * here, which is what this is really testing for.
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

  it('keeps the tile invariant at every rung of the cascade', () => {
    // The cascade changes which fractions are inked and nothing else. If it
    // ever changed the tile, the phase-lock bug would be back.
    for (const zoom of SWEEP) {
      const tile = tileFrom(gridStyle({ x: 0, y: 0, zoom }));
      expect(tile / (GRID * zoom)).toBeCloseTo(GRID_MAJOR_EVERY, 3);
    }
  });

  it.each([
    // The concrete picture at the three zooms that were reported, so the
    // abstract properties above have something recognisable beside them.
    [MIN_ZOOM, [1, 0, 0], 16],
    [0.33, [1, 0.242, 0], 21.1],
    [0.9, [1, 1, 0.896], 57.6],
    [1, [1, 1, 1], 64],
    [MAX_ZOOM, [1, 1, 1], 160],
  ])('at zoom %s draws %j with a major square of %s px', (zoom, expected, majorPitch) => {
    gridStrengths(zoom).forEach((value, index) => {
      expect(value).toBeCloseTo(expected[index] ?? 0, 3);
    });
    expect(tileFrom(gridStyle({ x: 0, y: 0, zoom }))).toBeCloseTo(majorPitch, 1);
  });

  it('writes the ink for each level as a unitless number the stylesheet can scale', () => {
    const style = gridStyle({ x: 0, y: 0, zoom: 1 });

    for (const value of [
      style['--canvas-grid-half'],
      style['--canvas-grid-quarter'],
      style['--canvas-grid-eighth'],
    ]) {
      const parsed = Number(value);
      expect(Number.isFinite(parsed), `${value} is not a number`).toBe(true);
      expect(parsed).toBeGreaterThanOrEqual(0);
      expect(parsed).toBeLessThanOrEqual(1);
    }
  });
});

describe('the grid offset', () => {
  it.each(OFFSETS)('wraps a pan of %s into the tile', (offset) => {
    const tile = 57.6;
    const wrapped = wrapToTile(offset, tile);

    expect(wrapped).toBeGreaterThanOrEqual(0);
    expect(wrapped).toBeLessThan(tile);
  });

  it('stays anchored to the world origin, not the viewport corner', () => {
    const tile = 57.6;
    // Panning by exactly one tile must land back on the same phase.
    expect(wrapToTile(0, tile)).toBeCloseTo(wrapToTile(tile, tile), 6);
    expect(wrapToTile(0, tile)).toBeCloseTo(wrapToTile(-tile, tile), 6);
    expect(wrapToTile(13, tile)).toBeCloseTo(wrapToTile(13 + tile * 5, tile), 6);
  });

  it('keeps a negative pan positive rather than mirroring the grid', () => {
    // A raw `%` gives -20.6 here, which CSS reads as an offset the other way.
    expect(wrapToTile(-20.6, 57.6)).toBeCloseTo(37, 1);
  });

  it('refuses to divide by a nonsense tile', () => {
    expect(wrapToTile(10, 0)).toBe(0);
    expect(wrapToTile(10, Number.NaN)).toBe(0);
  });
});

describe('the sweep that was broken', () => {
  /*
   * Every zoom crossed with every pan. The property is the same one at each
   * point: the offset sits inside the tile, and the tile is a whole number of
   * minor squares. Before the fix the second half held and the FIRST half was
   * left to the browser, whose `background-position` wrap on a large float is
   * where the phase drifted.
   */
  it('holds across the whole zoom and pan range', () => {
    for (const zoom of ZOOMS) {
      for (const offset of OFFSETS) {
        const style = gridStyle({ x: offset, y: -offset, zoom });
        const tile = tileFrom(style);
        const [x, y] = positionsFrom(style);

        expect(tile).toBeGreaterThan(0);
        expect(tile / (GRID * zoom)).toBeCloseTo(GRID_MAJOR_EVERY, 3);

        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(tile);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThan(tile);
      }
    }
  });

  it('gives the same phase for offsets a whole number of tiles apart', () => {
    for (const zoom of ZOOMS) {
      const base = gridStyle({ x: 11, y: 11, zoom });
      // Shifted by the tile the STYLE emits, which is the one the browser
      // sees, rather than the unrounded arithmetic behind it.
      const tile = tileFrom(base);
      const shifted = gridStyle({ x: 11 + tile * 37, y: 11 - tile * 37, zoom });

      const [bx] = positionsFrom(base);
      const [sx] = positionsFrom(shifted);
      // Rendered to 3dp, so compare at that precision rather than exactly.
      expect(sx ?? 0).toBeCloseTo(bx ?? 0, 2);
    }
  });
});
