import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import { usePipelineStore } from '@/features/execution/pipelineStore';
import type { ToolOutputs, ToolResult } from '@/features/registry/types';
import { EMPTY_ANNOUNCEMENTS } from '@/lib/announce';
import { expectNoAxeViolations } from '@/lib/testing/axe';

import { Canvas } from './Canvas';
import { useCanvasStore } from './graphStore';
import { EMPTY_GRAPH, type CanvasEdge, type CanvasNode } from './types';
import { DEFAULT_VIEWPORT, useViewportStore } from './viewportStore';

/**
 * THE NODE INSPECTOR.
 *
 * The canvas ran pipelines correctly and showed you none of it: no options, so
 * every node ran on defaults, and no output, so the answer - including the last
 * node's, which is the thing the chain was built for - existed only in memory.
 *
 * These tests are about the seams that fix touches, not about the panels
 * inside it. `OptionsPanel` and the five output views are the tool runner's
 * own and are tested there; what is asserted here is that the canvas hands
 * them the right node, that editing through them reaches the graph, and that
 * the states nobody designs for - nothing selected, several selected, the node
 * deleted while you were typing in it - do something rather than nothing.
 *
 * NOTE ON THE DEFAULT STATE. jsdom's `matchMedia` always reports no match, so
 * `(min-width: 1000px)` is false here and the inspector starts CLOSED, which is
 * the phone branch. That is the harder branch to get right and the one worth
 * exercising by default; the rail's own default is asserted explicitly below
 * by making the query match.
 */

function renderCanvas() {
  return render(
    <ToastProvider>
      <Canvas />
    </ToastProvider>,
  );
}

function node(
  id: string,
  toolId: CanvasNode['toolId'],
  x = 0,
  y = 0,
  extra: Partial<CanvasNode> = {},
): CanvasNode {
  return { id, toolId, position: { x, y }, options: {}, inputs: {}, ...extra };
}

function seed(nodes: readonly CanvasNode[], edges: readonly CanvasEdge[] = []): void {
  usePipelineStore.getState().reset();
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

function select(...ids: readonly string[]): void {
  act(() => {
    useCanvasStore.getState().select({ nodes: [...ids], edges: [] });
  });
}

/** Opens the panel the way a pointer user does. */
async function openInspector(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'Inspector' }));
  return screen.getByTestId('node-inspector');
}

