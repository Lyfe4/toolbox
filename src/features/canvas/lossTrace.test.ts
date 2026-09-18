import { describe, expect, it } from 'vitest';

import type { NodeRunState, PipelineState } from '@/features/execution/graph';
import type { ToolId } from '@/features/registry';
import type { ToolOutputs } from '@/features/registry/types';

import { traceLosses } from './lossTrace';

import type { CanvasEdge, CanvasNode, GraphData, NodeId } from './types';

/*
 * FOLLOWING A LOSS ALONG A WIRE.
 *
 * The bug this file exists to prevent, in the shape it was reported: a lossy
 * JSON → CSV node wired into a second structured-data node set to JSON. The
 * second node's output really is `"user": "{\\"name\\":\\"ada\\"}"` - a string
 * where the original had an object - and the second node said `ok` with a blank
 * face, because its own conversion lost nothing.
 *
 * Every test below drives `traceLosses` with report payloads of the shape the
 * tools really produce, because that payload - `notes[].reaches` - is the only
 * thing standing between "follows a wire" and "warns on everything downstream".
 */

/** A `report`-presented output, exactly as `notesToJson` writes one. */
function report(notes: readonly { title: string; reaches: readonly string[] }[]): ToolOutputs {
  return {
    output: { type: 'text', text: 'anything' },
    data: { type: 'json', data: [] },
    report: {
      type: 'json',
      data: {
        summary: 'JSON → CSV',
        notes: notes.map((note) => ({
          level: 'warn',
          title: note.title,
          body: 'why',
          reaches: [...note.reaches],
        })),
      },
    },
  };
}

/** A clean structured-data run: three ports, a report with nothing in it. */
function clean(): ToolOutputs {
  return {
    output: { type: 'text', text: 'a,b\n1,2' },
    data: { type: 'json', data: [] },
    report: { type: 'json', data: { summary: 'JSON → CSV', notes: [] } },
  };
}

function ranWith(outputs: ToolOutputs): NodeRunState {
  return {
    status: 'ok',
    outputs,
    error: null,
    durationMs: 1,
    blockedReason: null,
    failedUpstream: null,
    key: 'k',
  };
}

interface Wire {
  readonly from: NodeId;
  readonly fromPortId: string;
  readonly to: NodeId;
  readonly toPortId?: string;
}

function build(
  nodes: readonly { readonly id: NodeId; readonly toolId: ToolId }[],
  wires: readonly Wire[],
): GraphData {
  const record: Record<string, CanvasNode> = {};
  for (const [index, node] of nodes.entries()) {
    record[node.id] = {
      id: node.id,
      toolId: node.toolId,
      position: { x: index * 300, y: 0 },
      options: {},
      inputs: {},
      fileInputs: {},
    };
  }

  const edges: Record<string, CanvasEdge> = {};
  const edgeOrder: string[] = [];
  for (const [index, wire] of wires.entries()) {
    const id = `e${index.toString()}`;
    edgeOrder.push(id);
    edges[id] = {
      id,
      from: { nodeId: wire.from, portId: wire.fromPortId },
      to: { nodeId: wire.to, portId: wire.toPortId ?? 'input' },
    };
  }

  return {
    nodes: record,
    nodeOrder: nodes.map((node) => node.id),
    edges,
    edgeOrder,
    nextId: nodes.length + 1,
  };
}

function states(entries: Readonly<Record<string, NodeRunState>>): PipelineState {
  return entries;
}

/** The nested-value loss, which happens in the write half: `output` only. */
const NESTED = {
  title: 'The nested value at $[0].user was written into the cell as JSON',
  reaches: ['output'],
};

/** A read-half loss, which the parsed structure carries too. */
const ROUNDED = {
  title: 'The number at $[0].id was rounded',
  reaches: ['output', 'data'],
};

