import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import { usePipelineStore } from '@/features/execution/pipelineStore';
import { EMPTY_ANNOUNCEMENTS } from '@/lib/announce';
import { expectNoAxeViolations } from '@/lib/testing/axe';

import { Canvas } from './Canvas';
import { useCanvasStore } from './graphStore';
import { EMPTY_GRAPH } from './types';
import { DEFAULT_VIEWPORT, useViewportStore } from './viewportStore';

function renderCanvas() {
  return render(
    <ToastProvider>
      <Canvas />
    </ToastProvider>,
  );
}

/** The canvas's own polite live region, where movement chatter lands. */
function announcer(): HTMLElement {
  return screen.getByTestId('canvas-announcer');
}

/**
 * Waits for a message to reach the live region.
 *
 * The region delivers ONE MESSAGE AT A TIME - see `LiveRegion` - so a message
 * produced while an earlier one still holds the floor arrives a beat later.
 * These assertions used to be synchronous, and passed only because whatever
 * announced last overwrote everything before it. That overwriting was the
 * defect; waiting is the contract.
 */
async function expectAnnounced(text: string | RegExp): Promise<void> {
  await waitFor(() => {
    expect(announcer()).toHaveTextContent(text);
  });
}

/**
 * Records every distinct message the live region actually displays.
 *
 * Asserting on the region's CURRENT text can only ever ask "was this the last
 * thing said", which is the question that made this area look like a series of
 * unrelated races. What these tests need to ask is "was this said at all", and
 * that needs a recording rather than a snapshot - especially where the order
 * of two independent sources is genuinely not fixed.
 */
function recordAnnouncements(): { readonly seen: () => readonly string[] } {
  const target = announcer();
  const seen: string[] = [];

  const take = (): void => {
    const text = target.textContent;
    if (text !== '' && seen[seen.length - 1] !== text) seen.push(text);
  };

  take();
  new MutationObserver(take).observe(target, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  return { seen: () => seen };
}

function announced(seen: readonly string[], text: string): boolean {
  return seen.some((entry) => entry.includes(text));
}

async function addTool(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: /Add tool/ }));
  const search = await screen.findByRole('combobox', { name: 'Search tools' });
  await user.type(search, name);
  await user.keyboard('{Enter}');
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
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
    graph: EMPTY_GRAPH,
    selection: { nodes: [], edges: [] },
    past: [],
    future: [],
    pendingMove: null,
    ...EMPTY_ANNOUNCEMENTS,
  });
  useViewportStore.setState({ viewport: DEFAULT_VIEWPORT, isPanning: false });
});

describe('canvas shell', () => {
  it('exposes itself as a labelled application region with instructions', () => {
    renderCanvas();
    const canvas = screen.getByRole('application', { name: 'Pipeline canvas' });
    expect(canvas).toHaveAccessibleDescription(/Press K to add a tool/);
    expect(canvas).toHaveAccessibleDescription(/also available on the Tools page/);
  });

  it('tells an empty canvas what to do next', () => {
    renderCanvas();
    expect(screen.getByText('Empty canvas')).toBeInTheDocument();
  });

  it('has no axe violations when empty', async () => {
    const { container } = renderCanvas();
    await expectNoAxeViolations(container);
  });
});