/** Pretends the viewport is wide enough for the docked rail. */
function withRail(): void {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query.includes('min-width: 1000px'),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

function succeedsWith(outputs: ToolOutputs): () => Promise<ToolResult<ToolOutputs>> {
  return () => Promise.resolve<ToolResult<ToolOutputs>>({ ok: true, value: outputs });
}

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  usePipelineStore.getState().reset();
  usePipelineStore.setState({
    execute: succeedsWith({ output: { type: 'text', text: 'abc123' } }),
  });
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
 * Opening and closing
 * ========================================================================== */

describe('when the inspector is on screen', () => {
  /*
   * The panel defaults to open where it costs nothing - a docked rail simply
   * narrows the canvas - and closed where it covers the graph. Selection never
   * opens or closes it: on a phone that would bury the canvas on every tap
   * while arranging nodes, and on a desktop it would be a panel that reopens
   * itself faster than it can be dismissed.
   */
  it('is closed by default where it would cover the canvas', () => {
    seed([node('a', 'hash')]);
    renderCanvas();

    expect(screen.queryByTestId('node-inspector')).not.toBeInTheDocument();
  });

  it('is open by default where it merely narrows the canvas', () => {
    withRail();
    seed([node('a', 'hash')]);
    renderCanvas();

    expect(screen.getByTestId('node-inspector')).toBeInTheDocument();
  });

  it('does not open itself when a node is selected', async () => {
    seed([node('a', 'hash')]);
    renderCanvas();
    select('a');

    await waitFor(() => {
      expect(screen.getByTestId('node-a')).toHaveAttribute('data-status');
    });
    expect(screen.queryByTestId('node-inspector')).not.toBeInTheDocument();
  });

  /*
   * The toggle says which state it is in through `aria-pressed` rather than by
   * changing its label. The control is the same control either way, and
   * "Inspector, pressed" is a better thing to hear than a button whose name
   * flips between "Show" and "Hide" under you.
   */
  it('is toggled by a control that reports its own state', async () => {
    const user = userEvent.setup();
    seed([node('a', 'hash')]);
    renderCanvas();

    const toggle = screen.getByRole('button', { name: 'Inspector' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('node-inspector')).toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('node-inspector')).not.toBeInTheDocument();
  });

  it('is toggled by I from the canvas', async () => {
    const user = userEvent.setup();
    seed([node('a', 'hash')]);
    renderCanvas();

    screen.getByTestId('canvas-root').focus();
    await user.keyboard('i');
    expect(screen.getByTestId('node-inspector')).toBeInTheDocument();

    await user.keyboard('i');
    expect(screen.queryByTestId('node-inspector')).not.toBeInTheDocument();
  });

  /*
   * Closing is about the panel, not about the work. Collapsing the two would
   * mean the only way to get the canvas's width back was to deselect the node
   * you were about to move.
   */
  it('keeps the selection when it is closed', async () => {
    const user = userEvent.setup();
    seed([node('a', 'hash')]);
    renderCanvas();
    select('a');
    await openInspector(user);

    await user.click(screen.getByRole('button', { name: 'Close the inspector' }));

    expect(screen.queryByTestId('node-inspector')).not.toBeInTheDocument();
    expect(useCanvasStore.getState().selection.nodes).toEqual(['a']);
  });
});

/* ========================================================================== *
 * Nothing selected, or too much
 * ========================================================================== */

describe('what it shows when it is not showing one node', () => {
  it('says what to do when nothing is selected', async () => {
    const user = userEvent.setup();
    seed([node('a', 'hash')]);
    renderCanvas();
    const panel = await openInspector(user);

    expect(within(panel).getByText(/No node selected/)).toBeInTheDocument();
  });

  it('points at the palette when there is nothing to select', async () => {
    const user = userEvent.setup();
    renderCanvas();
    const panel = await openInspector(user);

    expect(within(panel).getByText(/Nothing on the canvas yet/)).toBeInTheDocument();
  });

  /*
   * "Select a node" is the answer to an empty selection and an insult to a
   * deliberate multi-selection. Listing them and letting one be picked turns a
   * dead end into a way through - and picking one is the only way a keyboard
   * user reaches a specific node of a group without clearing the whole thing.
   */
  it('lists a multi-selection and lets one of them be inspected', async () => {
    const user = userEvent.setup();
    seed([node('a', 'hash'), node('b', 'base64', 400)]);
    renderCanvas();
    select('a', 'b');
    const panel = await openInspector(user);

    expect(within(panel).getByText(/2 nodes selected/)).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: /Base64/ }));

    expect(useCanvasStore.getState().selection.nodes).toEqual(['b']);
    expect(within(screen.getByTestId('node-inspector')).getByText('Input')).toBeInTheDocument();
  });
});

/* ========================================================================== *
 * Input
 * ========================================================================== */

describe('input', () => {
  it('is entered here, and nowhere else', async () => {
    const user = userEvent.setup();
    seed([node('a', 'base64')]);
    const { container } = renderCanvas();
    select('a');
    const panel = await openInspector(user);

    expect(container.querySelectorAll('[data-node-id] textarea')).toHaveLength(0);
    expect(within(panel).getByRole('textbox', { name: 'Base64 input' })).toBeInTheDocument();
  });

  it('reaches the graph and runs the pipeline', async () => {
    const user = userEvent.setup();
    seed([node('a', 'hash')]);
    renderCanvas();
    select('a');
    const panel = await openInspector(user);

    await user.type(within(panel).getByRole('textbox', { name: 'Hash input' }), 'hello');

    expect(useCanvasStore.getState().graph.nodes.a?.inputs.input).toBe('hello');
    await waitFor(() => {
      expect(usePipelineStore.getState().states.a?.status).toBe('ok');
    });
  });

  /*
   * THE DEFECT THIS FEATURE HAD TO NOT REPEAT.
   *
   * `image-convert` declares `types: ['bytes']` on its only input. The canvas
   * drew an editor for every unwired input port without asking what the port
   * accepted, so that one got a textarea whose every keystroke was ignored:
   * the engine's preflight blocks a required bytes port with no wire whatever
   * the box contains, so the node sat blocked forever with an editor under it
   * inviting another attempt. The tool runner had the same bug and at least
   * reported a type error. This one said nothing at all.
   *
   * The README notes this codebase has shipped that pattern five times.
   */
  it('gives no editor to a port that cannot accept text', async () => {
    const user = userEvent.setup();
    seed([node('a', 'image-convert')]);
    renderCanvas();
    select('a');
    const panel = await openInspector(user);

    expect(within(panel).queryByRole('textbox', { name: /Image input/ })).toBeNull();
    // The port's own description is promoted from placeholder to instruction,
    // which is the same fix the tool runner made. Matched exactly rather than
    // loosely: the format select below it also says "WebP", and a pattern that
    // catches both would pass for the wrong reason.
    expect(
      within(panel).getByText('A PNG, JPEG, GIF or WebP file. The format is read from the bytes.'),
    ).toBeInTheDocument();
  });

  /*
   * A wire wins over typed text everywhere else in the engine, so drawing a
   * box whose contents the run would ignore is the same defect in a different
   * costume. It says what is feeding the port instead.
   */
  it('names the source of a wired port instead of offering an editor', async () => {
    const user = userEvent.setup();
    seed(
      [node('a', 'base64'), node('b', 'hash', 400)],
      [{ id: 'e1', from: { nodeId: 'a', portId: 'output' }, to: { nodeId: 'b', portId: 'input' } }],
    );
    renderCanvas();
    select('b');
    const panel = await openInspector(user);

    expect(within(panel).getByText(/Wired from Base64 · Output/)).toBeInTheDocument();
    expect(within(panel).queryByRole('textbox', { name: /Hash input/ })).toBeNull();
  });
});

