import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import { usePipelineStore } from '@/features/execution/pipelineStore';
import { EMPTY_ANNOUNCEMENTS } from '@/lib/announce';
import { expectNoAxeViolations } from '@/lib/testing/axe';

import { Canvas } from './Canvas';
import { useCanvasStore } from './graphStore';
import { DEFAULT_VIEWPORT, useViewportStore } from './viewportStore';

import type { CanvasEdge, CanvasNode, GraphData } from './types';

/**
 * DELETING THINGS WITHOUT A KEYBOARD.
 *
 * Delete, Duplicate and Select-all were keyboard-only, and the consequence got
 * worse the moment connecting became tappable: `checkConnection` refuses a
 * second wire into an occupied input and says to remove the existing one
 * first, and removing a wire needed Delete. So a touch user could wire two
 * tools together in three taps and then be unable to rewire it, and could add
 * nodes to a canvas and never remove one.
 *
 * WIRES WERE WORSE THAN THAT, and it was not only touch. Nothing on the
 * keyboard has ever put an edge in the selection - `Ctrl+A` selects nodes,
 * `Shift+Enter` toggles a node - so `Delete` could only ever remove a wire
 * that a POINTER had selected by hitting a 1.5px curve. Wire removal was
 * pointer-only at every input type.
 *
 * WHAT THESE TESTS DEFEND is not that the controls exist. It is that each of
 * them is the SAME code path as the keystroke it replaces: the bar's Delete
 * and the Delete key are one function, and the tests below drive both over one
 * graph and compare the document each leaves behind. Two routes to one graph
 * that agree today are two routes that disagree later - see `firstRefusedEdge`
 * in connections.ts, and `nodeActions.test.tsx` for the same assertion about
 * connecting.
 *
 * WHAT IS NOT HERE. Whether a control is 44px under a finger, whether the
 * canvas root clips it, whether the inspector sheet covers it on a phone, and
 * whether a real touchscreen produces a click at all are questions about
 * layout and real pointer semantics. jsdom has neither; they are asserted in
 * `scripts/cross-browser-check.mjs`.
 */

function node(id: string, toolId: CanvasNode['toolId'], x = 0, y = 0): CanvasNode {
  return { id, toolId, position: { x, y }, options: {}, inputs: {}, fileInputs: {} };
}

function renderCanvas() {
  return render(
    <ToastProvider>
      <Canvas />
    </ToastProvider>,
  );
}

/** A wired pair: Base64's output into Hash's input. */
const WIRE: CanvasEdge = {
  id: 'e1',
  from: { nodeId: 'a', portId: 'output' },
  to: { nodeId: 'b', portId: 'input' },
};

function seed(edges: readonly CanvasEdge[] = []): void {
  /*
   * The pipeline store keeps a result cache keyed by node id, and every test
   * here builds the same two ids. Without this, one test's result can be
   * served to the next as a cache hit - state leaking between tests in exactly
   * the shape it leaks between documents.
   */
  usePipelineStore.getState().reset();
  const nodes = [node('a', 'base64', 96, 96), node('b', 'hash', 496, 96)];

  useCanvasStore.setState({
    graph: {
      nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
      nodeOrder: nodes.map((n) => n.id),
      edges: Object.fromEntries(edges.map((edge) => [edge.id, edge])),
      edgeOrder: edges.map((edge) => edge.id),
      nextId: 3,
    },
    selection: { nodes: [], edges: [] },
    past: [],
    future: [],
    pendingMove: null,
    ...EMPTY_ANNOUNCEMENTS,
  });
}

function selectNodes(...ids: readonly string[]): void {
  act(() => {
    useCanvasStore.getState().select({ nodes: [...ids], edges: [] });
  });
}

function selectEdges(...ids: readonly string[]): void {
  act(() => {
    useCanvasStore.getState().select({ nodes: [], edges: [...ids] });
  });
}

const bar = (): HTMLElement => screen.getByTestId('canvas-selection-bar');
const graph = (): GraphData => useCanvasStore.getState().graph;

/** The document reduced to what a comparison should care about. */
function shape(): { nodes: readonly string[]; edges: readonly string[] } {
  const current = graph();
  return { nodes: [...current.nodeOrder], edges: [...current.edgeOrder] };
}

/**
 * The document WITHOUT its ids, for comparing two runs that each created
 * something.
 *
 * `nextId` is deliberately monotonic and undo does not roll it back - the note
 * on it says a reload must not be able to reissue an id - so duplicating,
 * undoing and duplicating again produces `n3` and then `n4`. Comparing ids
 * would be asserting that a rule this repository states on purpose is broken.
 * What has to match is what a duplicate IS: the same tool at the same offset.
 */
