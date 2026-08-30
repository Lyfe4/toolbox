import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import { getManifestEntry } from '@/features/registry';

import { Canvas } from './Canvas';
import { nearestCompatiblePort, orientEnds } from './connections';
import { portPosition, PORT_SNAP_RADIUS } from './geometry';
import { useCanvasStore } from './graphStore';
import { EMPTY_GRAPH, type CanvasNode, type GraphData } from './types';
import { DEFAULT_VIEWPORT, useViewportStore } from './viewportStore';

/**
 * PORTS AND WIRING
 *
 * jsdom has no layout engine, so every element's box is zero. That is
 * survivable here because the canvas does its own coordinate maths: with the
 * root's rect at the origin and the viewport untransformed, a client
 * coordinate IS a world coordinate. So a pointer event at (x, y) lands exactly
 * where the geometry says it does, and the drag path can be driven for real.
 *
 * What jsdom cannot tell us is what any of it LOOKS like - row heights, glyph
 * insets, whether the two stacks overlap. Those are asserted against the real
 * engines in scripts/cross-browser-check.mjs.
 */

function node(id: string, toolId: CanvasNode['toolId'], x: number, y: number): CanvasNode {
  return { id, toolId, position: { x, y }, options: {}, inputs: {} };
}

function graphOf(nodes: readonly CanvasNode[]): GraphData {
  return {
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    nodeOrder: nodes.map((n) => n.id),
    edges: {},
    edgeOrder: [],
    nextId: nodes.length + 1,
  };
}

function seed(nodes: readonly CanvasNode[]): void {
  useCanvasStore.setState({
    graph: graphOf(nodes),
    selection: { nodes: [], edges: [] },
    past: [],
    future: [],
    pendingMove: null,
    announcement: { text: '', seq: 0 },
  });
}

function renderCanvas() {
  return render(
    <ToastProvider>
      <Canvas />
    </ToastProvider>,
  );
}

/** Where a port's connector actually is, in world coordinates. */
function anchor(nodeId: string, side: 'input' | 'output', portId: string) {
  const graph = useCanvasStore.getState().graph;
  const target = graph.nodes[nodeId];
  if (!target) throw new Error(`no node ${nodeId}`);
  const entry = getManifestEntry(target.toolId);
  const ports = side === 'input' ? entry.inputs : entry.outputs;
  const index = ports.findIndex((port) => port.id === portId);
  if (index === -1) throw new Error(`no ${side} port ${portId}`);
  return portPosition(entry, target, side, index);
}

function portElement(nodeId: string, side: 'input' | 'output', portId: string): HTMLElement {
  const found = document
    .querySelector(`[data-node-id="${nodeId}"]`)
    ?.querySelector<HTMLElement>(`[data-port-side="${side}"][data-port-id="${portId}"]`);
  if (!found) throw new Error(`no ${side} port ${portId} on ${nodeId}`);
  return found;
}

/**
 * Dispatches a real pointer event, inside `act`.
 *
 * The canvas binds its pointer listeners imperatively, so these do not go
 * through React's event system and the `setDraft` they trigger would otherwise
 * still be queued when the assertion reads the DOM.
 */
function pointer(target: EventTarget, type: string, at: { x: number; y: number }): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: at.x,
        clientY: at.y,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
      }),
    );
  });
}

function canvasRoot(): HTMLElement {
  return screen.getByRole('application');
}

/** Starts a drag at a port and moves the pointer to `to`, without releasing. */
function beginDrag(
  nodeId: string,
  side: 'input' | 'output',
  portId: string,
  to: { x: number; y: number },
): void {
  const from = anchor(nodeId, side, portId);
  pointer(portElement(nodeId, side, portId), 'pointerdown', from);
  pointer(canvasRoot(), 'pointermove', to);
}

function draftPathData(): string | null {
  return document.querySelector('svg path[class*="wireDraft"]')?.getAttribute('d') ?? null;
}

/** The "M x y" the draft wire starts from. */
function draftOrigin(): { x: number; y: number } | null {
  const parsed = /^M ([\d.-]+) ([\d.-]+)/.exec(draftPathData() ?? '');
  return parsed ? { x: Number(parsed[1]), y: Number(parsed[2]) } : null;
}

const announcer = (): HTMLElement => screen.getByTestId('canvas-announcer');
const edgeCount = (): number => useCanvasStore.getState().graph.edgeOrder.length;

