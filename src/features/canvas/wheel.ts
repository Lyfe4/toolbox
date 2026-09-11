import { clamp } from './geometry';

import type { Point } from './types';

/**
 * Wheel maths: turning one `wheel` event into a pan and a zoom.
 *
 * Kept apart from the canvas component and free of the DOM, for the reason
 * `pinch.ts` is: the failures here are arithmetic, and the arithmetic is far
 * easier to pin down in a unit test than by spinning four kinds of mouse.
 *
 * THE PROBLEM THIS MODULE EXISTS FOR
 *
 * Two completely different gestures arrive at the same listener, and the units
 * they arrive in differ by a factor of about fifty:
 *
 *   - A MOUSE WHEEL delivers one large, quantised event per detent. Chromium
 *     and WebKit report it in pixels, conventionally 100 per detent; Firefox
 *     reports it in LINES, conventionally 3 per detent.
 *   - A TRACKPAD PINCH is synthesised as a stream of small ctrl+wheel events,
 *     a pixel or two each, many per frame.
 *
 * The canvas used to feed both through one exponential, `exp(-deltaY / 100)`.
 * That is the convention a trackpad pinch is calibrated against, and it is
 * correct for one: a two-pixel event moves the zoom by 2%. Handed a mouse
 * detent's hundred pixels the same expression returns e, so one notch of the
 * wheel multiplied the zoom by 2.72 and the reachable scales were 33%, 90% and
 * 250% - three notches spanning the entire range.
 *
 * THE FIX IS NOT A SMALLER COEFFICIENT, because a coefficient small enough for
 * the wheel makes a pinch inert. It is TWO STEPS:
 *
 *   1. Normalise every event to pixels first, so a line-reporting engine and a
 *      pixel-reporting one describe the same gesture with the same number.
 *   2. Convert pixels to NOTCHES at the trackpad's rate, then cap the result
 *      at one notch per event.
 *
 * The cap is what separates the devices without sniffing them. Every mouse
 * detent, in every engine and at every OS scroll setting, is far above the cap,
 * so every detent is exactly one notch. Every trackpad event is far below it,
 * so a pinch passes through untouched and stays continuous. Nothing has to
 * guess which device it is talking to; the magnitude answers on its own.
 */

/** Only the fields the maths needs, so this is testable without a DOM. */
export interface WheelLike {
  readonly deltaX: number;
  readonly deltaY: number;
  /** `WheelEvent.deltaMode`: 0 pixels, 1 lines, 2 pages. */
  readonly deltaMode: number;
}

/** What one wheel event asks the viewport for. */
export interface WheelStep {
  /** How far to move the content, in CSS pixels, sign already applied. */
  readonly pan: Point;
  /** How far to zoom, in notches. Positive zooms in. */
  readonly notches: number;
}

/**
 * One mouse detent, in each of the units an engine may report it in.
 *
 * Both describe the SAME physical click of the same wheel, which is why the
 * ratio between them is the line-to-pixel conversion rather than a font
 * measurement: the point is that a detent pans the same distance in Firefox as
 * it does in Chrome, and a line height would make it pan 48px against 100px.
 */
export const WHEEL_PIXELS_PER_DETENT = 100;
export const WHEEL_LINES_PER_DETENT = 3;

/**
 * Lines in a `DOM_DELTA_PAGE` delta.
 *
 * Vestigial - no shipping engine reports page units for a wheel - but the
 * alternative to a number here is treating a page as a pixel and panning by
 * one, so it gets a screenful of lines and a comment rather than a branch that
 * silently does nothing.
 */
export const WHEEL_LINES_PER_PAGE = 24;

/**
 * How many notches double the zoom.
 *
 * Zoom is multiplicative, so the invariant worth holding is the RATIO per
 * notch, not the percentage - one notch from 50% and one notch from 200% have
 * to feel like the same gesture, which is what an exponential gives and what
 * the old code got right before its coefficient ruined it.
 *
 * Six makes a notch 2^(1/6), about 1.12, and puts twenty notches across the
 * whole 0.25-2.5 range - roughly two sweeps of a finger. It also lands the
 * ladder exactly on the round scales: from 100%, six notches out is 50%,
 * twelve is 25%, and six in is 200%. Landing on a useful scale stops being
 * luck.
 */
export const ZOOM_NOTCHES_PER_DOUBLING = 6;

/**
 * Pixels of wheel delta that make one notch.
 *
 * Calibrated to the trackpad, deliberately. `exp(-deltaY / 100)` is what
 * Chromium and WebKit's synthesised pinch deltas are scaled for, and matching
 * it exactly needs 100 * ln(2) / 6 = 11.55 pixels per notch. Rounded to 12,
 * which is a quarter of a percent per pixel and well inside what anyone can
 * feel.
 */
export const ZOOM_PIXELS_PER_NOTCH = 12;

/**
 * The most one event may zoom.
 *
 * This is the whole device distinction. A mouse detent is 100px or 3 lines -
 * eight notches by the rate above - and lands here, at one notch. A trackpad's
 * pixel-or-two events are a fiftieth of a notch and never reach it. So a
 * detent is one notch on every engine, a pinch stays continuous, and no code
 * anywhere has to ask what kind of pointing device this is.
 *
 * It doubles as the answer to inertia: a flung trackpad scroll whose momentum
 * frames carry 200px cannot teleport across the range in three frames.
 */
export const ZOOM_MAX_NOTCHES_PER_EVENT = 1;

/**
 * Notches a single press of the zoom keys is worth.
 *
 * A notch is the wheel's unit and it is deliberately small, which makes it the
 * wrong size for a keystroke - crossing the range would be twenty presses.
 * Two notches is three presses per doubling, so 100% to 200% and 100% to 50%
 * are each exactly three, and the whole range is ten. The keys walk the SAME
 * ladder as the wheel rather than a parallel one, which is the only reason
 * pressing a zoom key after scrolling lands somewhere predictable.
 */
export const ZOOM_KEY_NOTCHES = 2;

/** A delta in whatever unit the engine chose, in CSS pixels. */
export function wheelPixels(delta: number, deltaMode: number): number {
  const perLine = WHEEL_PIXELS_PER_DETENT / WHEEL_LINES_PER_DETENT;

  if (deltaMode === 1) return delta * perLine;
  if (deltaMode === 2) return delta * WHEEL_LINES_PER_PAGE * perLine;
  return delta;
}

/**
 * The zoom multiplier for a number of notches.
 *
 * Exported because the wheel is not the only thing that zooms by notches - the
 * keyboard does too, and the two must agree about what a notch is or `+` and
 * the wheel walk different ladders.
 */
export function zoomFactorForNotches(notches: number): number {
  return 2 ** (notches / ZOOM_NOTCHES_PER_DOUBLING);
}

/** What one wheel event asks for: a pan in pixels, or a zoom in notches. */
export function wheelStep(event: WheelLike): WheelStep {
  const x = wheelPixels(event.deltaX, event.deltaMode);
  const y = wheelPixels(event.deltaY, event.deltaMode);

  return {
    // Negated: the wheel says which way the CONTENT should appear to move, and
    // the viewport translation moves the other way.
    pan: { x: -x, y: -y },
    // Scrolling down zooms out, hence the sign.
    notches: clamp(
      -y / ZOOM_PIXELS_PER_NOTCH,
      -ZOOM_MAX_NOTCHES_PER_EVENT,
      ZOOM_MAX_NOTCHES_PER_EVENT,
    ),
  };
}
