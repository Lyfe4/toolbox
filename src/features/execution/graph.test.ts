import { describe, expect, it, vi } from 'vitest';

import type { CanvasNode, GraphData, NodeId } from '@/features/canvas/types';
import { ok, fail, type ToolOutputs, type ToolResult } from '@/features/registry/types';

import {
  CycleError,
  nodeCacheKey,
  runPipeline,
  topologicalOrder,
  type PipelineCache,
} from './graph';

import type { ExecuteOptions } from './engine';

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

type ToolName = 'base64' | 'structured-data' | 'hash';

function node(
  id: string,
  toolId: ToolName,
  input = '',
  options: Record<string, unknown> = {},
): CanvasNode {
  return { id, toolId, position: { x: 0, y: 0 }, options, input };
}

function graphOf(
  nodes: readonly CanvasNode[],
  wires: readonly (readonly [string, string, string?, string?])[] = [],
): GraphData {
  const edges: GraphData['edges'] = {};
  const edgeOrder: string[] = [];

  wires.forEach(([from, to, fromPort = 'output', toPort = 'input'], index) => {
    const id = `e${index.toString()}`;
    edgeOrder.push(id);
    Object.assign(edges, {
      [id]: { id, from: { nodeId: from, portId: fromPort }, to: { nodeId: to, portId: toPort } },
    });
  });

  return {
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    nodeOrder: nodes.map((n) => n.id),
    edges,
    edgeOrder,
    nextId: nodes.length + 1,
  };
}

/** Records every execute call and returns a deterministic output. */
function recordingExecutor(
  behaviour: (options: ExecuteOptions) => ToolResult<ToolOutputs> = () =>
    ok({ output: { type: 'text', text: 'out' } }),
) {
  const calls: ExecuteOptions[] = [];
  const execute = vi.fn(async (options: ExecuteOptions): Promise<ToolResult<ToolOutputs>> => {
    calls.push(options);
    await Promise.resolve();
    return behaviour(options);
  });
  return { execute, calls, ids: (): NodeId[] => calls.map((call) => call.toolId) };
}

/* ========================================================================== *
 * Topological order
 * ========================================================================== */

describe('topologicalOrder', () => {
  it('orders a linear chain', () => {
    const graph = graphOf(
      [node('c', 'hash'), node('a', 'base64', 'x'), node('b', 'structured-data')],
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
    );
    expect(topologicalOrder(graph)).toEqual(['a', 'b', 'c']);
  });

  it('puts both sides of a diamond before the join', () => {
    const graph = graphOf(
      [
        node('a', 'structured-data', 'x'),
        node('b', 'hash'),
        node('c', 'base64'),
        node('d', 'hash'),
      ],
      [
        ['a', 'b'],
        ['a', 'c', 'data'],
        ['b', 'd'],
      ],
    );
    const order = topologicalOrder(graph);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
  });

  it('keeps unconnected nodes', () => {
    const graph = graphOf([node('a', 'base64', 'x'), node('b', 'hash', 'y')]);
    expect([...topologicalOrder(graph)].toSorted()).toEqual(['a', 'b']);
  });

  it('throws loudly on a cycle rather than running a subset', () => {
    // checkConnection refuses to build this, so reaching the executor with one
    // means a bug - and silently executing part of the graph would hide it.
    const graph = graphOf(
      [node('a', 'base64'), node('b', 'hash')],
      [
        ['a', 'b'],
        ['b', 'a'],
      ],
    );
    expect(() => topologicalOrder(graph)).toThrow(CycleError);
    expect(() => topologicalOrder(graph)).toThrow(/cycle/i);
  });
});

/* ========================================================================== *
 * Blocked, not failed
 * ========================================================================== */

describe('blocked nodes', () => {
  it('marks a node with no input and no wire as blocked, not errored', async () => {
    const { execute } = recordingExecutor();
    const graph = graphOf([node('a', 'base64', '')]);

    const summary = await runPipeline(graph, { execute });

    expect(summary.states.a?.status).toBe('blocked');
    expect(summary.states.a?.blockedReason).toBe('Needs input');
    expect(summary.states.a?.error).toBeNull();
    expect(summary.blocked).toBe(1);
    // A blocked node is not an attempt that failed; nothing ran.
    expect(execute).not.toHaveBeenCalled();
  });

  it('runs once the input is typed', async () => {
    const { execute } = recordingExecutor();
    const summary = await runPipeline(graphOf([node('a', 'base64', 'hello')]), { execute });

    expect(summary.states.a?.status).toBe('ok');
    expect(summary.ran).toBe(1);
  });

  it('blocks a downstream node while its source is blocked', async () => {
    const { execute } = recordingExecutor();
    const graph = graphOf([node('a', 'base64', ''), node('b', 'hash')], [['a', 'b']]);

    const summary = await runPipeline(graph, { execute });

    expect(summary.states.a?.status).toBe('blocked');
    expect(summary.states.b?.status).toBe('blocked');
    expect(summary.states.b?.blockedReason).toBe('Waiting upstream');
    expect(execute).not.toHaveBeenCalled();
  });
});

