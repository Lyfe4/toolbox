import { fail, ok, type ColorPayload, type ToolResult } from '@/features/registry/types';

/**
 * Colour parsing and formatting.
 *
 * Everything is held internally as sRGB in 0-1 with an alpha channel, which is
 * what `ColorPayload` already is. Parsing widens whatever the user typed into
 * that; formatting narrows it back into one notation. Keeping a single interior
 * representation means adding a fifth notation later is one parser and one
 * formatter rather than twenty pairwise conversions.
 */

export const COLOR_FORMATS = ['hex', 'rgb', 'hsl', 'oklch'] as const;
export type ColorFormat = (typeof COLOR_FORMATS)[number];

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/* ========================================================================== *
 * sRGB <-> HSL
 * ========================================================================== */

/** Hue in degrees 0-360, saturation and lightness 0-1. */
export interface Hsl {
  readonly h: number;
  readonly s: number;
  readonly l: number;
}

export function rgbToHsl(r: number, g: number, b: number): Hsl {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;

  if (delta === 0) return { h: 0, s: 0, l };

  // The denominator flips above mid-lightness because saturation is measured
  // against the distance to whichever end of the range is nearer.
  const s = delta / (1 - Math.abs(2 * l - 1));

  let h: number;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;

  h *= 60;
  if (h < 0) h += 360;

  return { h, s, l };
}

export function hslToRgb(h: number, s: number, l: number): readonly [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;

  const table: readonly (readonly [number, number, number])[] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const segment = table[Math.min(5, Math.floor(hp))] ?? [0, 0, 0];

  return [clamp01(segment[0] + m), clamp01(segment[1] + m), clamp01(segment[2] + m)];
}

/* ========================================================================== *
 * sRGB <-> OKLCH
 * ========================================================================== */

const toLinear = (value: number): number =>
  value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);

const fromLinear = (value: number): number =>
  value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;

/** Lightness 0-1, chroma (unbounded in principle, ~0-0.4 in sRGB), hue 0-360. */
export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

/**
 * sRGB -> OKLCH, via Björn Ottosson's OKLab.
 *
 * The matrices are the published ones. The cube roots in the middle are what
 * make OKLab perceptually uniform: equal numeric steps look like equal steps,
 * which is why it is worth having alongside HSL rather than instead of it.
 */
export function rgbToOklch(r: number, g: number, b: number): Oklch {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  const okL = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const okA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const okB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  const chroma = Math.sqrt(okA * okA + okB * okB);
  // A neutral colour has no meaningful hue; reporting 0 rather than whatever
  // atan2 makes of floating-point noise keeps grey round-tripping exactly.
  const hue = chroma < 1e-7 ? 0 : ((Math.atan2(okB, okA) * 180) / Math.PI + 360) % 360;

  return { l: okL, c: chroma, h: hue };
}

/** OKLCH -> sRGB. Out-of-gamut results are clipped per channel. */
export function oklchToRgb(
  lightness: number,
  chroma: number,
  hue: number,
): { readonly rgb: readonly [number, number, number]; readonly inGamut: boolean } {
  const radians = (hue * Math.PI) / 180;
  const okA = chroma * Math.cos(radians);
  const okB = chroma * Math.sin(radians);

  const l = (lightness + 0.3963377774 * okA + 0.2158037573 * okB) ** 3;
  const m = (lightness - 0.1055613458 * okA - 0.0638541728 * okB) ** 3;
  const s = (lightness - 0.0894841775 * okA - 1.291485548 * okB) ** 3;

  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  const raw = [fromLinear(lr), fromLinear(lg), fromLinear(lb)] as const;
  // Reported rather than silently corrected: "that OKLCH has no sRGB
  // equivalent, here is the nearest one" is information the user needs.
  const inGamut = raw.every((channel) => channel >= -1e-4 && channel <= 1 + 1e-4);

  return { rgb: [clamp01(raw[0]), clamp01(raw[1]), clamp01(raw[2])], inGamut };
}

