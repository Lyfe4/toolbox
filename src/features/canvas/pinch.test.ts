import { describe, expect, it } from 'vitest';

import { pinchPair, pinchSample, pinchStep } from './pinch';

/**
 * The arithmetic behind two-finger gestures, tested where the awkward cases
 * are cheap to reproduce: two fingers on the same pixel, a pair that shrinks
 * to nothing, a third contact arriving mid-gesture.
 */

describe('pinchSample', () => {
  it('measures the distance and the midpoint', () => {
    const sample = pinchSample({ x: 0, y: 0 }, { x: 6, y: 8 });

    expect(sample.distance).toBe(10);
    expect(sample.midpoint).toEqual({ x: 3, y: 4 });
  });

  it('does not care which finger is which', () => {
    const a = pinchSample({ x: 10, y: 20 }, { x: 30, y: 60 });
    const b = pinchSample({ x: 30, y: 60 }, { x: 10, y: 20 });

    expect(a).toEqual(b);
  });
});

describe('pinchStep', () => {
  it('reports the ratio of the spread as the zoom factor', () => {
    const before = pinchSample({ x: 0, y: 0 }, { x: 100, y: 0 });
    const after = pinchSample({ x: 0, y: 0 }, { x: 200, y: 0 });

    expect(pinchStep(before, after).factor).toBe(2);
  });

  it('reports a factor below 1 when the fingers close', () => {
    const before = pinchSample({ x: 0, y: 0 }, { x: 200, y: 0 });
    const after = pinchSample({ x: 0, y: 0 }, { x: 100, y: 0 });

    expect(pinchStep(before, after).factor).toBe(0.5);
  });

  it('reports the midpoint movement as a pan', () => {
    const before = pinchSample({ x: 0, y: 0 }, { x: 100, y: 0 });
    const after = pinchSample({ x: 40, y: 30 }, { x: 140, y: 30 });

    const step = pinchStep(before, after);

    // Same spread, so no zoom - the whole gesture is a translation.
    expect(step.factor).toBe(1);
    expect(step.pan).toEqual({ x: 40, y: 30 });
  });

  it('zooms about the newer midpoint', () => {
    const before = pinchSample({ x: 100, y: 100 }, { x: 200, y: 100 });
    const after = pinchSample({ x: 80, y: 100 }, { x: 220, y: 100 });

    expect(pinchStep(before, after).at).toEqual({ x: 150, y: 100 });
  });

  it('never divides by zero when two fingers land on the same pixel', () => {
    // `next / 0` is Infinity, which would slam the zoom to its limit in one
    // frame and read as the canvas exploding.
    const together = pinchSample({ x: 50, y: 50 }, { x: 50, y: 50 });
    const apart = pinchSample({ x: 0, y: 0 }, { x: 100, y: 0 });

    expect(pinchStep(together, apart).factor).toBe(1);
    expect(Number.isFinite(pinchStep(together, apart).factor)).toBe(true);
  });

  it('treats a collapse to nothing as a pan rather than a zoom to zero', () => {
    const apart = pinchSample({ x: 0, y: 0 }, { x: 100, y: 0 });
    const together = pinchSample({ x: 50, y: 0 }, { x: 50, y: 0 });

    expect(pinchStep(apart, together).factor).toBe(1);
  });

  it('is stable when nothing moves', () => {
    const sample = pinchSample({ x: 10, y: 10 }, { x: 110, y: 60 });
    const step = pinchStep(sample, sample);

    expect(step.factor).toBe(1);
    expect(step.pan).toEqual({ x: 0, y: 0 });
  });
});

describe('pinchPair', () => {
  it('is null with fewer than two pointers', () => {
    expect(pinchPair(new Map())).toBeNull();
    expect(pinchPair(new Map([[1, {}]]))).toBeNull();
  });

  it('takes the first two fingers down, in order', () => {
    expect(
      pinchPair(
        new Map([
          [7, {}],
          [3, {}],
        ]),
      ),
    ).toEqual([7, 3]);
  });

  it('ignores a third finger arriving later', () => {
    // Insertion order, not numeric order: a thumb resting mid-gesture must not
    // change what is being measured, or the zoom jumps.
    const pointers = new Map([
      [1, {}],
      [2, {}],
    ]);
    pointers.set(9, {});

    expect(pinchPair(pointers)).toEqual([1, 2]);
  });
});
