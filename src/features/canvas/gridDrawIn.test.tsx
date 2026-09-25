import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import styles from './canvas.module.css';
import { GridLayer } from './GridLayer';
import { DEFAULT_VIEWPORT } from './viewportStore';

/*
 * ONE TEST, BECAUSE THE STATE UNDER TEST IS THE MODULE'S. "Once per page load"
 * is a module-level flag in GridLayer.tsx, and a module is evaluated once per
 * test file - so the order below is the order a page would see, and nothing
 * else in this file may mount a grid first.
 */
describe('the grid', () => {
  it('draws in once per page load, and only once it can be seen', () => {
    const drawing = (container: HTMLElement): boolean =>
      container
        .querySelector('[data-testid="canvas-grid"]')
        ?.classList.contains(styles.gridDrawing ?? '') ?? false;

    // Behind the cold open: nothing yet, and the draw-in is not spent.
    const hidden = render(<GridLayer viewport={DEFAULT_VIEWPORT} revealed={false} />);
    expect(drawing(hidden.container)).toBe(false);

    // The panel comes down.
    hidden.rerender(<GridLayer viewport={DEFAULT_VIEWPORT} revealed />);
    expect(drawing(hidden.container)).toBe(true);
    hidden.unmount();

    // Back from another route: the same page, so never again.
    const again = render(<GridLayer viewport={DEFAULT_VIEWPORT} revealed />);
    expect(drawing(again.container)).toBe(false);
  });
});
