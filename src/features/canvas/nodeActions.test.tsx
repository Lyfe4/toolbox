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

import type { CanvasEdge, CanvasNode } from './types';

/**
 * THE NODE'S OWN CONNECT BUTTON.
 *
 * Wiring two tools together had a pointer route (drag a port) and a keyboard
 * route (`C`), and `C` was ALSO the documented way to read a port label the
 * node had truncated. A phone has no `C`, so on the one device where labels
 * truncate most the documented fallback did not exist - nothing was blocked,
 * because dragging works with a finger, but the escape hatch was fiction.
 *
 * What these tests defend is not that a button exists. It is that the button
 * and the keystroke are ONE flow: the button is handed `beginConnectFrom`, the
 * same function the `C` branch calls, and the test below drives both entrances
 * on the same graph and compares the wire each produces. A second
 * implementation of "which port, then which partner" that agreed today and
 * drifted next month is the failure this repository keeps finding.
 *
 * WHAT IS NOT HERE. Whether the button is 44px under a finger, whether the
 * canvas root clips it, and whether the canvas's pointer capture eats its
 * click are all questions about layout and real pointer semantics. jsdom has
 * neither; they are asserted in `scripts/cross-browser-check.mjs`.
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

/** Two nodes that can legally be wired one way round and not the other. */
function seedPair(): void {
  /*
   * The pipeline store keeps a result cache keyed by node id, and every test
   * here builds the same two ids. Without this, one test's result can be
   * served to the next as a cache hit.
   */
  usePipelineStore.getState().reset();
  useCanvasStore.setState({
    graph: {
      nodes: {
        // On the 8px grid: a nudge snaps, so an off-grid seed would move by
        // 12px on the first arrow press and make the assertion below a lie.
        a: node('a', 'base64', 96, 96),
        b: node('b', 'hash', 496, 96),
      },
      nodeOrder: ['a', 'b'],
      edges: {},
      edgeOrder: [],
      nextId: 3,
    },
    selection: { nodes: [], edges: [] },
    past: [],
    future: [],
    pendingMove: null,
    ...EMPTY_ANNOUNCEMENTS,
  });
}

function selectOnly(...ids: readonly string[]): void {
  act(() => {
    useCanvasStore.getState().select({ nodes: [...ids], edges: [] });
  });
}

/** The single edge on the canvas, as a plain from/to pair. */
function onlyEdge(): { readonly from: string; readonly to: string } {
  const graph = useCanvasStore.getState().graph;
  expect(graph.edgeOrder).toHaveLength(1);
  const edge: CanvasEdge | undefined = graph.edges[graph.edgeOrder[0] ?? ''];
  if (!edge) throw new Error('no edge');
  return {
    from: `${edge.from.nodeId}:${edge.from.portId}`,
    to: `${edge.to.nodeId}:${edge.to.portId}`,
  };
}

function connectButton(toolName: string): HTMLElement {
  return screen.getByRole('button', { name: `Connect from ${toolName}` });
}

beforeEach(() => {
  window.localStorage.clear();
  seedPair();
  useViewportStore.setState({ viewport: DEFAULT_VIEWPORT, isPanning: false });
});

describe('when the button is there at all', () => {
  it('draws nothing on an unselected node', () => {
    renderCanvas();
    expect(screen.queryByRole('button', { name: /^Connect from/ })).not.toBeInTheDocument();
  });

  it('draws one on the node that is the only thing selected', () => {
    renderCanvas();
    selectOnly('a');

    expect(connectButton('Base64')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Connect from/ })).toHaveLength(1);
  });

  /*
   * The reason the prop is `soleSelected` and not `selected`. With both nodes
   * selected, two buttons would each offer to connect "from" one node while
   * Delete and the arrow keys were acting on both - an affordance naming one
   * node in a state that is about two.
   */
  it('draws none while several nodes are selected', () => {
    renderCanvas();
    selectOnly('a', 'b');

    expect(screen.queryByRole('button', { name: /^Connect from/ })).not.toBeInTheDocument();
  });

  /*
   * The accessible name carries the tool. "Connect" alone is what a screen
   * reader reads out of a list of controls, and it does not say connect WHAT.
   * The visible word is still just "Connect", which is what keeps 2.5.3 Label
   * in Name satisfied.
   */
  it('names the tool it would connect from', () => {
    renderCanvas();
    selectOnly('b');

    expect(connectButton('Hash')).toHaveTextContent('Connect');
  });
});

