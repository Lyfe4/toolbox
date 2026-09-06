import { describe, expect, it } from 'vitest';

import { panToReveal } from './keyboardInset';

/**
 * The maths behind keeping a focused node field out from behind the keyboard.
 *
 * The wiring is in `keyboardInset.ts` and the geometry is asserted in
 * `check:browsers`; this is the arithmetic on its own, which is the half that
 * has edge cases. jsdom has no layout, so every rectangle here is supplied
 * rather than measured - which is the right shape for a pure function and the
 * wrong shape for anything that has to know what a real box is.
 *
 * NOTE ON WHAT IS NOT PROVEN ANYWHERE: no engine Playwright drives can open a
 * soft keyboard, so nothing in this repo has watched a real one appear. See the
 * comment at the top of `keyboardInset.ts`.
 */
describe('panToReveal', () => {
  const band = { top: 0, bottom: 400 };

  it('leaves a field that is already comfortably inside alone', () => {
    expect(panToReveal({ top: 100, bottom: 148 }, band)).toBe(0);
  });

  it('moves a field below the band up by just enough', () => {
    // Bottom 500, usable bottom 388: the content moves up 112.
    expect(panToReveal({ top: 452, bottom: 500 }, band)).toBe(-112);
  });

  it('moves a field above the band down by just enough', () => {
    expect(panToReveal({ top: -30, bottom: 18 }, band)).toBe(42);
  });

  it('counts the margin, so a field flush with the edge still moves', () => {
    expect(panToReveal({ top: 356, bottom: 400 }, band)).toBe(-12);
  });

  /*
   * A node's textarea is taller than what is left of the screen once a
   * keyboard is up. Both edges cannot be satisfied, and revealing the TOP is
   * the useful answer - that is where the caret starts and where the port
   * label sits. Preferring the bottom would scroll the caret off the top of
   * the screen, which is the failure this whole file exists to avoid.
   */
  it('reveals the top of a field taller than the band', () => {
    const delta = panToReveal({ top: 300, bottom: 900 }, band);
    expect(delta).toBe(-288);
    expect(300 + delta).toBe(band.top + 12);
  });

  /*
   * A keyboard covering all but a sliver. Panning to some arbitrary position
   * inside 8px of screen helps nobody, and the pan would have to be undone the
   * moment the keyboard closed.
   */
  it('does nothing when the visible band is smaller than its own margins', () => {
    expect(panToReveal({ top: 500, bottom: 548 }, { top: 0, bottom: 20 })).toBe(0);
  });

  /*
   * A pinch-zoomed page has a visual viewport that starts partway down the
   * layout one, and `getBoundingClientRect` is relative to the layout viewport.
   * If the band's own offset were dropped, every pan would be wrong by it.
   */
  it('measures against a band that does not start at zero', () => {
    expect(panToReveal({ top: 120, bottom: 168 }, { top: 200, bottom: 500 })).toBe(92);
  });
});
