import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import { idleState, type NodeRunState } from '@/features/execution/graph';
import { usePipelineStore } from '@/features/execution/pipelineStore';
import type { ToolOutputs, ToolResult } from '@/features/registry/types';
import { EMPTY_ANNOUNCEMENTS } from '@/lib/announce';

import { Canvas } from './Canvas';
import { useCanvasStore } from './graphStore';
import { EMPTY_GRAPH, type CanvasEdge, type CanvasNode } from './types';
import { DEFAULT_VIEWPORT, useViewportStore } from './viewportStore';

/**
 * THE COMPOSED CANVAS.
 *
 * `composition.integration.test.ts` runs graphs through the engine with no UI.
 * This file is the other half: a real Canvas, a real store, and the things a
 * PERSON does to a pipeline that is already running - deleting a node, undoing
 * mid-run, wiring the next hop from the keyboard - none of which the engine
 * ever sees on its own.
 */

function renderCanvas() {
  return render(
    <ToastProvider>
      <Canvas />
    </ToastProvider>,
  );
}

function node(id: string, toolId: CanvasNode['toolId'], x = 0, y = 0): CanvasNode {
  return { id, toolId, position: { x, y }, options: {}, inputs: { input: 'seed' }, fileInputs: {} };
}

function seed(nodes: readonly CanvasNode[], edges: readonly CanvasEdge[] = []): void {
  useCanvasStore.setState({
    graph: {
      nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
      nodeOrder: nodes.map((entry) => entry.id),
      edges: Object.fromEntries(edges.map((entry) => [entry.id, entry])),
      edgeOrder: edges.map((entry) => entry.id),
      nextId: nodes.length + edges.length + 1,
    },
    selection: { nodes: [], edges: [] },
    past: [],
    future: [],
    pendingMove: null,
    ...EMPTY_ANNOUNCEMENTS,
  });
}

function wire(id: string, from: string, to: string): CanvasEdge {
  return {
    id,
    from: { nodeId: from, portId: 'output' },
    to: { nodeId: to, portId: 'input' },
  };
}

/** Every node fails. Enough to make several failures happen at once. */
function alwaysFails(): Promise<ToolResult<ToolOutputs>> {
  return Promise.resolve<ToolResult<ToolOutputs>>({
    ok: false,
    error: { code: 'invalid-input', message: 'Not usable.' },
  });
}

function alwaysSucceeds(): Promise<ToolResult<ToolOutputs>> {
  return Promise.resolve<ToolResult<ToolOutputs>>({
    ok: true,
    value: { output: { type: 'text', text: 'out' }, digest: { type: 'text', text: 'out' } },
  });
}

function readout(): HTMLElement {
  return screen.getByTestId('canvas-readout');
}

beforeEach(() => {
  window.localStorage.clear();
  usePipelineStore.getState().reset();
  usePipelineStore.setState({ execute: alwaysSucceeds });
  useCanvasStore.setState({
    graph: EMPTY_GRAPH,
    selection: { nodes: [], edges: [] },
    past: [],
    future: [],
    pendingMove: null,
    ...EMPTY_ANNOUNCEMENTS,
  });
  useViewportStore.setState({ viewport: DEFAULT_VIEWPORT, isPanning: false });
});

/* ========================================================================== *
 * Several failures at once
 * ========================================================================== */

describe('when more than one node fails', () => {
  /*
   * Each failing node shows its own message, which is right. On a canvas
   * bigger than the viewport that is a message you cannot see, so the chrome
   * carries a COUNT - not a second copy of the wording, which would be a
   * second place to keep in step.
   */
  it('says how many failed, not merely that something did', async () => {
    usePipelineStore.setState({ execute: alwaysFails });
    seed([node('a', 'hash'), node('b', 'hash', 400), node('c', 'hash', 800)]);
    renderCanvas();

    await waitFor(() => {
      expect(readout()).toHaveTextContent('3 failed');
    });
  });

  /*
   * Downstream nodes are NOT counted. They did not fail - they never ran - and
   * counting them would turn one broken node into "5 failed" and send the user
   * looking for five bugs.
   */
  it('counts only the nodes that actually failed, not the ones they blocked', async () => {
    usePipelineStore.setState({
      execute: (options) => (options.toolId === 'base64' ? alwaysFails() : alwaysSucceeds()),
    });
    seed(
      [node('a', 'base64'), node('b', 'hash', 400), node('c', 'hash', 800)],
      [wire('e1', 'a', 'b'), wire('e2', 'b', 'c')],
    );
    renderCanvas();

    await waitFor(() => {
      expect(readout()).toHaveTextContent('1 failed');
    });
    // ...and the two that never ran say so on themselves.
    expect(screen.getByTestId('node-b')).toHaveTextContent(/upstream/);
    expect(screen.getByTestId('node-c')).toHaveTextContent(/upstream/);
  });

  it('says nothing about failures when nothing failed', async () => {
    seed([node('a', 'hash')]);
    renderCanvas();

    await waitFor(() => {
      expect(screen.getByTestId('node-a')).toHaveTextContent(/ok/);
    });
    expect(readout()).not.toHaveTextContent('failed');
  });
});

