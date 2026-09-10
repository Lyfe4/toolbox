import { useEffect } from 'react';

import { mediaMatches } from '@/lib/useMediaQuery';

import type { RefObject } from 'react';

/**
 * KEEPING THE INSPECTOR OUT FROM BEHIND THE ON-SCREEN KEYBOARD.
 *
 * Everywhere else in the application this is the browser's job and the browser
 * does it: a tool page is an ordinary scrolling document, so when the keyboard
 * opens the engine scrolls the focused field back into view.
 *
 * The canvas route is the exception, and the shape of the exception changed
 * with the inspector. It used to be that node fields sat on the canvas plane -
 * a 0x0 transformed box inside an `overflow: hidden` root, contributing no
 * scrollable overflow at all - so there was nothing for a browser to scroll
 * and the canvas panned the viewport itself to reveal them.
 *
 * There are no fields on the plane any more. Input is entered in the
 * inspector, which IS an ordinary scroll container, so the engine's own
 * scroll-into-view works inside it exactly as it does on a tool page. What the
 * engine cannot do is move the sheet: on a phone the inspector is anchored to
 * the bottom of the LAYOUT viewport, and a keyboard shrinks the VISUAL one and
 * leaves the layout viewport alone. The sheet ends up underneath the keyboard
 * whole, and no amount of scrolling inside it helps.
 *
 * So the one number this file computes is how much of the layout viewport the
 * keyboard is covering, and the sheet sits that far up. Everything else -
 * revealing the focused field within the sheet - is the browser's again.
 *
 * WHAT THIS IS AND IS NOT TESTED AGAINST. Playwright has no soft keyboard in
 * either engine and cannot open one.
 *
 * It used to be driven by shrinking the WINDOW, on the claim that this was the
 * same arithmetic on a different event. It was not the same arithmetic, and the
 * reason is the whole point of this file: a window resize moves the layout
 * viewport and the visual one TOGETHER, so `covered` below is zero however far
 * the window shrinks. The check was exercising a branch that always returned 0,
 * and it would have passed just as happily against a version of this file that
 * did nothing at all.
 *
 * `check:browsers` now shadows `visualViewport.height` with an own property -
 * the real accessor is on the prototype, and this reads the instance - and
 * dispatches the real `resize` event on the real object. That produces the one
 * condition a keyboard produces and a window resize cannot: a visual viewport
 * genuinely shorter than a layout viewport that has not moved. The arithmetic
 * is unit-tested, the sheet is measured lifting by exactly the covered height
 * and dropping back afterwards, and the KEYBOARD is still not tested. Whether
 * iOS fires this event when it opens one is in docs/manual-checks.md, which is
 * four minutes with a phone.
 */

export interface Band {
  readonly top: number;
  readonly bottom: number;
}

/** The custom property the sheet reads. See inspector.module.css. */
export const KEYBOARD_INSET_PROPERTY = '--keyboard-inset';

/**
 * The part of the layout viewport the user can actually see.
 *
 * `visualViewport` is the API that knows about the keyboard: iOS Safari shrinks
 * it and leaves the layout viewport alone, which is why `innerHeight` is no use
 * on its own. `offsetTop` matters too - a pinch-zoomed page has a visual
 * viewport that starts partway down the layout one.
 */
export function visibleBand(): Band {
  const view = window.visualViewport;
  if (!view) return { top: 0, bottom: window.innerHeight };
  return { top: view.offsetTop, bottom: view.offsetTop + view.height };
}

/**
 * How far the bottom of the layout viewport is obscured, in CSS pixels.
 *
 * Clamped at both ends and deliberately so. Below zero is a visual viewport
 * that extends past the layout one, which happens transiently during an
 * overscroll on iOS and is not a keyboard; above the viewport's own height is
 * a measurement taken while the two are being resized in different frames, and
 * pushing the sheet off the top of the screen is worse than leaving it behind
 * a keyboard for one frame.
 */
export function keyboardInset(band: Band, layoutHeight: number): number {
  if (!Number.isFinite(layoutHeight) || layoutHeight <= 0) return 0;
  const covered = layoutHeight - band.bottom;
  if (!Number.isFinite(covered)) return 0;
  return Math.min(layoutHeight, Math.max(0, Math.round(covered)));
}

/**
 * Writes the inset onto an element as a custom property.
 *
 * COARSE POINTERS ONLY, and checked when the handler runs rather than when it
 * is bound. With a mouse there is no keyboard to hide behind, and a panel that
 * jumped whenever a browser resized would be worse than the bug being fixed. A
 * tablet with a keyboard folded onto it changes its answer between one focus
 * and the next, so the question is asked each time.
 */
export function useKeyboardInset(elementRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return undefined;

    const apply = (): void => {
      const inset = mediaMatches('(pointer: coarse)')
        ? keyboardInset(visibleBand(), window.innerHeight)
        : 0;
      element.style.setProperty(KEYBOARD_INSET_PROPERTY, `${inset.toString()}px`);
    };

    apply();

    const view = window.visualViewport;
    view?.addEventListener('resize', apply);
    /*
     * `scroll` as well as `resize`: on iOS the visual viewport SLIDES rather
     * than resizing when the page is scrolled with the keyboard already open,
     * and `offsetTop` is what changes. Listening only for resize leaves the
     * sheet correct at the moment the keyboard opened and wrong afterwards.
     */
    view?.addEventListener('scroll', apply);
    window.addEventListener('resize', apply);

    return () => {
      view?.removeEventListener('resize', apply);
      view?.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
      element.style.removeProperty(KEYBOARD_INSET_PROPERTY);
    };
  }, [elementRef]);
}
