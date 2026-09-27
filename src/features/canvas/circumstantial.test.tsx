import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import type { ExecuteOptions } from '@/features/execution/engine';
import { usePipelineStore } from '@/features/execution/pipelineStore';
import { fail, type ToolOutputs, type ToolResult } from '@/features/registry/types';
import { ErrorReport } from '@/features/toolrunner/OutputPanel';
import { EMPTY_ANNOUNCEMENTS } from '@/lib/announce';

import { Canvas } from './Canvas';
import { MAYBE_NOT_THE_INPUT } from './CanvasNodeView';
import { useCanvasStore } from './graphStore';
import { EMPTY_GRAPH, type CanvasNode, type GraphData } from './types';
import { DEFAULT_VIEWPORT, useViewportStore } from './viewportStore';

/*
 * A FAILURE THAT MAY BE THE MACHINE'S, TOLD AS ONE AND EASY TO TRY AGAIN.
 *
 * Round twenty-five kept `timeout` and `internal` failures cached, on purpose:
 * a deadline measures a tool's own work, so a timeout is overwhelmingly the
 * input's, and re-running a slow tool on every edit anywhere in the graph
 * would be worse. That is unchanged, and the first test below holds it. What
 * was wrong is what the cached answer said: a timeout on a busy machine read,
 * and stayed, exactly like a permanent fact about the document. So the
 * engine's own failures carry `circumstantial`, the face says "Maybe not the
 * input", the inspector says why, and Run again forgets exactly one cache
 * entry.
 */

function node(id: string, toolId: CanvasNode['toolId'], text: string): CanvasNode {
  return {
    id,
    toolId,
    position: { x: 0, y: id === 'a' ? 0 : 200 },
    options: {},
    inputs: { input: text },
    fileInputs: {},
  };
}

function graphOf(nodes: readonly CanvasNode[]): GraphData {
  return {
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    nodeOrder: nodes.map((entry) => entry.id),
    edges: {},
    edgeOrder: [],
    nextId: nodes.length + 1,
  };
}

const TIMED_OUT = fail<ToolOutputs>('timeout', 'The tool took too long and was stopped.', {
  detail: 'Exceeded 2s.',
  circumstantial: true,
});
const REFUSED = fail<ToolOutputs>('invalid-input', 'That is not base64.');
const DONE: ToolResult<ToolOutputs> = { ok: true, value: { output: { type: 'text', text: 'ok' } } };

/**
 * An executor that answers by tool, and counts: the regex node times out the
 * first time it runs and succeeds after that, as a busy machine would.
 */
function counting() {
  const calls: string[] = [];
  const execute = (options: ExecuteOptions): Promise<ToolResult<ToolOutputs>> => {
    calls.push(options.toolId);
    if (options.toolId === 'regex-tester') {
      return Promise.resolve(
        calls.filter((id) => id === 'regex-tester').length === 1 ? TIMED_OUT : DONE,
      );
    }
    if (options.toolId === 'base64') return Promise.resolve(REFUSED);
    return Promise.resolve(DONE);
  };
  return { calls, execute };
}

beforeEach(() => {
  window.localStorage.clear();
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

describe('a cached failure that may be the machine’s', () => {
  it('is still cached, and Run again forgets that node alone', async () => {
    const { calls, execute } = counting();
    usePipelineStore.setState({ execute });
    const graph = graphOf([node('a', 'regex-tester', 'aaa'), node('b', 'hash', 'hello')]);

    await usePipelineStore.getState().run(graph);
    expect(usePipelineStore.getState().states.a?.status).toBe('error');
    expect(usePipelineStore.getState().states.a?.error?.circumstantial).toBe(true);
    expect(calls).toEqual(['regex-tester', 'hash']);

    // THE CACHE RULE, UNCHANGED: the same graph again runs nothing, the
    // timeout included.
    await usePipelineStore.getState().run(graph);
    expect(calls).toEqual(['regex-tester', 'hash']);
    expect(usePipelineStore.getState().states.a?.status).toBe('error');

    // Run again: exactly the one node, and the other still from the cache.
    usePipelineStore.getState().retry('a');
    await waitFor(() => {
      expect(usePipelineStore.getState().states.a?.status).toBe('ok');
    });
    expect(calls).toEqual(['regex-tester', 'hash', 'regex-tester']);
    expect(usePipelineStore.getState().summary?.cached).toBe(1);
  });

  it('says so on the node’s face and in its name, and offers Run again in the inspector', async () => {
    const { calls, execute } = counting();
    usePipelineStore.setState({ execute });
    useCanvasStore.setState({ graph: graphOf([node('a', 'regex-tester', 'aaa')]) });
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Canvas />
      </ToastProvider>,
    );

    const face = await screen.findByText(
      `${MAYBE_NOT_THE_INPUT} · The tool took too long and was stopped.`,
    );
    expect(face).toBeInTheDocument();
    expect(screen.getByTestId('node-a').getAttribute('aria-label')).toContain(
      `${MAYBE_NOT_THE_INPUT}, The tool took too long and was stopped.`,
    );

    useCanvasStore.getState().select({ nodes: ['a'], edges: [] });
    await user.click(screen.getByRole('button', { name: 'Inspector' }));
    const inspector = screen.getByTestId('node-inspector');
    expect(within(inspector).getByText(/This may not be about the input/)).toBeInTheDocument();
    expect(within(inspector).getByText(/will not be tried again by itself/)).toBeInTheDocument();

    await user.click(within(inspector).getByRole('button', { name: 'Run again' }));
    await waitFor(() => {
      expect(screen.getByTestId('node-a').getAttribute('data-status')).toBe('ok');
    });
    expect(calls.filter((id) => id === 'regex-tester')).toHaveLength(2);
  });

  it('is not said of a refusal, which is a fact about the input', async () => {
    const { execute } = counting();
    usePipelineStore.setState({ execute });
    useCanvasStore.setState({ graph: graphOf([node('a', 'base64', '!!')]) });
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Canvas />
      </ToastProvider>,
    );

    // The partner of the absences below: the refusal itself is on the face.
    expect(await screen.findByText('That is not base64.')).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(MAYBE_NOT_THE_INPUT))).not.toBeInTheDocument();

    useCanvasStore.getState().select({ nodes: ['a'], edges: [] });
    await user.click(screen.getByRole('button', { name: 'Inspector' }));
    const inspector = screen.getByTestId('node-inspector');
    expect(within(inspector).getByText('That is not base64.')).toBeInTheDocument();
    expect(within(inspector).queryByRole('button', { name: 'Run again' })).not.toBeInTheDocument();
    expect(within(inspector).queryByText(/may not be about the input/)).not.toBeInTheDocument();
  });
});

describe('ErrorReport', () => {
  it('words a timeout and an interrupted run each by what it is', () => {
    const { rerender } = render(<ErrorReport error={TIMED_OUT.ok ? never() : TIMED_OUT.error} />);
    expect(screen.getByText(/A time limit measures how long the work took/)).toBeInTheDocument();

    const interrupted = fail('internal', 'This run was interrupted before it could finish.', {
      circumstantial: true,
    });
    rerender(<ErrorReport error={interrupted.ok ? never() : interrupted.error} />);
    expect(screen.getByText(/the worker it was on was stopped, or failed/)).toBeInTheDocument();
    // No handler, no button: the sentence alone never promises an action.
    expect(screen.queryByRole('button', { name: 'Run again' })).not.toBeInTheDocument();
  });
});

function never(): never {
  throw new Error('expected a failure');
}
