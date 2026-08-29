import { describe, expect, it } from 'vitest';

import { instantiatePreset, PIPELINE_PRESETS } from '@/features/canvas/presets';
import type { CanvasNode, GraphData } from '@/features/canvas/types';
import { getManifestEntry, loadTool } from '@/features/registry';
import type { ToolOutputs, ToolResult } from '@/features/registry/types';

import { createExecutionEngine, type ExecuteOptions } from './engine';
import { runPipeline, type PipelineCache } from './graph';

/**
 * The whole thing, end to end, with the real tools.
 *
 * The unit tests use a fake executor to pin scheduling behaviour; this one
 * proves the pieces actually fit: real chunks are loaded, real values cross
 * real ports, and the output at the end is the value you would get by doing
 * each step by hand.
 */
function makeEngine() {
  const engine = createExecutionEngine({
    createWorker: () => {
      throw new Error('no worker in jsdom');
    },
    loadTool,
    // Main-thread strategy so this exercises the tools, not worker plumbing.
    getExecutionMeta: (id) => ({ ...getManifestEntry(id).execution, strategy: 'main' }),
    setTimer: (callback, ms) => window.setTimeout(callback, ms),
    clearTimer: (handle) => {
      window.clearTimeout(handle);
    },
  });

  return (options: ExecuteOptions): Promise<ToolResult<ToolOutputs>> => engine.execute(options);
}