function fingerprint(): { nodes: readonly string[]; edges: readonly string[] } {
  const current = graph();
  return {
    nodes: current.nodeOrder
      .flatMap((id) => {
        const found = current.nodes[id];
        return found
          ? [`${found.toolId}@${found.position.x.toString()},${found.position.y.toString()}`]
          : [];
      })
      .toSorted(),
    edges: current.edgeOrder
      .flatMap((id) => {
        const edge = current.edges[id];
        return edge ? [`${edge.from.portId}->${edge.to.portId}`] : [];
      })
      .toSorted(),
  };
}

/**
 * The Undo inside the notification, not the one on the toolbar.
 *
 * Both are called "Undo" and both are on screen at once at a comfortable
 * width, which is deliberate: they are the same action, in two regions, and
 * renaming either would make the pair read as two different things. The
 * ambiguity is a test problem rather than a user one - a screen reader
 * announces the notification's title with its control - so the query is
 * scoped to the region rather than the label being changed.
 */
function toastUndo(): HTMLElement {
  return within(screen.getByRole('region', { name: /notifications/i })).getByRole('button', {
    name: 'Undo',
  });
}

beforeEach(() => {
  window.localStorage.clear();
  seed();
  useViewportStore.setState({ viewport: DEFAULT_VIEWPORT, isPanning: false });
});

describe('when the selection bar is there at all', () => {
  it('draws nothing with nothing selected', () => {
    renderCanvas();
    expect(screen.queryByTestId('canvas-selection-bar')).not.toBeInTheDocument();
  });

  it('appears when a node is selected and goes when the selection is cleared', () => {
    renderCanvas();

    selectNodes('a');
    expect(bar()).toBeInTheDocument();

    act(() => {
      useCanvasStore.getState().clearSelection();
    });
    expect(screen.queryByTestId('canvas-selection-bar')).not.toBeInTheDocument();
  });

  it('appears for a selected wire, which nothing else on the canvas acts on', () => {
    seed([WIRE]);
    renderCanvas();

    selectEdges('e1');
    expect(within(bar()).getByRole('button', { name: 'Delete 1 wire' })).toBeInTheDocument();
  });
});

describe('what the bar says is selected', () => {
  /*
   * A single node is named by its TOOL. "1 item" is true and useless: after a
   * tap that deleted something, the only question is which thing, and the
   * answer has to be beside the undo offer for the offer to mean anything.
   */
  it('names the tool for one node', () => {
    renderCanvas();
    selectNodes('b');

    expect(bar()).toHaveTextContent('Hash selected');
    expect(within(bar()).getByRole('button', { name: 'Delete Hash' })).toBeInTheDocument();
  });

  it('counts several nodes rather than listing them', () => {
    renderCanvas();
    selectNodes('a', 'b');

    expect(bar()).toHaveTextContent('2 nodes selected');
  });

  it('counts wires as wires, not as nodes', () => {
    seed([WIRE]);
    renderCanvas();
    selectEdges('e1');

    expect(bar()).toHaveTextContent('1 wire selected');
  });

  /*
   * A NAME THAT IS NOT A NODE'S NAME.
   *
   * The group was first labelled `Base64 selected`, and a node is also a
   * `role="group"` whose accessible name begins with its tool - so the bar
   * became a second group answering to the same description. Ambiguous to
   * anyone navigating by role, and it broke three tests that find a node that
   * way, which is that ambiguity showing up where it could be measured.
   */
  it('does not answer to the name of the node it is about', () => {
    renderCanvas();
    selectNodes('a');

    expect(screen.getAllByRole('group', { name: /Base64/ })).toHaveLength(1);
    expect(screen.getByRole('group', { name: 'Selection actions' })).toBeInTheDocument();
  });
});

