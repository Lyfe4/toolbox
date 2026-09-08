import { describe, expect, it } from 'vitest';

import { keyboardInset } from './keyboardInset';

/**
 * The arithmetic behind keeping the inspector sheet above the keyboard.
 *
 * The wiring is in `keyboardInset.ts` and the geometry is asserted in
 * `check:browsers`; this is the pure function on its own, which is the half
 * that has edge cases. jsdom has no layout, so every measurement here is
 * supplied rather than read - the right shape for a pure function and the
 * wrong shape for anything that has to know what a real box is.
 *
 * WHY THIS REPLACED `panToReveal`. The canvas used to pan its own viewport to
 * lift a focused NODE field clear of the keyboard, because the plane is a 0x0
 * transformed box inside an `overflow: hidden` root and there was nothing for
 * a browser to scroll. There are no fields on the plane any more: input is
 * entered in the inspector, which is an ordinary scroll container, so the
 * engine reveals a focused field there by itself exactly as it does on a tool
 * page. What no engine can do is move the sheet, which is anchored to the
 * bottom of the LAYOUT viewport while the keyboard shrinks the VISUAL one.
 *
 * NOTE ON WHAT IS NOT PROVEN ANYWHERE: no engine Playwright drives can open a
 * soft keyboard, so nothing in this repo has watched a real one appear. See the
 * comment at the top of `keyboardInset.ts`.
 */
describe('keyboardInset', () => {
  it('is zero when the visible band fills the layout viewport', () => {
    expect(keyboardInset({ top: 0, bottom: 780 }, 780)).toBe(0);
  });

  it('is the height a keyboard covers', () => {
    // An iPhone-sized keyboard over a 780px viewport.
    expect(keyboardInset({ top: 0, bottom: 444 }, 780)).toBe(336);
  });

  /*
   * A pinch-zoomed page has a visual viewport that starts partway down the
   * layout one. What matters is where its BOTTOM is, not its height - a band
   * of 300px starting at 100 covers the same ground as one of 400 starting at
   * 0, and only the first leaves 380px of layout viewport underneath it.
   */
  it('measures from the band bottom, not from the band height', () => {
    expect(keyboardInset({ top: 100, bottom: 400 }, 780)).toBe(380);
  });

  /*
   * iOS lets the visual viewport extend past the layout one during an
   * overscroll, which produces a negative cover. That is not a keyboard, and
   * an inset below zero would push the sheet off the bottom of the screen.
   */
  it('never goes below zero when the visual viewport overhangs', () => {
    expect(keyboardInset({ top: 0, bottom: 820 }, 780)).toBe(0);
  });

  /*
   * The two viewports are resized in separate frames, so a measurement taken
   * between them can say the keyboard covers more than the whole screen.
   * Clamping means the sheet is briefly pinned to the top rather than pushed
   * off it, which is recoverable; the alternative is not.
   */
  it('never exceeds the layout viewport', () => {
    expect(keyboardInset({ top: 0, bottom: -200 }, 780)).toBe(780);
  });

  it('rounds, so the property is written as whole pixels', () => {
    expect(keyboardInset({ top: 0, bottom: 443.6 }, 780)).toBe(336);
  });

  it('is zero for a viewport height that is not a usable number', () => {
    expect(keyboardInset({ top: 0, bottom: 400 }, 0)).toBe(0);
    expect(keyboardInset({ top: 0, bottom: 400 }, Number.NaN)).toBe(0);
  });
});
