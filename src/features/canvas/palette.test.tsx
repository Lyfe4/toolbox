import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import { TOOL_CATEGORIES, TOOL_MANIFEST } from '@/features/registry';
import { expectNoAxeViolations } from '@/lib/testing/axe';

import { Canvas, PALETTE_CATEGORY_ORDER } from './Canvas';
import { clearOfExistingNodes, PLACEMENT_GAP } from './geometry';
import { useCanvasStore } from './graphStore';
import { PIPELINE_PRESETS } from './presets';
import { EMPTY_GRAPH, type GraphData } from './types';
import { DEFAULT_VIEWPORT, useViewportStore } from './viewportStore';

/**
 * THE TOOL PALETTE
 *
 * Every behavioural test here corresponds to something that was broken:
 * clicking a row did nothing because no handler was ever attached, and the
 * keyboard looked dead because the highlight moved correctly but the list
 * never scrolled to follow it.
 *
 * jsdom has no layout, so the purely visual half of the fix - equal row
 * heights, names that do not truncate - is asserted in the real engines by
 * scripts/cross-browser-check.mjs instead. What can be asserted here is the
 * structure those rules depend on.
 */

function renderCanvas() {
  return render(
    <ToastProvider>
      <Canvas />
    </ToastProvider>,
  );
}

async function openPalette(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: /Add tool/ }));
  return screen.findByRole('combobox', { name: 'Search tools' });
}

const graphOf = (): GraphData => useCanvasStore.getState().graph;

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

describe('choosing with a pointer', () => {
  it('adds a node when a row is clicked', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await openPalette(user);

    await user.click(screen.getByTestId('dialog-option-base64'));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    const graph = graphOf();
    expect(graph.nodeOrder).toHaveLength(1);
    expect(graph.nodes[graph.nodeOrder[0] ?? '']?.toolId).toBe('base64');
  });

  it('commits when the click lands on the summary rather than the row itself', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await openPalette(user);

    // Most clicks land on a child span, not the row. Delegation is what makes
    // that work; a handler bound to the row alone would still miss it.
    const row = screen.getByTestId('dialog-option-hash');
    const summary = within(row).getByText(/digests of text or files/);
    await user.click(summary);

    await waitFor(() => {
      expect(graphOf().nodeOrder).toHaveLength(1);
    });
    expect(graphOf().nodes[graphOf().nodeOrder[0] ?? '']?.toolId).toBe('hash');
  });

  it('moves the highlight on hover without taking focus from the input', async () => {
    const user = userEvent.setup();
    renderCanvas();
    const search = await openPalette(user);

    await user.hover(screen.getByTestId('dialog-option-diff'));

    await waitFor(() => {
      expect(screen.getByTestId('dialog-option-diff')).toHaveAttribute('aria-selected', 'true');
    });
    // One highlight, not two: the pointer drives the same selection the
    // keyboard does, and focus never leaves the combobox.
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute(
      'aria-activedescendant',
      screen.getByTestId('dialog-option-diff').id,
    );
  });
});

describe('choosing with the keyboard', () => {
  it('puts the best match first, whichever group it is in', async () => {
    const user = userEvent.setup();
    renderCanvas();
    const search = await openPalette(user);

    // Two presets mention base64 in their summaries, and the Pipelines group
    // leads the catalogue. Typing "base64" still has to land on Base64:
    // once there is a query the list is a ranking, not a catalogue.
    await user.type(search, 'base64');

    await waitFor(() => {
      expect(screen.getAllByRole('option')[0]).toHaveAttribute('data-option-id', 'base64');
    });
    expect(search).toHaveAttribute(
      'aria-activedescendant',
      screen.getByTestId('dialog-option-base64').id,
    );

    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(graphOf().nodeOrder).toHaveLength(1);
    });
    expect(graphOf().nodes[graphOf().nodeOrder[0] ?? '']?.toolId).toBe('base64');
  });

  it('keeps the declared group order when nothing has been typed', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await openPalette(user);

    expect(screen.getAllByRole('group')[0]).toHaveAccessibleName('Pipelines');
  });

  it('adds a node with ArrowDown then Enter, keeping focus in the input', async () => {
    const user = userEvent.setup();
    renderCanvas();
    const search = await openPalette(user);

    const first = screen.getAllByRole('option')[0];
    const second = screen.getAllByRole('option')[1];
    expect(search).toHaveAttribute('aria-activedescendant', first?.id);

    await user.keyboard('{ArrowDown}');
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute('aria-activedescendant', second?.id);

    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(graphOf().nodeOrder.length + graphOf().edgeOrder.length).toBeGreaterThan(0);
  });

  it('never moves DOM focus into the list', async () => {
    const user = userEvent.setup();
    renderCanvas();
    const search = await openPalette(user);

    for (const key of ['{ArrowDown}', '{ArrowDown}', '{End}', '{Home}', '{ArrowUp}']) {
      await user.keyboard(key);
      expect(search).toHaveFocus();
    }

    // Nothing in the list is a tab stop either, which is what makes
    // aria-activedescendant the only selection there is.
    expect(screen.getAllByRole('option').every((option) => !option.hasAttribute('tabindex'))).toBe(
      true,
    );
  });

  it('walks to the last option with End and back with Home', async () => {
    const user = userEvent.setup();
    renderCanvas();
    const search = await openPalette(user);

    const options = screen.getAllByRole('option');
    const last = options[options.length - 1];

    await user.keyboard('{End}');
    expect(search).toHaveAttribute('aria-activedescendant', last?.id);

    await user.keyboard('{Home}');
    expect(search).toHaveAttribute('aria-activedescendant', options[0]?.id);
  });

  it('does nothing on Enter when the search matches nothing', async () => {
    const user = userEvent.setup();
    renderCanvas();
    const search = await openPalette(user);

    await user.type(search, 'zzzzzz');
    expect(screen.getByTestId('dialog-empty')).toHaveTextContent('No matches for “zzzzzz”.');

    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(graphOf().nodeOrder).toHaveLength(0);
  });
});

