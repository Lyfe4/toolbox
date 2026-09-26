import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import { usePipelineStore } from '@/features/execution/pipelineStore';
import { EMPTY_ANNOUNCEMENTS } from '@/lib/announce';

import { Canvas } from './Canvas';
import { useCanvasStore } from './graphStore';
import { DEFAULT_VIEWPORT, useViewportStore } from './viewportStore';

import type * as NodeViewModule from './CanvasNodeView';
import type { CanvasNode, GraphData } from './types';

/**
 * A fifty-node graph, laid out in a grid, wired in a chain.
 *
 * jsdom has no compositor, so the numbers printed here are not frame times -
 * they are how long React spends reconciling, and they are REPORTED, never
 * asserted. This test exists to catch a regression that reintroduces per-node
 * work on every pan, and it catches it by counting that work rather than by
 * timing it: a node component rendered during a pan is the regression itself,
 * on any machine. Until round twenty-six it asserted `perOp < 20` and
 * `perOp < 30` milliseconds, which measured the machine - `pnpm test` runs
 * over a hundred files at once, and both were seen failing under that load
 * with the code correct.
 */
const NODE_COUNT = 50;

/**
 * Every render of a node component, by node id. The real component is
 * wrapped in a memo with the SAME comparison, so it renders exactly when the
 * real one would - the count is the component's own behaviour, observed.
 */
const nodeRenders: string[] = [];

vi.mock('./CanvasNodeView', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeViewModule>();
  const { createElement, memo } = await import('react');
  const real = actual.CanvasNodeView as unknown as {
    readonly type: (props: { readonly node: { readonly id: string } }) => unknown;
    readonly compare: ((a: unknown, b: unknown) => boolean) | null;
  };
  const Counted = memo((props: { readonly node: { readonly id: string } }) => {
    nodeRenders.push(props.node.id);
    return createElement(real.type as never, props as never);
  }, real.compare ?? undefined);
  return { ...actual, CanvasNodeView: Counted };
});

/** Which nodes rendered while `run` ran. */
function rendersDuring(run: () => void): readonly string[] {
  const from = nodeRenders.length;
  run();
  return nodeRenders.slice(from);
}

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
      inputs: {},
      fileInputs: {},
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
  /*
   * The pipeline store keeps a result cache keyed by node id, and every test
   * here builds a canvas whose first node is n1. Without this, one test's
   * result can be served to the next as a cache hit - state leaking between
   * tests in exactly the shape it leaks between documents.
   */
  usePipelineStore.getState().reset();
  useCanvasStore.setState({
    graph: bigGraph(),
    selection: { nodes: [], edges: [] },
    past: [],
    future: [],
    pendingMove: null,
    ...EMPTY_ANNOUNCEMENTS,
  });
  useViewportStore.setState({ viewport: DEFAULT_VIEWPORT, isPanning: false });
});

describe(`canvas with ${NODE_COUNT.toString()} nodes`, () => {
  it('renders every node and wire', () => {
    const rendered = rendersDuring(() => {
      measure('initial render', 1, () => {
        render(
          <ToastProvider>
            <Canvas />
          </ToastProvider>,
        );
      });
    });

    expect(screen.getAllByRole('group')).toHaveLength(NODE_COUNT);
    // The counter's positive partner: it sees every node the first time, so
    // an empty count during a pan below is the component not rendering, not
    // the counter not looking.
    expect(new Set(rendered).size).toBe(NODE_COUNT);
    expect(screen.getByRole('application')).toBeInTheDocument();
  });

  it('pans without touching a single node', () => {
    render(
      <ToastProvider>
        <Canvas />
      </ToastProvider>,
    );

    const before = nodeElements();

    const rendered = rendersDuring(() => {
      measure('60 pan steps', 60, () => {
        // One commit per step, as sixty pointer moves are: a single act()
        // batches them into one render, which would hide per-step work.
        for (let step = 0; step < 60; step += 1) {
          act(() => {
            useViewportStore.getState().panBy({ x: 3, y: 2 });
          });
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

    // And not one of them RENDERED: the per-node work on every pan that
    // `perOp < 20` used to stand in for, counted instead of timed.
    expect(rendered).toEqual([]);
  });

  it('zooms without touching a single node', () => {
    render(
      <ToastProvider>
        <Canvas />
      </ToastProvider>,
    );
    const before = nodeElements();

    const rendered = rendersDuring(() => {
      measure('40 zoom steps', 40, () => {
        for (let step = 0; step < 40; step += 1) {
          act(() => {
            useViewportStore.getState().zoomAt(1.02, { x: 400, y: 300 });
          });
        }
      });
    });
    expect(rendered).toEqual([]);

    const after = nodeElements();
    // Keyed by data-node-id, so a lost attribute collapses the map to one
    // entry and the loop would compare one node. The size is the subject.
    expect(before.size).toBe(NODE_COUNT);
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

    const rendered = rendersDuring(() => {
      measure('60 single-node drag steps', 60, () => {
        act(() => {
          useCanvasStore.getState().beginMove(['n1']);
        });
        for (let step = 1; step <= 60; step += 1) {
          act(() => {
            useCanvasStore.getState().dragMove({ x: step * 2, y: step });
          });
        }
        act(() => {
          useCanvasStore.getState().endMove();
        });
      });
    });

    /*
     * Compared by id rather than by array index: moving a node can legitimately
     * change its place in the spatial tab order, and React keys mean the DOM
     * element is MOVED rather than rebuilt. Every untouched node must still be
     * the very same element it was.
     */
    const after = nodeElements();
    // Keyed by data-node-id, so a lost attribute collapses the map to one
    // entry and the loop would compare one node. The size is the subject.
    expect(before.size).toBe(NODE_COUNT);
    for (const [id, element] of before) {
      expect(after.get(id)).toBe(element);
    }

    // The node being dragged renders on every step, and no other node renders
    // at all: `perOp < 30`, counted. Every other node re-rendered on every
    // step until round twenty-six, and the timing bound never noticed.
    expect(rendered.filter((id) => id === 'n1').length).toBeGreaterThanOrEqual(60);
    expect([...new Set(rendered)]).toEqual(['n1']);
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