describe('traceLosses', () => {
  it('marks the node holding a damaged value, which was the whole complaint', () => {
    const graph = build(
      [
        { id: 'a', toolId: 'structured-data' },
        { id: 'b', toolId: 'structured-data' },
      ],
      [{ from: 'a', fromPortId: 'output', to: 'b' }],
    );

    const traces = traceLosses(
      graph,
      states({ a: ranWith(report([NESTED])), b: ranWith(clean()) }),
    );

    // The node that LOST it is not downstream of anything: its own face says so.
    expect(traces.has('a')).toBe(false);

    const trace = traces.get('b');
    expect(trace?.origin).toBe('a');
    expect(trace?.toolName).toBe('Structured data');
    expect(trace?.title).toBe(NESTED.title);
    expect(trace?.origins).toBe(1);
  });

  /*
   * THE NEGATIVE CONTROL THAT DECIDES WHETHER THIS FEATURE IS WORTH HAVING.
   *
   * `data` is the parsed SOURCE structure, so the write half's flattening is
   * not in it - and its description is literally "for wiring into another
   * tool". Wiring it onward is the way AROUND this loss. A rule that marked
   * every wire leaving a lossy node would put a warning on the workaround,
   * which is the one thing the canvas rules refuse outright.
   */
  it('does not follow a wire out of a port the loss is not in', () => {
    const graph = build(
      [
        { id: 'a', toolId: 'structured-data' },
        { id: 'b', toolId: 'structured-data' },
      ],
      [{ from: 'a', fromPortId: 'data', to: 'b' }],
    );

    const traces = traceLosses(
      graph,
      states({ a: ranWith(report([NESTED])), b: ranWith(clean()) }),
    );

    expect(traces.get('b')).toBeUndefined();
  });

  it('does follow the same wire when the loss really is in that port', () => {
    const graph = build(
      [
        { id: 'a', toolId: 'structured-data' },
        { id: 'b', toolId: 'structured-data' },
      ],
      [{ from: 'a', fromPortId: 'data', to: 'b' }],
    );

    const traces = traceLosses(
      graph,
      states({ a: ranWith(report([ROUNDED])), b: ranWith(clean()) }),
    );

    expect(traces.get('b')?.title).toBe(ROUNDED.title);
  });

  it('names the loss that reached THIS node, not the first one the origin reported', () => {
    // Both losses on one node: the flattened cell is in `output` alone, the
    // rounded number is in both. A wire from `data` carries only the second,
    // and naming the first on that node would describe a loss the value in
    // front of the reader does not have.
    const graph = build(
      [
        { id: 'a', toolId: 'structured-data' },
        { id: 'b', toolId: 'structured-data' },
      ],
      [{ from: 'a', fromPortId: 'data', to: 'b' }],
    );

    const traces = traceLosses(
      graph,
      states({ a: ranWith(report([NESTED, ROUNDED])), b: ranWith(clean()) }),
    );

    expect(traces.get('b')?.title).toBe(ROUNDED.title);
  });

  it('keeps going past the first hop, which is where the warning used to vanish', () => {
    const graph = build(
      [
        { id: 'a', toolId: 'structured-data' },
        { id: 'b', toolId: 'structured-data' },
        { id: 'c', toolId: 'structured-data' },
        { id: 'd', toolId: 'hash' },
      ],
      [
        { from: 'a', fromPortId: 'output', to: 'b' },
        { from: 'b', fromPortId: 'output', to: 'c' },
        { from: 'c', fromPortId: 'output', to: 'd' },
      ],
    );

    const traces = traceLosses(
      graph,
      states({
        a: ranWith(report([NESTED])),
        b: ranWith(clean()),
        c: ranWith(clean()),
        d: ranWith({ output: { type: 'text', text: 'deadbeef' } }),
      }),
    );

    for (const id of ['b', 'c', 'd']) {
      expect(traces.get(id)?.origin, `${id} descends from a`).toBe('a');
    }
  });

  /*
   * A LOSS AN INHERITING NODE PASSES ON LEAVES BY EVERY PORT BUT THE REPORT.
   *
   * `reaches` says where a tool's OWN loss went, and a tool has no way to know
   * its input was already damaged - so the per-port narrowing applies at the
   * first hop and nowhere after it. Everything `b` produces descends from what
   * `b` was given.
   */
  it('passes an inherited loss out of a port the original loss was not in', () => {
    const graph = build(
      [
        { id: 'a', toolId: 'structured-data' },
        { id: 'b', toolId: 'structured-data' },
        { id: 'c', toolId: 'structured-data' },
      ],
      [
        { from: 'a', fromPortId: 'output', to: 'b' },
        { from: 'b', fromPortId: 'data', to: 'c' },
      ],
    );

    const traces = traceLosses(
      graph,
      states({ a: ranWith(report([NESTED])), b: ranWith(clean()), c: ranWith(clean()) }),
    );

    expect(traces.get('c')?.origin).toBe('a');
  });

  /*
   * A REPORT PORT CARRIES THE ACCOUNT OF A RUN, NOT ITS DOCUMENT.
   *
   * THE FIRST VERSION OF THIS TEST PASSED AGAINST THE BREAK IT WAS WRITTEN FOR.
   * It wired the lossy node's own `report` port onward and asserted silence -
   * which the per-port rule already produces, because `reaches` names `output`
   * and not `report`. Deleting the report guard changed nothing and the test
   * stayed green.
   *
   * The guard only bites on an INHERITED loss, which no `reaches` list narrows:
   * `a` below is downstream of `source`, so everything leaving `a` descends from
   * the loss - and without the guard that would include the report describing
   * `a`'s own clean conversion. A node reading that report is holding a
   * description, not a damaged document.
   */
  it('carries nothing out of a report port, not even a loss the node inherited', () => {
    const graph = build(
      [
        { id: 'source', toolId: 'structured-data' },
        { id: 'a', toolId: 'structured-data' },
        { id: 'b', toolId: 'structured-data' },
      ],
      [
        { from: 'source', fromPortId: 'output', to: 'a' },
        { from: 'a', fromPortId: 'report', to: 'b', toPortId: 'input' },
      ],
    );

    const traces = traceLosses(
      graph,
      states({
        source: ranWith(report([NESTED])),
        a: ranWith(clean()),
        b: ranWith(clean()),
      }),
    );

    // `a` is downstream of the loss; the node reading `a`'s report is not.
    expect(traces.get('a')?.origin).toBe('source');
    expect(traces.get('b')).toBeUndefined();
  });

  it('stays silent down a long chain where nothing was lost', () => {
    const ids = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8'];
    const graph = build(
      ids.map((id) => ({ id, toolId: 'structured-data' })),
      ids.slice(0, -1).map((id, index) => ({
        from: id,
        fromPortId: 'output',
        to: ids[index + 1] ?? '',
      })),
    );

    const traces = traceLosses(
      graph,
      states(Object.fromEntries(ids.map((id) => [id, ranWith(clean())]))),
    );

    expect([...traces.keys()]).toEqual([]);
  });

  it('counts distinct origins and names the nearest', () => {
    // Two lossy sources into one diff node, one of them two hops away.
    const graph = build(
      [
        { id: 'far', toolId: 'structured-data' },
        { id: 'mid', toolId: 'structured-data' },
        { id: 'near', toolId: 'structured-data' },
        { id: 'sink', toolId: 'diff' },
      ],
      [
        { from: 'far', fromPortId: 'output', to: 'mid' },
        { from: 'mid', fromPortId: 'output', to: 'sink', toPortId: 'original' },
        { from: 'near', fromPortId: 'output', to: 'sink', toPortId: 'changed' },
      ],
    );

    const traces = traceLosses(
      graph,
      states({
        far: ranWith(report([ROUNDED])),
        mid: ranWith(clean()),
        near: ranWith(report([NESTED])),
        sink: ranWith({ output: { type: 'text', text: '' }, changes: { type: 'json', data: {} } }),
      }),
    );

    const trace = traces.get('sink');
    expect(trace?.origin).toBe('near');
    expect(trace?.origins).toBe(2);
  });

  it('says nothing about a node that has not run', () => {
    const graph = build(
      [
        { id: 'a', toolId: 'structured-data' },
        { id: 'b', toolId: 'structured-data' },
      ],
      [{ from: 'a', fromPortId: 'output', to: 'b' }],
    );

    // `a` reported the loss on a run that has since been superseded: the state
    // the canvas holds for it is `blocked`, so there is no value on the wire.
    const traces = traceLosses(
      graph,
      states({
        a: {
          status: 'blocked',
          outputs: null,
          error: null,
          durationMs: null,
          blockedReason: 'Needs input',
          failedUpstream: null,
          key: 'k',
        },
        b: ranWith(clean()),
      }),
    );

    expect(traces.get('b')).toBeUndefined();
  });

  /*
   * A note with no `reaches` is what a share link hand-edited by a person, or a
   * report written before the field existed, produces. It still prints on the
   * node's own face - that is `lossSummary`, and it is a claim about the node -
   * and it does not travel, because nothing has said where it went. Silence is
   * the honest answer, not a guess applied to every wire.
   */
  it('does not travel on a note that names no port', () => {
    const graph = build(
      [
        { id: 'a', toolId: 'structured-data' },
        { id: 'b', toolId: 'structured-data' },
      ],
      [{ from: 'a', fromPortId: 'output', to: 'b' }],
    );

    const traces = traceLosses(
      graph,
      states({
        a: ranWith(report([{ title: 'Something went missing', reaches: [] }])),
        b: ranWith(clean()),
      }),
    );

    expect(traces.get('b')).toBeUndefined();
  });

  /*
   * `topologicalOrder` throws on a cycle, correctly, because it runs inside the
   * executor. This runs inside a render, where the same throw is a blank canvas
   * instead of the graph somebody is trying to debug. Nothing in the app can
   * make a cycle - `checkConnection` refuses one - so this is about what happens
   * when something does anyway.
   */
  it('finishes on a graph with a cycle instead of throwing the canvas away', () => {
    const graph = build(
      [
        { id: 'a', toolId: 'structured-data' },
        { id: 'b', toolId: 'structured-data' },
      ],
      [
        { from: 'a', fromPortId: 'output', to: 'b' },
        { from: 'b', fromPortId: 'output', to: 'a' },
      ],
    );

    expect(() =>
      traceLosses(graph, states({ a: ranWith(report([NESTED])), b: ranWith(clean()) })),
    ).not.toThrow();
  });
});
