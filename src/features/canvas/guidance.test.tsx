import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import { TOOL_MANIFEST } from '@/features/registry';

import { Canvas } from './Canvas';
import { useCanvasStore } from './graphStore';
import { EMPTY_GRAPH, type CanvasEdge, type CanvasNode } from './types';
import { DEFAULT_VIEWPORT, useViewportStore } from './viewportStore';

/**
 * NODE GUIDANCE
 *
 * A blocked node used to read "Needs input", which is true and useless, and
 * the sentence that replaced it ran to three lines in a box sized for two and
 * was cut mid-word: "…output into the".
 *
 * Worse, whether a node got the sentence at all depended on how many wires
 * happened to touch it, so two nodes blocked for the identical reason showed
 * different text. The rule is now about WHY a node is blocked, and these
 * tests pin both halves: same state, same words; short enough to fit.
 */

/**
 * How many characters fit on one line of the summary box.
 *
 * The node is 224px wide with 1px borders and 4px padding, and the label font
 * is IBM Plex Mono at 10px, whose advance is 0.6em. jsdom cannot measure any
 * of that, so it is derived here and the REAL measurement is done in
 * scripts/cross-browser-check.mjs.
 */
const SUMMARY_CHARS_PER_LINE = Math.floor((224 - 2 - 8) / 6);
const SUMMARY_MAX_CHARS = SUMMARY_CHARS_PER_LINE * 2;

function node(id: string, toolId: CanvasNode['toolId'], x = 0, y = 0): CanvasNode {
  return { id, toolId, position: { x, y }, options: {}, inputs: {} };
}

function seed(nodes: readonly CanvasNode[], edges: readonly CanvasEdge[] = []): void {
  useCanvasStore.setState({
    graph: {
      nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
      nodeOrder: nodes.map((n) => n.id),
      edges: Object.fromEntries(edges.map((e) => [e.id, e])),
      edgeOrder: edges.map((e) => e.id),
      nextId: nodes.length + edges.length + 1,
    },
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

function summaryOf(nodeId: string): string {
  const element = screen
    .getByTestId(`node-${nodeId}`)
    .querySelector<HTMLElement>('[class*="nodeSummary"]');
  if (!element) throw new Error(`no summary on ${nodeId}`);
  return element.textContent;
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

describe('what a blocked node says', () => {
  it('tells a text input to type or to wire, naming the port', async () => {
    seed([node('a', 'structured-data')]);
    renderCanvas();

    await waitFor(() => {
      expect(summaryOf('a')).toMatch(/Type below, or wire an output into Document\./);
    });
  });

  it('tells a bytes-only input to wire, since typing cannot satisfy it', async () => {
    seed([node('a', 'image-convert')]);
    renderCanvas();

    await waitFor(() => {
      // No "type below": the port takes bytes, and there is no editor for it.
      expect(summaryOf('a')).toBe('Wire an output into Image.');
    });
  });

  it('names the specific port on a tool with more than one input', async () => {
    seed([node('a', 'diff')]);
    renderCanvas();

    await waitFor(() => {
      expect(summaryOf('a')).toContain('Original');
    });
  });

  it('says the terse status when the reason is upstream, not the user', async () => {
    seed(
      [node('a', 'structured-data'), node('b', 'base64', 400, 0)],
      [{ id: 'e1', from: { nodeId: 'a', portId: 'output' }, to: { nodeId: 'b', portId: 'input' } }],
    );
    renderCanvas();

    await waitFor(() => {
      // `b` is not waiting on the user; telling it to type would be wrong.
      expect(summaryOf('b')).toBe('Waiting upstream');
    });
  });
});

describe('the same state says the same thing', () => {
  it('does not change its guidance because an unrelated wire exists', async () => {
    /*
     * `a` and `c` are both structured-data with an empty required input. `c`
     * additionally has its OUTPUT wired onward, which is nothing to do with
     * why it is blocked - but the old rule keyed on the node's total wire
     * count, so `c` got "Needs input" while `a` got the full sentence.
     */
    seed(
      [
        node('a', 'structured-data'),
        node('c', 'structured-data', 0, 400),
        node('b', 'base64', 400, 400),
      ],
      [{ id: 'e1', from: { nodeId: 'c', portId: 'output' }, to: { nodeId: 'b', portId: 'input' } }],
    );
    renderCanvas();

    // Waited on individually: the pipeline settles each node as it gets to
    // it, so asserting on `c` off the back of `a` racing ahead is flaky.
    await waitFor(() => {
      expect(summaryOf('a')).toContain('wire an output into');
      expect(summaryOf('c')).toContain('wire an output into');
    });
    expect(summaryOf('c')).toBe(summaryOf('a'));
  });

  it('gives every blocked-on-empty-input node the same shape of sentence', async () => {
    seed([
      node('a', 'structured-data'),
      node('b', 'diff', 400, 0),
      node('c', 'regex-tester', 0, 400),
    ]);
    renderCanvas();

    await waitFor(() => {
      for (const id of ['a', 'b', 'c']) {
        expect(summaryOf(id)).toMatch(/^Type below, or wire an output into .+\.$/);
      }
    });
  });
});

describe('guidance fits the node', () => {
  /*
   * The reason this is a test and not a comment: the string is built from a
   * port label, so a tool added later with a long label could push it over
   * without anyone noticing until it is cut mid-word again.
   */
  it.each(
    TOOL_MANIFEST.filter((entry) => entry.inputs.length > 0).map((entry) => [entry.id] as const),
  )('stays inside two lines for %s', async (toolId) => {
    seed([node('a', toolId)]);
    renderCanvas();

    await waitFor(() => {
      expect(summaryOf('a').length).toBeGreaterThan(0);
    });
    expect(summaryOf('a').length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
  });

  it('leaves room even for the longest label any tool declares', () => {
    const labels: readonly string[] = TOOL_MANIFEST.flatMap((entry) =>
      entry.inputs.map((port) => port.label),
    );
    const longest = labels.reduce(
      (worst, label) => (label.length > worst.length ? label : worst),
      '',
    );

    expect(`Type below, or wire an output into ${longest}.`.length).toBeLessThanOrEqual(
      SUMMARY_MAX_CHARS,
    );
  });
});

describe('the node summary when nothing is wrong', () => {
  it('shows the tool summary rather than guidance', async () => {
    seed([node('a', 'base64')]);
    renderCanvas();

    // base64 takes text and has an editor, so it is blocked and guided...
    await waitFor(() => {
      expect(summaryOf('a')).toContain('wire an output into');
    });

    // ...but once it has input, the summary is the tool's own description.
    useCanvasStore.getState().setNodeInput('a', 'input', 'aGk=');
    await waitFor(() => {
      expect(summaryOf('a')).not.toContain('wire an output into');
    });
  });

  it('keeps the accessible name in step with the visible text', async () => {
    seed([node('a', 'structured-data')]);
    renderCanvas();

    const group = await screen.findByRole('group', { name: /Structured data/ });
    // The blocked reason is part of the name; the guidance is the visible
    // elaboration of it. Both must be present, neither may contradict.
    expect(group).toHaveAccessibleName(/blocked/);
    expect(within(group).getByText(/wire an output into/)).toBeInTheDocument();
  });
});
