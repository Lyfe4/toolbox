import { create } from 'zustand';

import { clamp, graphBounds, MAX_ZOOM, MIN_ZOOM, type Rect } from './geometry';

import type { GraphData, Point } from './types';

/**
 * Viewport state, deliberately separate from graph state.
 *
 * Panning changes fifty times a second and changes nothing about the document;
 * the graph changes rarely and is what gets saved. Keeping them in different
 * stores means a pan does not notify graph subscribers, does not mark the graph
 * dirty, and never lands in the undo history or in localStorage.
 */
export interface Viewport {
  /** Screen-space translation applied before the scale. */
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface ViewportStore {
  readonly viewport: Viewport;
  readonly isPanning: boolean;
  readonly setViewport: (viewport: Viewport) => void;
  readonly panBy: (delta: Point) => void;
  readonly zoomAt: (factor: number, pointer: Point) => void;
  readonly setZoom: (zoom: number, centre: Point) => void;
  readonly resetZoom: (centre: Point) => void;
  readonly fitToContent: (graph: GraphData, size: { width: number; height: number }) => void;
  readonly setPanning: (panning: boolean) => void;
}

export const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

/** Screen point -> world point, given a viewport. */
export function toWorld(point: Point, viewport: Viewport): Point {
  return {
    x: (point.x - viewport.x) / viewport.zoom,
    y: (point.y - viewport.y) / viewport.zoom,
  };
}

/** World point -> screen point. */
export function toScreen(point: Point, viewport: Viewport): Point {
  return {
    x: point.x * viewport.zoom + viewport.x,
    y: point.y * viewport.zoom + viewport.y,
  };
}

/**
 * Zooms about a fixed screen point.
 *
 * The world coordinate under the pointer must not move, which means the
 * translation has to absorb the scale change: solve `toScreen(w) === pointer`
 * for the new x/y with the new zoom. Without this the content slides away from
 * the cursor and zooming feels broken.
 */
export function zoomAbout(viewport: Viewport, nextZoom: number, pointer: Point): Viewport {
  const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
  const world = toWorld(pointer, viewport);

  return {
    zoom,
    x: pointer.x - world.x * zoom,
    y: pointer.y - world.y * zoom,
  };
}

/** Viewport that frames `bounds` inside a viewport of `size`, with margin. */
export function viewportForBounds(
  bounds: Rect,
  size: { width: number; height: number },
  margin = 64,
): Viewport {
  const available = {
    width: Math.max(1, size.width - margin * 2),
    height: Math.max(1, size.height - margin * 2),
  };

  const zoom = clamp(
    Math.min(
      available.width / Math.max(bounds.width, 1),
      available.height / Math.max(bounds.height, 1),
    ),
    MIN_ZOOM,
    // Never zoom past 1 just because the content is small; blowing up a single
    // node to fill the screen is disorienting rather than helpful.
    1,
  );

  return {
    zoom,
    x: size.width / 2 - (bounds.x + bounds.width / 2) * zoom,
    y: size.height / 2 - (bounds.y + bounds.height / 2) * zoom,
  };
}

export const useViewportStore = create<ViewportStore>()((set, get) => ({
  viewport: DEFAULT_VIEWPORT,
  isPanning: false,

  setViewport: (viewport) => {
    set({ viewport });
  },

  panBy: (delta) => {
    const { viewport } = get();
    set({ viewport: { ...viewport, x: viewport.x + delta.x, y: viewport.y + delta.y } });
  },

  zoomAt: (factor, pointer) => {
    const { viewport } = get();
    set({ viewport: zoomAbout(viewport, viewport.zoom * factor, pointer) });
  },

  setZoom: (zoom, centre) => {
    const { viewport } = get();
    set({ viewport: zoomAbout(viewport, zoom, centre) });
  },

  resetZoom: (centre) => {
    const { viewport } = get();
    set({ viewport: zoomAbout(viewport, 1, centre) });
  },

  fitToContent: (graph, size) => {
    const bounds = graphBounds(graph);
    if (!bounds) {
      set({ viewport: DEFAULT_VIEWPORT });
      return;
    }
    set({ viewport: viewportForBounds(bounds, size) });
  },

  setPanning: (panning) => {
    set({ isPanning: panning });
  },
}));
