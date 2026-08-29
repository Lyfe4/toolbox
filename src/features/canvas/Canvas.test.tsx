import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { ToastProvider } from '@/components/Toast';
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
    expect(announcer()).toHaveTextContent('Added Base64');
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
    expect(announcer()).toHaveTextContent('No data included');
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
    expect(announcer()).toHaveTextContent('Moved to');

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
    expect(announcer()).toHaveTextContent('Deleted 1 item');

    await user.keyboard('{Control>}z{/Control}');
    expect(useCanvasStore.getState().graph.nodeOrder).toHaveLength(1);
  });

  it('duplicates the selection', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await addTool(user, 'base');

    await user.keyboard('{Control>}d{/Control}');
    expect(useCanvasStore.getState().graph.nodeOrder).toHaveLength(2);
    expect(announcer()).toHaveTextContent('Duplicated node');
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
          },
          left: {
            id: 'left',
            toolId: 'base64',
            position: { x: 0, y: 0 },
            options: {},
            inputs: {},
          },
          below: {
            id: 'below',
            toolId: 'base64',
            position: { x: 200, y: 400 },
            options: {},
            inputs: {},
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

    // base64 has one output, so the flow skips straight to choosing a target.
    const dialog = await screen.findByRole('dialog', { name: /Connect to which input/ });
    const options = within(dialog).getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Structured data');

    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(useCanvasStore.getState().graph.edgeOrder).toHaveLength(1);
    });
    expect(announcer()).toHaveTextContent('Connected Base64 to Structured data');
  });

  it('asks which output first when a tool has more than one', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await twoNodes(user);

    const source = screen.getByRole('group', { name: /Structured data/ });
    source.focus();
    await user.keyboard('c');

    // structured-data has two outputs, so the output step is not skipped.
    const dialog = await screen.findByRole('dialog', { name: /Connect from which output/ });
    expect(within(dialog).getAllByRole('option')).toHaveLength(2);
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

    await user.type(await screen.findByRole('combobox', { name: 'Search outputs' }), 'Parsed');
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
    expect(announcer()).toHaveTextContent('Connection refused');
    expect(announcer()).toHaveTextContent('loop');
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
    await screen.findByRole('dialog');
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(useCanvasStore.getState().graph.edgeOrder).toHaveLength(1);
    });
    // The claim is about the SETTLED canvas. Running axe while the connect
    // dialog is still unmounting scans a half-torn-down tree, which made this
    // fail once in a while under parallel load - a flaky test, not a flaky
    // canvas, but the assertion should say what it means either way.
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
    expect(announcer()).toHaveTextContent('Zoom reset');
  });

  it('fits content with F', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await addTool(user, 'base');

    await user.click(screen.getByRole('application'));
    await user.keyboard('f');
    expect(announcer()).toHaveTextContent('Fitted every node');
  });
});