describe('the button route and the key route are one path', () => {
  /**
   * THE ASSERTION THIS FILE EXISTS FOR.
   *
   * Both entrances are walked over the same graph and the document each leaves
   * is compared. A fork shows up here as two different shapes - or as one
   * entrance forgetting to move focus, or to offer an undo, which are the two
   * things the key branch used to do inline.
   */
  it('leaves the identical document whichever removes a node', async () => {
    const user = userEvent.setup();
    renderCanvas();

    // Entrance one: the keystroke.
    selectNodes('a');
    const target = screen.getByRole('group', { name: /Base64/ });
    act(() => {
      target.focus();
    });
    await user.keyboard('{Delete}');
    const fromKey = shape();

    // Put the graph back exactly as it was.
    act(() => {
      useCanvasStore.getState().undo();
    });
    await waitFor(() => {
      expect(graph().nodeOrder).toHaveLength(2);
    });

    // Entrance two: the button.
    selectNodes('a');
    await user.click(within(bar()).getByRole('button', { name: 'Delete Base64' }));

    expect(shape()).toEqual(fromKey);
    expect(fromKey.nodes).toEqual(['b']);
  });

  it('leaves the identical document whichever removes a wire', async () => {
    const user = userEvent.setup();
    seed([WIRE]);
    renderCanvas();

    selectEdges('e1');
    act(() => {
      screen.getByTestId('canvas-root').focus();
    });
    await user.keyboard('{Delete}');
    const fromKey = shape();

    act(() => {
      useCanvasStore.getState().undo();
    });
    await waitFor(() => {
      expect(graph().edgeOrder).toHaveLength(1);
    });

    selectEdges('e1');
    await user.click(within(bar()).getByRole('button', { name: 'Delete 1 wire' }));

    expect(shape()).toEqual(fromKey);
    expect(fromKey.edges).toEqual([]);
  });

  it('duplicates identically from the button and from Ctrl+D', async () => {
    const user = userEvent.setup();
    renderCanvas();

    selectNodes('a');
    act(() => {
      screen.getByTestId('canvas-root').focus();
    });
    await user.keyboard('{Control>}d{/Control}');
    const fromKey = fingerprint();

    act(() => {
      useCanvasStore.getState().undo();
    });
    await waitFor(() => {
      expect(graph().nodeOrder).toHaveLength(2);
    });

    selectNodes('a');
    await user.click(within(bar()).getByRole('button', { name: 'Duplicate' }));

    expect(fingerprint()).toEqual(fromKey);
    expect(fromKey.nodes).toHaveLength(3);
  });

  it('selects everything identically from the button and from Ctrl+A', async () => {
    const user = userEvent.setup();
    renderCanvas();

    selectNodes('a');
    act(() => {
      screen.getByTestId('canvas-root').focus();
    });
    await user.keyboard('{Control>}a{/Control}');
    const fromKey = [...useCanvasStore.getState().selection.nodes];

    selectNodes('a');
    await user.click(within(bar()).getByRole('button', { name: 'Select all' }));

    expect([...useCanvasStore.getState().selection.nodes]).toEqual(fromKey);
    expect(fromKey).toEqual(['a', 'b']);
  });
});

describe('the bar can be driven from the keyboard, not only tapped', () => {
  /**
   * THE CANVAS CLAIMS EVERY SINGLE LETTER, AND THAT CLAIM REACHES INSIDE IT.
   *
   * This bar is rendered inside a `role="application"` region whose key
   * handler exists to hear bare letters, and it has already been found
   * cancelling `Space` on its way to every button in the toolbar - a
   * `<button>` is activated by `Space` on keyup only if the keydown's default
   * action survived. `Enter` escaped that only by accident, because its branch
   * returns early when no node has focus.
   *
   * These three controls are new residents of exactly that region, so the
   * exclusion is load-bearing for them rather than incidental. A regression
   * would be silent in the worst way: the button looks focused, the ring is
   * there, and nothing happens.
   */
  it('activates Delete on Enter rather than opening the inspector', async () => {
    const user = userEvent.setup();
    renderCanvas();
    selectNodes('a');

    within(bar()).getByRole('button', { name: 'Delete Base64' }).focus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(graph().nodeOrder).toEqual(['b']);
    });
    expect(screen.queryByTestId('node-inspector')).not.toBeInTheDocument();
  });

  it('activates Delete on Space, which the region used to cancel', async () => {
    const user = userEvent.setup();
    renderCanvas();
    selectNodes('a');

    within(bar()).getByRole('button', { name: 'Delete Base64' }).focus();
    await user.keyboard('[Space]');

    await waitFor(() => {
      expect(graph().nodeOrder).toEqual(['b']);
    });
  });

  /*
   * An arrow key still nudges the node, because a button does nothing with an
   * arrow key and a focus ring inside the canvas should not stop the canvas
   * moving. Asserted so the exclusion above cannot quietly widen to every key.
   */
  it('still lets an arrow key nudge the selection while a bar button has focus', async () => {
    const user = userEvent.setup();
    renderCanvas();
    selectNodes('a');

    within(bar()).getByRole('button', { name: 'Delete Base64' }).focus();
    await user.keyboard('{ArrowRight}');

    await waitFor(() => {
      expect(graph().nodes.a?.position.x).toBe(104);
    });
  });

  it('duplicates from the keyboard through the button', async () => {
    const user = userEvent.setup();
    renderCanvas();
    selectNodes('a');

    within(bar()).getByRole('button', { name: 'Duplicate' }).focus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(graph().nodeOrder).toHaveLength(3);
    });
  });
});

