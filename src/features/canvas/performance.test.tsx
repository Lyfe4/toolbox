import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { ToastProvider } from '@/components/Toast';

import { Canvas } from './Canvas';
import { useCanvasStore } from './graphStore';
import { DEFAULT_VIEWPORT, useViewportStore } from './viewportStore';

import type { CanvasNode, GraphData } from './types';

/**
 * A fifty-node graph, laid out in a grid, wired in a chain.
 *
 * jsdom has no compositor, so these numbers are not frame times - they measure
 * the JavaScript half: how long React spends reconciling. That is the half a
 * bug would land in. Real frame timings are measured in a browser and reported
 * separately; this test exists to catch a regression that reintroduces
 * per-node work on every pan.
 */
const NODE_COUNT = 50;

function bigGraph(): GraphData {
  const nodes: Record<string, CanvasNode> = {};
  const order: string[] = [];

  for (let index = 0; index < NODE_COUNT; index += 1) {
    const id = `n${(index + 1).toString()}`;
    order.push(id);
    nodes[id] = {
      id,
      toolId: index % 2 === 0 ? 'base64' : 'structured-data',
      position: { x: (index % 10) * 280, y: Math.floor(index / 10) * 240 },
      options: {},
      input: '',
    };
  }

  const edges: GraphData['edges'] = {};
  const edgeOrder: string[] = [];
  // Chain every even node into the odd one beside it: 25 wires.
  for (let index = 0; index + 1 < NODE_COUNT; index += 2) {
    const id = `e${index.toString()}`;
    edgeOrder.push(id);
    Object.assign(edges, {
      [id]: {
        id,
        from: { nodeId: `n${(index + 1).toString()}`, portId: 'output' },
        to: { nodeId: `n${(index + 2).toString()}`, portId: 'input' },
      },
    });
  }

  return { nodes, nodeOrder: order, edges, edgeOrder, nextId: NODE_COUNT + 100 };
}

/** Maps node id -> its DOM element, so identity survives a reorder. */
function nodeElements(): Map<string, Element> {
  return new Map(
    screen.getAllByRole('group').map((node) => [node.getAttribute('data-node-id') ?? '', node]),
  );
}

function measure(label: string, iterations: number, run: () => void): number {
  const started = performance.now();
  run();
  const elapsed = performance.now() - started;
  const per = elapsed / iterations;
  console.warn(
    `  [perf] ${label.padEnd(34)} ${elapsed.toFixed(1).padStart(8)} ms total  ${per.toFixed(2).padStart(7)} ms/op`,
  );
  return per;
}

beforeEach(() => {
  window.localStorage.clear();
  useCanvasStore.setState({
    graph: bigGraph(),
    selection: { nodes: [], edges: [] },
    past: [],
    future: [],
    pendingMove: null,
    announcement: { text: '', seq: 0 },
  });
  useViewportStore.setState({ viewport: DEFAULT_VIEWPORT, isPanning: false });
});

describe(`canvas with ${NODE_COUNT.toString()} nodes`, () => {
  it('renders every node and wire', () => {
    measure('initial render', 1, () => {
      render(
        <ToastProvider>
          <Canvas />
        </ToastProvider>,
      );
    });

    expect(screen.getAllByRole('group')).toHaveLength(NODE_COUNT);
    expect(screen.getByRole('application')).toBeInTheDocument();
  });

  it('pans without touching a single node', () => {
    render(
      <ToastProvider>
        <Canvas />
      </ToastProvider>,
    );

    const before = nodeElements();

    const perOp = measure('60 pan steps', 60, () => {
      act(() => {
        for (let step = 0; step < 60; step += 1) {
          useViewportStore.getState().panBy({ x: 3, y: 2 });
        }
      });
    });

    /*
     * The decisive assertion: after sixty pans every node element is the SAME
     * DOM node. Nothing was unmounted, remounted, or repositioned - only the
     * plane's transform changed. If someone ever moves the transform onto the
     * nodes, these identities break and this test fails.
     */
    const after = nodeElements();
    expect(after.size).toBe(NODE_COUNT);
    for (const [id, element] of before) {
      expect(after.get(id)).toBe(element);
    }

    expect(perOp).toBeLessThan(20);
  });

  it('zooms without touching a single node', () => {
    render(
      <ToastProvider>
        <Canvas />
      </ToastProvider>,
    );
    const before = nodeElements();

    measure('40 zoom steps', 40, () => {
      act(() => {
        for (let step = 0; step < 40; step += 1) {
          useViewportStore.getState().zoomAt(1.02, { x: 400, y: 300 });
        }
      });
    });

    const after = nodeElements();
    for (const [id, element] of before) {
      expect(after.get(id)).toBe(element);
    }
  });

  it('moves one node without remounting the other forty-nine', () => {
    render(
      <ToastProvider>
        <Canvas />
      </ToastProvider>,
    );
    const before = nodeElements();

    const perOp = measure('60 single-node drag steps', 60, () => {
      act(() => {
        useCanvasStore.getState().beginMove(['n1']);
        for (let step = 1; step <= 60; step += 1) {
          useCanvasStore.getState().dragMove({ x: step * 2, y: step });
        }
        useCanvasStore.getState().endMove();
      });
    });

    /*
     * Compared by id rather than by array index: moving a node can legitimately
     * change its place in the spatial tab order, and React keys mean the DOM
     * element is MOVED rather than rebuilt. Every untouched node must still be
     * the very same element it was.
     */
    const after = nodeElements();
    for (const [id, element] of before) {
      expect(after.get(id)).toBe(element);
    }

    expect(perOp).toBeLessThan(30);
  });

  it('keeps the whole drag as a single undo step', () => {
    render(
      <ToastProvider>
        <Canvas />
      </ToastProvider>,
    );

    act(() => {
      useCanvasStore.getState().beginMove(['n1']);
      for (let step = 1; step <= 60; step += 1) {
        useCanvasStore.getState().dragMove({ x: step, y: 0 });
      }
      useCanvasStore.getState().endMove();
    });

    expect(useCanvasStore.getState().past).toHaveLength(1);
  });
});