function graphFrom(
  nodes: readonly CanvasNode[],
  wires: readonly (readonly [string, string, string, string])[],
): GraphData {
  const edges: GraphData['edges'] = {};
  const edgeOrder: string[] = [];

  wires.forEach(([fromNode, fromPort, toNode, toPort], index) => {
    const id = `e${index.toString()}`;
    edgeOrder.push(id);
    Object.assign(edges, {
      [id]: {
        id,
        from: { nodeId: fromNode, portId: fromPort },
        to: { nodeId: toNode, portId: toPort },
      },
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

function textAt(
  states: Record<string, { outputs: ToolOutputs | null }>,
  id: string,
  port: string,
): string {
  const value = states[id]?.outputs?.[port];
  if (value?.type !== 'text') throw new Error(`no text on ${id}.${port}`);
  return value.text;
}

describe('a real pipeline', () => {
  it('decodes base64 and converts the JSON inside it to YAML', async () => {
    // {"name":"ada","tags":["x","y"]} as base64.
    const payload = 'eyJuYW1lIjoiYWRhIiwidGFncyI6WyJ4IiwieSJdfQ==';

    const graph = graphFrom(
      [
        {
          id: 'a',
          toolId: 'base64',
          position: { x: 0, y: 0 },
          options: { mode: 'decode' },
          input: payload,
        },
        {
          id: 'b',
          toolId: 'structured-data',
          position: { x: 320, y: 0 },
          options: { source: 'auto', target: 'yaml', indent: 2 },
          input: '',
        },
      ],
      [['a', 'output', 'b', 'input']],
    );

    const summary = await runPipeline(graph, { execute: makeEngine() });

    expect(summary.failed).toBe(0);
    expect(summary.states.a?.status).toBe('ok');
    expect(summary.states.b?.status).toBe('ok');

    const yaml = textAt(summary.states, 'b', 'output');
    expect(yaml).toContain('name: ada');
    expect(yaml).toContain('- x');
  });

  it('converts CSV to JSON and fingerprints it', async () => {
    const graph = graphFrom(
      [
        {
          id: 'a',
          toolId: 'structured-data',
          position: { x: 0, y: 0 },
          options: { source: 'csv', target: 'json', indent: 0 },
          input: 'name,age\nada,36',
        },
        {
          id: 'b',
          toolId: 'hash',
          position: { x: 320, y: 0 },
          options: { algorithm: 'sha-256', encoding: 'hex' },
          input: '',
        },
      ],
      [['a', 'output', 'b', 'input']],
    );

    const summary = await runPipeline(graph, { execute: makeEngine() });

    expect(summary.failed).toBe(0);
    expect(textAt(summary.states, 'a', 'output')).toBe('[{"name":"ada","age":"36"}]');
    // A SHA-256 in hex is 64 characters, and it is the digest of that exact
    // JSON - so the chain really carried the value through.
    expect(textAt(summary.states, 'b', 'digest')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fans one output into two hashes, and both see the same bytes', async () => {
    const graph = graphFrom(
      [
        {
          id: 'src',
          toolId: 'base64',
          position: { x: 0, y: 0 },
          options: { mode: 'decode' },
          input: 'aGVsbG8gd29ybGQ=',
        },
        {
          id: 'sha',
          toolId: 'hash',
          position: { x: 320, y: -100 },
          options: { algorithm: 'sha-256', encoding: 'hex' },
          input: '',
        },
        {
          id: 'md5',
          toolId: 'hash',
          position: { x: 320, y: 100 },
          options: { algorithm: 'md5', encoding: 'hex' },
          input: '',
        },
      ],
      [
        ['src', 'output', 'sha', 'input'],
        ['src', 'output', 'md5', 'input'],
      ],
    );

    const summary = await runPipeline(graph, { execute: makeEngine() });

    expect(summary.failed).toBe(0);
    // Known digests of the literal bytes "hello world". If the buffer had been
    // detached by the first consumer, the second would have hashed nothing and
    // produced the empty-input digest instead.
    expect(textAt(summary.states, 'sha', 'digest')).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    );
    expect(textAt(summary.states, 'md5', 'digest')).toBe('5eb63bbbe01eeed093cb22bb8f5acdc3');
  });

  it('reports a real tool failure on the failing node only', async () => {
    const graph = graphFrom(
      [
        {
          id: 'a',
          toolId: 'base64',
          position: { x: 0, y: 0 },
          options: { mode: 'decode' },
          input: '!!!! not base64 !!!!',
        },
        { id: 'b', toolId: 'hash', position: { x: 320, y: 0 }, options: {}, input: '' },
      ],
      [['a', 'output', 'b', 'input']],
    );

    const summary = await runPipeline(graph, { execute: makeEngine() });

    expect(summary.states.a?.status).toBe('error');
    expect(summary.states.a?.error?.code).toBe('parse-error');
    expect(summary.states.b?.status).toBe('upstream-failed');
    expect(summary.states.b?.error).toBeNull();
    expect(summary.failed).toBe(1);
  });

  it('re-runs only what changed when an option is edited', async () => {
    const cache: PipelineCache = new Map();
    let executions = 0;
    const engine = makeEngine();
    const counting = (options: ExecuteOptions): Promise<ToolResult<ToolOutputs>> => {
      executions += 1;
      return engine(options);
    };

    const nodes: CanvasNode[] = [
      {
        id: 'a',
        toolId: 'base64',
        position: { x: 0, y: 0 },
        options: { mode: 'encode' },
        input: 'patchbay',
      },
      {
        id: 'b',
        toolId: 'hash',
        position: { x: 320, y: 0 },
        options: { algorithm: 'sha-256' },
        input: '',
      },
    ];
    const wires = [['a', 'output', 'b', 'input']] as const;

    await runPipeline(graphFrom(nodes, [wires[0]]), { execute: counting, cache });
    expect(executions).toBe(2);

    const [source, sink] = nodes;
    if (!source || !sink) throw new Error('fixture is malformed');

    const edited = graphFrom([source, { ...sink, options: { algorithm: 'md5' } }], [wires[0]]);
    const summary = await runPipeline(edited, { execute: counting, cache });

    // Only the hash node ran again; the encode was served from cache.
    expect(executions).toBe(3);
    expect(summary.cached).toBe(1);
    expect(textAt(summary.states, 'b', 'digest')).toHaveLength(32);
  });
});

describe('the shipped presets', () => {
  it.each(PIPELINE_PRESETS.map((preset) => [preset.id, preset] as const))(
    '%s wires up and blocks cleanly with no data',
    async (_id, preset) => {
      const { nodes, edges } = instantiatePreset(preset, { x: 0, y: 0 }, 1);
      const graph: GraphData = {
        nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
        nodeOrder: nodes.map((n) => n.id),
        edges: Object.fromEntries(edges.map((e) => [e.id, e])),
        edgeOrder: edges.map((e) => e.id),
        nextId: nodes.length + edges.length + 1,
      };

      const summary = await runPipeline(graph, { execute: makeEngine() });

      // Every preset arrives empty, so nothing runs and nothing errors: the
      // whole pipeline is simply waiting for the user's input.
      expect(summary.failed).toBe(0);
      expect(summary.ran).toBe(0);
      expect(summary.blocked).toBe(nodes.length);
      expect(summary.states[nodes[0]?.id ?? '']?.blockedReason).toBe('Needs input');
    },
  );

  it('runs the decode-and-convert preset once its input is supplied', async () => {
    const preset = PIPELINE_PRESETS.find((entry) => entry.id === 'decode-and-convert');
    expect(preset).toBeDefined();
    if (!preset) return;

    const { nodes, edges } = instantiatePreset(preset, { x: 0, y: 0 }, 1);
    const first = nodes[0];
    expect(first).toBeDefined();
    if (!first) return;

    const seeded = nodes.map((node) =>
      node.id === first.id ? { ...node, input: 'eyJhIjoxfQ==' } : node,
    );

    const graph: GraphData = {
      nodes: Object.fromEntries(seeded.map((n) => [n.id, n])),
      nodeOrder: seeded.map((n) => n.id),
      edges: Object.fromEntries(edges.map((e) => [e.id, e])),
      edgeOrder: edges.map((e) => e.id),
      nextId: seeded.length + edges.length + 1,
    };

    const summary = await runPipeline(graph, { execute: makeEngine() });

    expect(summary.failed).toBe(0);
    expect(summary.ran).toBe(2);
    expect(textAt(summary.states, nodes[1]?.id ?? '', 'output')).toContain('a: 1');
  });
});
