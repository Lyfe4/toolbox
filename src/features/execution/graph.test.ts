import { describe, expect, it, vi } from 'vitest';

import type { CanvasNode, GraphData, NodeId } from '@/features/canvas/types';
import {
  bytesValue,
  ok,
  fail,
  type ToolOutputs,
  type ToolResult,
  type ToolValue,
} from '@/features/registry/types';
import { residentBytes } from '@/lib/binary';

import {
  CycleError,
  nodeCacheKey,
  type UpstreamRef,
  runPipeline,
  topologicalOrder,
  type PipelineCache,
} from './graph';

import type { ExecuteOptions } from './engine';

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

type ToolName = 'base64' | 'structured-data' | 'hash' | 'diff' | 'image-convert';

function node(
  id: string,
  toolId: ToolName,
  input = '',
  options: Record<string, unknown> = {},
): CanvasNode {
  return { id, toolId, position: { x: 0, y: 0 }, options, inputs: { input }, fileInputs: {} };
}

/** A diff node, which is the one tool with two required input ports. */
function diffNode(id: string, inputs: Record<string, string> = {}): CanvasNode {
  return { id, toolId: 'diff', position: { x: 0, y: 0 }, options: {}, inputs, fileInputs: {} };
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

const TEXT = { type: 'text', text: 'out' } as const;

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

  /*
   * Diff is the only tool with two required inputs, so it is the only place
   * the multi-input path is exercised in anger - and the state that matters is
   * the half-wired one, which is where somebody spends most of their time
   * while building a comparison.
   */
  it('names the port that is still missing when a tool needs two inputs', async () => {
    const { execute } = recordingExecutor();
    const graph = graphOf(
      [node('a', 'base64', 'seed'), diffNode('d')],
      [['a', 'd', 'output', 'original']],
    );

    const summary = await runPipeline(graph, { execute });

    // "Needs input" would be no help at all: one of the two IS satisfied.
    expect(summary.states.d?.status).toBe('blocked');
    expect(summary.states.d?.blockedReason).toBe('Needs Changed');
  });

  it('runs a two-input tool once one port is wired and the other is typed', async () => {
    const { execute, calls } = recordingExecutor();
    const graph = graphOf(
      [node('a', 'base64', 'seed'), diffNode('d', { changed: 'typed' })],
      [['a', 'd', 'output', 'original']],
    );

    const summary = await runPipeline(graph, { execute });

    expect(summary.states.d?.status).toBe('ok');
    const run = calls.find((call) => call.toolId === 'diff');
    expect(run?.inputs.original).toEqual({ type: 'text', text: 'out' });
    expect(run?.inputs.changed).toEqual({ type: 'text', text: 'typed' });
  });

  it('reports a two-input tool as upstream-failed when either feed failed', async () => {
    const { execute } = recordingExecutor((options) =>
      options.toolId === 'hash'
        ? fail('internal', 'nope')
        : ok({ output: { type: 'text', text: 'out' } }),
    );
    const graph = graphOf(
      [node('a', 'base64', 'seed'), node('b', 'hash', 'seed'), diffNode('d')],
      [
        ['a', 'd', 'output', 'original'],
        ['b', 'd', 'output', 'changed'],
      ],
    );

    const summary = await runPipeline(graph, { execute });

    expect(summary.states.d?.status).toBe('upstream-failed');
    expect(summary.states.d?.failedUpstream).toBe('b');
  });

  /*
   * A tool is supposed to produce every output it declares, and the compiler
   * enforces that - right up to the registry boundary, where `ErasedTool.run`
   * returns a loose record and the guarantee is gone.
   *
   * When a value did not arrive, the missing input used to be reported on the
   * node that was waiting for it: "Missing required input" on a port that is
   * visibly wired up, which sends the reader to the wrong node entirely.
   */
  it('blames the empty port rather than the node waiting on it', async () => {
    // Succeeds, but produces nothing on the port the wire leaves from.
    const execute = vi.fn((): Promise<ToolResult<ToolOutputs>> =>
      Promise.resolve(ok({ somethingElse: TEXT })),
    );

    const graph = graphOf([node('a', 'base64', 'seed'), node('b', 'hash')], [['a', 'b']]);
    const summary = await runPipeline(graph, { execute });

    expect(summary.states.a?.status).toBe('ok');
    expect(summary.states.b?.status).toBe('blocked');
    expect(summary.states.b?.blockedReason).toContain('Nothing arrived');
    expect(summary.states.b?.error).toBeNull();
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
      if (value?.type === 'bytes') seen.push(Array.from(residentBytes(value.data) ?? []));
      if (options.toolId === 'base64') {
        return ok({ output: bytesValue(bytes) });
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
    const ref = (key: string): UpstreamRef => ({ toPortId: 'input', fromPortId: 'output', key });
    expect(nodeCacheKey(n, [ref('aaaa')])).not.toBe(nodeCacheKey(n, [ref('bbbb')]));
  });

  /*
   * WHICH WIRE GOES WHERE IS PART OF THE IDENTITY.
   *
   * The key was the sorted SET of upstream keys, so swapping the two wires
   * into a two-input node left it unchanged. On a diff node that means the
   * cached patch is served for the reversed comparison: the answer is
   * confident, well formed, and describes the wiring from a moment ago.
   * Nobody reports a bug like that, which is exactly why it needs a test.
   */
  it('changes its key when two upstreams swap input ports', () => {
    const n = node('d', 'diff');
    const forwards: readonly UpstreamRef[] = [
      { toPortId: 'original', fromPortId: 'digest', key: 'aaaa' },
      { toPortId: 'changed', fromPortId: 'digest', key: 'bbbb' },
    ];
    const backwards: readonly UpstreamRef[] = [
      { toPortId: 'original', fromPortId: 'digest', key: 'bbbb' },
      { toPortId: 'changed', fromPortId: 'digest', key: 'aaaa' },
    ];
    expect(nodeCacheKey(n, forwards)).not.toBe(nodeCacheKey(n, backwards));
  });

  /*
   * The same again at the other end of the wire. A tool with several outputs -
   * structured-data's `output` text and `data` JSON - has the same cache key
   * whichever port you take, so moving a wire between them used to serve the
   * previous port's answer for the new one.
   */
  it('changes its key when the wire moves to another output port', () => {
    const n = node('h', 'hash');
    const fromText: readonly UpstreamRef[] = [
      { toPortId: 'input', fromPortId: 'output', key: 'aaaa' },
    ];
    const fromData: readonly UpstreamRef[] = [
      { toPortId: 'input', fromPortId: 'data', key: 'aaaa' },
    ];
    expect(nodeCacheKey(n, fromText)).not.toBe(nodeCacheKey(n, fromData));
  });

  /*
   * ...but the order edges happen to sit in the document must NOT change it,
   * or every re-run would be a miss and the cache would do nothing at all.
   */
  it('keys the same however the wires are ordered', () => {
    const n = node('d', 'diff');
    const one: readonly UpstreamRef[] = [
      { toPortId: 'original', fromPortId: 'digest', key: 'aaaa' },
      { toPortId: 'changed', fromPortId: 'digest', key: 'bbbb' },
    ];
    expect(nodeCacheKey(n, one)).toBe(nodeCacheKey(n, [...one].reverse()));
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

  /*
   * A NODE MUST NEVER JUST NOT BE MENTIONED.
   *
   * A wire whose source node is gone left its target waiting for a run that
   * would never come. The scheduler finishes when nothing is active and
   * nothing is ready, so the target was neither failed nor blocked - it was
   * absent from the summary entirely, and the canvas kept showing whatever it
   * had last said about it. Nothing in the app is supposed to produce a
   * dangling edge; this is the guard for when something does.
   */
  it('still reports a node whose only wire comes from a node that is gone', async () => {
    const { execute } = recordingExecutor();
    const graph = graphOf([node('b', 'hash')], [['ghost', 'b']]);

    const summary = await runPipeline(graph, { execute });

    expect(summary.states.b).toBeDefined();
    expect(summary.states.b?.status).toBe('blocked');
  });

  /*
   * `execute` is injected, and not every path beneath it is ours:
   * `postMessage` throws outright on a value it cannot clone or cannot
   * allocate a copy of. That rejection used to escape as an unhandled promise
   * rejection, and - worse - the node was never emitted at all. It kept
   * whatever status it had and the summary did not mention it. A node that
   * vanishes is harder to explain than a node that fails.
   */
  it('fails a node whose executor throws rather than dropping it', async () => {
    const execute = vi.fn((): Promise<ToolResult<ToolOutputs>> =>
      Promise.reject(new Error('could not be cloned')),
    );

    const graph = graphOf([node('a', 'hash', 'x'), node('b', 'hash', 'y')]);
    const summary = await runPipeline(graph, { execute });

    expect(summary.states.a?.status).toBe('error');
    expect(summary.states.a?.error?.detail).toContain('could not be cloned');
    // The other node is unaffected, and both are accounted for.
    expect(summary.states.b?.status).toBe('error');
    expect(summary.failed).toBe(2);
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

/* ========================================================================== *
 * A file on an input port
 * ========================================================================== */

/**
 * WIRE, THEN FILE, THEN TEXT.
 *
 * A node's input can now come from three places, and the engine has to pick
 * one. The order is by how deliberate the act was, and it is asserted here
 * rather than only through the UI because it is an engine rule: `preflight`
 * decides whether a node can run at all from it, and `buildInputs` decides what
 * the tool is handed.
 *
 * The bytes are injected through `deps.fileInput`, which is why these tests
 * need no `File`, no `FileReader` and no canvas - the document says a port HAS
 * a file, and only the session can say whether the bytes are still there.
 */
function fileNode(id: string, toolId: ToolName, portId = 'input', name = 'notes.txt'): CanvasNode {
  return {
    id,
    toolId,
    position: { x: 0, y: 0 },
    options: {},
    inputs: {},
    fileInputs: { [portId]: { name, size: 4, token: 7 } },
  };
}

const FILE_BYTES = Uint8Array.from([1, 2, 3, 4]);

function fileValue(filename = 'notes.txt'): ToolValue {
  return bytesValue(FILE_BYTES, { filename });
}

describe('a file as a node input', () => {
  it('satisfies a required port with no wire and nothing typed into it', async () => {
    const { execute, calls } = recordingExecutor();

    const summary = await runPipeline(graphOf([fileNode('a', 'hash')]), {
      execute,
      fileInput: () => fileValue(),
    });

    expect(summary.states.a?.status).toBe('ok');
    expect(calls[0]?.inputs.input).toEqual(fileValue());
  });

  it('beats typed text on the same port', async () => {
    const { execute, calls } = recordingExecutor();
    const typed: CanvasNode = { ...fileNode('a', 'hash'), inputs: { input: 'typed earlier' } };

    await runPipeline(graphOf([typed]), { execute, fileInput: () => fileValue() });

    expect(calls[0]?.inputs.input?.type).toBe('bytes');
  });

  /*
   * A wire wins over a file, because a wire wins over everything: it is the
   * only input whose value the user cannot see until the run happens, and the
   * inspector draws neither control for a wired port precisely so that nothing
   * suggests otherwise.
   */
  it('loses to a wire on the same port', async () => {
    const { execute, calls } = recordingExecutor();
    const source = node('src', 'base64', 'x');
    const target = fileNode('a', 'hash');

    await runPipeline(graphOf([source, target], [['src', 'a']]), {
      execute,
      fileInput: () => fileValue(),
    });

    const call = calls.find((entry) => entry.toolId === 'hash');
    expect(call?.inputs.input).toEqual({ type: 'text', text: 'out' });
  });

  /*
   * THE RELOAD CASE, AT THE ENGINE LEVEL. The document names a file and the
   * session cannot produce it, which is what a page load leaves behind. It is
   * its own blocked reason: "Needs input" would be true and would send the user
   * to a text box for a port they fed a photograph.
   */
  it('blocks and names the file when the document remembers one the session lacks', async () => {
    const { execute } = recordingExecutor();

    const summary = await runPipeline(graphOf([fileNode('a', 'hash', 'input', 'holiday.png')]), {
      execute,
      // No `fileInput` at all: exactly the state after a reload.
    });

    expect(execute).not.toHaveBeenCalled();
    expect(summary.states.a?.status).toBe('blocked');
    expect(summary.states.a?.blockedReason).toBe('"holiday.png" needs choosing again');
  });

  it('names which port on a tool with two of them', async () => {
    const { execute } = recordingExecutor();
    const withOne: CanvasNode = {
      ...diffNode('a', { original: 'left' }),
      fileInputs: { changed: { name: 'right.txt', size: 4, token: 1 } },
    };

    const summary = await runPipeline(graphOf([withOne]), { execute });

    expect(summary.states.a?.blockedReason).toBe('Changed: "right.txt" needs choosing again');
  });

  /*
   * A bytes-only port's blocked reason used to read `Needs a wire into Image`,
   * which described half of what would work - and the half it left out was the
   * only way to start an image conversion on the canvas at all.
   */
  it('offers a file, not only a wire, when a bytes-only port is empty', async () => {
    const { execute } = recordingExecutor();
    const bytesOnly: CanvasNode = {
      id: 'a',
      toolId: 'image-convert',
      position: { x: 0, y: 0 },
      options: {},
      inputs: {},
      fileInputs: {},
    };

    const summary = await runPipeline(graphOf([bytesOnly]), { execute });

    expect(summary.states.a?.blockedReason).toBe('Needs a file or a wire into Image');
  });

  /*
   * ONE FILE, TWO CONSUMERS. Binary payload ownership has bitten before:
   * buffers are borrowed by default and transferred only on an explicit opt-in,
   * because a fan-out detaches the second consumer's view. A file is a second
   * source of one buffer reaching several tools, so it is asserted here too.
   */
  it('feeds two nodes from one file without detaching either', async () => {
    const seen: number[][] = [];
    const { execute } = recordingExecutor((options) => {
      const value = options.inputs.input;
      if (value?.type === 'bytes') seen.push(Array.from(residentBytes(value.data) ?? []));
      return ok({ output: { type: 'text', text: 'out' } });
    });

    const summary = await runPipeline(graphOf([fileNode('a', 'hash'), fileNode('b', 'hash')]), {
      execute,
      fileInput: () => fileValue(),
    });

    expect(summary.failed).toBe(0);
    expect(seen).toEqual([
      [1, 2, 3, 4],
      [1, 2, 3, 4],
    ]);
  });

  it('is borrowed rather than transferred, so nothing can detach it', async () => {
    const { execute, calls } = recordingExecutor();

    await runPipeline(graphOf([fileNode('a', 'hash')]), { execute, fileInput: () => fileValue() });

    expect(calls[0]?.ownership).toBe('borrow');
  });
});

describe('a file in the cache key', () => {
  const NO_UPSTREAM: readonly UpstreamRef[] = [];

  /*
   * Two different files can share a name and a size. The token is what tells
   * them apart, and serving the first one's answer for the second is the worst
   * failure this cache can have: nobody reports it, because nothing looks
   * wrong.
   */
  it('changes when the file changes but its name and size do not', () => {
    const first = fileNode('a', 'hash');
    const second: CanvasNode = {
      ...first,
      fileInputs: { input: { name: 'notes.txt', size: 4, token: 8 } },
    };

    expect(nodeCacheKey(first, NO_UPSTREAM)).not.toBe(nodeCacheKey(second, NO_UPSTREAM));
  });

  it('is unchanged when the same file is still on the same port', () => {
    expect(nodeCacheKey(fileNode('a', 'hash'), NO_UPSTREAM)).toBe(
      nodeCacheKey(fileNode('a', 'hash'), NO_UPSTREAM),
    );
  });

  /*
   * The same file on a DIFFERENT port is a different node, for the reason the
   * upstream refs are sorted by receiving port: which port a value arrives at
   * is part of what the node is.
   */
  it('changes when a file moves between ports', () => {
    const onOriginal: CanvasNode = {
      ...diffNode('a'),
      fileInputs: { original: { name: 'x.txt', size: 1, token: 2 } },
    };
    const onChanged: CanvasNode = {
      ...diffNode('a'),
      fileInputs: { changed: { name: 'x.txt', size: 1, token: 2 } },
    };

    expect(nodeCacheKey(onOriginal, NO_UPSTREAM)).not.toBe(nodeCacheKey(onChanged, NO_UPSTREAM));
  });

  /*
   * A TOKEN RESTORED FROM STORAGE POINTS AT NOTHING, and cannot collide its way
   * into a wrong answer. The counter is session-scoped, so a reloaded reference
   * can carry a token a new attachment later reuses - but the cache only holds
   * entries for keys computed while a file was actually attached, and a node
   * with a remembered-but-missing file is `blocked`, which is never cached.
   */
  it('cannot serve a cached answer for a file that was never loaded', async () => {
    const cache: PipelineCache = new Map();
    const { execute } = recordingExecutor();
    const graph = graphOf([fileNode('a', 'hash', 'input', 'holiday.png')]);

    // The reload: blocked, and nothing cached.
    const blocked = await runPipeline(graph, { execute, cache });
    expect(blocked.states.a?.status).toBe('blocked');
    expect(cache.has('a')).toBe(false);

    // Choosing the file again runs it for real rather than hitting anything.
    const chosen = await runPipeline(graph, { execute, cache, fileInput: () => fileValue() });
    expect(chosen.states.a?.status).toBe('ok');
    expect(chosen.cached).toBe(0);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
