import { describe, expect, it } from 'vitest';

import { contrastBetween, presetReader } from '@/features/theme/contrast';
import { THEME_NAMES, type ThemedToken } from '@/features/theme/types';

/**
 * THE CANVAS GRID'S INK, MEASURED.
 *
 * This is the bug that produced three different-looking grids at three zooms,
 * and it was never geometry. The minor rules were `--pb-border-subtle`, a token
 * specified against `--pb-surface-raised` - a decorative rule inside a panel.
 * Against `--pb-surface-sunken`, which is what the canvas actually is, it
 * measured 1.26:1 in graphite, 1.41:1 in phosphor, 1.48:1 in blueprint and
 * EXACTLY 1.00:1 in vellum, where `--pb-border-subtle` and
 * `--pb-surface-sunken` resolve to the same paper shade.
 *
 * A line at 1.00:1 is not a faint line, it is no line. What made that survive
 * review is that it did not look like nothing at every zoom: at 90% the rules
 * were 7.2px apart, and a field of near-invisible hairlines that dense sums
 * into a perceptible tint. So the grid appeared to work at the zoom people
 * looked at, vanished when the rules spread out at 250%, and turned into a flat
 * wash when they closed up at 33%. One cause, three symptoms, none of them
 * looking like a colour problem.
 *
 * WHY A RANGE AND NOT A FLOOR. Every other contrast assertion in this repo is
 * "at least", because every other one is about legibility and more is never
 * worse. A grid rule is the opposite kind of thing: it is backing, it sits
 * behind the work, and being too loud is a real failure - a major rule heavier
 * than a node's own border makes the backdrop compete with the content. So both
 * ends are asserted, and the bands are narrow enough that a theme cannot drift
 * into either failure.
 *
 * It is not in `CONTRAST_PAIRS` for the reason `--pb-border-subtle` is not: no
 * WCAG criterion applies to it. See the note at the top of
 * features/theme/contrast.ts.
 */

/** Minor rules: a line you can see and can never read. */
const MINOR_RANGE = { min: 1.4, max: 1.7 };

/**
 * Major rules: structure, but quieter than a node.
 *
 * A canvas node's edge is `--pb-border-strong`, measured at 3.57:1 in vellum
 * and up to 6.2:1 elsewhere by themes.contrast.test.ts. Holding the major rule
 * under 3.3 keeps the backdrop below the content in every theme rather than
 * only in the ones where the node border happens to be heavy.
 */
const MAJOR_RANGE = { min: 2.4, max: 3.3 };

describe.each(THEME_NAMES)('canvas grid ink: %s', (theme) => {
  const read = presetReader(theme);

  const ratioAgainstCanvas = (token: ThemedToken): { ratio: number; value: string } => {
    const value = read(token);
    const backdrop = read('surface-sunken');
    expect(value, `--pb-${token} is not defined`).toBeDefined();
    expect(backdrop, '--pb-surface-sunken is not defined').toBeDefined();
    if (value === undefined || backdrop === undefined) return { ratio: 0, value: '?' };

    /*
     * `contrastBetween`, not a second copy of the arithmetic. It is the same
     * function the theme editor's live readout and themes.contrast.test.ts
     * both go through, for the reason set out at the top of contrast.ts: two
     * implementations that agree today is the failure mode worth avoiding.
     */
    const { ratio } = contrastBetween(value, backdrop);
    expect(ratio, `could not measure --pb-${token} (${value})`).not.toBeNull();

    return { ratio: ratio ?? 0, value };
  };

  it.each([
    ['canvas-grid-minor' as const, MINOR_RANGE],
    ['canvas-grid-major' as const, MAJOR_RANGE],
  ])('--pb-%s sits in its band against the canvas', (token, range) => {
    const { ratio, value } = ratioAgainstCanvas(token);
    const detail = `${theme}: --pb-${token} (${value}) is ${ratio.toFixed(2)}:1 on --pb-surface-sunken`;

    expect(ratio, `${detail}, needs at least ${range.min.toFixed(1)}:1`).toBeGreaterThanOrEqual(
      range.min,
    );
    expect(ratio, `${detail}, needs at most ${range.max.toFixed(1)}:1`).toBeLessThanOrEqual(
      range.max,
    );
  });

  it('draws the major rule more heavily than the minor one', () => {
    // The hierarchy is the whole point of having two weights. Equal ink is a
    // grid with no reference in it, and inverted ink is a grid that reads
    // eight times too coarse.
    expect(ratioAgainstCanvas('canvas-grid-major').ratio).toBeGreaterThan(
      ratioAgainstCanvas('canvas-grid-minor').ratio * 1.3,
    );
  });
});