describe('the tap route and the C route are one flow', () => {
  it('opens the same chooser the keystroke opens', async () => {
    const user = userEvent.setup();
    renderCanvas();
    selectOnly('a');

    await user.click(connectButton('Base64'));

    const ports = await screen.findByRole('dialog', { name: /Connect from which port/ });
    // Outputs lead, exactly as they do from `C`, so the first Enter still
    // means "from my output" whichever entrance was used.
    expect(within(ports).getAllByRole('option')[0]).toHaveTextContent('Output');
  });

  /**
   * THE ASSERTION THIS FILE EXISTS FOR.
   *
   * Both entrances are walked over the same graph and the wire each produces
   * is compared. A fork would show up here as two different edges - or as one
   * entrance offering a target the other refuses, since `validPartnersFor` is
   * consulted once per flow rather than once per entrance.
   */
  it('produces the identical wire whichever entrance is used', async () => {
    const user = userEvent.setup();
    renderCanvas();

    // Entrance one: the keystroke.
    const keyboardNode = screen.getByRole('group', { name: /Base64/ });
    act(() => {
      keyboardNode.focus();
    });
    await user.keyboard('c');
    await screen.findByRole('dialog', { name: /Connect from which port/ });
    await user.keyboard('{Enter}');
    await screen.findByRole('dialog', { name: /Connect to which input/ });
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(useCanvasStore.getState().graph.edgeOrder).toHaveLength(1);
    });
    const fromKeyboard = onlyEdge();

    // Put the graph back exactly as it was.
    act(() => {
      useCanvasStore.getState().undo();
    });
    await waitFor(() => {
      expect(useCanvasStore.getState().graph.edgeOrder).toHaveLength(0);
    });

    // Entrance two: the button.
    selectOnly('a');
    await user.click(connectButton('Base64'));
    await screen.findByRole('dialog', { name: /Connect from which port/ });
    await user.keyboard('{Enter}');
    await screen.findByRole('dialog', { name: /Connect to which input/ });
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(useCanvasStore.getState().graph.edgeOrder).toHaveLength(1);
    });

    expect(onlyEdge()).toEqual(fromKeyboard);
  });

  it('offers only the targets a drag would accept, because it asks once', async () => {
    const user = userEvent.setup();
    renderCanvas();
    selectOnly('b');

    // Hash emits a digest of text, and Base64's input takes text or bytes, so
    // there is exactly one legal landing place and it is not Hash itself.
    await user.click(connectButton('Hash'));
    await screen.findByRole('dialog', { name: /Connect from which port/ });
    await user.keyboard('{Enter}');

    const partners = await screen.findByRole('dialog', { name: /Connect to which input/ });
    const options = within(partners).getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Base64');
  });
});

