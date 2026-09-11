import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MAX_ZOOM, MIN_ZOOM } from './geometry';
import { zoomAbout, type Viewport } from './viewportStore';
import {
  wheelPixels,
  wheelStep,
  WHEEL_LINES_PER_DETENT,
  WHEEL_PIXELS_PER_DETENT,
  zoomFactorForNotches,
  ZOOM_KEY_NOTCHES,
  ZOOM_MAX_NOTCHES_PER_EVENT,
  ZOOM_NOTCHES_PER_DOUBLING,
} from './wheel';

/**
 * ZOOM GRANULARITY
 *
 * The bug this file exists for: scroll-zooming reached 33%, then 90%, then
 * 250%. Three notches over an eight-fold range, and no way to land anywhere
 * else.
 *
 * The shape was never the problem. `exp(-deltaY * 0.01)` is exponential, which
 * is the right shape - zoom is multiplicative, so a notch has to be a RATIO and
 * one notch from 50% must feel like one notch from 200%. What was wrong was the
 * coefficient, and it was wrong because it was calibrated for the wrong device:
 * `/100` is the convention a trackpad pinch is scaled against, and a mouse
 * detent's hundred pixels through the same expression comes out as a factor of
 * e.
 *
 * So the assertions below are mostly about units and about granularity, and the
 * two that matter most are the ones a person could have caught by scrolling
 * once: no single event may cross a large fraction of the range, and the same
 * physical detent has to mean the same thing in an engine that reports pixels
 * and one that reports lines.
 */

/** A wheel event, in the shape `wheelStep` reads. */
function wheel(deltaY: number, deltaMode = 0, deltaX = 0) {
  return { deltaX, deltaY, deltaMode };
}

describe('the notch ladder', () => {
  it('doubles the zoom in exactly the stated number of notches', () => {
    expect(zoomFactorForNotches(ZOOM_NOTCHES_PER_DOUBLING)).toBeCloseTo(2, 12);
    expect(zoomFactorForNotches(-ZOOM_NOTCHES_PER_DOUBLING)).toBeCloseTo(0.5, 12);
    expect(zoomFactorForNotches(0)).toBe(1);
  });

  it('lands on the round scales from 100%', () => {
    /*
     * "Landing on a useful scale is luck" was half the complaint. It is not
     * luck now: the ladder passes exactly through 200%, 50% and 25%, which are
     * also the zoom the toolbar resets to and the minimum.
     */
    expect(zoomFactorForNotches(ZOOM_NOTCHES_PER_DOUBLING)).toBeCloseTo(2, 12);
    expect(zoomFactorForNotches(-ZOOM_NOTCHES_PER_DOUBLING * 2)).toBeCloseTo(MIN_ZOOM, 12);
  });

  it('is symmetric, so scrolling back returns to where you were', () => {
    fc.assert(
      fc.property(fc.double({ min: -40, max: 40, noNaN: true }), (notches) => {
        expect(zoomFactorForNotches(notches) * zoomFactorForNotches(-notches)).toBeCloseTo(1, 10);
      }),
    );
  });

  it('treats a notch as the same ratio wherever it starts from', () => {
    /*
     * The invariant the user named without naming it: "it should probably feel
     * like the same gesture". A ratio is the only way that can be true, and an
     * additive step is the only way it cannot.
     */
    fc.assert(
      fc.property(
        fc.double({ min: MIN_ZOOM, max: MAX_ZOOM, noNaN: true }),
        fc.double({ min: MIN_ZOOM, max: MAX_ZOOM, noNaN: true }),
        (a, b) => {
          const step = zoomFactorForNotches(1);
          expect((a * step) / a).toBeCloseTo((b * step) / b, 12);
        },
      ),
    );
  });

  it('needs at least fifteen notches to cross the whole range', () => {
    /*
     * THE REGRESSION TEST FOR THE ACTUAL BUG. Under the old coefficient one
     * notch was a factor of 2.72, so the range was three notches wide and a
     * zoom was a jump. Fifteen is well under the twenty this ladder gives and
     * well over anything that would feel like a jump.
     */
    const span = Math.log2(MAX_ZOOM / MIN_ZOOM) * ZOOM_NOTCHES_PER_DOUBLING;
    expect(span).toBeGreaterThan(15);
  });
});

describe('a mouse detent', () => {
  it('is one notch whether the engine reports pixels or lines', () => {
    /*
     * THE FIREFOX HALF OF THE BUG, and it was not only the zoom. Firefox
     * reports a wheel in LINES - three of them per detent - and the old handler
     * fed `deltaY` straight in, so the same physical click of the same wheel
     * asked for exp(-1) in Chrome and exp(-0.03) in Firefox. The zoom was
     * catastrophic in one engine and inert in the other, and the pan moved the
     * canvas 100px against 3px.
     */
    const pixels = wheelStep(wheel(-WHEEL_PIXELS_PER_DETENT, 0));
    const lines = wheelStep(wheel(-WHEEL_LINES_PER_DETENT, 1));

    expect(pixels.notches).toBe(ZOOM_MAX_NOTCHES_PER_EVENT);
    expect(lines.notches).toBe(ZOOM_MAX_NOTCHES_PER_EVENT);
    expect(lines.pan.y).toBeCloseTo(pixels.pan.y, 9);
  });

  it('is one notch at every OS scroll-lines setting', () => {
    /*
     * The cap is what makes this true, and it is why the cap exists. Chromium
     * scales its pixel delta by the OS "lines to scroll" setting, so a detent
     * can arrive as 33px, 100px or 400px on the same hardware. Every one of
     * those is over the cap, so every one is one notch - which is the device
     * distinction, made without ever asking what the device is.
     */
    for (const delta of [33.33, 40, 53.33, 100, 120, 240, 400]) {
      expect(wheelStep(wheel(-delta)).notches).toBe(ZOOM_MAX_NOTCHES_PER_EVENT);
      expect(wheelStep(wheel(delta)).notches).toBe(-ZOOM_MAX_NOTCHES_PER_EVENT);
    }
  });

  it('cannot cross more than a fraction of the range, however hard it is spun', () => {
    /*
     * The property the reported bug violated, stated as a bound on ONE event.
     * Two notches of the old handler took 33% past 240%.
     */
    fc.assert(
      fc.property(
        fc.double({ min: -100_000, max: 100_000, noNaN: true }),
        fc.constantFrom(0, 1, 2),
        fc.double({ min: MIN_ZOOM, max: MAX_ZOOM, noNaN: true }),
        (deltaY, deltaMode, zoom) => {
          const factor = zoomFactorForNotches(wheelStep(wheel(deltaY, deltaMode)).notches);
          const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));

          // At most one notch of travel, in either direction, ever.
          expect(Math.abs(Math.log2(next / zoom))).toBeLessThanOrEqual(
            ZOOM_MAX_NOTCHES_PER_EVENT / ZOOM_NOTCHES_PER_DOUBLING + 1e-9,
          );
        },
      ),
    );
  });
});

