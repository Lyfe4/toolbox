/**
 * Minimal colour maths for contrast checking. Pure functions, no dependencies.
 * Implements the WCAG 2.x relative-luminance and contrast-ratio definitions.
 */

/** A colour as 8-bit channels, each 0-255. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * Parses `#rgb` or `#rrggbb`.
 *
 * The return type `Rgb | null` forces callers to handle bad input - there is
 * no way to accidentally use an unparsed colour, because TypeScript will not
 * let you read `.r` off a possibly-null value.
 */
export function parseHex(input: string): Rgb | null {
  const hex = input.trim().replace('#', '');

  if (hex.length === 3) {
    const [r, g, b] = [hex[0], hex[1], hex[2]];
    if (r === undefined || g === undefined || b === undefined) return null;
    return parseHex(`#${r}${r}${g}${g}${b}${b}`);
  }

  if (hex.length !== 6 || !/^[0-9a-f]{6}$/i.test(hex)) return null;

  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

/** Undoes the sRGB transfer function for one channel. */
function linearise(channel8Bit: number): number {
  const c = channel8Bit / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance: 0 for black, 1 for white. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
}

/** WCAG contrast ratio between two colours. Ranges from 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Convenience wrapper for two hex strings. Throws on unparseable input. */
export function contrastRatioHex(foreground: string, background: string): number {
  const fg = parseHex(foreground);
  const bg = parseHex(background);
  if (!fg || !bg) {
    throw new Error(`Cannot parse colours: ${foreground} / ${background}`);
  }
  return contrastRatio(fg, bg);
}