describe('pipeline presets', () => {
  const preset = PIPELINE_PRESETS.find((entry) => entry.id === 'encode-and-compare');

  it('places every node and every wire the preset declares', async () => {
    if (!preset) throw new Error('the fan-out preset is missing');
    const user = userEvent.setup();
    renderCanvas();
    await openPalette(user);

    await user.click(screen.getByTestId('dialog-option-preset:encode-and-compare'));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    const graph = graphOf();
    expect(graph.nodeOrder).toHaveLength(preset.nodes.length);
    expect(graph.edgeOrder).toHaveLength(preset.wires.length);

    expect(graph.nodeOrder.map((id) => graph.nodes[id]?.toolId)).toEqual(
      preset.nodes.map((node) => node.toolId),
    );

    // The wires must connect the right pair of nodes, not merely exist: this
    // one fans a single output into two inputs.
    const wired = graph.edgeOrder.map((id) => {
      const edge = graph.edges[id];
      return `${graph.nodeOrder.indexOf(edge?.from.nodeId ?? '').toString()}.${edge?.from.portId ?? ''} -> ${graph.nodeOrder.indexOf(edge?.to.nodeId ?? '').toString()}.${edge?.to.portId ?? ''}`;
    });
    expect(wired).toEqual(['0.output -> 1.input', '0.output -> 2.input']);

    // Everything it placed is selected, so the next keystroke acts on it.
    expect(useCanvasStore.getState().selection.nodes).toEqual([...graph.nodeOrder]);
  });

  it('announces what it loaded, and that it carried no data', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await openPalette(user);

    await user.click(screen.getByTestId('dialog-option-preset:decode-and-convert'));

    await waitFor(() => {
      expect(screen.getByTestId('canvas-announcer')).toHaveTextContent(
        /Loaded the Decode, then convert pipeline: 2 nodes, 1 wires\. No data included\./,
      );
    });
  });

  it('drops a second preset clear of the first rather than on top of it', async () => {
    const user = userEvent.setup();
    renderCanvas();

    await openPalette(user);
    await user.click(screen.getByTestId('dialog-option-preset:decode-and-convert'));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    await openPalette(user);
    await user.click(screen.getByTestId('dialog-option-preset:fingerprint-csv'));
    await waitFor(() => {
      expect(graphOf().nodeOrder).toHaveLength(4);
    });

    const graph = graphOf();
    const ys = graph.nodeOrder.map((id) => graph.nodes[id]?.position.y ?? 0);
    // The second pair sits strictly below the first.
    expect(Math.min(ys[2] ?? 0, ys[3] ?? 0)).toBeGreaterThan(Math.max(ys[0] ?? 0, ys[1] ?? 0));
  });
});

