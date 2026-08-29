import { describe, expect, it } from 'vitest';

import { contrastRatioHex } from '@/lib/color';
import { resolveTheme, semanticTokenNames } from '@/lib/testing/cssTokens';

/**
 * Every preset. `as const` freezes this into a tuple of literal strings rather
 * than a general `string[]`, so a typo here is a compile error.
 */
const THEMES = ['graphite', 'vellum', 'phosphor', 'blueprint'] as const;

/** WCAG 2.2 AA thresholds. */
const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

/** Foreground/background token pairs that must clear the body-text ratio. */
const TEXT_PAIRS: readonly (readonly [string, string])[] = [
  ['pb-ink-primary', 'pb-surface-base'],
  ['pb-ink-primary', 'pb-surface-raised'],
  ['pb-ink-primary', 'pb-surface-overlay'],
  ['pb-ink-secondary', 'pb-surface-base'],
  ['pb-ink-secondary', 'pb-surface-raised'],
  ['pb-ink-muted', 'pb-surface-base'],
  ['pb-ink-muted', 'pb-surface-raised'],
  ['pb-ink-accent', 'pb-surface-base'],
  ['pb-ink-accent', 'pb-surface-raised'],
  ['pb-ink-on-accent', 'pb-accent'],
  ['pb-ink-inverse', 'pb-ink-primary'],
  ['pb-signal-ok', 'pb-surface-base'],
  ['pb-signal-warn', 'pb-surface-base'],
  ['pb-signal-error', 'pb-surface-base'],
  ['pb-signal-ok', 'pb-surface-raised'],
  ['pb-signal-warn', 'pb-surface-raised'],
  ['pb-signal-error', 'pb-surface-raised'],
  ['pb-selection-ink', 'pb-selection-surface'],
  ['pb-ink-primary', 'pb-control-surface'],
];

/**
 * Boundaries and indicators. WCAG 1.4.11 asks 3:1 of anything a user must
 * perceive to operate a control. `--pb-border-subtle` is intentionally absent:
 * it draws decorative rules inside a panel and carries no meaning.
 */
const NON_TEXT_PAIRS: readonly (readonly [string, string])[] = [
  ['pb-border-hairline', 'pb-surface-base'],
  ['pb-border-hairline', 'pb-surface-raised'],
  ['pb-border-strong', 'pb-surface-base'],
  ['pb-control-border', 'pb-surface-base'],
  ['pb-control-border', 'pb-surface-raised'],
  ['pb-control-border', 'pb-control-surface'],
  ['pb-focus-ring', 'pb-surface-base'],
  ['pb-focus-ring', 'pb-surface-raised'],
  ['pb-focus-ring', 'pb-control-surface'],
  ['pb-accent', 'pb-surface-base'],
  ['pb-accent', 'pb-surface-raised'],
];

describe.each(THEMES)('theme: %s', (theme) => {
  const tokens = resolveTheme(theme);

  it.each(TEXT_PAIRS)('%s on %s meets AA for body text', (fg, bg) => {
    const fgHex = tokens[fg];
    const bgHex = tokens[bg];
    expect(fgHex, `--${fg} is not defined`).toBeDefined();
    expect(bgHex, `--${bg} is not defined`).toBeDefined();

    const ratio = contrastRatioHex(fgHex ?? '', bgHex ?? '');
    expect(
      ratio,
      `${theme}: --${fg} (${fgHex ?? '?'}) on --${bg} (${bgHex ?? '?'}) is ${ratio.toFixed(2)}:1, needs ${AA_TEXT.toString()}:1`,
    ).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it.each(NON_TEXT_PAIRS)('%s on %s meets AA for UI boundaries', (fg, bg) => {
    const fgHex = tokens[fg];
    const bgHex = tokens[bg];
    const ratio = contrastRatioHex(fgHex ?? '', bgHex ?? '');
    expect(
      ratio,
      `${theme}: --${fg} (${fgHex ?? '?'}) on --${bg} (${bgHex ?? '?'}) is ${ratio.toFixed(2)}:1, needs ${AA_NON_TEXT.toString()}:1`,
    ).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  it('defines every themed semantic token', () => {
    const missing = semanticTokenNames().filter((name) => tokens[name] === undefined);
    expect(missing).toEqual([]);
  });
});
