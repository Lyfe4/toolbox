import { cachedTheme } from '@/lib/cssTokens';
import { contrastRatio, relativeLuminance, WCAG_THRESHOLDS } from '@/lib/wcag';
import { parseColor } from '@/tools/color-convert/color';

import type { ThemedToken, ThemeName } from './types';

/**
 * CONTRAST, MEASURED THE SAME WAY TWICE
 *
 * The four presets are held to WCAG AA by themes.contrast.test.ts, which
 * resolves the real CSS and measures every pair. A theme the user built cannot
 * be held to anything by a test, because it does not exist when the test runs
 * - so the editor has to measure it live.
 *
 * That is two consumers of one question, and the failure mode of answering it
 * twice is the worst kind: an editor that says AA and a suite that says fail,
 * with no way to tell which is lying. So the pair list and the arithmetic both
 * live HERE, and themes.contrast.test.ts imports them. The test proves the
 * presets pass; the editor proves the same thing about a theme in progress,
 * with the same code.
 *
 * WHAT IS MEASURED. The 33 pairs below are the design system's load-bearing
 * relationships: every combination in which one token is read against another.
 * `--pb-border-subtle` is deliberately absent - it draws decorative rules
 * inside a panel and carries no meaning, so 1.4.11 does not apply to it.
 */

export type ContrastKind = 'text' | 'non-text';

export interface ContrastPair {
  /** What this pair IS, in the words someone designing a theme would use. */
  readonly label: string;
  readonly foreground: ThemedToken;
  readonly background: ThemedToken;
  readonly kind: ContrastKind;
}

/**
 * SC 1.4.3 Contrast (Minimum) - text.
 *
 * Taken from the shared table rather than written as 4.5, so there is one
 * definition of what AA means in this codebase.
 */
export const AA_TEXT = WCAG_THRESHOLDS.AA;

/**
 * SC 1.4.11 Non-text Contrast - boundaries a user must perceive to operate a
 * control. A different success criterion that happens to share its number with
 * "AA large", which is why it is written out rather than borrowed from the
 * table: they mean different things and could in principle diverge.
 */
export const AA_NON_TEXT = 3;