describe('adding tools', () => {
  it('opens the palette with K and adds the chosen tool', async () => {
    const user = userEvent.setup();
    renderCanvas();

    await user.click(screen.getByRole('application'));
    await user.keyboard('k');

    const search = await screen.findByRole('combobox', { name: 'Search tools' });
    await user.type(search, 'base');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(useCanvasStore.getState().graph.nodeOrder).toHaveLength(1);
    });
    await expectAnnounced('Added Base64');
  });

  it('fuzzy-matches on summary as well as name', async () => {
    const user = userEvent.setup();
    renderCanvas();

    await user.click(screen.getByRole('button', { name: /Add tool/ }));
    await user.type(screen.getByRole('combobox', { name: 'Search tools' }), 'yaml');

    // "yaml" appears nowhere in the tool's NAME, only in its summary, so a
    // hit here proves the summary is searched. The palette also lists
    // pipelines, whose summaries mention YAML too, so this checks membership
    // rather than an exact count.
    const text = screen.getAllByRole('option').map((option) => option.textContent);
    expect(text.some((entry) => entry.includes('Structured data'))).toBe(true);
  });

  it('lists pipeline presets in the palette and loads one in a click', async () => {
    const user = userEvent.setup();
    renderCanvas();

    await user.click(screen.getByRole('button', { name: /Add tool/ }));
    await user.type(screen.getByRole('combobox', { name: 'Search tools' }), 'fingerprint');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(useCanvasStore.getState().graph.nodeOrder).toHaveLength(2);
    });

    const graph = useCanvasStore.getState().graph;
    expect(graph.edgeOrder).toHaveLength(1);
    // Structure only: a preset ships no data.
    for (const id of graph.nodeOrder) expect(graph.nodes[id]?.inputs).toEqual({});
    await expectAnnounced('No data included');
  });

  it('undoes a whole preset in one press', async () => {
    const user = userEvent.setup();
    renderCanvas();

    await user.click(screen.getByRole('button', { name: /Add tool/ }));
    // The preset's own name, not a word from it: "compare" also matches the
    // diff tool now, and the tool sorts above the preset.
    await user.type(screen.getByRole('combobox', { name: 'Search tools' }), 'Encode, then');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(useCanvasStore.getState().graph.nodeOrder).toHaveLength(3);
    });

    await user.click(screen.getByRole('application'));
    await user.keyboard('{Control>}z{/Control}');
    expect(useCanvasStore.getState().graph.nodeOrder).toHaveLength(0);
    expect(useCanvasStore.getState().graph.edgeOrder).toHaveLength(0);
  });

  it('selects and focuses the new node so it needs no hunting for', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await addTool(user, 'base');

    const id = useCanvasStore.getState().graph.nodeOrder[0] ?? '';
    expect(useCanvasStore.getState().selection.nodes).toEqual([id]);
    await waitFor(() => {
      expect(screen.getByTestId(`node-${id}`)).toHaveFocus();
    });
  });

  it('closes the palette on Escape without adding anything', async () => {
    const user = userEvent.setup();
    renderCanvas();

    await user.click(screen.getByRole('button', { name: /Add tool/ }));
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(useCanvasStore.getState().graph.nodeOrder).toHaveLength(0);
  });
});