describe('Select all, and when it is worth offering', () => {
  /*
   * A control that cannot change anything is the affordance rule this
   * repository has caught four times, read the other way round.
   */
  it('is gone once everything is already selected', () => {
    renderCanvas();
    selectNodes('a', 'b');

    expect(within(bar()).queryByRole('button', { name: 'Select all' })).not.toBeInTheDocument();
  });

  /*
   * It selects NODES, which is what Ctrl+A does. Offering it beside a selected
   * wire would be offering to replace the selection with something unrelated.
   */
  it('is gone while a wire is selected', () => {
    seed([WIRE]);
    renderCanvas();
    selectEdges('e1');

    expect(within(bar()).queryByRole('button', { name: 'Select all' })).not.toBeInTheDocument();
  });

  it('is offered when one of two nodes is selected', () => {
    renderCanvas();
    selectNodes('a');

    expect(within(bar()).getByRole('button', { name: 'Select all' })).toBeInTheDocument();
  });
});

describe('Duplicate', () => {
  it('is not offered for a wire, which cannot be duplicated', () => {
    seed([WIRE]);
    renderCanvas();
    selectEdges('e1');

    expect(within(bar()).queryByRole('button', { name: 'Duplicate' })).not.toBeInTheDocument();
  });
});

describe('taking a deletion back', () => {
  /*
   * THE REASON THE TOAST CARRIES A CONTROL.
   *
   * Undo already existed and has a visible button - on a wide screen. Below
   * 640px the toolbar collapses and Undo moves into an overflow menu, so on
   * the device where the only way to delete is a tap, the only way to reverse
   * it was three taps behind a control whose label says nothing about
   * deletion. A destructive action reachable by finger needs its reversal
   * offered where the deletion is reported.
   */
  it('offers an Undo beside the report of what was deleted', async () => {
    const user = userEvent.setup();
    renderCanvas();
    selectNodes('a');

    await user.click(within(bar()).getByRole('button', { name: 'Delete Base64' }));

    expect(await screen.findByText('Deleted Base64')).toBeInTheDocument();
    expect(toastUndo()).toBeInTheDocument();
  });

  it('restores the node when that Undo is pressed', async () => {
    const user = userEvent.setup();
    renderCanvas();
    selectNodes('a');

    await user.click(within(bar()).getByRole('button', { name: 'Delete Base64' }));
    await waitFor(() => {
      expect(graph().nodeOrder).toEqual(['b']);
    });

    await user.click(toastUndo());

    await waitFor(() => {
      expect(graph().nodeOrder).toContain('a');
    });
  });

  /*
   * A node's wires go with it and come back with it, so the offer has to
   * restore the whole thing rather than the box it was in.
   */
  it('restores the wires that went with a deleted node', async () => {
    const user = userEvent.setup();
    seed([WIRE]);
    renderCanvas();
    selectNodes('a');

    await user.click(within(bar()).getByRole('button', { name: 'Delete Base64' }));
    await waitFor(() => {
      expect(graph().edgeOrder).toEqual([]);
    });

    await user.click(toastUndo());

    await waitFor(() => {
      expect(graph().edgeOrder).toEqual(['e1']);
    });
  });

  /**
   * HOW MANY HISTORY STEPS THE OFFER UNDOES, WHICH IS MEASURED RATHER THAN
   * ASSUMED.
   *
   * `deleteSelection` pushes one command for wires and one for nodes, so a
   * selection holding both is two entries and a single `undo()` would restore
   * half of it and call that recovery. No gesture on this canvas can currently
   * select both at once - selecting a wire clears the nodes and vice versa -
   * which is exactly why this is worth a test: the guard lives in another
   * file's selection rules, and nothing would fail if those changed.
   */
  it('undoes both halves of a mixed selection in one press', async () => {
    const user = userEvent.setup();
    seed([WIRE]);
    renderCanvas();

    act(() => {
      useCanvasStore.getState().select({ nodes: ['a'], edges: ['e1'] });
    });

    await user.click(within(bar()).getByRole('button', { name: 'Delete 2 items' }));
    await waitFor(() => {
      expect(graph().nodeOrder).toEqual(['b']);
    });

    await user.click(toastUndo());

    await waitFor(() => {
      expect(shape()).toEqual({ nodes: ['a', 'b'], edges: ['e1'] });
    });
  });

  it('reports a disconnected wire with its own Undo', async () => {
    const user = userEvent.setup();
    seed([WIRE]);
    renderCanvas();

    selectEdges('e1');
    await user.click(within(bar()).getByRole('button', { name: 'Delete 1 wire' }));

    expect(await screen.findByText('Deleted 1 wire')).toBeInTheDocument();
    await user.click(toastUndo());

    await waitFor(() => {
      expect(graph().edgeOrder).toEqual(['e1']);
    });
  });
});