beforeEach(() => {
  window.localStorage.clear();
  useCanvasStore.setState({
    graph: EMPTY_GRAPH,
    selection: { nodes: [], edges: [] },
    past: [],
    future: [],
    pendingMove: null,
    announcement: { text: '', seq: 0 },
  });
  useViewportStore.setState({ viewport: DEFAULT_VIEWPORT, isPanning: false });
});

describe('the pending wire', () => {
  it('leaves from the port that was grabbed, not from the node', () => {
    seed([node('a', 'structured-data', 100, 100)]);
    renderCanvas();

    // structured-data has two outputs. Grabbing each must produce a visibly
    // different origin: they used to differ only because a hardcoded copy of
    // the layout arithmetic happened to include the index, and it was 21px
    // above the connector either way.
    beginDrag('a', 'output', 'output', { x: 400, y: 400 });
    const first = draftOrigin();
    pointer(canvasRoot(), 'pointerup', { x: 400, y: 400 });

    beginDrag('a', 'output', 'data', { x: 400, y: 400 });
    const second = draftOrigin();
    pointer(canvasRoot(), 'pointerup', { x: 400, y: 400 });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toEqual(second);
  });

  it('starts at the exact centre of the grabbed connector', () => {
    seed([node('a', 'structured-data', 240, 160)]);
    renderCanvas();

    for (const portId of ['output', 'data']) {
      beginDrag('a', 'output', portId, { x: 600, y: 600 });
      // The single source of truth for where that port is.
      expect(draftOrigin()).toEqual(anchor('a', 'output', portId));
      pointer(canvasRoot(), 'pointerup', { x: 600, y: 600 });
    }
  });

  it('is anchored from the first frame, before the pointer has moved', () => {
    seed([node('a', 'base64', 100, 100)]);
    renderCanvas();

    // No pointermove yet. The draft used to start at the world origin, so the
    // first painted frame was a line to the top-left corner of the plane.
    pointer(portElement('a', 'output', 'output'), 'pointerdown', anchor('a', 'output', 'output'));

    expect(draftOrigin()).toEqual(anchor('a', 'output', 'output'));
  });

  it('marks the grabbed port as held for the whole drag', () => {
    seed([node('a', 'structured-data', 100, 100)]);
    renderCanvas();

    beginDrag('a', 'output', 'data', { x: 500, y: 500 });

    expect(portElement('a', 'output', 'data')).toHaveAttribute('data-port-state', 'held');
    expect(portElement('a', 'output', 'output')).not.toHaveAttribute('data-port-state', 'held');
  });
});

describe('drop tolerance', () => {
  it('connects when the release is near a port rather than on it', () => {
    seed([node('a', 'base64', 0, 0), node('b', 'structured-data', 400, 0)]);
    renderCanvas();

    const target = anchor('b', 'input', 'input');
    const nearMiss = { x: target.x - 18, y: target.y + 10 };
    // Comfortably off the 11px glyph, comfortably inside the snap radius.
    expect(Math.hypot(nearMiss.x - target.x, nearMiss.y - target.y)).toBeGreaterThan(11);
    expect(Math.hypot(nearMiss.x - target.x, nearMiss.y - target.y)).toBeLessThan(PORT_SNAP_RADIUS);

    beginDrag('a', 'output', 'output', nearMiss);
    pointer(canvasRoot(), 'pointerup', nearMiss);

    expect(edgeCount()).toBe(1);
  });

  it('arms the port it would snap to, so the outcome is visible first', () => {
    seed([node('a', 'base64', 0, 0), node('b', 'structured-data', 400, 0)]);
    renderCanvas();

    const target = anchor('b', 'input', 'input');
    beginDrag('a', 'output', 'output', { x: target.x - 16, y: target.y });

    expect(portElement('b', 'input', 'input')).toHaveAttribute('data-port-state', 'armed');
  });

  it('snaps to the nearer of two candidates', () => {
    // diff has two inputs a row apart; a release between them must resolve to
    // exactly one, and to the closer one.
    seed([node('a', 'base64', 0, 0), node('b', 'diff', 400, 0)]);
    renderCanvas();

    const original = anchor('b', 'input', 'original');
    const changed = anchor('b', 'input', 'changed');
    const nearerChanged = { x: changed.x, y: changed.y + (original.y - changed.y) * 0.3 };

    beginDrag('a', 'output', 'output', nearerChanged);
    pointer(canvasRoot(), 'pointerup', nearerChanged);

    const graph = useCanvasStore.getState().graph;
    const edge = graph.edges[graph.edgeOrder[0] ?? ''];
    expect(edge?.to.portId).toBe('changed');
  });

  it('never snaps to a port that would refuse the wire', () => {
    seed([node('a', 'structured-data', 0, 0), node('b', 'base64', 400, 0)]);

    // `data` carries json; base64's input takes text or bytes. Dropping right
    // on it must not be rescued by the snap.
    const target = anchor('b', 'input', 'input');
    const snap = nearestCompatiblePort(
      useCanvasStore.getState().graph,
      { ref: { nodeId: 'a', portId: 'data' }, side: 'output' },
      target,
    );

    expect(snap).toBeNull();
  });
});

