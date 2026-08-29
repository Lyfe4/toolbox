import { beforeEach, describe, expect, it } from 'vitest';

import { getManifestEntry } from '@/features/registry';

import { applyCommand, describeCommand, revertCommand, type Command } from './commands';
import { checkConnection, connectionCount, edgeInto, validTargetsFor } from './connections';
import {
  graphBounds,
  nodeHeight,
  portPosition,
  snapToGrid,
  spatialOrder,
  wirePath,
} from './geometry';
import { useCanvasStore } from './graphStore';
import { EMPTY_GRAPH, type CanvasNode, type GraphData, type PortRef } from './types';
import { viewportForBounds, zoomAbout, DEFAULT_VIEWPORT } from './viewportStore';

function node(id: string, toolId: 'base64' | 'structured-data', x = 0, y = 0): CanvasNode {
  return { id, toolId, position: { x, y }, options: {}, input: '' };
}

function graphOf(...nodes: CanvasNode[]): GraphData {
  return {
    ...EMPTY_GRAPH,
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    nodeOrder: nodes.map((n) => n.id),
    nextId: nodes.length + 1,
  };
}

const out = (nodeId: string, portId = 'output'): PortRef => ({ nodeId, portId });
const into = (nodeId: string, portId = 'input'): PortRef => ({ nodeId, portId });

/* ========================================================================== *
 * Commands: every one must have a correct inverse
 * ========================================================================== */

describe('command inverses', () => {
  const base = graphOf(node('n1', 'base64', 0, 0), node('n2', 'structured-data', 300, 0));

  const cases: readonly Command[] = [
    { kind: 'add-node', node: node('n3', 'base64', 100, 100) },
    {
      kind: 'remove-nodes',
      nodes: [node('n1', 'base64', 0, 0)],
      nodeIndices: [0],
      edges: [],
      edgeIndices: [],
    },
    {
      kind: 'move-nodes',
      ids: ['n1'],
      from: { n1: { x: 0, y: 0 } },
      to: { n1: { x: 64, y: 32 } },
    },
    { kind: 'add-edge', edge: { id: 'e1', from: out('n1'), to: into('n2') } },
    { kind: 'set-options', nodeId: 'n1', from: {}, to: { mode: 'decode' } },
  ];

  it.each(cases.map((command) => [command.kind, command] as const))(
    '%s: apply then revert returns the original graph',
    (_kind, command) => {
      const applied = applyCommand(base, command);
      const reverted = revertCommand(applied, command);
      expect(reverted.nodes).toEqual(base.nodes);
      expect(reverted.nodeOrder).toEqual(base.nodeOrder);
      expect(reverted.edges).toEqual(base.edges);
      expect(reverted.edgeOrder).toEqual(base.edgeOrder);
    },
  );

  it('restores a deleted node together with its wires', () => {
    const withEdge = applyCommand(base, {
      kind: 'add-edge',
      edge: { id: 'e1', from: out('n1'), to: into('n2') },
    });

    const remove: Command = {
      kind: 'remove-nodes',
      nodes: [node('n1', 'base64', 0, 0)],
      nodeIndices: [0],
      edges: [{ id: 'e1', from: out('n1'), to: into('n2') }],
      edgeIndices: [0],
    };

    const removed = applyCommand(withEdge, remove);
    expect(removed.nodeOrder).toEqual(['n2']);
    expect(removed.edgeOrder).toEqual([]);

    const restored = revertCommand(removed, remove);
    expect(restored.nodeOrder).toContain('n1');
    expect(restored.edgeOrder).toEqual(['e1']);
  });

  it('describes itself for the undo announcement', () => {
    expect(describeCommand({ kind: 'add-node', node: node('n9', 'base64') })).toBe('add node');
    expect(
      describeCommand({
        kind: 'move-nodes',
        ids: ['a', 'b'],
        from: {},
        to: {},
      }),
    ).toBe('move 2 nodes');
  });
});

/* ========================================================================== *
 * Connection rules
 * ========================================================================== */