describe('where focus goes', () => {
  /*
   * The bar unmounts the instant the selection empties, so a Delete that left
   * focus on its own button would drop focus to the document and lose the
   * keyboard's place on the canvas entirely. The move happens synchronously
   * inside the handler - the store write is batched, so the root is still
   * there to aim at and no layout effect is needed to wait for a render.
   */
  it('returns to the canvas root after the bar deletes something', async () => {
    const user = userEvent.setup();
    renderCanvas();
    selectNodes('a');

    await user.click(within(bar()).getByRole('button', { name: 'Delete Base64' }));

    expect(document.activeElement).toBe(screen.getByTestId('canvas-root'));
  });
});

describe('removing a wire from the inspector', () => {
  /**
   * THE ROUTE THAT NEEDS NO AIM.
   *
   * `checkConnection` refuses a second wire into an occupied input and says to
   * remove the existing wire first. Until now that sentence described
   * something only a pointer could do - the wire had to be hit on the plane,
   * and no keystroke selects one - so the advice was unfollowable from a
   * keyboard and fiddly with a finger. The panel already knew exactly which
   * wire was in the way, because it prints a sentence naming it.
   */
  it('offers Disconnect beside the sentence naming the wire', async () => {
    const user = userEvent.setup();
    seed([WIRE]);
    renderCanvas();

    selectNodes('b');
    await user.click(screen.getByRole('button', { name: 'Inspector' }));

    const panel = await screen.findByTestId('node-inspector');
    expect(panel).toHaveTextContent('Wired from Base64 · Output.');
    expect(
      within(panel).getByRole('button', { name: 'Disconnect Input from Base64 · Output' }),
    ).toBeInTheDocument();
  });

  it('removes that wire and offers to put it back', async () => {
    const user = userEvent.setup();
    seed([WIRE]);
    renderCanvas();

    selectNodes('b');
    await user.click(screen.getByRole('button', { name: 'Inspector' }));
    const panel = await screen.findByTestId('node-inspector');

    await user.click(
      within(panel).getByRole('button', { name: 'Disconnect Input from Base64 · Output' }),
    );

    await waitFor(() => {
      expect(graph().edgeOrder).toEqual([]);
    });
    expect(await screen.findByText('Disconnected Input from Base64 · Output')).toBeInTheDocument();

    await user.click(toastUndo());
    await waitFor(() => {
      expect(graph().edgeOrder).toEqual(['e1']);
    });
  });

  /*
   * NOT ROUTED THROUGH THE SELECTION. Selecting the wire first would clear the
   * node selection, and the node selection is what the panel is SHOWING - so
   * the panel would empty itself as a side effect of a button inside it. This
   * asserts the panel is still on the node afterwards.
   */
  it('leaves the panel showing the node whose wire was removed', async () => {
    const user = userEvent.setup();
    seed([WIRE]);
    renderCanvas();

    selectNodes('b');
    await user.click(screen.getByRole('button', { name: 'Inspector' }));
    const panel = await screen.findByTestId('node-inspector');

    await user.click(
      within(panel).getByRole('button', { name: 'Disconnect Input from Base64 · Output' }),
    );

    await waitFor(() => {
      expect(graph().edgeOrder).toEqual([]);
    });
    expect(useCanvasStore.getState().selection.nodes).toEqual(['b']);
    expect(await screen.findByTestId('node-inspector')).toHaveTextContent('Hash');
  });
});

describe('accessibility', () => {
  it('has no violations with a node selected', async () => {
    const { container } = renderCanvas();
    selectNodes('a');

    await expectNoAxeViolations(container);
  });

  it('has no violations with a wire selected', async () => {
    seed([WIRE]);
    const { container } = renderCanvas();
    selectEdges('e1');

    await expectNoAxeViolations(container);
  });

  it('has no violations on the inspector row carrying Disconnect', async () => {
    const user = userEvent.setup();
    seed([WIRE]);
    const { container } = renderCanvas();

    selectNodes('b');
    await user.click(screen.getByRole('button', { name: 'Inspector' }));
    await screen.findByTestId('node-inspector');

    await expectNoAxeViolations(container);
  });
});
