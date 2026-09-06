import { useEffect } from 'react';

import { mediaMatches } from '@/lib/useMediaQuery';

import type { Point } from './types';
import type { RefObject } from 'react';

/**
 * KEEPING A FOCUSED NODE FIELD OUT FROM BEHIND THE ON-SCREEN KEYBOARD.
 *
 * Everywhere else in the application this is the browser's job and the browser
 * does it: a tool page is an ordinary scrolling document, so when the keyboard
 * opens the engine scrolls the focused field back into view.
 *
 * The canvas has nothing to scroll. Its root is `overflow: hidden` and its
 * plane is a 0x0 box with a transform - the transform IS the coordinate system,
 * so nodes contribute no scrollable overflow at all and `scrollHeight` equals
 * `clientHeight` however far the graph extends. Measured: with a node's
 * textarea at y=491 and the visible area cut to 444px, `scrollTop` stays 0 in
 * both engines and the field simply sits behind the keyboard. There is no
 * browser behaviour to fix, because there is nothing for the browser to move.
 *
 * So the canvas moves it, using the one thing that does move: the viewport pan.
 *
 * WHAT THIS IS AND IS NOT TESTED AGAINST. Playwright has no soft keyboard, in
 * either engine - it cannot open one and cannot shrink the visual viewport
 * independently of the layout viewport, which is precisely what a keyboard
 * does on iOS. `check:browsers` therefore drives this by shrinking the window,
 * which runs the same code down the same branch with the same numbers, and is
 * NOT the same event. The reveal maths is unit-tested on its own; the wiring is
 * proved to fire; the actual keyboard is not, and saying so is more useful than
 * a green check that means less than it looks like.
 */

export interface Band {
  readonly top: number;
  readonly bottom: number;
}

export interface FieldBox {
  readonly top: number;
  readonly bottom: number;
}

/** Breathing room between a field and the edge of the visible band. */
const MARGIN = 12;

/**
 * How far to move the content so `field` sits inside `band`, in screen pixels.
 * Positive moves it down, negative up, zero leaves it alone.
 *
 * A field taller than the band cannot be shown whole, and the choice there is
 * deliberate: its TOP is what gets revealed, because that is where the caret
 * starts and where the label above it is.
 */
export function panToReveal(field: FieldBox, band: Band, margin = MARGIN): number {
  const top = band.top + margin;
  const bottom = band.bottom - margin;

  // A band with no usable room - a keyboard covering nearly everything - is
  // better left alone than filled with a pan to an arbitrary position.
  if (bottom <= top) return 0;

  if (field.top < top) return top - field.top;

  if (field.bottom > bottom) {
    // Never so far up that the top of the field leaves the band: for a field
    // taller than the band the second term is the one that wins.
    return Math.max(bottom - field.bottom, top - field.top);
  }

  return 0;
}

/**
 * The part of the layout viewport the user can actually see.
 *
 * `visualViewport` is the API that knows about the keyboard: iOS Safari shrinks
 * it and leaves the layout viewport alone, which is why `innerHeight` is no use
 * here. `offsetTop` matters too - a pinch-zoomed page has a visual viewport
 * that starts partway down the layout one.
 */
export function visibleBand(): Band {
  const view = window.visualViewport;
  if (!view) return { top: 0, bottom: window.innerHeight };
  return { top: view.offsetTop, bottom: view.offsetTop + view.height };
}

/**
 * Binds the reveal to focus and to the viewport shrinking.
 *
 * Both, because they happen in that order and only the second one knows the
 * answer: focus arrives while the keyboard is still opening, so the band is
 * still full height and nothing needs to move yet. The `resize` that follows is
 * where the pan actually happens. Focus is still worth listening to for the
 * case where the keyboard is already up and the user moves between fields.
 *
 * COARSE POINTERS ONLY, and checked when the handler runs rather than when it
 * is bound. With a mouse there is no keyboard to hide behind and no reason for
 * the canvas to move under a click; this must be invisible on a desktop.
 */
export function useRevealFocusedField(
  rootRef: RefObject<HTMLDivElement | null>,
  panBy: (delta: Point) => void,
): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;

    const reveal = (): void => {
      if (!mediaMatches('(pointer: coarse)')) return;

      const active = document.activeElement;
      // Only the fields inside nodes. The canvas root itself is focusable, and
      // panning because somebody tapped the background would be alarming.
      if (!(active instanceof HTMLElement) || !active.matches('[data-node-input]')) return;
      if (!root.contains(active)) return;

      const delta = panToReveal(active.getBoundingClientRect(), visibleBand());
      if (delta !== 0) panBy({ x: 0, y: delta });
    };

    root.addEventListener('focusin', reveal);
    window.visualViewport?.addEventListener('resize', reveal);

    return () => {
      root.removeEventListener('focusin', reveal);
      window.visualViewport?.removeEventListener('resize', reveal);
    };
  }, [rootRef, panBy]);
}