/* ========================================================================== *
 * Options
 * ========================================================================== */

describe('options', () => {
  it('draws the tool’s own fields', async () => {
    const user = userEvent.setup();
    seed([node('a', 'hash')]);
    renderCanvas();
    select('a');
    const panel = await openInspector(user);

    await waitFor(() => {
      expect(within(panel).getByText('Algorithm')).toBeInTheDocument();
    });
    expect(within(panel).getByText('Output encoding')).toBeInTheDocument();
  });

  /*
   * A node stores `{}` and the engine fills the gaps by parsing through the
   * tool's Zod schema - so a node really does run on its defaults. A control
   * handed `undefined` draws itself empty, which says the option has no value
   * when it has the default one.
   */
  it('shows the tool’s defaults for a node that has set nothing', async () => {
    const user = userEvent.setup();
    seed([node('a', 'hash')]);
    renderCanvas();
    select('a');
    const panel = await openInspector(user);

    await waitFor(() => {
      expect(within(panel).getByRole('combobox', { name: /Algorithm/ })).toHaveTextContent(
        'SHA-256',
      );
    });
  });

  /*
   * An option change is an ordinary graph edit, so it goes down the path
   * everything else does: the store updates the document, the effect watching
   * the graph schedules a run, and that schedule is the existing 300ms
   * debounce. Nothing here re-runs the pipeline itself - a second trigger
   * would be a second thing to keep in step with the debounce.
   */
  it('changing one edits the node and re-runs the pipeline', async () => {
    const user = userEvent.setup();
    const seen: unknown[] = [];
    usePipelineStore.setState({
      execute: (options) => {
        seen.push(options.options);
        return Promise.resolve<ToolResult<ToolOutputs>>({
          ok: true,
          value: { output: { type: 'text', text: 'abc' } },
        });
      },
    });

    seed([node('a', 'hash', 0, 0, { inputs: { input: 'hello' } })]);
    renderCanvas();
    select('a');
    const panel = await openInspector(user);

    await waitFor(() => {
      expect(within(panel).getByRole('combobox', { name: /Output encoding/ })).toBeInTheDocument();
    });
    await user.click(within(panel).getByRole('combobox', { name: /Output encoding/ }));
    await user.click(await screen.findByRole('option', { name: 'Base64' }));

    expect(useCanvasStore.getState().graph.nodes.a?.options.encoding).toBe('base64');
    await waitFor(() => {
      expect(seen.at(-1)).toMatchObject({ encoding: 'base64' });
    });
  });

  /*
   * TYPING IS ONE UNDO STEP, NOT FORTY.
   *
   * Options are part of the document here, unlike on the tool page where they
   * are component state - so without coalescing, typing a regex pattern buries
   * whatever the user actually wants to undo under a history of their own
   * keystrokes. The merge keeps the OLDER `from`, so one undo returns to the
   * value before the run of edits began.
   */
  it('merges consecutive typing into one undo step', async () => {
    const user = userEvent.setup();
    seed([node('a', 'regex-tester')]);
    renderCanvas();
    select('a');
    const panel = await openInspector(user);

    await waitFor(() => {
      expect(within(panel).getByRole('textbox', { name: /Pattern/ })).toBeInTheDocument();
    });
    await user.type(within(panel).getByRole('textbox', { name: /Pattern/ }), '\\d+');

    expect(useCanvasStore.getState().graph.nodes.a?.options.pattern).toBe('\\d+');
    expect(useCanvasStore.getState().past).toHaveLength(1);

    act(() => {
      useCanvasStore.getState().undo();
    });
    expect(useCanvasStore.getState().graph.nodes.a?.options.pattern).toBeUndefined();
  });

  /*
   * A toggle or a select is a single deliberate act and keeps its own step.
   * The line is drawn on the CONTROL rather than on timing, because a control
   * is a fact and a pause is a guess.
   */
  it('does not merge a discrete choice into the typing before it', async () => {
    const user = userEvent.setup();
    seed([node('a', 'regex-tester')]);
    renderCanvas();
    select('a');
    const panel = await openInspector(user);

    await waitFor(() => {
      expect(within(panel).getByRole('textbox', { name: /Pattern/ })).toBeInTheDocument();
    });
    await user.type(within(panel).getByRole('textbox', { name: /Pattern/ }), 'ab');
    await user.click(within(panel).getByRole('switch', { name: /Ignore case/i }));

    expect(useCanvasStore.getState().past).toHaveLength(2);
  });
});