export function thresholdFor(kind: ContrastKind): number {
  return kind === 'text' ? AA_TEXT : AA_NON_TEXT;
}

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  /* --- Text -------------------------------------------------------------- */
  { label: 'Body text', foreground: 'ink-primary', background: 'surface-base', kind: 'text' },
  {
    label: 'Body text on a panel',
    foreground: 'ink-primary',
    background: 'surface-raised',
    kind: 'text',
  },
  {
    label: 'Body text on a menu',
    foreground: 'ink-primary',
    background: 'surface-overlay',
    kind: 'text',
  },
  {
    label: 'Body text in a control',
    foreground: 'ink-primary',
    background: 'control-surface',
    kind: 'text',
  },
  {
    label: 'Secondary text',
    foreground: 'ink-secondary',
    background: 'surface-base',
    kind: 'text',
  },
  {
    label: 'Secondary text on a panel',
    foreground: 'ink-secondary',
    background: 'surface-raised',
    kind: 'text',
  },
  { label: 'Muted text', foreground: 'ink-muted', background: 'surface-base', kind: 'text' },
  {
    label: 'Muted text on a panel',
    foreground: 'ink-muted',
    background: 'surface-raised',
    kind: 'text',
  },
  {
    label: 'Muted text on a menu',
    foreground: 'ink-muted',
    background: 'surface-overlay',
    kind: 'text',
  },
  { label: 'Accent text', foreground: 'ink-accent', background: 'surface-base', kind: 'text' },
  {
    label: 'Accent text on a panel',
    foreground: 'ink-accent',
    background: 'surface-raised',
    kind: 'text',
  },
  {
    label: 'Accent text on a menu',
    foreground: 'ink-accent',
    background: 'surface-overlay',
    kind: 'text',
  },
  { label: 'Text on accent', foreground: 'ink-on-accent', background: 'accent', kind: 'text' },
  { label: 'Inverted text', foreground: 'ink-inverse', background: 'ink-primary', kind: 'text' },
  { label: 'Success text', foreground: 'signal-ok', background: 'surface-base', kind: 'text' },
  { label: 'Warning text', foreground: 'signal-warn', background: 'surface-base', kind: 'text' },
  { label: 'Error text', foreground: 'signal-error', background: 'surface-base', kind: 'text' },
  {
    label: 'Success text on a panel',
    foreground: 'signal-ok',
    background: 'surface-raised',
    kind: 'text',
  },
  {
    label: 'Warning text on a panel',
    foreground: 'signal-warn',
    background: 'surface-raised',
    kind: 'text',
  },
  {
    label: 'Error text on a panel',
    foreground: 'signal-error',
    background: 'surface-raised',
    kind: 'text',
  },
  {
    label: 'Selected text',
    foreground: 'selection-ink',
    background: 'selection-surface',
    kind: 'text',
  },

  /* --- Boundaries and indicators ----------------------------------------- */
  {
    label: 'Panel edge',
    foreground: 'border-hairline',
    background: 'surface-base',
    kind: 'non-text',
  },
  {
    label: 'Panel edge on a panel',
    foreground: 'border-hairline',
    background: 'surface-raised',
    kind: 'non-text',
  },
  {
    label: 'Divider',
    foreground: 'border-strong',
    background: 'surface-base',
    kind: 'non-text',
  },
  {
    label: 'Control edge',
    foreground: 'control-border',
    background: 'surface-base',
    kind: 'non-text',
  },
  {
    label: 'Control edge on a panel',
    foreground: 'control-border',
    background: 'surface-raised',
    kind: 'non-text',
  },
  {
    label: 'Control edge on its own fill',
    foreground: 'control-border',
    background: 'control-surface',
    kind: 'non-text',
  },
  { label: 'Focus ring', foreground: 'focus-ring', background: 'surface-base', kind: 'non-text' },
  {
    label: 'Focus ring on a panel',
    foreground: 'focus-ring',
    background: 'surface-raised',
    kind: 'non-text',
  },
  {
    label: 'Focus ring in a control',
    foreground: 'focus-ring',
    background: 'control-surface',
    kind: 'non-text',
  },
  { label: 'Accent fill', foreground: 'accent', background: 'surface-base', kind: 'non-text' },
  {
    label: 'Accent fill on a panel',
    foreground: 'accent',
    background: 'surface-raised',
    kind: 'non-text',
  },
  {
    label: 'Selection bar',
    foreground: 'accent',
    background: 'surface-overlay',
    kind: 'non-text',
  },
];

/* ========================================================================== *
 * Arithmetic
 * ========================================================================== */

/**
 * Why a pair has no ratio, when it has none.
 *
 * A union of literals rather than a free string, so a caller rendering these
 * has to handle every case and the compiler tells it when a new one appears.
 */
export type ContrastProblem = 'missing' | 'unreadable' | 'translucent';

export interface Measurement {
  readonly pair: ContrastPair;
  readonly threshold: number;
  /** The colour each side actually resolved to, for the readout. */
  readonly foregroundValue: string | null;
  readonly backgroundValue: string | null;
  /** null when the pair could not be measured; `problem` says why. */
  readonly ratio: number | null;
  readonly problem: ContrastProblem | null;
  readonly passes: boolean;
}

/**
 * The contrast ratio between two CSS colours, or a reason there is none.
 *
 * Parsing is the colour tool's, so the editor accepts exactly the notations
 * that tool converts between - hex, rgb(), hsl() and oklch() - and one parser
 * defines what a colour is. The luminance and ratio are `@/lib/wcag`'s, which
 * is the same arithmetic the colour tool's own contrast readout uses.
 */