describe('connection rules', () => {
  const base = graphOf(node('n1', 'base64', 0, 0), node('n2', 'structured-data', 300, 0));

  it('accepts a compatible wire', () => {
    expect(checkConnection(base, out('n1'), into('n2')).ok).toBe(true);
  });

  it('refuses a node wired to itself, with a reason', () => {
    const result = checkConnection(base, out('n1'), into('n1'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.reason).toBe('same-node');
      expect(result.rejection.message).toMatch(/itself/);
    }
  });

  it('refuses incompatible types, naming both sides', () => {
    // structured-data's `data` output is json; base64's input takes text|bytes.
    const result = checkConnection(base, out('n2', 'data'), into('n1'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.reason).toBe('type-mismatch');
      expect(result.rejection.message).toContain('json');
    }
  });

  it('refuses a second wire into an occupied input', () => {
    const withEdge = applyCommand(base, {
      kind: 'add-edge',
      edge: { id: 'e1', from: out('n1'), to: into('n2') },
    });
    const withThird = applyCommand(withEdge, {
      kind: 'add-node',
      node: node('n3', 'base64', 0, 200),
    });

    const result = checkConnection(withThird, out('n3'), into('n2'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.reason).toBe('occupied');
  });

  it('refuses a duplicate of an existing wire', () => {
    const withEdge = applyCommand(base, {
      kind: 'add-edge',
      edge: { id: 'e1', from: out('n1'), to: into('n2') },
    });
    const result = checkConnection(withEdge, out('n1'), into('n2'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.reason).toBe('duplicate');
  });

  it('refuses a wire that would close a loop, before it is committed', () => {
    // n1 -> n2 already exists; n2 -> n1 would make a cycle.
    const withEdge = applyCommand(base, {
      kind: 'add-edge',
      edge: { id: 'e1', from: out('n1'), to: into('n2') },
    });

    const result = checkConnection(withEdge, out('n2'), into('n1'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.reason).toBe('cycle');
      expect(result.rejection.message).toMatch(/loop/);
    }
  });

  it('detects a loop through an intermediate node', () => {
    let graph = graphOf(
      node('n1', 'structured-data', 0, 0),
      node('n2', 'structured-data', 200, 0),
      node('n3', 'structured-data', 400, 0),
    );
    graph = applyCommand(graph, {
      kind: 'add-edge',
      edge: { id: 'e1', from: out('n1'), to: into('n2') },
    });
    graph = applyCommand(graph, {
      kind: 'add-edge',
      edge: { id: 'e2', from: out('n2'), to: into('n3') },
    });

    const result = checkConnection(graph, out('n3'), into('n1'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.reason).toBe('cycle');
  });

  it('lists exactly the targets a pointer drop would be allowed to land on', () => {
    const targets = validTargetsFor(base, out('n1'));
    expect(targets).toHaveLength(1);
    expect(targets[0]?.nodeId).toBe('n2');
    expect(targets[0]?.portLabel).toBe('Document');
  });

  it('stops offering an input once it is occupied', () => {
    const withEdge = applyCommand(base, {
      kind: 'add-edge',
      edge: { id: 'e1', from: out('n1'), to: into('n2') },
    });
    expect(validTargetsFor(withEdge, out('n1'))).toHaveLength(0);
  });

  it('counts and finds wires on a port', () => {
    const withEdge = applyCommand(base, {
      kind: 'add-edge',
      edge: { id: 'e1', from: out('n1'), to: into('n2') },
    });
    expect(connectionCount(withEdge, 'n1')).toBe(1);
    expect(edgeInto(withEdge, into('n2'))?.id).toBe('e1');
    expect(edgeInto(withEdge, into('n1'))).toBeNull();
  });
});

/* ========================================================================== *
 * Geometry
 * ========================================================================== */

describe('geometry', () => {
  it('snaps to the 8px baseline', () => {
    expect(snapToGrid(3)).toBe(0);
    expect(snapToGrid(5)).toBe(8);
    // Normalised to +0, so a saved position round-trips through JSON.
    expect(Object.is(snapToGrid(-3), 0)).toBe(true);
    expect(snapToGrid(60)).toBe(64);
  });

  it('puts inputs on the left edge and outputs on the right', () => {
    const n = node('n1', 'structured-data', 100, 200);
    const input = portPosition(n, 'input', 0);
    const output = portPosition(n, 'output', 0);
    expect(input.x).toBe(100);
    expect(output.x).toBe(100 + 224);
    expect(input.y).toBe(output.y);
  });

  it('gives a taller node to a tool with more ports', () => {
    expect(nodeHeight(getManifestEntry('structured-data'))).toBeGreaterThan(
      nodeHeight(getManifestEntry('base64')),
    );
  });

  it('draws a horizontal-first bezier', () => {
    const path = wirePath({ x: 0, y: 0 }, { x: 200, y: 100 });
    expect(path).toMatch(/^M 0.0 0.0 C /);
    expect(path).toContain('200.0 100.0');
  });

  it('bounds every node', () => {
    const graph = graphOf(node('n1', 'base64', 0, 0), node('n2', 'base64', 400, 200));
    const bounds = graphBounds(graph);
    expect(bounds?.x).toBe(0);
    expect(bounds?.width).toBe(400 + 224);
    expect(graphBounds(EMPTY_GRAPH)).toBeNull();
  });

  it('orders nodes top-to-bottom then left-to-right', () => {
    const graph = graphOf(
      node('n1', 'base64', 400, 0),
      node('n2', 'base64', 0, 0),
      node('n3', 'base64', 200, 300),
    );
    // n2 and n1 share a row band, so x decides; n3 is a row below.
    expect(spatialOrder(graph)).toEqual(['n2', 'n1', 'n3']);
  });
});

/* ========================================================================== *
 * Viewport maths
 * ========================================================================== */

describe('viewport', () => {
  it('keeps the world point under the pointer fixed while zooming', () => {
    const pointer = { x: 300, y: 200 };
    const before = { x: 40, y: 10, zoom: 1 };
    const after = zoomAbout(before, 2, pointer);

    const worldBefore = {
      x: (pointer.x - before.x) / before.zoom,
      y: (pointer.y - before.y) / before.zoom,
    };
    const worldAfter = {
      x: (pointer.x - after.x) / after.zoom,
      y: (pointer.y - after.y) / after.zoom,
    };

    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 6);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 6);
  });

  it('clamps the zoom range', () => {
    expect(zoomAbout(DEFAULT_VIEWPORT, 100, { x: 0, y: 0 }).zoom).toBeLessThanOrEqual(2.5);
    expect(zoomAbout(DEFAULT_VIEWPORT, 0.001, { x: 0, y: 0 }).zoom).toBeGreaterThanOrEqual(0.25);
  });

  it('frames content without magnifying past 100%', () => {
    const fitted = viewportForBounds(
      { x: 0, y: 0, width: 100, height: 100 },
      { width: 1000, height: 800 },
    );
    expect(fitted.zoom).toBe(1);
  });

  it('shrinks to fit content larger than the viewport', () => {
    const fitted = viewportForBounds(
      { x: 0, y: 0, width: 4000, height: 200 },
      { width: 800, height: 600 },
    );
    expect(fitted.zoom).toBeLessThan(1);
  });
});

/* ========================================================================== *
 * Store: undo/redo over real mutations
 * ========================================================================== */

describe('canvas store', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      graph: EMPTY_GRAPH,
      selection: { nodes: [], edges: [] },
      past: [],
      future: [],
      pendingMove: null,
    });
  });

  it('adds a node, selects it, and announces it', () => {
    const id = useCanvasStore.getState().addNode('base64', { x: 13, y: 21 });
    const state = useCanvasStore.getState();

    expect(state.graph.nodeOrder).toEqual([id]);
    // Snapped to the baseline grid on the way in.
    expect(state.graph.nodes[id]?.position).toEqual({ x: 16, y: 24 });
    expect(state.selection.nodes).toEqual([id]);
    expect(state.announcement.text).toContain('Added Base64');
  });

  it('undoes and redoes an add', () => {
    useCanvasStore.getState().addNode('base64', { x: 0, y: 0 });
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().graph.nodeOrder).toEqual([]);
    expect(useCanvasStore.getState().announcement.text).toBe('Undid add node.');

    useCanvasStore.getState().redo();
    expect(useCanvasStore.getState().graph.nodeOrder).toHaveLength(1);
  });

  it('coalesces consecutive nudges into one undo step', () => {
    const id = useCanvasStore.getState().addNode('base64', { x: 0, y: 0 });
    useCanvasStore.getState().select({ nodes: [id], edges: [] });

    for (let step = 0; step < 5; step += 1) {
      useCanvasStore.getState().nudgeNodes([id], { x: 8, y: 0 });
    }

    expect(useCanvasStore.getState().graph.nodes[id]?.position.x).toBe(40);
    // One add + one coalesced move.
    expect(useCanvasStore.getState().past).toHaveLength(2);

    useCanvasStore.getState().undo();
    // A single undo returns to where the run of nudges started.
    expect(useCanvasStore.getState().graph.nodes[id]?.position.x).toBe(0);
  });

  it('treats a pointer drag as one undo step', () => {
    const id = useCanvasStore.getState().addNode('base64', { x: 0, y: 0 });
    useCanvasStore.getState().select({ nodes: [id], edges: [] });

    useCanvasStore.getState().beginMove([id]);
    useCanvasStore.getState().dragMove({ x: 20, y: 0 });
    useCanvasStore.getState().dragMove({ x: 40, y: 0 });
    useCanvasStore.getState().dragMove({ x: 80, y: 40 });
    useCanvasStore.getState().endMove();

    expect(useCanvasStore.getState().graph.nodes[id]?.position).toEqual({ x: 80, y: 40 });
    expect(useCanvasStore.getState().past).toHaveLength(2);

    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().graph.nodes[id]?.position).toEqual({ x: 0, y: 0 });
  });

  it('deletes a node and its wires together, and brings both back', () => {
    const a = useCanvasStore.getState().addNode('base64', { x: 0, y: 0 });
    const b = useCanvasStore.getState().addNode('structured-data', { x: 400, y: 0 });
    useCanvasStore.getState().connect(out(a), into(b));

    expect(useCanvasStore.getState().graph.edgeOrder).toHaveLength(1);

    useCanvasStore.getState().select({ nodes: [a], edges: [] });
    useCanvasStore.getState().deleteSelection();
    expect(useCanvasStore.getState().graph.nodeOrder).toEqual([b]);
    expect(useCanvasStore.getState().graph.edgeOrder).toEqual([]);

    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().graph.nodeOrder).toContain(a);
    expect(useCanvasStore.getState().graph.edgeOrder).toHaveLength(1);
  });

  it('announces a refused connection with its reason', () => {
    const a = useCanvasStore.getState().addNode('base64', { x: 0, y: 0 });
    const result = useCanvasStore.getState().connect(out(a), into(a));

    expect(result.ok).toBe(false);
    expect(useCanvasStore.getState().announcement.text).toContain('Connection refused');
    expect(useCanvasStore.getState().announcement.text).toContain('itself');
    expect(useCanvasStore.getState().graph.edgeOrder).toEqual([]);
  });

  it('duplicates a selection, offset and reselected', () => {
    const a = useCanvasStore.getState().addNode('base64', { x: 0, y: 0 });
    useCanvasStore.getState().select({ nodes: [a], edges: [] });
    useCanvasStore.getState().duplicateSelection();

    const state = useCanvasStore.getState();
    expect(state.graph.nodeOrder).toHaveLength(2);
    expect(state.selection.nodes).not.toEqual([a]);
    const copyId = state.selection.nodes[0];
    expect(state.graph.nodes[copyId ?? '']?.position).toEqual({ x: 24, y: 24 });
  });

  it('drops the redo branch once a new action happens', () => {
    useCanvasStore.getState().addNode('base64', { x: 0, y: 0 });
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().future).toHaveLength(1);

    useCanvasStore.getState().addNode('structured-data', { x: 0, y: 0 });
    expect(useCanvasStore.getState().future).toHaveLength(0);
  });

  it('says so when there is nothing to undo', () => {
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().announcement.text).toBe('Nothing to undo.');
  });
});