/* ========================================================================== *
 * Editing a pipeline that is already running
 * ========================================================================== */

describe('editing the graph under a running pipeline', () => {
  /**
   * An executor that does not settle until it is told to.
   *
   * This is the only way to hold a run open across a user action; a real tool
   * would settle far too quickly to interleave anything with it.
   */
  function heldExecutor() {
    const release: (() => void)[] = [];
    const started: string[] = [];

    const execute = (): Promise<ToolResult<ToolOutputs>> =>
      new Promise((resolve) => {
        started.push('call');
        release.push(() => {
          resolve({ ok: true, value: { output: { type: 'text', text: 'out' } } });
        });
      });

    return {
      execute,
      started,
      releaseAll: (): void => {
        for (const settle of release.splice(0)) settle();
      },
    };
  }

  /*
   * DELETING A NODE WHILE IT IS RUNNING.
   *
   * The run holds the graph it started with, so it goes on computing a node
   * that no longer exists. What must not happen is that node's result arriving
   * back into a canvas that has moved on - either as a state for an id that is
   * gone, or as a cache entry holding its whole output for the life of the tab.
   */
  it('does not resurrect a node deleted while it was running', async () => {
    const held = heldExecutor();
    usePipelineStore.setState({ execute: held.execute });
    seed([node('a', 'hash'), node('b', 'hash', 400)]);
    renderCanvas();

    await waitFor(() => {
      expect(held.started.length).toBeGreaterThan(0);
    });

    act(() => {
      useCanvasStore.getState().select({ nodes: ['b'], edges: [] });
      useCanvasStore.getState().deleteSelection();
    });
    act(() => {
      held.releaseAll();
    });

    // The deleted node is gone from the canvas...
    expect(screen.queryByTestId('node-b')).not.toBeInTheDocument();

    // ...and once the replacement run has settled, it is gone from the run
    // state too rather than lingering as a result for an id nobody can see.
    usePipelineStore.setState({ execute: alwaysSucceeds });
    await waitFor(() => {
      expect(usePipelineStore.getState().states.a?.status).toBe('ok');
      expect(usePipelineStore.getState().states.b).toBeUndefined();
    });
  });

  /*
   * UNDO DURING A RUN.
   *
   * Undo is a graph edit like any other, so it supersedes the run in flight.
   * The restored graph then has to run to completion on its own - the danger
   * is the superseded run's results painting over the new one's, which is what
   * the run token in the store exists to prevent.
   */
  it('runs the restored graph to completion when undo lands mid-run', async () => {
    const held = heldExecutor();
    usePipelineStore.setState({ execute: held.execute });
    seed([node('a', 'hash'), node('b', 'hash', 400)]);
    renderCanvas();

    act(() => {
      useCanvasStore.getState().select({ nodes: ['b'], edges: [] });
      useCanvasStore.getState().deleteSelection();
    });

    await waitFor(() => {
      expect(held.started.length).toBeGreaterThan(0);
    });

    act(() => {
      useCanvasStore.getState().undo();
    });
    act(() => {
      held.releaseAll();
    });

    usePipelineStore.setState({ execute: alwaysSucceeds });

    // The node undo brought back is present, and has a result of its own.
    await waitFor(() => {
      expect(screen.getByTestId('node-b')).toBeInTheDocument();
      expect(usePipelineStore.getState().states.b?.status).toBe('ok');
      expect(usePipelineStore.getState().states.a?.status).toBe('ok');
    });
  });

  /*
   * Changing an option re-runs that node and everything below it, and NOTHING
   * else. The cache is the only reason a long pipeline is usable at all, so
   * this is as much a performance contract as a correctness one.
   */
  it('re-runs only the edited node and its descendants', async () => {
    const ran: string[] = [];
    usePipelineStore.setState({
      execute: (options) => {
        ran.push(options.toolId);
        return alwaysSucceeds();
      },
    });

    seed(
      [node('a', 'base64'), node('b', 'hash', 400), node('c', 'hash', 800)],
      [wire('e1', 'a', 'b'), wire('e2', 'b', 'c')],
    );
    renderCanvas();

    await waitFor(() => {
      expect(usePipelineStore.getState().states.c?.status).toBe('ok');
    });
    expect(ran).toHaveLength(3);

    ran.length = 0;
    act(() => {
      useCanvasStore.getState().setNodeOptions('b', { algorithm: 'md5' });
    });

    await waitFor(() => {
      expect(ran).toHaveLength(2);
    });
    // The source was served from cache; b and c had to run again.
    expect(ran).toEqual(['hash', 'hash']);
  });
});

/* ========================================================================== *
 * The keyboard, across a whole pipeline
 * ========================================================================== */