describe('nodes', () => {
  it('states its tool, position, connections and status in its accessible name', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await addTool(user, 'base');

    const node = screen.getByRole('group', { name: /Base64/ });
    expect(node).toHaveAccessibleName(/at -?\d+, -?\d+/);
    expect(node).toHaveAccessibleName(/0 connections/);
    expect(node).toHaveAccessibleName(/not run yet|blocked/);
    expect(node).toHaveAccessibleName(/selected/);
    expect(node).toHaveAttribute('aria-roledescription', 'Canvas node');
  });

  it('moves with the arrow keys and announces the new position', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await addTool(user, 'base');

    const id = useCanvasStore.getState().graph.nodeOrder[0] ?? '';
    const before = useCanvasStore.getState().graph.nodes[id]?.position.x ?? 0;

    await user.keyboard('{ArrowRight}');
    expect(useCanvasStore.getState().graph.nodes[id]?.position.x).toBe(before + 8);
    await expectAnnounced('Moved to');

    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(useCanvasStore.getState().graph.nodes[id]?.position.x).toBe(before + 8 + 64);
  });

  it('stays on the 8px baseline when moved', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await addTool(user, 'base');

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowRight}');
    const id = useCanvasStore.getState().graph.nodeOrder[0] ?? '';
    const position = useCanvasStore.getState().graph.nodes[id]?.position;
    // Math.abs because the remainder of a negative multiple of 8 is -0, which
    // is not Object.is-equal to 0 even though the position is on the grid.
    expect(Math.abs((position?.x ?? 0) % 8)).toBe(0);
    expect(Math.abs((position?.y ?? 0) % 8)).toBe(0);
  });

  it('deletes with Delete and restores with undo', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await addTool(user, 'base');

    await user.keyboard('{Delete}');
    expect(useCanvasStore.getState().graph.nodeOrder).toHaveLength(0);
    await expectAnnounced('Deleted 1 item');

    await user.keyboard('{Control>}z{/Control}');
    expect(useCanvasStore.getState().graph.nodeOrder).toHaveLength(1);
  });

  it('duplicates the selection', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await addTool(user, 'base');

    await user.keyboard('{Control>}d{/Control}');
    expect(useCanvasStore.getState().graph.nodeOrder).toHaveLength(2);
    await expectAnnounced('Duplicated node');
  });

  it('walks nodes with Tab in spatial order, top-to-bottom then left-to-right', async () => {
    const user = userEvent.setup();
    // The fixture is installed BEFORE the first render, so the DOM order under
    // test is the one the canvas actually produces.
    useCanvasStore.setState({
      graph: {
        ...EMPTY_GRAPH,
        nodes: {
          right: {
            id: 'right',
            toolId: 'base64',
            position: { x: 400, y: 0 },
            options: {},
            inputs: {},
            fileInputs: {},
          },
          left: {
            id: 'left',
            toolId: 'base64',
            position: { x: 0, y: 0 },
            options: {},
            inputs: {},
            fileInputs: {},
          },
          below: {
            id: 'below',
            toolId: 'base64',
            position: { x: 200, y: 400 },
            options: {},
            inputs: {},
            fileInputs: {},
          },
        },
        // Insertion order deliberately does NOT match spatial order.
        nodeOrder: ['right', 'left', 'below'],
        nextId: 4,
      },
    });

    renderCanvas();

    const nodes = screen.getAllByRole('group');
    // The DOM order is the spatial order, so native Tab follows it.
    expect(nodes.map((node) => node.getAttribute('data-node-id'))).toEqual([
      'left',
      'right',
      'below',
    ]);

    await user.click(screen.getByRole('application'));
    await user.tab();
    expect(screen.getByTestId('node-left')).toHaveFocus();
    await user.tab();
    expect(screen.getByTestId('node-right')).toHaveFocus();
  });
});

/* ========================================================================== *
 * The keyboard connection flow
 *
 * This is the part a drag-and-drop canvas normally cannot do at all, so it is
 * tested as behaviour rather than left to an axe check - axe would happily
 * pass a canvas that no keyboard user can wire up.
 * ========================================================================== */

