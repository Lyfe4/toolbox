import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import { usePipelineStore } from '@/features/execution/pipelineStore';
import { EMPTY_ANNOUNCEMENTS } from '@/lib/announce';

import { Canvas } from './Canvas';
import { COLD_OPEN_ID, COLD_OPEN_START_ID, COLD_OPEN_STORAGE_KEY } from './coldOpen';
import { useCanvasStore } from './graphStore';
import { type CanvasNode } from './types';
import { DEFAULT_VIEWPORT, useViewportStore } from './viewportStore';

/**
 * THE CANVAS'S SIDE OF THE COLD OPEN.
 *
 * The panel is markup in index.html, so in a unit test it has to be built by
 * hand - which is the point of these tests rather than an inconvenience. The
 * app's contract with that markup is not typed and cannot be: it is "if an
 * element with this id is in the document, you did not put it there and you
 * are responsible for taking it down". Everything below is that contract.
 *
 * The interesting half is the NEGATIVE case. A canvas rendered without the
 * panel - which is every returning visitor, and every other test in this
 * directory - must behave exactly as it did before any of this existed, and
 * the last test here is what says so.
 */

function mountColdOpen(): void {
  const appRoot = document.createElement('div');
  appRoot.id = 'root';
  appRoot.inert = true;

  const panel = document.createElement('div');
  panel.id = COLD_OPEN_ID;

  const start = document.createElement('button');
  start.id = COLD_OPEN_START_ID;
  start.type = 'button';
  // Shipped disabled - the canvas is what makes it mean anything, and it is a
  // lazy chunk away. See onColdOpenStart.
  start.disabled = true;
  start.textContent = 'Start with an empty canvas';

  panel.append(start);
  document.body.append(appRoot, panel);
}

function node(id: string): CanvasNode {
  return {
    id,
    toolId: 'base64',
    position: { x: 0, y: 0 },
    options: {},
    inputs: {},
    fileInputs: {},
  };
}

function seed(nodes: readonly CanvasNode[]): void {
  usePipelineStore.getState().reset();
  useCanvasStore.setState({
    graph: {
      nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
      nodeOrder: nodes.map((n) => n.id),
      edges: {},
      edgeOrder: [],
      nextId: nodes.length + 1,
    },
    selection: { nodes: [], edges: [] },
    past: [],
    future: [],
    pendingMove: null,
    ...EMPTY_ANNOUNCEMENTS,
  });
}

function renderCanvas() {
  return render(
    <ToastProvider>
      <Canvas />
    </ToastProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  useViewportStore.setState({ viewport: DEFAULT_VIEWPORT, isPanning: false });
  seed([]);
});

afterEach(() => {
  document.getElementById(COLD_OPEN_ID)?.remove();
  document.getElementById('root')?.remove();
  window.localStorage.clear();
});

describe('while the cold open is up', () => {
  beforeEach(() => {
    mountColdOpen();
  });

  it('the canvas does not draw its own empty state underneath it', () => {
    renderCanvas();

    expect(screen.queryByText('Empty canvas')).not.toBeInTheDocument();
    expect(document.getElementById(COLD_OPEN_ID)).not.toBeNull();
  });

  it('makes the start button live, because now it can honour it', () => {
    renderCanvas();

    expect(screen.getByRole('button', { name: 'Start with an empty canvas' })).toBeEnabled();
  });

  it('the toolbar is still rendered, and still behind an inert root', () => {
    renderCanvas();

    // The canvas mounts normally - it is the DOCUMENT that is holding it shut,
    // not the component declining to exist.
    expect(screen.getByRole('button', { name: 'Add tool' })).toBeInTheDocument();
    expect(document.getElementById('root')?.inert).toBe(true);
  });
});

describe('taking it down by hand', () => {
  beforeEach(() => {
    mountColdOpen();
  });

  it('removes the panel, releases the app and reveals the empty state', async () => {
    const user = userEvent.setup();
    renderCanvas();

    await user.click(screen.getByRole('button', { name: 'Start with an empty canvas' }));

    expect(document.getElementById(COLD_OPEN_ID)).toBeNull();
    expect(document.getElementById('root')?.inert).toBe(false);
    expect(await screen.findByText('Empty canvas')).toBeInTheDocument();
  });

  /*
   * Focus was on a button that has just left the document. Left alone it falls
   * to <body>, where none of the canvas's keys reach the handler and the next
   * Tab restarts from the top of the page - so the dismissal would quietly cost
   * a keyboard user their place.
   */
  it('moves focus to the canvas rather than letting it fall to the body', async () => {
    const user = userEvent.setup();
    renderCanvas();

    await user.click(screen.getByRole('button', { name: 'Start with an empty canvas' }));

    expect(document.activeElement).toBe(screen.getByTestId('canvas-root'));
  });

  /*
   * Without this, choosing "empty canvas" and then reloading hands back the
   * introduction - the graph is still empty, so nothing else in the document
   * would know the question had already been answered.
   */
  it('remembers that it happened', async () => {
    const user = userEvent.setup();
    renderCanvas();

    await user.click(screen.getByRole('button', { name: 'Start with an empty canvas' }));

    expect(window.localStorage.getItem(COLD_OPEN_STORAGE_KEY)).not.toBeNull();
  });
});

describe('a graph arriving', () => {
  it('takes the panel down without being asked', async () => {
    mountColdOpen();
    renderCanvas();

    expect(document.getElementById(COLD_OPEN_ID)).not.toBeNull();

    // What a share link, a preset and a restored save all look like from here.
    seed([node('n1')]);

    await waitFor(() => {
      expect(document.getElementById(COLD_OPEN_ID)).toBeNull();
    });
    expect(document.getElementById('root')?.inert).toBe(false);
  });

  /*
   * The panel is gone for good once it has gone, and an emptied canvas is the
   * case that says so. Without a latch, `nodeOrder.length === 0` recomputes to
   * "the introduction is up" - which renders nothing, because the element was
   * removed, and takes the canvas's own empty state down with it. A blank grid
   * with no message on it is the exact screen all of this exists to remove.
   */
  it('does not come back when the canvas is emptied again', async () => {
    mountColdOpen();
    seed([node('n1')]);
    renderCanvas();

    await waitFor(() => {
      expect(document.getElementById(COLD_OPEN_ID)).toBeNull();
    });

    seed([]);

    expect(await screen.findByText('Empty canvas')).toBeInTheDocument();
    expect(document.getElementById(COLD_OPEN_ID)).toBeNull();
  });
});

describe('without a cold open at all', () => {
  it('is the canvas exactly as it was', async () => {
    renderCanvas();

    expect(await screen.findByText('Empty canvas')).toBeInTheDocument();
    expect(window.localStorage.getItem(COLD_OPEN_STORAGE_KEY)).toBeNull();
  });
});