export function contrastBetween(
  foreground: string,
  background: string,
): { readonly ratio: number | null; readonly problem: ContrastProblem | null } {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (!fg.ok || !bg.ok) return { ratio: null, problem: 'unreadable' };

  /*
   * A translucent colour has no single contrast ratio: what it reads against
   * depends on what happens to be underneath, which is a layout question, not
   * a colour one. Reporting "cannot say" is honest; compositing it against the
   * nominal background would produce a number that is right only sometimes.
   */
  if (fg.value.a < 1 || bg.value.a < 1) return { ratio: null, problem: 'translucent' };

  return {
    ratio: contrastRatio(
      relativeLuminance(fg.value.r, fg.value.g, fg.value.b),
      relativeLuminance(bg.value.r, bg.value.g, bg.value.b),
    ),
    problem: null,
  };
}

/**
 * Looks a themed token up and returns its colour, or undefined.
 *
 * A FUNCTION TYPE as a parameter is what keeps this module free of any opinion
 * about where the colours came from. The test passes a reader backed by the
 * parsed stylesheet; the editor passes one backed by a draft's overrides
 * falling through to its base preset. Neither has to know about the other.
 */
export type TokenReader = (token: ThemedToken) => string | undefined;

export function measureContrast(read: TokenReader): readonly Measurement[] {
  return CONTRAST_PAIRS.map((pair) => {
    const threshold = thresholdFor(pair.kind);
    const foregroundValue = read(pair.foreground) ?? null;
    const backgroundValue = read(pair.background) ?? null;

    if (foregroundValue === null || backgroundValue === null) {
      return {
        pair,
        threshold,
        foregroundValue,
        backgroundValue,
        ratio: null,
        problem: 'missing' as const,
        passes: false,
      };
    }

    const { ratio, problem } = contrastBetween(foregroundValue, backgroundValue);
    return {
      pair,
      threshold,
      foregroundValue,
      backgroundValue,
      ratio,
      problem,
      passes: ratio !== null && ratio >= threshold,
    };
  });
}

export interface ContrastSummary {
  readonly total: number;
  readonly failing: number;
  /** The pair furthest below its threshold, which is the one worth naming. */
  readonly worst: Measurement | null;
}

export function summariseContrast(measurements: readonly Measurement[]): ContrastSummary {
  const failures = measurements.filter((measurement) => !measurement.passes);

  /*
   * Ranked by SHORTFALL, not by ratio. A non-text pair at 2.9:1 is a hair
   * under its 3:1 bar; a text pair at 3.5:1 is a whole point under its 4.5:1
   * one, and is the more useful thing to put in front of someone even though
   * its raw number is higher. An unmeasurable pair sorts to the top, because
   * "cannot tell" needs looking at before "nearly".
   */
  const shortfall = (measurement: Measurement): number =>
    measurement.ratio === null
      ? Number.POSITIVE_INFINITY
      : measurement.threshold - measurement.ratio;

  let worst: Measurement | null = null;
  for (const failure of failures) {
    if (worst === null || shortfall(failure) > shortfall(worst)) worst = failure;
  }

  return { total: measurements.length, failing: failures.length, worst };
}

/* ========================================================================== *
 * Readers
 * ========================================================================== */

/**
 * A reader for one preset, straight out of the stylesheet.
 *
 * The `pb-` prefix is where the two naming schemes meet: a `ThemedToken` is
 * `accent`, the CSS custom property is `--pb-accent`, and `cachedTheme` keys
 * its map on the name without the leading dashes.
 */
export function presetReader(theme: ThemeName): TokenReader {
  const tokens = cachedTheme(theme);
  return (token) => tokens[`pb-${token}`];
}

/**
 * A reader for a theme being edited: its own overrides first, then whatever
 * its base preset says. Exactly the resolution order the browser performs,
 * because `applyTheme` writes overrides as inline custom properties on the
 * same element the `[data-theme]` block targets.
 */
export function draftReader(
  base: ThemeName,
  overrides: Partial<Record<ThemedToken, string>>,
): TokenReader {
  const inherited = presetReader(base);
  return (token) => overrides[token] ?? inherited(token);
}