/* ========================================================================== *
 * Data flow
 * ========================================================================== */

describe('data flow', () => {
  it('feeds each node the output of the one before it', async () => {
    const { execute, calls } = recordingExecutor((options) =>
      ok({ output: { type: 'text', text: `${options.toolId}!` } }),
    );

    const graph = graphOf([node('a', 'base64', 'seed'), node('b', 'hash')], [['a', 'b']]);
    await runPipeline(graph, { execute });

    expect(calls).toHaveLength(2);
    // The source node got its typed-in text...
    expect(calls[0]?.inputs.input).toEqual({ type: 'text', text: 'seed' });
    // ...and the second got the first's output, not the typed text.
    expect(calls[1]?.inputs.input).toEqual({ type: 'text', text: 'base64!' });
  });

  it('borrows binary values so one output can feed two inputs intact', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const seen: number[][] = [];

    const execute = vi.fn(async (options: ExecuteOptions): Promise<ToolResult<ToolOutputs>> => {
      await Promise.resolve();
      const value = options.inputs.input;
      if (value?.type === 'bytes') seen.push(Array.from(value.bytes));
      if (options.toolId === 'base64') {
        return ok({ output: { type: 'bytes', bytes, mediaType: null, filename: null } });
      }
      return ok({ digest: { type: 'text', text: 'digest' } });
    });

    // One source fanning out to two consumers.
    const graph = graphOf(
      [node('src', 'base64', 'seed'), node('h1', 'hash'), node('h2', 'hash')],
      [
        ['src', 'h1'],
        ['src', 'h2'],
      ],
    );

    const summary = await runPipeline(graph, { execute });

    expect(summary.failed).toBe(0);
    // Both consumers saw the same four bytes; neither got a detached view.
    expect(seen).toEqual([
      [1, 2, 3, 4],
      [1, 2, 3, 4],
    ]);
    for (const call of execute.mock.calls) {
      expect(call[0].ownership).toBe('borrow');
    }
  });
});

/* ========================================================================== *
 * Caching and incremental re-execution
 * ========================================================================== */

describe('result cache', () => {
  it('does not re-run an upstream node when only a downstream one changed', async () => {
    const { execute, calls } = recordingExecutor();
    const cache: PipelineCache = new Map();

    const first = graphOf([node('a', 'base64', 'seed'), node('b', 'hash')], [['a', 'b']]);
    await runPipeline(first, { execute, cache });
    expect(calls).toHaveLength(2);

    // Change ONLY node b's options.
    const second = graphOf(
      [node('a', 'base64', 'seed'), node('b', 'hash', '', { algorithm: 'md5' })],
      [['a', 'b']],
    );
    const summary = await runPipeline(second, { execute, cache });

    // The upstream node was served from cache and never executed again.
    expect(calls).toHaveLength(3);
    expect(calls[2]?.toolId).toBe('hash');
    expect(summary.cached).toBe(1);
    expect(summary.ran).toBe(1);
    expect(summary.states.a?.status).toBe('ok');
  });

  it('re-runs a node and everything downstream of it when it changes', async () => {
    const { execute, calls } = recordingExecutor();
    const cache: PipelineCache = new Map();

    const first = graphOf(
      [node('a', 'base64', 'seed'), node('b', 'structured-data'), node('c', 'hash')],
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
    );
    await runPipeline(first, { execute, cache });
    expect(calls).toHaveLength(3);

    // Editing the source invalidates its key, and therefore both descendants.
    const second = graphOf(
      [node('a', 'base64', 'edited'), node('b', 'structured-data'), node('c', 'hash')],
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
    );
    const summary = await runPipeline(second, { execute, cache });

    expect(calls).toHaveLength(6);
    expect(summary.cached).toBe(0);
    expect(summary.ran).toBe(3);
  });

  it('serves an entirely unchanged graph from cache', async () => {
    const { execute, calls } = recordingExecutor();
    const cache: PipelineCache = new Map();
    const graph = graphOf([node('a', 'base64', 'seed'), node('b', 'hash')], [['a', 'b']]);

    await runPipeline(graph, { execute, cache });
    const summary = await runPipeline(graph, { execute, cache });

    expect(calls).toHaveLength(2);
    expect(summary.cached).toBe(2);
    expect(summary.ran).toBe(0);
  });

  it('keys on options regardless of their key order', () => {
    const a = nodeCacheKey(node('a', 'hash', 'x', { algorithm: 'md5', encoding: 'hex' }), []);
    const b = nodeCacheKey(node('a', 'hash', 'x', { encoding: 'hex', algorithm: 'md5' }), []);
    expect(a).toBe(b);
  });

  it('changes its key when an upstream key changes', () => {
    const n = node('b', 'hash');
    expect(nodeCacheKey(n, ['aaaa'])).not.toBe(nodeCacheKey(n, ['bbbb']));
  });
});