describe('refusing a drop', () => {
  it('explains an incompatible drop instead of silently doing nothing', async () => {
    seed([node('a', 'structured-data', 0, 0), node('b', 'base64', 400, 0)]);
    renderCanvas();

    const target = anchor('b', 'input', 'input');
    beginDrag('a', 'output', 'data', target);
    pointer(canvasRoot(), 'pointerup', target);

    /*
     * Snapshotted rather than re-read.
     *
     * The canvas has ONE live region, shared with the pipeline, and the
     * debounced re-run posts "Pipeline finished" into it a few hundred
     * milliseconds later. Reading the region three times would sometimes catch
     * that instead. The durable copy of a refusal is the toast; the live
     * region is the moment it happened, so that moment is what is asserted.
     */
    let announced = '';
    await waitFor(() => {
      announced = announcer().textContent;
      expect(announced).toContain('Connection refused');
    });

    // Named types, not a generic "cannot connect".
    expect(announced).toContain('json');
    expect(announced).toContain('text or bytes');
    expect(edgeCount()).toBe(0);
  });

  it('marks the port that refused, so the reason has somewhere to point', () => {
    seed([node('a', 'structured-data', 0, 0), node('b', 'base64', 400, 0)]);
    renderCanvas();

    const target = anchor('b', 'input', 'input');
    beginDrag('a', 'output', 'data', target);
    pointer(canvasRoot(), 'pointerup', target);

    expect(portElement('b', 'input', 'input')).toHaveAttribute('data-port-state', 'refused');
  });

  it('still refuses a loop, and still says why', async () => {
    seed([node('a', 'base64', 0, 0), node('b', 'structured-data', 400, 0)]);
    renderCanvas();

    // Wire a -> b, then try b -> a.
    const forward = anchor('b', 'input', 'input');
    beginDrag('a', 'output', 'output', forward);
    pointer(canvasRoot(), 'pointerup', forward);
    await waitFor(() => {
      expect(edgeCount()).toBe(1);
    });

    const backward = anchor('a', 'input', 'input');
    beginDrag('b', 'output', 'output', backward);
    pointer(canvasRoot(), 'pointerup', backward);

    await waitFor(() => {
      expect(announcer()).toHaveTextContent('loop');
    });
    expect(edgeCount()).toBe(1);
  });

  it('recedes every port a drag cannot land on', () => {
    seed([node('a', 'structured-data', 0, 0), node('b', 'base64', 400, 0)]);
    renderCanvas();

    beginDrag('a', 'output', 'data', { x: 300, y: 300 });

    // json into text-or-bytes: nothing on base64 can take it.
    expect(portElement('b', 'input', 'input')).toHaveAttribute('data-port-state', 'idle');
    expect(portElement('b', 'input', 'input').className).toMatch(/portReceded/);
  });
});

describe('cancelling a drag', () => {
  it('leaves no wire when the drop lands on empty canvas', () => {
    seed([node('a', 'base64', 0, 0), node('b', 'structured-data', 400, 0)]);
    renderCanvas();

    beginDrag('a', 'output', 'output', { x: 900, y: 900 });
    pointer(canvasRoot(), 'pointerup', { x: 900, y: 900 });

    expect(edgeCount()).toBe(0);
    expect(draftPathData()).toBeNull();
  });

  it('leaves no wire when Escape cancels mid-drag', async () => {
    const user = userEvent.setup();
    seed([node('a', 'base64', 0, 0), node('b', 'structured-data', 400, 0)]);
    renderCanvas();

    beginDrag('a', 'output', 'output', { x: 200, y: 40 });
    expect(draftPathData()).not.toBeNull();

    canvasRoot().focus();
    await user.keyboard('{Escape}');

    expect(draftPathData()).toBeNull();

    // A release after the cancel must not resurrect the connection.
    const target = anchor('b', 'input', 'input');
    pointer(canvasRoot(), 'pointerup', target);
    expect(edgeCount()).toBe(0);
  });
});

