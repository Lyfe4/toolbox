import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { ToastProvider } from '@/components/Toast';

import { Canvas } from './Canvas';
import { useCanvasStore } from './graphStore';
import { type CanvasNode } from './types';
import { DEFAULT_VIEWPORT, useViewportStore } from './viewportStore';

/**
 * SCROLL CONTAINMENT
 *
 * The overlays are rendered inside the canvas root, and the canvas binds a
 * NON-PASSIVE wheel listener there. A wheel over a dialog therefore bubbled
 * into it and did two wrong things at once: fed the delta into the canvas
 * pan/zoom, and called preventDefault, which cancelled the dialog's own
 * native scrolling. Measured in the browser: scrolling the shortcuts
 * reference panned the canvas 400px and moved the dialog not at all.
 *
 * jsdom has no layout, so whether a dialog physically scrolls cannot be
 * answered here - that is measured in scripts/cross-browser-check.mjs. What
 * IS answerable, and what the bug actually was, is whether the canvas moves
 * and whether the event survives to reach the dialog.
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

/**
 * Dispatches a wheel and reports whether anything cancelled it.
 *
 * `defaultPrevented` is the thing to watch: while a dialog is open the canvas
 * must not touch the event at all, or the browser's own scrolling never runs.
 */
function wheel(target: EventTarget, init: WheelEventInit = {}): boolean {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    clientX: 400,
    clientY: 300,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

/** Wheel plus the frame the canvas batches its transform on. */
async function wheelAndSettle(target: EventTarget, init: WheelEventInit = {}): Promise<boolean> {
  const prevented = wheel(target, init);
  await act(async () => {
    await new Promise((resolve) => {
      requestAnimationFrame(() => {
        resolve(null);
      });
    });
  });
  return prevented;
}

beforeEach(() => {
  window.localStorage.clear();
  useCanvasStore.setState({
    graph: {
      nodes: { a: node('a', 'structured-data'), b: node('b', 'base64', 400, 0) },
      nodeOrder: ['a', 'b'],
      edges: {},
      edgeOrder: [],
      nextId: 3,
    },
    selection: { nodes: [], edges: [] },
    past: [],
    future: [],
    pendingMove: null,
    announcement: { text: '', seq: 0 },
  });
  useViewportStore.setState({ viewport: DEFAULT_VIEWPORT, isPanning: false });
});

describe('with no dialog open', () => {
  it('pans the canvas on a wheel', async () => {
    renderCanvas();

    await wheelAndSettle(canvasRoot(), { deltaY: 240 });

    expect(viewport().y).not.toBe(0);
  });

  it('zooms the canvas on ctrl+wheel, which is also how a trackpad pinches', async () => {
    renderCanvas();

    await wheelAndSettle(canvasRoot(), { deltaY: -40, ctrlKey: true });

    expect(viewport().zoom).not.toBe(1);
  });
});

describe.each([
  {
    name: 'the tool palette',
    open: async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole('button', { name: /Add tool/ }));
      await screen.findByRole('dialog', { name: 'Add a tool' });
    },
  },
  {
    name: 'the shortcuts reference',
    open: async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(canvasRoot());
      await user.keyboard('?');
      await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    },
  },
  {
    name: 'the connect chooser',
    open: async (user: ReturnType<typeof userEvent.setup>) => {
      screen.getByRole('group', { name: /Structured data/ }).focus();
      await user.keyboard('c');
      await screen.findByRole('dialog', { name: /Connect from which port/ });
    },
  },
])('with $name open', ({ open }) => {
  it('does not pan the canvas', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await open(user);

    const before = viewport();
    await wheelAndSettle(screen.getByRole('dialog'), { deltaY: 400, deltaX: 120 });

    expect(viewport()).toEqual(before);
  });

  it('does not zoom the canvas, including on a trackpad pinch', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await open(user);

    const before = viewport();
    await wheelAndSettle(screen.getByRole('dialog'), { deltaY: -60, ctrlKey: true });
    await wheelAndSettle(screen.getByRole('dialog'), { deltaY: 60, metaKey: true });

    expect(viewport()).toEqual(before);
  });

  it('leaves the wheel event alone so the dialog can scroll itself', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await open(user);

    // The canvas used to preventDefault unconditionally, which is what stopped
    // the dialog scrolling at all. Nothing may cancel it now.
    const prevented = await wheelAndSettle(screen.getByRole('dialog'), { deltaY: 300 });

    expect(prevented).toBe(false);
  });

  it('ignores a wheel over the scrim as well as over the dialog', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await open(user);

    const before = viewport();
    // The scrim covers the canvas; wheeling there must not reach it either.
    await wheelAndSettle(canvasRoot(), { deltaY: 300 });

    expect(viewport()).toEqual(before);
  });

  it('gives the canvas back cleanly once the dialog closes', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await open(user);

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    const before = viewport();
    await wheelAndSettle(canvasRoot(), { deltaY: 240 });

    // Pans again, and only by this wheel - nothing accumulated while the
    // dialog was open is allowed to land afterwards.
    expect(viewport().y).toBe(before.y - 240);
  });
});

describe('a wheel that arrives in the same tick a dialog opens', () => {
  it('does not land on the canvas afterwards', async () => {
    renderCanvas();

    /*
     * Both in ONE synchronous act, so the frame that would apply the wheel
     * cannot have run in between. A wheel from before the dialog existed is
     * allowed to pan; one still sitting in the accumulator when the dialog
     * opens is not, or the canvas appears to drift by itself a frame later.
     */
    act(() => {
      canvasRoot().dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: 500,
          clientX: 400,
          clientY: 300,
        }),
      );
      screen.getByRole('button', { name: /Add tool/ }).click();
    });

    await screen.findByRole('dialog');

    await act(async () => {
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          resolve(null);
        });
      });
    });

    expect(viewport()).toEqual(DEFAULT_VIEWPORT);
  });
});

describe('keyboard scrolling inside a dialog', () => {
  it('moves the palette selection and never the canvas', async () => {
    const user = userEvent.setup();
    renderCanvas();

    await user.click(screen.getByRole('button', { name: /Add tool/ }));
    const search = await screen.findByRole('combobox', { name: 'Search tools' });
    const before = viewport();

    const options = screen.getAllByRole('option');
    const activeId = () => search.getAttribute('aria-activedescendant');

    await user.keyboard('{End}');
    expect(activeId()).toBe(options[options.length - 1]?.id);

    await user.keyboard('{Home}');
    expect(activeId()).toBe(options[0]?.id);

    await user.keyboard('{PageDown}');
    // PageUp/PageDown did nothing at all before: focus stays in the input, so
    // the browser's own paging never applied, and nothing else handled them.
    expect(activeId()).not.toBe(options[0]?.id);

    await user.keyboard('{PageUp}');
    expect(activeId()).toBe(options[0]?.id);

    await user.keyboard('{ArrowDown}');
    expect(activeId()).toBe(options[1]?.id);

    // Every one of those keys, and the canvas has not moved.
    expect(viewport()).toEqual(before);
    expect(search).toHaveFocus();
  });

  it('does not let arrow keys reach the canvas and nudge a node', async () => {
    const user = userEvent.setup();
    renderCanvas();

    useCanvasStore.getState().select({ nodes: ['a'], edges: [] });
    const positionBefore = useCanvasStore.getState().graph.nodes.a?.position;

    await user.click(screen.getByRole('button', { name: /Add tool/ }));
    await screen.findByRole('dialog');
    await user.keyboard('{ArrowDown}{ArrowDown}{End}');

    expect(useCanvasStore.getState().graph.nodes.a?.position).toEqual(positionBefore);
  });
});