describe('placement', () => {
  it('leaves an origin alone on an empty canvas', () => {
    expect(clearOfExistingNodes(EMPTY_GRAPH, { x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
  });

  it('pushes an origin below whatever is already there', () => {
    const graph: GraphData = {
      nodes: {
        n1: { id: 'n1', toolId: 'base64', position: { x: 0, y: 0 }, options: {}, inputs: {} },
      },
      nodeOrder: ['n1'],
      edges: {},
      edgeOrder: [],
      nextId: 2,
    };

    const moved = clearOfExistingNodes(graph, { x: 0, y: 0 });
    expect(moved.x).toBe(0);
    expect(moved.y).toBeGreaterThanOrEqual(PLACEMENT_GAP);
  });

  it('leaves an origin that is already well below alone', () => {
    const graph: GraphData = {
      nodes: {
        n1: { id: 'n1', toolId: 'base64', position: { x: 0, y: 0 }, options: {}, inputs: {} },
      },
      nodeOrder: ['n1'],
      edges: {},
      edgeOrder: [],
      nextId: 2,
    };

    expect(clearOfExistingNodes(graph, { x: 0, y: 5000 })).toEqual({ x: 0, y: 5000 });
  });
});

describe('grouping and layout', () => {
  it('orders every category deliberately and covers all of them', () => {
    // A permutation, not a subset: adding a category to the registry without
    // placing it here would otherwise mean a group that never renders.
    expect([...PALETTE_CATEGORY_ORDER].toSorted()).toEqual([...TOOL_CATEGORIES].toSorted());
  });

  it('renders each category exactly once, in the declared order', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await openPalette(user);

    const groupNames = screen
      .getAllByRole('group')
      .map((group) => group.getAttribute('aria-label'));

    // Pipelines lead; then only the categories that actually have a tool, in
    // the declared order and with no repeats.
    const present = PALETTE_CATEGORY_ORDER.filter((category) =>
      TOOL_MANIFEST.some((entry) => entry.category === category),
    );
    expect(groupNames).toEqual(['Pipelines', ...present]);
    expect(new Set(groupNames).size).toBe(groupNames.length);
  });

  it('does not repeat the category on every row', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await openPalette(user);

    const row = screen.getByTestId('dialog-option-base64');
    expect(row).toHaveTextContent('Base64');
    // The heading above it already says "encoding"; saying it again was what
    // squeezed the name column out of existence.
    expect(row.textContent.toLowerCase()).not.toContain('encoding');
  });

  it('gives every row the same two parts, so they can be sized alike', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await openPalette(user);

    for (const row of screen.getAllByRole('option')) {
      // A marker, a name and a summary. Nothing variable-length beyond those.
      expect(row.children).toHaveLength(3);
    }
  });

  it('sets pipelines apart from the tool categories', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await openPalette(user);

    const pipelines = screen.getByRole('group', { name: 'Pipelines' });
    expect(pipelines).toHaveTextContent('whole prewired graphs');

    // A different class, which is what carries the divider and the label
    // treatment. A pipeline is a different kind of thing to a tool.
    const encoding = screen.getByRole('group', { name: 'encoding' });
    expect(pipelines.className).not.toBe(encoding.className);
  });
});

describe('accessibility', () => {
  it('has no axe violations with the palette open', async () => {
    const user = userEvent.setup();
    const { container } = renderCanvas();
    await openPalette(user);

    await expectNoAxeViolations(container);
  });

  it('has no axe violations with a search that matches nothing', async () => {
    const user = userEvent.setup();
    const { container } = renderCanvas();
    const search = await openPalette(user);

    await user.type(search, 'zzzzzz');

    // The empty state removes the listbox that aria-controls points at, which
    // is exactly the kind of dangling reference axe catches.
    await expectNoAxeViolations(container);
  });
});

describe('where a new node lands', () => {
  /*
   * Found by walking the whole add-connect-run flow from the keyboard.
   *
   * Every palette add went to the exact centre of the viewport, so a second
   * tool landed perfectly on top of the first - both nodes reporting "at 608,
   * 368". With a pointer you drag the top one off without thinking; from the
   * keyboard the only way out is arrow keys, 8px at a time, on a node you
   * cannot see is there twice.
   */

  /**
   * Adds one tool by its id.
   *
   * By id rather than by accessible name: several tools mention each other in
   * their summaries, so a name match finds more than one row - "Base64" is in
   * the base64 tool AND in the base64-decode pipeline's description.
   */
  async function addTool(
    user: ReturnType<typeof userEvent.setup>,
    query: string,
    id = query,
  ): Promise<void> {
    const search = await openPalette(user);
    // Narrow the list first, then pick the exact row - searching matches names,
    // summaries and keywords, so a query alone can leave several rows standing.
    await user.type(search, query);
    await user.click(await screen.findByTestId(`dialog-option-${id}`));
  }

  it('does not stack a second node on top of the first', async () => {
    const user = userEvent.setup();
    renderCanvas();

    await addTool(user, 'base64');
    await waitFor(() => {
      expect(graphOf().nodeOrder).toHaveLength(1);
    });

    await addTool(user, 'hash');
    await waitFor(() => {
      expect(graphOf().nodeOrder).toHaveLength(2);
    });

    const [first, second] = graphOf().nodeOrder.map((id) => graphOf().nodes[id]?.position);
    expect(first).toBeDefined();
    expect(second).not.toEqual(first);
  });

  it('keeps every node in a run of adds on its own spot', async () => {
    const user = userEvent.setup();
    renderCanvas();

    for (const [index, [query, id]] of (
      [
        ['base64', 'base64'],
        ['hash', 'hash'],
        ['diff', 'diff'],
        ['regex', 'regex-tester'],
      ] as const
    ).entries()) {
      await addTool(user, query, id);
      await waitFor(() => {
        expect(graphOf().nodeOrder).toHaveLength(index + 1);
      });
    }

    const positions = graphOf().nodeOrder.map((id) => {
      const point = graphOf().nodes[id]?.position;
      return `${String(point?.x)},${String(point?.y)}`;
    });

    // Four adds, four distinct positions - the cascade steps every time
    // rather than only once.
    expect(new Set(positions).size).toBe(4);
  });
});
