import { useEffect, useState } from 'react';

export interface Truncation {
  /**
   * Attach to the element whose text may be clipped.
   *
   * A CALLBACK REF rather than a `useRef` object, and not as a style choice.
   * A ref object's `.current` changes without telling React, so an effect
   * keyed on it never re-runs when the element is REPLACED - and this element
   * is replaced, because discovering truncation wraps the trigger in a
   * tooltip, which remounts it. The first version measured the old node,
   * which by then was detached and therefore zero-sized, and promptly decided
   * nothing was truncated after all. Storing the node in state makes its
   * identity something React can depend on.
   */
  readonly ref: (node: HTMLElement | null) => void;
  readonly truncated: boolean;
}

/**
 * Whether an element's text is actually being cut off by `text-overflow`.
 *
 * WHY MEASURE AT ALL. A tooltip that repeats a label you can already read in
 * full is noise on every single port, and noise is what teaches people that
 * these tooltips are not worth waiting for. So the question is not "could this
 * truncate?" but "is this one, right now, at this zoom, in this font?" - and
 * the only thing that knows is layout.
 *
 * `scrollWidth > clientWidth` is that question: the content's own width
 * against the box it was given. Both are integers, so sub-pixel rounding can
 * report a one-pixel overflow on text that visibly fits; the tolerance below
 * is for that and nothing else.
 *
 * WHAT MAKES IT CHANGE, and what does not:
 *
 *   Browser zoom changes CSS pixel density, so glyph advances round
 *   differently and a label that fitted at 100% may not at 110%. It fires
 *   `resize`.
 *
 *   Web fonts land after first paint with different metrics.
 *   `document.fonts.ready` settles once and is worth one re-measure.
 *
 *   A layout change - a panel resizing, a container growing - is what
 *   ResizeObserver is for, and it covers the box moving for any other reason
 *   as well.
 *
 *   CANVAS zoom does NOT, and this is measured rather than assumed: the
 *   canvas scales with a CSS transform, which paints the same layout larger.
 *   `scrollWidth` and `clientWidth` are layout facts, so scaling to 250%
 *   leaves both exactly where they were and cannot truncate or untruncate
 *   anything.
 *
 * `text` is a dependency rather than a convenience: the same element can be
 * handed different content without ever changing size, and the observer would
 * have nothing to fire on.
 */
export function useIsTruncated(text: string): Truncation {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    if (!node) return;

    const measure = (): void => {
      // One pixel of slack for sub-pixel rounding: scrollWidth and clientWidth
      // are both rounded, so an exact fit can report a 1px overflow.
      setTruncated(node.scrollWidth - node.clientWidth > 1);
    };

    measure();

    /*
     * jsdom has neither a layout engine nor ResizeObserver, so everything
     * below is inert there - every box is zero-sized and nothing ever fires.
     * That is why the unit tests drive the truncated case by stubbing the two
     * widths, and why the real measurement is asserted against real engines in
     * scripts/cross-browser-check.mjs.
     */
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined;
    observer?.observe(node);
    window.addEventListener('resize', measure);

    /*
     * An `in` check rather than `?.`, for the same reason HtmlView does it
     * with `navigator.clipboard`: the DOM types declare `document.fonts` as
     * always present and the linter believes them. jsdom has no font loading
     * API at all, and this hook runs there in every unit test.
     */
    let live = true;
    if ('fonts' in document) {
      void document.fonts.ready.then(() => {
        if (live) measure();
      });
    }

    return () => {
      live = false;
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [node, text]);

  return { ref: setNode, truncated };
}