describe('dragging in either direction', () => {
  it('starts a wire from an input as well as an output', () => {
    seed([node('a', 'base64', 0, 0), node('b', 'structured-data', 400, 0)]);
    renderCanvas();

    beginDrag('b', 'input', 'input', { x: 300, y: 300 });

    expect(draftPathData()).not.toBeNull();
    expect(portElement('b', 'input', 'input')).toHaveAttribute('data-port-state', 'held');
  });

  it('connects when dropped on a compatible output', () => {
    seed([node('a', 'base64', 0, 0), node('b', 'structured-data', 400, 0)]);
    renderCanvas();

    const source = anchor('a', 'output', 'output');
    beginDrag('b', 'input', 'input', source);
    pointer(canvasRoot(), 'pointerup', source);

    const graph = useCanvasStore.getState().graph;
    const edge = graph.edges[graph.edgeOrder[0] ?? ''];
    // Stored the right way round however it was drawn.
    expect(edge?.from).toEqual({ nodeId: 'a', portId: 'output' });
    expect(edge?.to).toEqual({ nodeId: 'b', portId: 'input' });
  });

  it('offers only outputs when the drag began at an input', () => {
    seed([node('a', 'base64', 0, 0), node('b', 'structured-data', 400, 0)]);
    renderCanvas();

    beginDrag('b', 'input', 'input', { x: 300, y: 300 });

    expect(portElement('a', 'output', 'output')).toHaveAttribute('data-port-state', 'valid');
    // Another input is not a partner for an input.
    expect(portElement('a', 'input', 'input')).toHaveAttribute('data-port-state', 'idle');
  });

  it('puts a pair of ends the right way round whichever end led', () => {
    const out = { ref: { nodeId: 'a', portId: 'output' }, side: 'output' } as const;
    const into = { ref: { nodeId: 'b', portId: 'input' }, side: 'input' } as const;

    expect(orientEnds(out, into)).toEqual({ from: out.ref, to: into.ref });
    expect(orientEnds(into, out)).toEqual({ from: out.ref, to: into.ref });
    // Two of the same side is not a wire at all.
    expect(orientEnds(out, out)).toBeNull();
  });
});

describe('the keyboard path', () => {
  it('offers the same connections the pointer would, from either side', async () => {
    const user = userEvent.setup();
    seed([node('a', 'base64', 0, 0), node('b', 'structured-data', 400, 0)]);
    renderCanvas();

    screen.getByRole('group', { name: /Base64/ }).focus();
    await user.keyboard('c');

    // Outputs lead, so `C, Enter` still means "from my output" - but the
    // node's inputs are reachable too, which is what keeps the keyboard level
    // with a pointer that can now drag either way.
    const dialog = await screen.findByRole('dialog', { name: /Connect from which port/ });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Outputs' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Inputs' })).toBeInTheDocument();
  });

  it('completes a connection through the two dialogs', async () => {
    const user = userEvent.setup();
    seed([node('a', 'base64', 0, 0), node('b', 'structured-data', 400, 0)]);
    renderCanvas();

    screen.getByRole('group', { name: /Base64/ }).focus();
    await user.keyboard('c');
    await screen.findByRole('dialog', { name: /Connect from which port/ });
    await user.keyboard('{Enter}');

    await screen.findByRole('dialog', { name: /Connect to which input/ });
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(edgeCount()).toBe(1);
    });
    const graph = useCanvasStore.getState().graph;
    expect(graph.edges[graph.edgeOrder[0] ?? '']?.from.nodeId).toBe('a');
  });

  it('refuses through the same rules and the same message as a drop', async () => {
    const user = userEvent.setup();
    seed([node('a', 'base64', 0, 0), node('b', 'structured-data', 400, 0)]);
    renderCanvas();

    // Wire a -> b by pointer, then attempt the loop by keyboard.
    const forward = anchor('b', 'input', 'input');
    beginDrag('a', 'output', 'output', forward);
    pointer(canvasRoot(), 'pointerup', forward);
    await waitFor(() => {
      expect(edgeCount()).toBe(1);
    });

    screen.getByRole('group', { name: /Structured data/ }).focus();
    await user.keyboard('c');
    await screen.findByRole('dialog', { name: /Connect from which port/ });
    await user.keyboard('{Enter}');

    const partners = await screen.findByRole('dialog', { name: /Connect to which input/ });
    // base64's input is the only candidate, and it would close a loop, so the
    // keyboard flow must not offer it either.
    expect(partners).toHaveTextContent(/Nothing on the canvas can accept/);
  });
});