describe('building and running a pipeline from the keyboard', () => {
  /*
   * The keyboard path is tested a node at a time elsewhere. This walks the
   * whole route - add, wire, wire again, type into the source - and then
   * checks that the far end of the chain actually produced something. A canvas
   * a keyboard user can build but not run is not a keyboard-accessible canvas.
   */
  it('wires a three-node chain and runs it end to end', async () => {
    const user = userEvent.setup();
    renderCanvas();

    async function addTool(name: string): Promise<void> {
      await user.click(screen.getByRole('button', { name: /Add tool/ }));
      const search = await screen.findByRole('combobox', { name: 'Search tools' });
      await user.type(search, name);
      await user.keyboard('{Enter}');
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    }

    async function connect(fromName: RegExp): Promise<void> {
      const source = screen.getByRole('group', { name: fromName });
      source.focus();
      await user.keyboard('c');
      await screen.findByRole('dialog', { name: /Connect from which port/ });
      await user.keyboard('{Enter}');
      const target = await screen.findByRole('dialog', { name: /Connect to which input/ });
      expect(within(target).getAllByRole('option').length).toBeGreaterThan(0);
      await user.keyboard('{Enter}');
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    }

    await addTool('base');
    await addTool('structured');
    await addTool('hash');

    await connect(/Base64/);
    await connect(/Structured data/);

    /*
     * THE CHAIN IT ASKED FOR, not merely two wires.
     *
     * A count is satisfied by any two legal wires, and the keyboard flow can
     * produce a completely different graph without producing an illegal one -
     * a stolen focus once built Structured data -> Hash -> Base64 here, which
     * has two edges, refuses nothing, and simply runs the pipeline backwards.
     * That went unnoticed until the assertion at the bottom timed out fifteen
     * seconds later against the execution engine, which had done nothing
     * wrong. Naming the wires fails in the right place, immediately.
     */
    const built = useCanvasStore.getState().graph;
    const toolOf = (id: string): string | undefined => built.nodes[id]?.toolId;
    expect(
      built.edgeOrder.map((id) => {
        const edge = built.edges[id];
        return `${toolOf(edge?.from.nodeId ?? '') ?? '?'} -> ${toolOf(edge?.to.nodeId ?? '') ?? '?'}`;
      }),
    ).toEqual(['base64 -> structured-data', 'structured-data -> hash']);

    // Typing into the source is what turns a wired-up shape into a run.
    const [sourceId] = useCanvasStore.getState().graph.nodeOrder;
    act(() => {
      useCanvasStore.getState().setNodeInput(sourceId ?? '', 'input', 'eyJhIjoxfQ==');
    });

    await waitFor(() => {
      const states = usePipelineStore.getState().states;
      expect(Object.values(states).every((state) => state.status === 'ok')).toBe(true);
      expect(Object.keys(states)).toHaveLength(3);
    });
  });
});

/* ========================================================================== *
 * The wire that shows data moving through it
 * ========================================================================== */

/**
 * THE ANIMATION THAT WAS WRITTEN, COMPUTED, PASSED AND NEVER APPLIED.
 *
 * `Canvas.tsx` derives `activeEdges` from the live run states on every render
 * and hands it to `Wires`. `Wires` declared the prop, typed it, and did not
 * destructure it - so `.wireActive`, its reduced-motion variant and its
 * forced-colors variant have never once been on an element. Nothing failed:
 * the prop was supplied, and a class nobody names produces no error and no
 * visible difference from the same wire not moving.
 *
 * It was found by the reverse half of `cssModules.test.ts`, which asks whether
 * every class a stylesheet DECLARES is named by a component - the mirror of
 * the check that has been asking the opposite question since a missing
 * `.tokens` made the styleguide wider than a phone.
 *
 * The class, not the animation. Whether it actually travels, and whether
 * reduced motion stops it, are questions about a compositor jsdom does not
 * have.
 */
describe('a wire feeding a running node', () => {
  const activeWires = (): readonly string[] =>
    [...document.querySelectorAll('[data-edge-id]')]
      .filter((group) =>
        [...group.querySelectorAll('path')].some((path) =>
          (path.getAttribute('class') ?? '').includes('wireActive'),
        ),
      )
      .flatMap((group) => group.getAttribute('data-edge-id') ?? []);

  /** A run state built from the real idle one, so no field can be forgotten. */
  const runState = (status: NodeRunState['status']): NodeRunState => ({
    ...idleState(),
    status,
  });

  it('is marked while that node is running, and only that wire', () => {
    seed(
      [node('a', 'base64'), node('b', 'hash', 400), node('c', 'hash', 800)],
      [wire('e1', 'a', 'b'), wire('e2', 'b', 'c')],
    );
    renderCanvas();

    act(() => {
      usePipelineStore.setState({
        states: { a: runState('ok'), b: runState('running'), c: runState('idle') },
      });
    });

    expect(activeWires()).toEqual(['e1']);
  });

  it('is not marked while nothing is running', () => {
    seed([node('a', 'base64'), node('b', 'hash', 400)], [wire('e1', 'a', 'b')]);
    renderCanvas();

    act(() => {
      usePipelineStore.setState({ states: { a: runState('ok'), b: runState('ok') } });
    });

    expect(activeWires()).toEqual([]);
  });
});