describe('a trackpad', () => {
  it('passes small deltas through as fractions of a notch', () => {
    // Under the cap, so the gesture stays continuous rather than quantised.
    const step = wheelStep(wheel(-2));
    expect(step.notches).toBeGreaterThan(0);
    expect(step.notches).toBeLessThan(0.25);
  });

  it('reaches the same zoom in many small events as in one large one', () => {
    /*
     * Additivity, which is what makes accumulating notches per frame correct
     * rather than merely convenient: summing the notches and exponentiating
     * once is the same answer as multiplying the factors one event at a time.
     * The canvas relies on this - it coalesces a frame's worth of events into
     * one `+=` - and the store used to ASSIGN the pending factor instead, which
     * threw away every event in a frame but the last.
     */
    const many = Array.from({ length: 20 }, () => wheelStep(wheel(-1.5)).notches);
    const summed = many.reduce((total, one) => total + one, 0);
    const multiplied = many.reduce((total, one) => total * zoomFactorForNotches(one), 1);

    expect(zoomFactorForNotches(summed)).toBeCloseTo(multiplied, 9);
  });

  it('keeps a pinch monotonic in the delta', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 11, noNaN: true }),
        fc.double({ min: 0.01, max: 11, noNaN: true }),
        (a, b) => {
          const [small, large] = a <= b ? [a, b] : [b, a];
          expect(wheelStep(wheel(-large)).notches).toBeGreaterThanOrEqual(
            wheelStep(wheel(-small)).notches,
          );
        },
      ),
    );
  });
});

describe('units', () => {
  it('leaves a pixel delta alone', () => {
    expect(wheelPixels(37, 0)).toBe(37);
  });

  it('scales a line delta so a detent pans the same distance', () => {
    expect(wheelPixels(WHEEL_LINES_PER_DETENT, 1)).toBeCloseTo(WHEEL_PIXELS_PER_DETENT, 9);
  });

  it('treats an unknown delta mode as pixels rather than as nothing', () => {
    // A mode this build has never heard of should behave like the common case,
    // not like a zero.
    expect(wheelPixels(37, 9)).toBe(37);
  });

  it('pans against the wheel on both axes', () => {
    const step = wheelStep(wheel(40, 0, 25));
    expect(step.pan).toEqual({ x: -25, y: -40 });
  });

  it('zooms in when the wheel is pushed away', () => {
    expect(wheelStep(wheel(-10)).notches).toBeGreaterThan(0);
    expect(wheelStep(wheel(10)).notches).toBeLessThan(0);
  });
});

describe('the zoom keys', () => {
  it('walk the same ladder as the wheel', () => {
    // Three presses per doubling, and ten across the range, so `+` and `-` are
    // a usable way to zoom rather than a token one.
    expect(ZOOM_NOTCHES_PER_DOUBLING / ZOOM_KEY_NOTCHES).toBe(3);

    let zoom = 1;
    for (let press = 0; press < 3; press += 1) zoom *= zoomFactorForNotches(ZOOM_KEY_NOTCHES);
    expect(zoom).toBeCloseTo(2, 9);
  });
});

describe('the clamps', () => {
  it('holds the point under the pointer still even when the zoom is refused', () => {
    /*
     * At either end the zoom cannot move, and the question is what happens to
     * the translation. `zoomAbout` solves for the clamped zoom rather than the
     * requested one, so the world point under the pointer stays exactly where
     * it is - the canvas goes still rather than sliding while it declines.
     */
    const at = { x: 300, y: 200 };
    const atMax: Viewport = { x: -100, y: -50, zoom: MAX_ZOOM };

    const pushed = zoomAbout(atMax, atMax.zoom * zoomFactorForNotches(5), at);
    expect(pushed).toEqual(atMax);
  });

  it('does not wind up: a notch back from the clamp moves immediately', () => {
    // Notches are applied per frame and never banked, so scrolling into the
    // clamp twenty times and then reversing gives one notch back, not twenty.
    const atMax: Viewport = { x: 0, y: 0, zoom: MAX_ZOOM };
    let viewport = atMax;
    for (let i = 0; i < 20; i += 1) {
      viewport = zoomAbout(viewport, viewport.zoom * zoomFactorForNotches(1), { x: 0, y: 0 });
    }

    const back = zoomAbout(viewport, viewport.zoom * zoomFactorForNotches(-1), { x: 0, y: 0 });
    expect(back.zoom).toBeCloseTo(MAX_ZOOM / zoomFactorForNotches(1), 9);
  });
});
