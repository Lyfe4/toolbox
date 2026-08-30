import type { Point } from './types';

/**
 * Two-finger gesture maths.
 *
 * Kept apart from the canvas component and free of any DOM, because the
 * interesting failures here are arithmetic ones - a divide by zero when two
 * fingers land on the same pixel, a factor that inverts, a midpoint that drifts
 * - and those are far easier to pin down in a unit test than by pinching a
 * phone.
 */

/** A single reading of a two-finger gesture. */
export interface PinchSample {
  /** Distance between the two pointers, in px. */
  readonly distance: number;
  /** Point halfway between them, in the same coordinate space as the inputs. */
  readonly midpoint: Point;
}

/** What changed between two readings. */
export interface PinchStep {
  /** Multiply the current zoom by this. 1 means the fingers held their spread. */
  readonly factor: number;
  /** Where to zoom about - the midpoint of the newer reading. */
  readonly at: Point;
  /** How far the midpoint travelled, which is the two-finger pan. */
  readonly pan: Point;
}

export function pinchSample(a: Point, b: Point): PinchSample {
  return {
    distance: Math.hypot(a.x - b.x, a.y - b.y),
    midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
  };
}

/**
 * Below this the distance is treated as unusable rather than divided by.
 *
 * Two fingers genuinely can report the same coordinates - a stray palm
 * contact, a synthetic event, a screen rounding both touches to one pixel -
 * and `next / 0` is Infinity, which would slam the zoom to its maximum in one
 * frame and look like the canvas exploding.
 */
const MIN_DISTANCE = 1;

export function pinchStep(previous: PinchSample, next: PinchSample): PinchStep {
  const usable = previous.distance >= MIN_DISTANCE && next.distance >= MIN_DISTANCE;

  return {
    // Not usable means "the fingers moved but did not spread", which is a pan.
    factor: usable ? next.distance / previous.distance : 1,
    at: next.midpoint,
    pan: {
      x: next.midpoint.x - previous.midpoint.x,
      y: next.midpoint.y - previous.midpoint.y,
    },
  };
}

/**
 * Picks the two pointers a pinch should track.
 *
 * Insertion order, so it is the first two fingers down - a third finger
 * arriving mid-gesture is recorded but does not change what is being measured,
 * which is what stops the zoom jumping when someone rests a thumb.
 */
export function pinchPair<T>(pointers: ReadonlyMap<number, T>): [number, number] | null {
  const ids = [...pointers.keys()];
  if (ids.length < 2) return null;

  const [first, second] = ids;
  if (first === undefined || second === undefined) return null;
  return [first, second];
}
