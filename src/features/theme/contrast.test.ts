import { describe, expect, it } from 'vitest';

import { resolveTheme } from '@/lib/cssTokens';

import {
  AA_NON_TEXT,
  AA_TEXT,
  CONTRAST_PAIRS,
  contrastBetween,
  draftReader,
  measureContrast,
  presetReader,
  summariseContrast,
} from './contrast';
import { THEMED_TOKENS, THEME_NAMES } from './types';

describe('contrastBetween', () => {
  it('gives the textbook extremes', () => {
    expect(contrastBetween('#000000', '#ffffff').ratio).toBeCloseTo(21, 5);
    expect(contrastBetween('#808080', '#808080').ratio).toBeCloseTo(1, 5);
  });

  it('reads every notation the colour tool converts between', () => {
    const hex = contrastBetween('#3b82f6', '#ffffff').ratio;

    // The same blue, four ways. All four have to agree, because the editor
    // lets the user type whichever they think in.
    expect(contrastBetween('rgb(59 130 246)', '#ffffff').ratio).toBeCloseTo(hex ?? 0, 6);
    expect(contrastBetween('hsl(217 91% 60%)', '#ffffff').ratio).toBeCloseTo(hex ?? 0, 1);
    expect(contrastBetween('oklch(0.62 0.19 259)', '#ffffff').ratio).toBeCloseTo(hex ?? 0, 0);
  });

  it('refuses to guess at a colour it cannot read', () => {
    expect(contrastBetween('not a colour', '#ffffff')).toEqual({
      ratio: null,
      problem: 'unreadable',
    });
  });

  it('refuses to guess at a translucent colour', () => {
    /*
     * A ratio for `#ffffff80` would depend on what happens to be underneath,
     * which is a layout question. Saying "cannot tell" is the honest answer;
     * compositing against the nominal background would produce a number that
     * is right only sometimes.
     */
    expect(contrastBetween('#ffffff80', '#000000')).toEqual({
      ratio: null,
      problem: 'translucent',
    });
  });
});

describe('CONTRAST_PAIRS', () => {
  it('names only real tokens', () => {
    const known = new Set<string>(THEMED_TOKENS);
    for (const pair of CONTRAST_PAIRS) {
      expect(known.has(pair.foreground), `${pair.foreground} is not a themed token`).toBe(true);
      expect(known.has(pair.background), `${pair.background} is not a themed token`).toBe(true);
    }
  });

  it('has no duplicates, so nothing is measured twice', () => {
    const keys = CONTRAST_PAIRS.map((pair) => `${pair.foreground}/${pair.background}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has a distinct label for every pair, since the label is the identity', () => {
    const labels = CONTRAST_PAIRS.map((pair) => pair.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('uses the WCAG thresholds and nothing invented', () => {
    expect(AA_TEXT).toBe(4.5);
    expect(AA_NON_TEXT).toBe(3);
  });

  it('leaves --pb-border-subtle out, because it carries no meaning', () => {
    const mentions = CONTRAST_PAIRS.filter(
      (pair) => pair.foreground === 'border-subtle' || pair.background === 'border-subtle',
    );
    expect(mentions).toEqual([]);
  });
});

describe('measureContrast', () => {
  /*
   * THE POINT OF THE WHOLE MODULE.
   *
   * A preset loaded into the editor as a custom theme is the same theme, so
   * the editor's live readout has to produce exactly what themes.contrast.
   * test.ts asserts about that preset. Anything else means the editor could
   * bless a theme the suite would fail, or condemn one it would pass.
   */
  it.each(THEME_NAMES)('agrees with the preset reader for %s loaded as a custom theme', (theme) => {
    const asPreset = measureContrast(presetReader(theme));

    // Every token copied into `overrides`, which is what "duplicate this
    // preset into a custom theme" produces.
    const tokens = resolveTheme(theme);
    const overrides: Record<string, string> = {};
    for (const token of THEMED_TOKENS) {
      const value = tokens[`pb-${token}`];
      if (value !== undefined) overrides[token] = value;
    }
    const asCustom = measureContrast(draftReader(theme, overrides));

    expect(asCustom.map((one) => one.ratio)).toEqual(asPreset.map((one) => one.ratio));
    expect(asCustom.every((one) => one.passes)).toBe(true);
  });

  it('resolves an override over the inherited value', () => {
    const read = draftReader('graphite', { 'ink-primary': '#010101' });
    expect(read('ink-primary')).toBe('#010101');
    expect(read('surface-base')).toBe(resolveTheme('graphite')['pb-surface-base']);
  });

  it('marks a pair failing when an override destroys it', () => {
    const measurements = measureContrast(
      draftReader('graphite', { 'ink-primary': '#0c0d12', 'surface-base': '#0b0d11' }),
    );
    const body = measurements.find((one) => one.pair.label === 'Body text');

    expect(body?.passes).toBe(false);
    expect(body?.ratio ?? 0).toBeLessThan(AA_TEXT);
    // The readout has to be able to say what failed against what.
    expect(body?.foregroundValue).toBe('#0c0d12');
    expect(body?.backgroundValue).toBe('#0b0d11');
  });

  it('reports a missing token rather than pretending it is black', () => {
    const measurements = measureContrast(() => undefined);
    expect(measurements.every((one) => one.problem === 'missing')).toBe(true);
    expect(measurements.every((one) => one.passes)).toBe(false);
  });
});

describe('summariseContrast', () => {
  it('counts nothing when every preset pair passes', () => {
    expect(summariseContrast(measureContrast(presetReader('vellum')))).toEqual({
      total: CONTRAST_PAIRS.length,
      failing: 0,
      worst: null,
    });
  });

  it('ranks the worst failure by shortfall, not by raw ratio', () => {
    /*
     * Measured, so the case is real rather than assumed: `ink-muted` here
     * lands 1.57 below its 4.5 bar and `focus-ring` 0.89 below its 3.0 one.
     * The RAW numbers say the focus ring is worse - it is at 2.11:1 and the
     * muted text at 2.93:1 - but the muted text is further from where it needs
     * to be, and that is what a person should be shown first.
     */
    const measurements = measureContrast(
      draftReader('graphite', {
        'ink-muted': '#5f6474',
        'focus-ring': '#4a4f5c',
      }),
    );
    const summary = summariseContrast(measurements);
    const worstRatio = Math.min(
      ...measurements.filter((one) => !one.passes).map((one) => one.ratio ?? 0),
    );

    expect(summary.failing).toBe(6);
    expect(summary.worst?.pair.foreground).toBe('ink-muted');
    // The pair with the lowest ratio is a focus-ring pair, and it is NOT the
    // one reported - which is the whole distinction this test exists for.
    expect(summary.worst?.ratio ?? 0).toBeGreaterThan(worstRatio);
  });

  it('puts an unmeasurable pair ahead of a merely poor one', () => {
    const summary = summariseContrast(
      measureContrast(
        draftReader('graphite', { 'ink-muted': '#6d7280', 'focus-ring': 'nonsense' }),
      ),
    );
    expect(summary.worst?.problem).toBe('unreadable');
  });
});
