/**
 * WCAG contrast maths.
 *
 * Lives in `lib` rather than inside the colour tool because two very different
 * consumers need it: the tool itself (which reports ratios as data) and the
 * output view (which draws the pass/fail badges). Putting it in the tool would
 * mean the view had to import a lazily-chunked tool module to render, which
 * would drag that chunk into the page that lists tools.
 */

/**
 * Relative luminance, per WCAG 2.1 §Relative luminance.
 *
 * Channels are 0-1 sRGB. The piecewise curve is the sRGB transfer function:
 * the low end is linear because a pure power curve has an infinite slope at
 * zero, which quantises badly in 8 bits.
 */
export function relativeLuminance(r: number, g: number, b: number): number {
  const channel = (value: number): number =>
    value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * A TRANSLUCENT COLOUR OVER AN OPAQUE ONE, IN THE SPACE A BROWSER PAINTS IN.
 *
 * `#aabbccdd` and `#aabbcc` used to give byte-identical ratios - 10.69:1 and
 * 1.96:1 for both - because `relativeLuminance` has no alpha parameter and
 * nothing composited before calling it. That is wrong for exactly the colour
 * somebody would open a contrast checker to ask about, and it is not a
 * question that needs a guess: every row of the table names its own
 * background, so the composite is determined.
 *
 * SOURCE-OVER, ON THE GAMMA-ENCODED CHANNELS, which is what the platform's
 * own compositor does - `globalCompositeOperation` defaults to `source-over`
 * and a 2D canvas composites in sRGB rather than in linear light. So this is
 * not a formula chosen for tidiness: `checkColourReports` in
 * `scripts/cross-browser-check.mjs` paints the same colour over the same
 * backdrop in Firefox and WebKit, reads the pixel back, and holds this
 * function to it.
 *
 * The backdrop is opaque, which is why there is no alpha in the result: every
 * background in the table is `#000000` or `#ffffff`.
 */
export function compositeOver(
  color: { readonly r: number; readonly g: number; readonly b: number; readonly a: number },
  backdrop: readonly [number, number, number],
): readonly [number, number, number] {
  const mix = (channel: number, under: number): number => channel * color.a + under * (1 - color.a);
  return [mix(color.r, backdrop[0]), mix(color.g, backdrop[1]), mix(color.b, backdrop[2])];
}

/**
 * Contrast ratio between two luminances, from 1 (identical) to 21 (black on
 * white). The 0.05 offsets model viewing flare, which is why pure black on
 * pure white is 21 and not infinity.
 */
export function contrastRatio(luminanceA: number, luminanceB: number): number {
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

/** The four WCAG 2.1 contrast thresholds. */
export const WCAG_THRESHOLDS = {
  'AA large': 3,
  AA: 4.5,
  'AAA large': 4.5,
  AAA: 7,
} as const;

export type WcagLevel = keyof typeof WCAG_THRESHOLDS;

export function passes(ratio: number, level: WcagLevel): boolean {
  return ratio >= WCAG_THRESHOLDS[level];
}

/**
 * The best level a ratio reaches, or null when it reaches none.
 *
 * Ordered strongest-first so the first match wins.
 */
export function bestLevel(ratio: number): WcagLevel | null {
  if (ratio >= WCAG_THRESHOLDS.AAA) return 'AAA';
  if (ratio >= WCAG_THRESHOLDS.AA) return 'AA';
  if (ratio >= WCAG_THRESHOLDS['AA large']) return 'AA large';
  return null;
}