describe('connecting without a pointer', () => {
  async function twoNodes(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await addTool(user, 'base');
    await addTool(user, 'structured');
  }

  it('connects from the focused node through the C key', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await twoNodes(user);

    // Focus the base64 node and start a connection.
    const source = screen.getByRole('group', { name: /Base64/ });
    source.focus();
    await user.keyboard('c');

    /*
     * Step one lists every port on the node, because a pointer drag can now
     * start from either end and the keyboard is not a lesser route. Outputs
     * lead, so `C, Enter` still means "from my output" - the same two
     * keystrokes this flow always took.
     */
    const ports = await screen.findByRole('dialog', { name: /Connect from which port/ });
    expect(within(ports).getAllByRole('option')[0]).toHaveTextContent('Output');
    await user.keyboard('{Enter}');

    const dialog = await screen.findByRole('dialog', { name: /Connect to which input/ });
    const options = within(dialog).getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Structured data');

    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(useCanvasStore.getState().graph.edgeOrder).toHaveLength(1);
    });
    await expectAnnounced('Connected Base64 to Structured data');
  });

  it('lists every port of the node, both sides, before asking where to', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await twoNodes(user);

    const source = screen.getByRole('group', { name: /Structured data/ });
    source.focus();
    await user.keyboard('c');

    const dialog = await screen.findByRole('dialog', { name: /Connect from which port/ });
    // structured-data: two outputs and one input, each reachable.
    expect(within(dialog).getAllByRole('option')).toHaveLength(3);
    expect(within(dialog).getByRole('group', { name: 'Outputs' })).toBeInTheDocument();
    expect(within(dialog).getByRole('group', { name: 'Inputs' })).toBeInTheDocument();
  });

  it('offers only targets a pointer drop would also be allowed to land on', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await twoNodes(user);

    // The json `data` output fits nothing here: base64 takes text|bytes, and
    // structured-data cannot wire into itself.
    const source = screen.getByRole('group', { name: /Structured data/ });
    source.focus();
    await user.keyboard('c');

    await user.type(await screen.findByRole('combobox', { name: 'Search ports' }), 'Parsed');
    await user.keyboard('{Enter}');

    const dialog = await screen.findByRole('dialog', { name: /Connect to which input/ });
    expect(within(dialog).queryAllByRole('option')).toHaveLength(0);
    expect(dialog).toHaveTextContent(/Nothing on the canvas can accept this output/);
  });

  it('announces a refusal and its reason instead of failing silently', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await twoNodes(user);

    const ids = useCanvasStore.getState().graph.nodeOrder;
    const base = ids.find((id) => useCanvasStore.getState().graph.nodes[id]?.toolId === 'base64');
    const structured = ids.find(
      (id) => useCanvasStore.getState().graph.nodes[id]?.toolId === 'structured-data',
    );

    // Wire them, then try to wire the loop back the other way. Wrapped in act
    // because these are store writes from outside React's event system.
    act(() => {
      useCanvasStore
        .getState()
        .connect(
          { nodeId: base ?? '', portId: 'output' },
          { nodeId: structured ?? '', portId: 'input' },
        );
    });

    let refused = true;
    act(() => {
      refused = !useCanvasStore
        .getState()
        .connect(
          { nodeId: structured ?? '', portId: 'output' },
          { nodeId: base ?? '', portId: 'input' },
        ).ok;
    });

    expect(refused).toBe(true);
    await expectAnnounced('Connection refused');
    await expectAnnounced('loop');
  });

  it('cancels the flow on Escape', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await twoNodes(user);

    screen.getByRole('group', { name: /Base64/ }).focus();
    await user.keyboard('c');
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(useCanvasStore.getState().graph.edgeOrder).toHaveLength(0);
  });

  it('has no axe violations with nodes and a wire on screen', async () => {
    const user = userEvent.setup();
    const { container } = renderCanvas();
    await twoNodes(user);

    screen.getByRole('group', { name: /Base64/ }).focus();
    await user.keyboard('c');
    await screen.findByRole('dialog', { name: /Connect from which port/ });
    await user.keyboard('{Enter}');
    await screen.findByRole('dialog', { name: /Connect to which input/ });
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(useCanvasStore.getState().graph.edgeOrder).toHaveLength(1);
    });
    // The claim is about the SETTLED canvas, so wait for the connect dialog
    // to be gone before scanning rather than catching it mid-teardown.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    await expectNoAxeViolations(container);
  });
});

describe('shortcuts reference', () => {
  it('opens with ? and lists the bindings the canvas actually implements', async () => {
    const user = userEvent.setup();
    renderCanvas();

    await user.click(screen.getByRole('application'));
    await user.keyboard('?');

    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).getByText(/Connect from the focused node/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Open the tool palette/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Move to the next node/)).toBeInTheDocument();
  });

  it('is also reachable from a visible control', async () => {
    const user = userEvent.setup();
    renderCanvas();

    await user.click(screen.getByRole('button', { name: /Shortcuts/ }));
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const user = userEvent.setup();
    const { container } = renderCanvas();
    await user.click(screen.getByRole('button', { name: /Shortcuts/ }));
    await screen.findByRole('dialog');
    await expectNoAxeViolations(container);
  });
});