/* ========================================================================== *
 * Output
 * ========================================================================== */

describe('output', () => {
  it('shows the result of the node, through the runner’s own views', async () => {
    const user = userEvent.setup();
    usePipelineStore.setState({
      execute: succeedsWith({ output: { type: 'text', text: 'deadbeef' } }),
    });
    seed([node('a', 'hash', 0, 0, { inputs: { input: 'hello' } })]);
    renderCanvas();
    select('a');
    const panel = await openInspector(user);

    await waitFor(() => {
      expect(within(panel).getByRole('textbox', { name: 'Hash Digest' })).toHaveValue('deadbeef');
    });
  });

  /*
   * The port's `presentation` hint reaches the view unchanged, so the regex
   * report is drawn as matches rather than as a wall of braces - and the Raw
   * toggle beside it is the runner's one implementation of that rule rather
   * than a second copy living on the canvas.
   */
  it('honours the port’s presentation hint', async () => {
    const user = userEvent.setup();
    usePipelineStore.setState({
      execute: succeedsWith({
        output: { type: 'text', text: '42' },
        matches: {
          type: 'json',
          data: {
            pattern: '\\d+',
            flags: 'g',
            mode: 'match',
            count: 1,
            listed: 1,
            matches: [{ index: 0, line: 1, column: 1, match: '42', empty: false, groups: [] }],
            segments: [{ text: '42', match: 0 }],
            notes: [],
          },
        },
      }),
    });
    seed([node('a', 'regex-tester', 0, 0, { inputs: { input: 'x42' } })]);
    renderCanvas();
    select('a');
    const panel = await openInspector(user);

    await waitFor(() => {
      expect(within(panel).getByRole('group', { name: 'Regex Matches view' })).toBeInTheDocument();
    });
    expect(within(panel).getByRole('button', { name: 'Raw' })).toBeInTheDocument();
  });

  /*
   * A RUNNING NODE SAYS SO rather than showing its previous answer. Keeping the
   * last result on screen would mean showing the answer to a question the user
   * has already changed, and the only case where it lasts long enough to
   * notice - a slow tool - is the case where saying "running" is the truth.
   */
  it('says a node is running rather than showing its last answer', async () => {
    const user = userEvent.setup();
    let release = (): void => undefined;
    usePipelineStore.setState({
      execute: () =>
        new Promise<ToolResult<ToolOutputs>>((resolve) => {
          release = () => {
            resolve({ ok: true, value: { output: { type: 'text', text: 'done' } } });
          };
        }),
    });

    seed([node('a', 'hash', 0, 0, { inputs: { input: 'hello' } })]);
    renderCanvas();
    select('a');
    const panel = await openInspector(user);

    await waitFor(() => {
      expect(within(panel).getByText('Running…')).toBeInTheDocument();
    });

    act(() => {
      release();
    });
    await waitFor(() => {
      expect(within(panel).getByRole('textbox', { name: 'Hash Digest' })).toHaveValue('done');
    });
  });

  it('shows a failure where the result would be', async () => {
    const user = userEvent.setup();
    usePipelineStore.setState({
      execute: () =>
        Promise.resolve<ToolResult<ToolOutputs>>({
          ok: false,
          error: { code: 'invalid-input', message: 'Not usable.' },
        }),
    });
    seed([node('a', 'hash', 0, 0, { inputs: { input: 'hello' } })]);
    renderCanvas();
    select('a');
    const panel = await openInspector(user);

    await waitFor(() => {
      expect(within(panel).getByText('Not usable.')).toBeInTheDocument();
    });
  });
});

