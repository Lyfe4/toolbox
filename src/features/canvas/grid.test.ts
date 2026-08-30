import { describe, expect, it } from 'vitest';

import { GRID, GRID_MAJOR_EVERY, gridStyle, MAX_ZOOM, MIN_ZOOM, wrapToTile } from './geometry';

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

  it('emits one size for both axes and both layers, so nothing can diverge', () => {
    const style = gridStyle({ x: 0, y: 0, zoom: 0.9 });
    const sizes = style.backgroundSize.split(',').map((part) => part.trim());

    expect(sizes).toHaveLength(2);
    expect(new Set(sizes).size).toBe(1);
    // Square tiles: the same value twice.
    const [width, height] = (sizes[0] ?? '').split(' ');
    expect(width).toBe(height);
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
