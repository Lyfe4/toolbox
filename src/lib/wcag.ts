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