/* ========================================================================== *
 * A node summary, so a chain reads at a glance
 * ========================================================================== */

describe('the node’s own summary', () => {
  /*
   * The point of the panel is that a node does not have to carry a result. The
   * point of this line is that you should not have to open the panel to know
   * whether the chain did what you expected.
   */
  it('replaces the tool description once the node has run', async () => {
    usePipelineStore.setState({
      execute: succeedsWith({ output: { type: 'text', text: 'deadbeef' } }),
    });
    seed([node('a', 'hash', 0, 0, { inputs: { input: 'hello' } })]);
    renderCanvas();

    await waitFor(() => {
      expect(screen.getByTestId('node-a')).toHaveTextContent('deadbeef');
    });
    expect(screen.getByTestId('node-a')).not.toHaveTextContent('MD5 and the SHA family');
  });

  /*
   * A chain scannable by eye and not by ear is not a chain a keyboard user can
   * follow, so the summary is in the accessible name as well as on screen.
   */
  it('is part of the node’s accessible name', async () => {
    usePipelineStore.setState({
      execute: succeedsWith({ output: { type: 'text', text: 'deadbeef' } }),
    });
    seed([node('a', 'hash', 0, 0, { inputs: { input: 'hello' } })]);
    renderCanvas();

    await waitFor(() => {
      expect(screen.getByRole('group', { name: /deadbeef/ })).toBeInTheDocument();
    });
  });
});

/* ========================================================================== *
 * The keyboard
 * ========================================================================== */

