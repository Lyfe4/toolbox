import { useLayoutEffect, type RefObject } from 'react';

/**
 * Below this width the notifications stop being a 320px column in a corner and
 * become a band across the bottom, one line each, at most `MAX_ON_SCREEN_NARROW`
 * of them. The same figure as the canvas's own `COMPACT_TOOLBAR`: the width at
 * which the canvas changes into its phone layout is the width at which a
 * corner column stops fitting beside the readout. `Toast.module.css` carries
 * it as a literal, because a media query cannot read a variable - the layout
 * is decided there alone, and this copy only sets how many are kept.
 */
export const NARROW_TOASTS = '(max-width: 640px)';

/**
 * WHERE THE BOTTOM CHROME ENDS, MEASURED, so a notification sits above it.
 *
 * The canvas's readout is 22px tall under a mouse and 46px under a finger,
 * where its zoom reset grows to 44px - so a clearance written as a number
 * would be right at one pointer type and wrong at the other, which is the
 * argument the toolbar's own column already makes. The element says where it
 * is instead: its top edge's distance from the bottom of the layout viewport,
 * which is what `position: fixed` measures from.
 *
 * `--toast-clearance` IS DELIBERATELY NOT `--pb-`, for the reason
 * `--inspector-width` is not: it is a live measurement written by JavaScript,
 * not a question a theme answers. Removed when the element goes, so a page
 * with no readout keeps the ordinary margin.
 */
export function useToastClearance(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const root = document.documentElement;

    const measure = (): void => {
      const top = element.getBoundingClientRect().top;
      const clearance = Math.max(0, Math.round(root.clientHeight - top));
      root.style.setProperty('--toast-clearance', `${clearance.toString()}px`);
    };
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      root.style.removeProperty('--toast-clearance');
    };
  }, [ref]);
}
