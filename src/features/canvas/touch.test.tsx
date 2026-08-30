import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { ToastProvider } from '@/components/Toast';

import { Canvas } from './Canvas';
import { useCanvasStore } from './graphStore';
import { type CanvasNode } from './types';
import { DEFAULT_VIEWPORT, useViewportStore } from './viewportStore';

/**
 * TOUCH.
 *
 * The canvas could not be panned or zoomed with fingers at all. Panning was
 * reachable three ways - space+drag, middle-drag and the wheel - and a
 * touchscreen has none of them; pinch was implemented as ctrl+wheel, which
 * trackpads emit and touchscreens never do. `touch-action: none` was already
 * set, so the browser was not the problem: the handlers simply had no branch a
 * finger could reach.
 *
 * jsdom has no touch hardware, but PointerEvent is constructible and the
 * canvas listens for pointer events - so the state machine (which pointers are
 * down, which gesture is live, what happens when one is lost) is testable
 * here. Whether a real finger produces those events is asserted against real
 * engines in scripts/cross-browser-check.mjs.
 */

function node(id: string, toolId: CanvasNode['toolId'], x = 0, y = 0): CanvasNode {
  return { id, toolId, position: { x, y }, options: {}, inputs: {} };
}

function renderCanvas() {
  return render(
    <ToastProvider>
      <Canvas />
    </ToastProvider>,
  );
}

const canvasRoot = (): HTMLElement => screen.getByRole('application');
const viewport = () => useViewportStore.getState().viewport;

interface TouchInit {
  readonly id?: number;
  readonly type?: string;
  readonly target?: EventTarget;
}

/** Dispatches one pointer event with a touch pointerType by default. */
function pointer(
  kind: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  x: number,
  y: number,
  { id = 1, type = 'touch', target }: TouchInit = {},
): void {
  const event = new PointerEvent(kind, {
    pointerId: id,
    pointerType: type,
    isPrimary: id === 1,
    clientX: x,
    clientY: y,
    button: kind === 'pointerup' || kind === 'pointercancel' ? -1 : 0,
    buttons: kind === 'pointerdown' || kind === 'pointermove' ? 1 : 0,
    bubbles: true,
    cancelable: true,
  });

  act(() => {
    (target ?? canvasRoot()).dispatchEvent(event);
  });
}

beforeEach(() => {
  window.localStorage.clear();
  useCanvasStore.setState({
    graph: {
      nodes: { a: node('a', 'base64', 100, 100) },
      nodeOrder: ['a'],
      edges: {},
      edgeOrder: [],
      nextId: 2,
    },
    selection: { nodes: [], edges: [] },
    past: [],
    future: [],
    pendingMove: null,
    announcement: { text: '', seq: 0 },
  });
  useViewportStore.setState({ viewport: DEFAULT_VIEWPORT, isPanning: false });
});

describe('one finger', () => {
  it('pans the canvas when it drags on empty space', () => {
    renderCanvas();

    pointer('pointerdown', 200, 200);
    pointer('pointermove', 260, 150);
    pointer('pointerup', 260, 150);

    expect(viewport().x).toBe(60);
    expect(viewport().y).toBe(-50);
  });

  it('moves a node when it drags on one, rather than panning', () => {
    renderCanvas();

    const target = screen.getByRole('group', { name: /Base64/ });
    const before = viewport();

    pointer('pointerdown', 150, 150, { target });
    pointer('pointermove', 190, 190, { target });
    pointer('pointerup', 190, 190, { target });

    expect(viewport()).toEqual(before);
    expect(useCanvasStore.getState().graph.nodes.a?.position).not.toEqual({ x: 100, y: 100 });
  });

  it('does not pan for a mouse, which keeps its existing behaviour', () => {
    renderCanvas();
    useCanvasStore.getState().select({ nodes: ['a'], edges: [] });

    pointer('pointerdown', 200, 200, { type: 'mouse' });
    pointer('pointermove', 300, 300, { type: 'mouse' });
    pointer('pointerup', 300, 300, { type: 'mouse' });

    // Unchanged: a left-drag on empty canvas clears the selection and does
    // nothing else, exactly as it did before touch existed.
    expect(viewport()).toEqual(DEFAULT_VIEWPORT);
    expect(useCanvasStore.getState().selection.nodes).toEqual([]);
  });
});

describe('two fingers', () => {
  it('zooms on a pinch', () => {
    renderCanvas();

    pointer('pointerdown', 100, 300, { id: 1 });
    pointer('pointerdown', 300, 300, { id: 2 });
    // Spread from 200px apart to 400px apart.
    pointer('pointermove', 0, 300, { id: 1 });
    pointer('pointermove', 400, 300, { id: 2 });

    expect(viewport().zoom).toBeCloseTo(2, 5);

    pointer('pointerup', 0, 300, { id: 1 });
    pointer('pointerup', 400, 300, { id: 2 });
  });

  it('zooms out when the fingers close', () => {
    renderCanvas();

    pointer('pointerdown', 0, 300, { id: 1 });
    pointer('pointerdown', 400, 300, { id: 2 });
    pointer('pointermove', 100, 300, { id: 1 });
    pointer('pointermove', 300, 300, { id: 2 });

    expect(viewport().zoom).toBeCloseTo(0.5, 5);
  });

  it('pans on a two-finger drag that holds its spread', () => {
    renderCanvas();

    pointer('pointerdown', 100, 100, { id: 1 });
    pointer('pointerdown', 200, 100, { id: 2 });
    pointer('pointermove', 140, 160, { id: 1 });
    pointer('pointermove', 240, 160, { id: 2 });

    expect(viewport().zoom).toBeCloseTo(1, 5);
    expect(viewport().x).toBeCloseTo(40, 5);
    expect(viewport().y).toBeCloseTo(60, 5);
  });

  it('stays within the same zoom limits as the mouse', () => {
    renderCanvas();

    pointer('pointerdown', 199, 300, { id: 1 });
    pointer('pointerdown', 201, 300, { id: 2 });
    // An absurd spread, repeated: the clamp lives in zoomAbout, so touch and
    // wheel are held to the identical range.
    for (let step = 1; step <= 6; step += 1) {
      pointer('pointermove', 200 - step * 400, 300, { id: 1 });
      pointer('pointermove', 200 + step * 400, 300, { id: 2 });
    }

    expect(viewport().zoom).toBeLessThanOrEqual(4);
    expect(viewport().zoom).toBeGreaterThan(1);
  });
});

