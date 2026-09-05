import { describe, expect, it } from 'vitest';

import {
  CONTRAST_PAIRS,
  measureContrast,
  presetReader,
  type ContrastPair,
} from '@/features/theme/contrast';
import { THEME_NAMES } from '@/features/theme/types';
import { resolveTheme, semanticTokenNames } from '@/lib/cssTokens';

/**
 * WCAG AA, ASSERTED AGAINST THE REAL STYLESHEET.
 *
 * The pair list and the arithmetic both come from features/theme/contrast.ts,
 * which is also what the theme editor uses to measure a theme somebody is
 * building. That sharing is the point: a preset loaded into the editor as a
 * custom theme has to produce exactly the numbers this file asserts, and it
 * can only be guaranteed to if there is one implementation rather than two
 * that agree today.
 *
 * `presetReader` resolves the tokens by parsing primitives.css, semantic.css
 * and themes.css, which is what the browser does with the cascade - see
 * lib/cssTokens.ts for why that is read rather than computed.
 */
describe.each(THEME_NAMES)('theme: %s', (theme) => {
  const measurements = measureContrast(presetReader(theme));

  const cases: readonly (readonly [string, ContrastPair])[] = CONTRAST_PAIRS.map((pair) => [
    `${pair.label} (--pb-${pair.foreground} on --pb-${pair.background})`,
    pair,
  ]);

  it.each(cases)('%s meets AA', (_name, pair) => {
    const measurement = measurements.find((one) => one.pair === pair);
    expect(measurement, 'pair was not measured').toBeDefined();
    if (measurement === undefined) return;

    expect(measurement.foregroundValue, `--pb-${pair.foreground} is not defined`).not.toBeNull();
    expect(measurement.backgroundValue, `--pb-${pair.background} is not defined`).not.toBeNull();

    expect(
      measurement.ratio,
      `${theme}: --pb-${pair.foreground} (${measurement.foregroundValue ?? '?'}) on --pb-${pair.background} (${measurement.backgroundValue ?? '?'}) could not be measured: ${measurement.problem ?? 'unknown'}`,
    ).not.toBeNull();

    expect(
      measurement.ratio ?? 0,
      `${theme}: --pb-${pair.foreground} (${measurement.foregroundValue ?? '?'}) on --pb-${pair.background} (${measurement.backgroundValue ?? '?'}) is ${(measurement.ratio ?? 0).toFixed(2)}:1, needs ${measurement.threshold.toFixed(1)}:1`,
    ).toBeGreaterThanOrEqual(measurement.threshold);
  });

  it('defines every themed semantic token', () => {
    const tokens = resolveTheme(theme);
    const missing = semanticTokenNames().filter((name) => tokens[name] === undefined);
    expect(missing).toEqual([]);
  });
});