describe('viewport controls', () => {
  it('resets zoom with 0 and announces it', async () => {
    const user = userEvent.setup();
    renderCanvas();

    useViewportStore.setState({ viewport: { x: 0, y: 0, zoom: 2 } });
    await user.click(screen.getByRole('application'));
    await user.keyboard('0');

    expect(useViewportStore.getState().viewport.zoom).toBe(1);
    await expectAnnounced('Zoom reset');
  });

  /*
   * THE FLAKY TEST, AND WHY IT NO LONGER NEEDS A WORKAROUND.
   *
   * Adding a node starts a pipeline run. The run and the fit announce into the
   * SAME live region, which held one string, so whichever arrived last won and
   * the other was simply gone. This test used to wait for the run to settle
   * before pressing `f` - a workaround that made the test green while leaving
   * the application dropping messages, and which is now known to have been one
   * of four sightings of a single problem.
   *
   * It presses `f` straight into the middle of the run, and asserts that BOTH
   * messages are delivered, in order. See `@/lib/announce`.
   */
  it('fits content with F without losing the run announcement', async () => {
    const user = userEvent.setup();
    renderCanvas();
    const recorder = recordAnnouncements();

    await addTool(user, 'base');
    await user.click(screen.getByRole('application'));
    await user.keyboard('f');

    /*
     * BOTH, IN WHICHEVER ORDER THEY HAPPEN.
     *
     * Which of the two lands first depends on whether the run's debounce
     * elapses before the keystroke, which depends on how loaded the machine
     * is - and pinning an order here would just be a new way to be flaky
     * about the same thing. What is being tested is that neither message is
     * LOST, and that is true either way round.
     */
    await waitFor(() => {
      expect(announced(recorder.seen(), 'Fitted every node')).toBe(true);
      expect(announced(recorder.seen(), 'Pipeline finished')).toBe(true);
    });

    // ...and the one that came first was not simply overwritten by the second.
    expect(recorder.seen().filter((entry) => entry.includes('Added Base64'))).toHaveLength(1);
  });
});

describe('the live region', () => {
  /*
   * THE OTHER HALF OF THE SAME PROBLEM.
   *
   * Two announcements inside one React batch used to produce a single render
   * carrying only the second. The first never existed as a rendered value, so
   * no amount of care in the region itself could have recovered it - which is
   * why the fix is a log in the store rather than a smarter component.
   */
  it('delivers both messages announced in the same tick', async () => {
    renderCanvas();

    act(() => {
      const { announce } = useCanvasStore.getState();
      announce('First message.');
      announce('Second message.');
    });

    await expectAnnounced('First message.');
    await expectAnnounced('Second message.');
  });

  /*
   * Position chatter is the one thing that must NOT queue. Holding an arrow
   * key announces per repeat, and reading every one of them would leave a
   * screen-reader user hearing where the node used to be for seconds after it
   * stopped. Superseded messages are dropped; the final position is not.
   */
  it('collapses superseded movement chatter to the last position', async () => {
    renderCanvas();

    act(() => {
      const { announce } = useCanvasStore.getState();
      announce('Moved to 8, 0.', 'canvas-move');
      announce('Moved to 16, 0.', 'canvas-move');
      announce('Moved to 24, 0.', 'canvas-move');
    });

    await expectAnnounced('Moved to 24, 0.');
    expect(announcer()).not.toHaveTextContent('Moved to 8, 0.');
  });

  /*
   * A live region handed identical text is silent, because identical text is
   * not a DOM change. Pressing undo twice on an empty history is two real
   * events and has to be announced twice, so the message is a keyed child
   * that gets replaced rather than the region's own text.
   */
  it('re-announces the same message when it happens twice', async () => {
    renderCanvas();

    act(() => {
      useCanvasStore.getState().announce('Nothing to undo.');
    });
    await expectAnnounced('Nothing to undo.');
    const first = announcer().firstElementChild;

    act(() => {
      useCanvasStore.getState().announce('Nothing to undo.');
    });
    await waitFor(() => {
      expect(announcer().firstElementChild).not.toBe(first);
    });
    expect(announcer()).toHaveTextContent('Nothing to undo.');
  });
});
