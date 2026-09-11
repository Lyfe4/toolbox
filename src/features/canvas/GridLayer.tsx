import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import styles from './canvas.module.css';
import { gridLevels, gridRules } from './grid';

import type { Viewport } from './viewportStore';

/**
 * THE CANVAS'S GRID.
 *
 * A `<canvas>` rather than a background image, and `grid.ts` carries the whole
 * argument for why: a CSS gradient cannot put a one-pixel rule on a device
 * pixel, and everything wrong with the grid at fractional zoom followed from
 * that. Here every rule is rounded to a whole device pixel, so every rule is
 * one device pixel of full ink.
 *
 * WHAT THIS FILE OWNS, which is only the parts that need a document: the
 * backing store's size, the ink, and when to redraw. Where the rules go is
 * `grid.ts`'s and is tested without a DOM.
 */
export interface GridLayerProps {
  readonly viewport: Viewport;
}

/** The ink for one draw, resolved from the cascade rather than hard-coded. */
interface GridInk {
  readonly minor: string;
  readonly major: string;
}

/**
 * WHY THE COLOURS ARE READ BACK OUT OF CSS.
 *
 * A canvas takes a colour string, not a custom property, so the tokens have to
 * be resolved before they can be drawn with - and resolving them HERE, off the
 * live element, is what keeps `themes.css` the only place they are written.
 * `--pb-canvas-grid-*` are read straight through because a custom property's
 * computed value is already substituted, so they arrive as the hex the theme
 * declared.
 *
 * FORCED COLOURS IS THE EXCEPTION and takes the other path. The OS replaces the
 * palette, but it does not reach into a canvas bitmap - so the tokens would
 * still be the app's own hex on a surface that is no longer the app's own
 * colour. System colours are not reliably parseable by every engine's canvas
 * either, so instead the stylesheet puts one on the element's `color`, which is
 * a real property and therefore computes to something every engine can parse.
 * Only the major rule survives: system colours come in two weights and a faded
 * rule is not available, so the honest reduction is the one rank that says
 * where the world's axes are.
 */
function inkFrom(canvas: HTMLCanvasElement): GridInk {
  const style = window.getComputedStyle(canvas);

  if (window.matchMedia('(forced-colors: active)').matches) {
    return { minor: 'transparent', major: style.color };
  }

  return {
    minor: style.getPropertyValue('--pb-canvas-grid-minor').trim(),
    major: style.getPropertyValue('--pb-canvas-grid-major').trim(),
  };
}

/**
 * A rule's width, in device pixels.
 *
 * One device pixel per whole CSS pixel of scale, so a hairline is a hairline at
 * every density: one device pixel at 1x, two at 2x. Rounded rather than exact,
 * because a fractional-width rect is antialiased along its edge and that is the
 * artefact this whole layer exists to remove - a slightly heavier or lighter
 * hairline on an unusual display is a far smaller price than a soft one.
 */
function ruleWidth(dpr: number): number {
  return Math.max(1, Math.round(dpr));
}

function draw(canvas: HTMLCanvasElement, viewport: Viewport, dpr: number): void {
  const context = canvas.getContext('2d');
  // jsdom has no 2D context at all, and a lost context returns null too.
  if (!context) return;

  const width = Math.round(canvas.clientWidth * dpr);
  const height = Math.round(canvas.clientHeight * dpr);
  if (width <= 0 || height <= 0) return;

  // Assigning either dimension clears the bitmap, so only touch them on a real
  // change: a resize is rare and a pan is every frame.
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.clearRect(0, 0, width, height);

  const ink = inkFrom(canvas);
  const levels = gridLevels(viewport.zoom);
  const thickness = ruleWidth(dpr);

  const columns = gridRules(viewport.x, canvas.clientWidth, viewport.zoom, dpr);
  const rows = gridRules(viewport.y, canvas.clientHeight, viewport.zoom, dpr);

  for (const [index, level] of levels.entries()) {
    if (level.strength <= 0) continue;

    /*
     * BOTH AXES IN ONE PATH, FILLED ONCE.
     *
     * Two fills would composite twice wherever a rule crosses a rule, so every
     * intersection of a part-drawn level would come out darker than the rules
     * that make it - a field of dots over the grid, at exactly the zooms where a
     * level is fading in. One fill of a self-overlapping path paints each pixel
     * once whatever crosses it.
     */
    const path = new Path2D();
    for (const rule of columns) {
      if (rule.level === index) path.rect(rule.at, 0, thickness, height);
    }
    for (const rule of rows) {
      if (rule.level === index) path.rect(0, rule.at, width, thickness);
    }

    context.globalAlpha = level.strength;
    context.fillStyle = index === 0 ? ink.major : ink.minor;
    context.fill(path);
  }

  context.globalAlpha = 1;
}

export function GridLayer({ viewport }: GridLayerProps) {
  const ref = useRef<HTMLCanvasElement>(null);

  /**
   * WHAT MAKES THE GRID REDRAW, beyond the viewport moving.
   *
   * A background image was repainted by the compositor whenever anything about
   * it changed, and nothing had to say so. A bitmap has to be told. Four things
   * change what this layer should look like without changing the viewport: the
   * layer's own size, the theme, the display's density, and the accessibility
   * media queries that rewrite the tokens. A counter is the redraw request, for
   * the reason the inspector's focus request is one - two changes in a row are
   * two requests where a boolean would be one.
   */
  const [epoch, setEpoch] = useState(0);
  const [dpr, setDpr] = useState(() =>
    typeof window === 'undefined' ? 1 : window.devicePixelRatio,
  );

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;

    const bump = (): void => {
      setEpoch((request) => request + 1);
    };

    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(bump) : undefined;
    resize?.observe(canvas);

    /*
     * The theme is written to the root as an attribute by `applyTheme`, and a
     * custom theme's overrides as inline custom properties on the same element,
     * so watching its attributes catches a preset switch and a live edit alike.
     * Nothing else on the root changes often enough for this to be a cost.
     */
    const themes = new MutationObserver(bump);
    themes.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style', 'class'],
    });

    const queries = [
      // The system theme, when that is what the user picked.
      window.matchMedia('(prefers-color-scheme: dark)'),
      // Both of these rewrite the grid's own tokens in global.css.
      window.matchMedia('(forced-colors: active)'),
      window.matchMedia('(prefers-contrast: more)'),
    ];
    for (const query of queries) query.addEventListener('change', bump);

    return () => {
      resize?.disconnect();
      themes.disconnect();
      for (const query of queries) query.removeEventListener('change', bump);
    };
  }, []);

  /*
   * Density is watched separately, and keyed on the value in hand, because the
   * query has to name the density it is watching FOR. Moving a window to a
   * display with a different one fires this, the state changes, and the effect
   * rebinds around the new value.
   */
  useEffect(() => {
    const query = window.matchMedia(`(resolution: ${dpr.toString()}dppx)`);
    const onChange = (): void => {
      setDpr(window.devicePixelRatio);
    };
    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, [dpr]);

  /*
   * A LAYOUT EFFECT, so the grid and the plane move in the same frame.
   *
   * The plane's transform is an inline style set during this render, so it is on
   * screen the moment this commit paints. A passive effect would draw the grid
   * AFTER that paint, which during a fast pan is the grid one frame behind the
   * nodes - visible as the whole backdrop lagging whatever is on it.
   */
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (canvas) draw(canvas, viewport, dpr);
  }, [viewport, dpr, epoch]);

  return <canvas ref={ref} className={styles.grid} aria-hidden="true" data-testid="canvas-grid" />;
}