/* ========================================================================== *
 * Parsing
 * ========================================================================== */

const HEX_PATTERN = /^#?([0-9a-f]{3,8})$/i;
const FUNCTION_PATTERN = /^([a-z]+)\(([^)]*)\)$/i;

/** Splits `1 2 3 / 0.5` or `1, 2, 3, 0.5` into components plus alpha. */
function splitArguments(body: string): { readonly parts: string[]; readonly alpha: string | null } {
  const [main, alphaPart] = body.split('/');
  const parts = (main ?? '')
    .trim()
    .split(/[\s,]+/)
    .filter((part) => part !== '');

  if (alphaPart !== undefined) return { parts, alpha: alphaPart.trim() };

  // Legacy comma form puts alpha in the fourth slot instead of after a slash.
  if (parts.length === 4) return { parts: parts.slice(0, 3), alpha: parts[3] ?? null };
  return { parts, alpha: null };
}

/**
 * A number that may be a percentage.
 *
 * `scale` is what 100% means: 255 for an rgb() channel, 1 for a lightness.
 */
function parseNumber(raw: string | undefined, scale: number): number | null {
  if (raw === undefined) return null;
  const text = raw.trim();

  if (text.endsWith('%')) {
    const value = Number(text.slice(0, -1));
    return Number.isFinite(value) ? (value / 100) * scale : null;
  }

  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * An `hsl()` saturation or lightness.
 *
 * CSS Color 4 defines both as `<percentage> | <number>`, and says a bare
 * number means THAT MANY PERCENT - so `hsl(217 91 60)` is exactly
 * `hsl(217 91% 60%)`. This used to go through `parseNumber(raw, 1)`, which
 * reads a bare number as already being a 0-1 fraction: 91 and 60 were clamped
 * to 1, and `hsl(217 91 60)` came back as WHITE. No error, no clue, and a
 * colour is the one kind of answer nobody checks digit by digit.
 *
 * https://www.w3.org/TR/css-color-4/#the-hsl-notation
 */
function parseHslComponent(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  const value = Number(text.endsWith('%') ? text.slice(0, -1) : text);
  return Number.isFinite(value) ? value / 100 : null;
}

/**
 * A hue, in degrees.
 *
 * A percentage is not a hue in any of the notations here - CSS gives hue as
 * `<number> | <angle>` - and it used to be read as one anyway: `parseNumber`
 * scaled it by 360, so `hsl(50% 100% 50%)` silently became 180deg rather than
 * being refused.
 */
function parseHue(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const text = raw.trim().replace(/deg$/i, '');
  if (text.endsWith('%')) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function parseAlpha(raw: string | null): number {
  if (raw === null) return 1;
  const value = parseNumber(raw, 1);
  return value === null ? 1 : clamp01(value);
}

function parseHex(digits: string): ColorPayload | null {
  const expand = (pair: string): number => parseInt(pair, 16) / 255;

  if (digits.length === 3 || digits.length === 4) {
    // Indexed rather than spread: hex digits are ASCII, and spreading a string
    // to code points is the wrong tool even when it happens to work.
    const doubled: string[] = [];
    for (let index = 0; index < digits.length; index += 1) {
      const character = digits.charAt(index);
      doubled.push(character + character);
    }
    return {
      r: expand(doubled[0] ?? '00'),
      g: expand(doubled[1] ?? '00'),
      b: expand(doubled[2] ?? '00'),
      a: doubled[3] === undefined ? 1 : expand(doubled[3]),
    };
  }

  if (digits.length === 6 || digits.length === 8) {
    return {
      r: expand(digits.slice(0, 2)),
      g: expand(digits.slice(2, 4)),
      b: expand(digits.slice(4, 6)),
      a: digits.length === 8 ? expand(digits.slice(6, 8)) : 1,
    };
  }

  // 5 and 7 digits are the classic typo, and both are ambiguous rather than
  // recoverable, so they are refused.
  return null;
}

/**
 * WHAT THE PARSER HAD TO CHANGE ABOUT THE COLOUR TO ANSWER AT ALL.
 *
 * Both fields are facts the parser has always known and never returned.
 * `inGamut` was computed by `oklchToRgb` and destructured away at the one call
 * site that could have used it; the clamps were applied by `clamp01` with
 * nothing anywhere recording that they had fired. A colour is the one kind of
 * answer nobody checks digit by digit, so an adjustment nobody is told about
 * is an adjustment nobody finds.
 *
 * NAMED AS WRITTEN, not as parsed. `clamped` holds `saturation 110%` rather
 * than `saturation 1`, because the sentence the user needs is about what they
 * typed - the parsed value is, by construction, the one that is in range.
 */
export interface ParsedColor {
  readonly color: ColorPayload;
  /** Components that were outside their range, spelled as the user wrote them. */
  readonly clamped: readonly string[];
  /**
   * True when an `oklch()` input names a colour sRGB cannot show.
   *
   * Only `oklch()` can produce it: it is the one notation here whose
   * coordinate space is larger than the gamut. hex, `rgb()` and `hsl()` are
   * defined inside sRGB, so an out-of-range component there is a clamp and not
   * a gamut question.
   */
  readonly outOfGamut: boolean;
}

/**
 * A component that was outside the range its notation allows, or null.
 *
 * A HUE IS NEVER ONE. `hslToRgb` wraps with `% 360`, which is what CSS does
 * and what the circle means - `hsl(361 …)` is `hsl(1 …)` exactly, nothing is
 * lost, and reporting it would be the note that cries wolf.
 */
function outOfRange(
  name: string,
  written: string | undefined,
  value: number,
  min: number,
  max: number,
): string | null {
  if (written === undefined) return null;
  return value < min || value > max ? `${name} ${written.trim()}` : null;
}

/** Drops the nulls from a list of range checks. */
function clampedList(...checks: readonly (string | null)[]): readonly string[] {
  return checks.filter((entry): entry is string => entry !== null);
}

/**
 * Parses any of the four notations.
 *
 * Deliberately does NOT accept named colours. Resolving them would mean
 * shipping the 148-entry CSS list, and the tool is about conversion between
 * notations rather than about being a colour dictionary.
 *
 * RETURNS WHAT IT HAD TO CHANGE, as well as the colour. See `ParsedColor`:
 * every caller that only wants the colour reads `.value.color`, and the one
 * caller that can say something says it.
 */
export function parseColor(input: string): ToolResult<ParsedColor> {
  const text = input.trim();
  if (text === '') return fail('invalid-input', 'Enter a colour to convert.');

  const hex = HEX_PATTERN.exec(text);
  if (hex?.[1] !== undefined) {
    const parsed = parseHex(hex[1]);
    if (!parsed) {
      return fail('parse-error', 'A hex colour needs 3, 4, 6 or 8 digits.', {
        detail: `Got ${hex[1].length.toString()}.`,
      });
    }
    // Nothing in hex can be out of range: three to eight digits is the whole
    // grammar, and every one of them names a byte.
    return ok({ color: parsed, clamped: [], outOfGamut: false });
  }

  const call = FUNCTION_PATTERN.exec(text);
  if (!call) {
    return fail('parse-error', `"${text}" is not a colour this tool recognises.`, {
      detail: 'Try #3b82f6, rgb(59 130 246), hsl(217 91% 60%) or oklch(0.62 0.19 259).',
    });
  }

  const name = (call[1] ?? '').toLowerCase();
  const { parts, alpha } = splitArguments(call[2] ?? '');
  const a = parseAlpha(alpha);
  // Shared by all three function notations: `/ 2` and `/ -1` are both clamped.
  const alphaClamped = outOfRange(
    'alpha',
    alpha ?? undefined,
    parseNumber(alpha ?? undefined, 1) ?? 1,
    0,
    1,
  );

  if (name === 'rgb' || name === 'rgba') {
    const channels = [0, 1, 2].map((index) => parseNumber(parts[index], 255));
    if (channels.some((channel) => channel === null)) {
      return fail('parse-error', 'rgb() needs three numeric channels.');
    }
    const [r, g, b] = channels as [number, number, number];
    /*
     * QUANTISED TO THE 8-BIT STEP, ONCE, HERE.
     *
     * `rgb(50% 50% 50%)` is exactly 127.5, and keeping that in the payload made
     * the report's own rows disagree with each other: hex printed `#808080`,
     * because hex rounds, while oklch printed the value for 127.5. Every row of
     * one report is supposed to describe the same colour, and two of them
     * described colours one 8-bit step apart.
     *
     * ROUNDING BEATS STATING IT, on two grounds. The first is that a report
     * whose rows disagree is a report nobody can use, and a footnote saying
     * which row is rounded does not fix that - it explains it. The second is
     * that rounding is what a BROWSER does: `getComputedStyle` on
     * `color: rgb(50% 50% 50%)` returns `rgb(128, 128, 128)`, in every engine,
     * because `rgb()` serialises to 8-bit integers. Asserted against two real
     * engines in `scripts/cross-browser-check.mjs` rather than taken on trust,
     * since this is precisely the kind of claim this repository has been wrong
     * about before.
     *
     * IT IS THE `rgb()` NOTATION ONLY. `hsl()` and `oklch()` are continuous in
     * CSS and in the payload, and quantising them would break the round trips
     * the stride test asserts at the default precision. This is not "8-bit
     * everywhere"; it is "rgb() means what a browser says it means".
     */
    const step = (value: number): number => clamp01(Math.round(value) / 255);
    return ok({
      color: { r: step(r), g: step(g), b: step(b), a },
      // Against 0-255 rather than 0-1: the scale `parseNumber` was given is
      // what `150%` and `300` both arrive on.
      clamped: clampedList(
        outOfRange('red', parts[0], r, 0, 255),
        outOfRange('green', parts[1], g, 0, 255),
        outOfRange('blue', parts[2], b, 0, 255),
        alphaClamped,
      ),
      outOfGamut: false,
    });
  }

  if (name === 'hsl' || name === 'hsla') {
    const h = parseHue(parts[0]);
    const s = parseHslComponent(parts[1]);
    const l = parseHslComponent(parts[2]);
    if (h === null || s === null || l === null) {
      return fail('parse-error', 'hsl() needs a hue, a saturation and a lightness.');
    }
    const [r, g, b] = hslToRgb(h, clamp01(s), clamp01(l));
    return ok({
      color: { r, g, b, a },
      // The hue is absent on purpose - see `outOfRange`. 361 is 1, exactly.
      clamped: clampedList(
        outOfRange('saturation', parts[1], s, 0, 1),
        outOfRange('lightness', parts[2], l, 0, 1),
        alphaClamped,
      ),
      outOfGamut: false,
    });
  }

  if (name === 'oklch') {
    const l = parseNumber(parts[0], 1);
    const c = parseNumber(parts[1], 0.4);
    const h = parseHue(parts[2]);
    if (l === null || c === null || h === null) {
      return fail('parse-error', 'oklch() needs a lightness, a chroma and a hue.');
    }
    /*
     * `inGamut` IS READ HERE, AND THAT IS THE WHOLE OF CC-1.
     *
     * It has been computed correctly since `e56bd2f` and destructured away at
     * this one line ever since - `git log -S inGamut` over the whole history
     * returns that single commit, so nothing drifted: the feature was never
     * wired. The conversion matrix recorded it as reported anyway.
     */
    const { rgb, inGamut } = oklchToRgb(clamp01(l), Math.max(0, c), h);
    return ok({
      color: { r: rgb[0], g: rgb[1], b: rgb[2], a },
      clamped: clampedList(
        outOfRange('lightness', parts[0], l, 0, 1),
        // Chroma has no upper bound in OKLCH; only a negative one is a clamp,
        // and a chroma too large for sRGB is the gamut question below.
        outOfRange('chroma', parts[1], c, 0, Number.POSITIVE_INFINITY),
        alphaClamped,
      ),
      outOfGamut: !inGamut,
    });
  }

  return fail('parse-error', `${name}() is not a colour notation this tool supports.`, {
    detail: 'Supported: hex, rgb(), hsl() and oklch().',
  });
}

/* ========================================================================== *
 * Formatting
 * ========================================================================== */

/** Trims trailing zeros so 0.50 prints as 0.5 and 1.00 as 1. */
function round(value: number, places: number): string {
  const fixed = value.toFixed(places);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

/**
 * A hue, rounded, kept inside the half-open range the two converters promise.
 *
 * `rgbToHsl` and `rgbToOklch` both return a hue in [0, 360) - `rgbToHsl` adds
 * 360 to a negative and `rgbToOklch` takes `% 360`, so neither can produce 360
 * itself. ROUNDING CAN. A hue of 359.996 prints as `360` at two decimal places,
 * and `hsl(360 50% 50%)` is a colour written the long way round: a wrap point
 * stated as the value it wraps to.
 *
 * It is a real output. `#800000` through `oklch()` and back is `hsl(360 100%
 * 25.1%)` - the same colour as `hsl(0 ...)`, printed as the one number the
 * range excludes, next to every other red in the same report starting at 0.
 *
 * Only the exact wrap is moved. 359.98 is a DIFFERENT question - a hue that
 * really did drift, which no formatter can distinguish from a hue somebody
 * meant - and snapping a tolerance here would be a guess where this is an
 * identity.
 */
function roundHue(value: number, places: number): string {
  const text = round(value, places);
  return text === '360' ? '0' : text;
}

function hexPair(value: number): string {
  return Math.round(clamp01(value) * 255)
    .toString(16)
    .padStart(2, '0');
}

export function formatColor(color: ColorPayload, format: ColorFormat, precision: number): string {
  const hasAlpha = color.a < 1;

  switch (format) {
    case 'hex': {
      const base = `#${hexPair(color.r)}${hexPair(color.g)}${hexPair(color.b)}`;
      return hasAlpha ? `${base}${hexPair(color.a)}` : base;
    }

    case 'rgb': {
      const channels = [color.r, color.g, color.b]
        .map((channel) => Math.round(clamp01(channel) * 255).toString())
        .join(' ');
      // Modern space-separated syntax, which is what every current browser
      // emits and what the CSS Color 4 spec prefers.
      return hasAlpha ? `rgb(${channels} / ${round(color.a, 3)})` : `rgb(${channels})`;
    }

    case 'hsl': {
      const { h, s, l } = rgbToHsl(color.r, color.g, color.b);
      const body = `${roundHue(h, Math.min(precision, 2))} ${round(s * 100, Math.min(precision, 2))}% ${round(l * 100, Math.min(precision, 2))}%`;
      return hasAlpha ? `hsl(${body} / ${round(color.a, 3)})` : `hsl(${body})`;
    }

    case 'oklch': {
      const { l, c, h } = rgbToOklch(color.r, color.g, color.b);
      const body = `${round(l, precision)} ${round(c, precision)} ${roundHue(h, Math.min(precision, 2))}`;
      return hasAlpha ? `oklch(${body} / ${round(color.a, 3)})` : `oklch(${body})`;
    }
  }
}

/** Every notation at once, for the report output. */
export function formatAll(color: ColorPayload, precision: number): Record<ColorFormat, string> {
  return {
    hex: formatColor(color, 'hex', precision),
    rgb: formatColor(color, 'rgb', precision),
    hsl: formatColor(color, 'hsl', precision),
    oklch: formatColor(color, 'oklch', precision),
  };
}