/* ========================================================================== *
 * Failure propagation
 * ========================================================================== */

describe('failure propagation', () => {
  it('shows the error only on the node that failed', async () => {
    const execute = vi.fn(async (options: ExecuteOptions): Promise<ToolResult<ToolOutputs>> => {
      await Promise.resolve();
      if (options.toolId === 'base64') return fail('parse-error', 'Not valid base64.');
      return ok({ output: { type: 'text', text: 'out' } });
    });

    const graph = graphOf(
      [node('a', 'base64', 'seed'), node('b', 'hash'), node('c', 'structured-data')],
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
    );

    const summary = await runPipeline(graph, { execute });

    expect(summary.states.a?.status).toBe('error');
    expect(summary.states.a?.error?.message).toBe('Not valid base64.');

    // Descendants are a DISTINCT state, not a copy of the original error.
    expect(summary.states.b?.status).toBe('upstream-failed');
    expect(summary.states.b?.error).toBeNull();
    expect(summary.states.c?.status).toBe('upstream-failed');

    // Both point back at the node that actually failed, not at their parent.
    expect(summary.states.b?.failedUpstream).toBe('a');
    expect(summary.states.c?.failedUpstream).toBe('a');

    // Neither descendant was executed.
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('leaves an independent branch alone when another fails', async () => {
    const execute = vi.fn(async (options: ExecuteOptions): Promise<ToolResult<ToolOutputs>> => {
      await Promise.resolve();
      if (options.options && (options.options as { boom?: boolean }).boom === true) {
        return fail('internal', 'boom');
      }
      return ok({ output: { type: 'text', text: 'out' } });
    });

    const graph = graphOf([node('bad', 'base64', 'x', { boom: true }), node('good', 'hash', 'y')]);

    const summary = await runPipeline(graph, { execute });

    expect(summary.states.bad?.status).toBe('error');
    expect(summary.states.good?.status).toBe('ok');
    expect(summary.failed).toBe(1);
  });
});

/* ========================================================================== *
 * Concurrency, cancellation and caps
 * ========================================================================== */

describe('scheduling', () => {
  it('never exceeds the concurrency bound', async () => {
    let active = 0;
    let peak = 0;

    const execute = vi.fn(async (): Promise<ToolResult<ToolOutputs>> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return ok({ output: { type: 'text', text: 'out' } });
    });

    // Twelve independent nodes, all ready at once.
    const nodes = Array.from({ length: 12 }, (_, index) =>
      node(`n${index.toString()}`, 'hash', 'x'),
    );
    const summary = await runPipeline(graphOf(nodes), { execute, concurrency: 3 });

    expect(summary.ran).toBe(12);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('stops scheduling once cancelled', async () => {
    const controller = new AbortController();
    let started = 0;

    const execute = vi.fn(async (): Promise<ToolResult<ToolOutputs>> => {
      started += 1;
      if (started === 1) controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 1));
      return ok({ output: { type: 'text', text: 'out' } });
    });

    const nodes = Array.from({ length: 10 }, (_, index) =>
      node(`n${index.toString()}`, 'hash', 'x'),
    );
    const summary = await runPipeline(graphOf(nodes), {
      execute,
      concurrency: 1,
      signal: controller.signal,
    });

    expect(summary.cancelled).toBe(true);
    expect(started).toBeLessThan(10);
  });

  it('refuses to run a graph beyond the node cap rather than wedging the tab', async () => {
    const { execute } = recordingExecutor();
    const nodes = Array.from({ length: 12 }, (_, index) =>
      node(`n${index.toString()}`, 'hash', 'x'),
    );

    const summary = await runPipeline(graphOf(nodes), { execute, maxNodes: 5 });

    expect(execute).not.toHaveBeenCalled();
    expect(summary.blocked).toBe(12);
    expect(summary.states.n0?.blockedReason).toMatch(/at most 5/);
  });

  it('reports timing per node', async () => {
    let clock = 0;
    const { execute } = recordingExecutor();

    const summary = await runPipeline(graphOf([node('a', 'hash', 'x')]), {
      execute,
      now: () => (clock += 5),
    });

    expect(summary.states.a?.durationMs).toBeGreaterThan(0);
  });
});