describe('gestures that do not end tidily', () => {
  it('keeps the viewport usable after pointercancel', () => {
    renderCanvas();

    pointer('pointerdown', 100, 300, { id: 1 });
    pointer('pointerdown', 300, 300, { id: 2 });
    pointer('pointermove', 50, 300, { id: 1 });

    // The browser takes the gesture away mid-pinch.
    pointer('pointercancel', 50, 300, { id: 1 });
    pointer('pointercancel', 300, 300, { id: 2 });

    const after = viewport();

    // A fresh single-finger drag still pans, from where it started.
    pointer('pointerdown', 200, 200, { id: 3 });
    pointer('pointermove', 230, 200, { id: 3 });
    pointer('pointerup', 230, 200, { id: 3 });

    expect(viewport().x).toBeCloseTo(after.x + 30, 5);
    expect(useViewportStore.getState().isPanning).toBe(false);
  });

  it('carries on panning with the finger that is left', () => {
    renderCanvas();

    pointer('pointerdown', 100, 300, { id: 1 });
    pointer('pointerdown', 300, 300, { id: 2 });
    pointer('pointerup', 100, 300, { id: 1 });

    const after = viewport();

    // The survivor re-anchors where it currently is, so there is no jump.
    pointer('pointermove', 350, 300, { id: 2 });

    expect(viewport().x).toBeCloseTo(after.x + 50, 5);
  });

  it('ignores a third finger rather than jumping', () => {
    renderCanvas();

    pointer('pointerdown', 100, 300, { id: 1 });
    pointer('pointerdown', 300, 300, { id: 2 });
    pointer('pointermove', 0, 300, { id: 1 });
    pointer('pointermove', 400, 300, { id: 2 });

    const afterPinch = viewport();

    // A thumb lands. It is tracked but must not be measured.
    pointer('pointerdown', 50, 600, { id: 3 });

    expect(viewport()).toEqual(afterPinch);
  });

  it('survives a pointer that vanishes without an up', () => {
    renderCanvas();

    pointer('pointerdown', 100, 300, { id: 1 });
    pointer('pointerdown', 300, 300, { id: 2 });

    // id 2 is never heard from again; id 1 keeps moving.
    pointer('pointermove', 120, 300, { id: 1 });
    pointer('pointerup', 120, 300, { id: 1 });

    // Whatever happened, the canvas still responds.
    pointer('pointerdown', 200, 200, { id: 4 });
    pointer('pointermove', 240, 200, { id: 4 });
    pointer('pointerup', 240, 200, { id: 4 });

    expect(Number.isFinite(viewport().x)).toBe(true);
    expect(Number.isFinite(viewport().zoom)).toBe(true);
    expect(viewport().zoom).toBeGreaterThan(0);
  });
});

describe('while a dialog is open', () => {
  it('does not pan on a one-finger drag', async () => {
    const user = userEvent.setup();
    renderCanvas();

    await user.click(screen.getByRole('button', { name: /Add tool/ }));
    await screen.findByRole('dialog', { name: 'Add a tool' });

    const before = viewport();
    pointer('pointerdown', 200, 200);
    pointer('pointermove', 300, 300);
    pointer('pointerup', 300, 300);

    expect(viewport()).toEqual(before);
  });

  it('does not zoom on a pinch', async () => {
    const user = userEvent.setup();
    renderCanvas();

    await user.click(screen.getByRole('button', { name: /Add tool/ }));
    await screen.findByRole('dialog', { name: 'Add a tool' });

    const before = viewport();
    pointer('pointerdown', 100, 300, { id: 1 });
    pointer('pointerdown', 300, 300, { id: 2 });
    pointer('pointermove', 0, 300, { id: 1 });
    pointer('pointermove', 400, 300, { id: 2 });

    expect(viewport()).toEqual(before);
  });

  it('gives touch back cleanly once the dialog closes', async () => {
    const user = userEvent.setup();
    renderCanvas();

    await user.click(screen.getByRole('button', { name: /Add tool/ }));
    await screen.findByRole('dialog', { name: 'Add a tool' });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    const before = viewport();
    pointer('pointerdown', 200, 200);
    pointer('pointermove', 250, 200);
    pointer('pointerup', 250, 200);

    // Pans again, and only by this gesture - nothing left over from the touch
    // that was in flight when the dialog opened.
    expect(viewport().x).toBe(before.x + 50);
  });
});