describe('the keyboard path', () => {
  /*
   * Enter used to step into the node's own input editor. The editor moved, so
   * Enter follows it - same key, same intent - which is why the inspector
   * needs no separate "open on this node" affordance for the keyboard.
   */
  it('opens the inspector on the focused node and moves into it', async () => {
    const user = userEvent.setup();
    seed([node('a', 'hash')]);
    renderCanvas();

    screen.getByTestId('node-a').focus();
    await user.keyboard('{Enter}');

    const panel = await screen.findByTestId('node-inspector');
    expect(useCanvasStore.getState().selection.nodes).toEqual(['a']);
    await waitFor(() => {
      expect(panel.contains(document.activeElement)).toBe(true);
    });
  });

  /*
   * INTO THE EDITOR, NOT INTO THE CLOSE BUTTON.
   *
   * The assertion above - "focus is somewhere in the panel" - was true of the
   * bug it was meant to cover. `querySelector` returns the first element
   * matching ANY selector in a list, in document order, and the panel's header
   * holds the close button, so "the first thing in the inspector that takes
   * focus" was the button that shuts it. Enter announced itself as stepping
   * into the node's input; a user who pressed it and typed got nothing, and
   * their next Space closed the panel.
   *
   * It is also asserted synchronously - no `waitFor`. The move used to be
   * deferred to an animation frame, and a deferred focus move is a focus move
   * that lands in the middle of whatever the user did next: text typed into
   * the editor during that window goes to the button and is discarded, which
   * is how `check:browsers` came to fail one worker-wedge run in three. Focus
   * settles in the same task as the keystroke, so a test that has to wait for
   * it is a test that would pass on the deferred version too.
   */
  it('puts focus in the input editor, in the same task as the keystroke', async () => {
    const user = userEvent.setup();
    seed([node('a', 'hash')]);
    renderCanvas();

    screen.getByTestId('node-a').focus();
    await user.keyboard('{Enter}');

    const panel = screen.getByTestId('node-inspector');
    expect(document.activeElement).toBe(within(panel).getByRole('textbox', { name: 'Hash input' }));
  });

  /*
   * A node whose only input port cannot carry text has no editor - it gets a
   * sentence telling you to wire something into it - so Enter has to land on
   * something rather than nowhere. Image convert is that node: its input is
   * `bytes`.
   */
  it('falls back to the first control when the node has no text editor', async () => {
    const user = userEvent.setup();
    seed([node('a', 'image-convert')]);
    renderCanvas();

    screen.getByTestId('node-a').focus();
    await user.keyboard('{Enter}');

    const panel = screen.getByTestId('node-inspector');
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(within(panel).queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('returns to the node on Escape', async () => {
    const user = userEvent.setup();
    seed([node('a', 'hash')]);
    renderCanvas();
    select('a');
    const panel = await openInspector(user);

    within(panel).getByRole('textbox', { name: 'Hash input' }).focus();
    await user.keyboard('{Escape}');

    expect(document.activeElement).toBe(screen.getByTestId('node-a'));
  });

  /*
   * The canvas root is a `role="application"` region that claims every single
   * letter. The panel is a SIBLING of it rather than a child, so a keystroke
   * meant for a field can never reach the canvas's handler - which is what
   * stops "k" opening the palette out of the middle of somebody's regex.
   */
  it('does not let the canvas claim letters typed into a field', async () => {
    const user = userEvent.setup();
    seed([node('a', 'hash')]);
    renderCanvas();
    select('a');
    const panel = await openInspector(user);

    await user.type(within(panel).getByRole('textbox', { name: 'Hash input' }), 'kick');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(useCanvasStore.getState().graph.nodes.a?.inputs.input).toBe('kick');
  });

  /*
   * The ARIA window-splitter pattern: a focusable separator with a value and
   * arrow keys that change it. A handle only a pointer can move is a
   * preference only a pointer user has, and the reason it is resizable at all
   * is that a diff wants more width than a colour swatch does.
   */
  it('resizes the rail from the keyboard', async () => {
    withRail();
    const user = userEvent.setup();
    seed([node('a', 'hash')]);
    renderCanvas();

    const handle = screen.getByTestId('inspector-handle');
    const before = Number(handle.getAttribute('aria-valuenow'));

    handle.focus();
    await user.keyboard('{ArrowLeft}');
    expect(Number(handle.getAttribute('aria-valuenow'))).toBeGreaterThan(before);

    await user.keyboard('{End}');
    expect(handle.getAttribute('aria-valuenow')).toBe(handle.getAttribute('aria-valuemin'));
  });

  it('has no handle where there is no rail to size', async () => {
    const user = userEvent.setup();
    seed([node('a', 'hash')]);
    renderCanvas();
    await openInspector(user);

    expect(screen.queryByTestId('inspector-handle')).not.toBeInTheDocument();
  });
});

/* ========================================================================== *
 * The node goes away while you are working on it
 * ========================================================================== */

describe('when the inspected node stops existing', () => {
  /*
   * Deleting from the canvas already returns focus to the root, because the
   * key that did it was handled there. Every other route out - undo, a share
   * link replacing the graph, a redo that removes the node again - runs while
   * focus is INSIDE the panel, and an element that unmounts under focus drops
   * it to <body>, where none of the canvas's keys work and nothing says why.
   */
  it('hands focus back to the canvas and says so', async () => {
    const user = userEvent.setup();
    seed([node('a', 'hash')]);
    renderCanvas();
    select('a');
    const panel = await openInspector(user);
    within(panel).getByRole('textbox', { name: 'Hash input' }).focus();

    act(() => {
      useCanvasStore.getState().deleteSelection();
    });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('canvas-root'));
    });
    expect(screen.getByTestId('node-inspector')).toHaveTextContent(/Nothing on the canvas yet/);
  });

  it('leaves focus alone when the node was deleted from the canvas', async () => {
    const user = userEvent.setup();
    seed([node('a', 'hash')]);
    renderCanvas();
    select('a');
    await openInspector(user);

    const root = screen.getByTestId('canvas-root');
    root.focus();
    await user.keyboard('{Delete}');

    expect(document.activeElement).toBe(root);
  });
});

/* ========================================================================== *
 * Accessibility
 * ========================================================================== */

describe('accessibility', () => {
  it('has no axe violations showing a node', async () => {
    const user = userEvent.setup();
    usePipelineStore.setState({
      execute: succeedsWith({ output: { type: 'text', text: 'deadbeef' } }),
    });
    seed([node('a', 'hash', 0, 0, { inputs: { input: 'hello' } })]);
    const { container } = renderCanvas();
    select('a');
    const panel = await openInspector(user);

    await waitFor(() => {
      expect(within(panel).getByText('Algorithm')).toBeInTheDocument();
    });
    await expectNoAxeViolations(container);
  });

  it('has no axe violations as a docked rail', async () => {
    withRail();
    seed([node('a', 'hash')]);
    const { container } = renderCanvas();
    select('a');

    await waitFor(() => {
      expect(screen.getByTestId('inspector-handle')).toBeInTheDocument();
    });
    await expectNoAxeViolations(container);
  });
});