describe('pressing it does not become a drag', () => {
  /** One native pointerdown, which is what the canvas root actually listens for. */
  function press(target: EventTarget): void {
    act(() => {
      target.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          clientX: 10,
          clientY: 10,
          button: 0,
          buttons: 1,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  }

  /**
   * A pointerdown anywhere inside a node begins a move and captures the
   * pointer on the canvas root. The capture is what would eat the button's
   * click in a real engine; what is observable HERE is the move.
   *
   * ASSERTED WHILE THE PRESS IS STILL DOWN, and that is the whole test rather
   * than a detail. A full click ends in `endMove`, which clears
   * `pendingMove` and pushes nothing when the position has not changed - so
   * the first version of this passed with the guard deliberately removed. A
   * drag that begins and is tidied up is still a drag that swallowed a press.
   */
  it('starts no node move', () => {
    renderCanvas();
    selectOnly('a');

    press(connectButton('Base64'));

    expect(useCanvasStore.getState().pendingMove).toBeNull();
  });

  it('does begin one for a press on the node itself, so the test above means something', () => {
    renderCanvas();
    selectOnly('a');

    press(screen.getByRole('group', { name: /Base64/ }));

    expect(useCanvasStore.getState().pendingMove).not.toBeNull();
  });

  it('leaves the selection and the position alone', async () => {
    const user = userEvent.setup();
    renderCanvas();
    selectOnly('a');

    const before = useCanvasStore.getState().graph.nodes.a?.position;
    await user.click(connectButton('Base64'));

    expect(useCanvasStore.getState().selection.nodes).toEqual(['a']);
    expect(useCanvasStore.getState().graph.nodes.a?.position).toEqual(before);
    expect(useCanvasStore.getState().past).toHaveLength(0);
  });
});

/* ========================================================================== *
 * The canvas claims every single letter, and that claim was reaching controls
 * rendered inside it.
 * ========================================================================== */

describe('keys the focused control owns', () => {
  /*
   * Enter is bound on the canvas to "open the inspector on the focused node",
   * and it preventDefaults. The Connect button lives inside a node, so the
   * canvas saw a node with focus and took the key - the button would have been
   * pressable by pointer and by Space and not by Enter.
   */
  it('lets Enter press the Connect button rather than opening the inspector', async () => {
    const user = userEvent.setup();
    renderCanvas();
    selectOnly('a');

    act(() => {
      connectButton('Base64').focus();
    });
    await user.keyboard('{Enter}');

    await screen.findByRole('dialog', { name: /Connect from which port/ });
  });

  /**
   * A SHIPPED BUG, FOUND ON THE WAY PAST.
   *
   * Space was cancelled on the way to every button in the toolbar: the canvas
   * takes it to arm space-drag panning and calls `preventDefault`, and a
   * `<button>` is activated by Space on KEYUP only if the keydown's default
   * action survived. So "Add tool", "Fit", "Undo", "Redo", "Share" and
   * "Shortcuts" could each be focused, each looked focused, and none of them
   * could be pressed with the key half the world presses buttons with.
   *
   * Asserted through the palette, because that is the consequence a user has:
   * Space on "Add tool" has to open the palette.
   */
  it('lets Space press a toolbar button rather than arming the pan', async () => {
    const user = userEvent.setup();
    renderCanvas();

    act(() => {
      screen.getByRole('button', { name: /Add tool/ }).focus();
    });
    await user.keyboard(' ');

    await screen.findByRole('dialog', { name: 'Add a tool' });
  });

  /*
   * The other half of the same guard: only Enter and Space are given up. A
   * focus ring sitting on a button inside a node must not stop the node
   * moving, because a button does nothing with an arrow key and the node is
   * still what the arrow key is about.
   */
  it('still nudges the node when an arrow key arrives at its button', async () => {
    const user = userEvent.setup();
    renderCanvas();
    selectOnly('a');

    act(() => {
      connectButton('Base64').focus();
    });
    await user.keyboard('{ArrowRight}');

    expect(useCanvasStore.getState().graph.nodes.a?.position.x).toBe(104);
  });
});

describe('accessibility', () => {
  it('has no axe violations with the node control on screen', async () => {
    const { container } = renderCanvas();
    selectOnly('a');

    expect(connectButton('Base64')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('has no axe violations with the chooser it opens', async () => {
    const user = userEvent.setup();
    const { container } = renderCanvas();
    selectOnly('a');

    await user.click(connectButton('Base64'));
    await screen.findByRole('dialog', { name: /Connect from which port/ });

    await expectNoAxeViolations(container);
  });
});
