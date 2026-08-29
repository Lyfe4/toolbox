import type { CanvasEdge, CanvasNode, EdgeId, GraphData, NodeId, Point } from './types';

/**
 * UNDO/REDO AS A COMMAND HISTORY
 *
 * Every mutation is described by a small object holding exactly the data
 * needed to do it and to take it back. The history is a list of those objects
 * plus a cursor; undo walks the cursor back applying `revert`, redo walks it
 * forward applying `apply`.
 *
 * Why not snapshots? The obvious alternative is to deep-copy the whole graph
 * before each change and keep a stack of copies. That is simpler to write but:
 *
 *   - Memory is O(graph size) per step rather than O(change size). Nudging one
 *     node by 8px would clone every node, every edge and every options object;
 *     a fifty-node graph makes that hundreds of kilobytes per keystroke.
 *   - It throws away meaning. A snapshot cannot tell you what changed, so the
 *     UI cannot say "Undo: move 3 nodes" - and this canvas has to announce
 *     exactly that to a screen reader.
 *   - Coalescing becomes guesswork. A drag produces one command that can be
 *     amended in place while the pointer is down, so a drag is one undo step
 *     rather than sixty.
 *
 * The cost is that each command must be written with a correct inverse, and
 * that is what the tests in commands.test.ts check: apply-then-revert must
 * return the graph to a deeply equal state, for every command kind.
 */

export type Command =
  | { readonly kind: 'add-node'; readonly node: CanvasNode }
  | {
      readonly kind: 'remove-nodes';
      readonly nodes: readonly CanvasNode[];
      /**
       * Where each node sat in nodeOrder. Recorded so undo puts it back in the
       * same place rather than at the end - an inverse that only restores the
       * VALUES is not actually an inverse.
       */
      readonly nodeIndices: readonly number[];
      /** Edges that were attached to those nodes, restored together on undo. */
      readonly edges: readonly CanvasEdge[];
      readonly edgeIndices: readonly number[];
    }
  | {
      readonly kind: 'move-nodes';
      readonly ids: readonly NodeId[];
      readonly from: Readonly<Record<NodeId, Point>>;
      readonly to: Readonly<Record<NodeId, Point>>;
    }
  | { readonly kind: 'add-edge'; readonly edge: CanvasEdge }
  | {
      readonly kind: 'remove-edges';
      readonly edges: readonly CanvasEdge[];
      readonly edgeIndices: readonly number[];
    }
  | {
      readonly kind: 'set-options';
      readonly nodeId: NodeId;
      readonly from: Readonly<Record<string, unknown>>;
      readonly to: Readonly<Record<string, unknown>>;
    };

/** A short human description, used for the undo announcement. */
export function describeCommand(command: Command): string {
  switch (command.kind) {
    case 'add-node':
      return 'add node';
    case 'remove-nodes':
      return command.nodes.length === 1
        ? 'delete node'
        : `delete ${command.nodes.length.toString()} nodes`;
    case 'move-nodes':
      return command.ids.length === 1 ? 'move node' : `move ${command.ids.length.toString()} nodes`;
    case 'add-edge':
      return 'connect';
    case 'remove-edges':
      return command.edges.length === 1
        ? 'disconnect'
        : `remove ${command.edges.length.toString()} connections`;
    case 'set-options':
      return 'change options';
  }
}

/* -------------------------------------------------------------------------- *
 * Primitive graph operations
 * -------------------------------------------------------------------------- */

function withNode(graph: GraphData, node: CanvasNode, index?: number): GraphData {
  const present = node.id in graph.nodes;
  const order = present ? graph.nodeOrder : insertAt(graph.nodeOrder, node.id, index);

  return {
    ...graph,
    nodes: { ...graph.nodes, [node.id]: node },
    nodeOrder: order,
    nextId: Math.max(graph.nextId, numericSuffix(node.id) + 1),
  };
}

/** Appends when no index is given, so ordinary creation stays append-only. */
function insertAt(order: readonly string[], id: string, index?: number): readonly string[] {
  if (index === undefined || index < 0 || index > order.length) return [...order, id];
  return [...order.slice(0, index), id, ...order.slice(index)];
}

function withoutNodes(graph: GraphData, ids: readonly NodeId[]): GraphData {
  const removing = new Set(ids);
  // Rebuilt by filtering rather than by deleting keys: `delete` on a computed
  // key deoptimises the object's shape, and this runs on every deletion.
  const nodes = Object.fromEntries(Object.entries(graph.nodes).filter(([id]) => !removing.has(id)));

  return {
    ...graph,
    nodes,
    nodeOrder: graph.nodeOrder.filter((id) => !removing.has(id)),
  };
}

function withEdge(graph: GraphData, edge: CanvasEdge, index?: number): GraphData {
  const present = edge.id in graph.edges;
  const order = present ? graph.edgeOrder : insertAt(graph.edgeOrder, edge.id, index);

  return {
    ...graph,
    edges: { ...graph.edges, [edge.id]: edge },
    edgeOrder: order,
    nextId: Math.max(graph.nextId, numericSuffix(edge.id) + 1),
  };
}

function withoutEdges(graph: GraphData, ids: readonly EdgeId[]): GraphData {
  const removing = new Set(ids);
  const edges = Object.fromEntries(Object.entries(graph.edges).filter(([id]) => !removing.has(id)));

  return {
    ...graph,
    edges,
    edgeOrder: graph.edgeOrder.filter((id) => !removing.has(id)),
  };
}

/** Ids look like "n12" / "e3"; this reads the number back off one. */
function numericSuffix(id: string): number {
  const parsed = Number.parseInt(id.slice(1), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function movedNodes(
  graph: GraphData,
  ids: readonly NodeId[],
  positions: Readonly<Record<NodeId, Point>>,
): GraphData {
  const nodes = { ...graph.nodes };

  for (const id of ids) {
    const node = nodes[id];
    const position = positions[id];
    if (!node || !position) continue;
    nodes[id] = { ...node, position };
  }

  return { ...graph, nodes };
}

/* -------------------------------------------------------------------------- *
 * apply / revert
 * -------------------------------------------------------------------------- */

export function applyCommand(graph: GraphData, command: Command): GraphData {
  switch (command.kind) {
    case 'add-node':
      return withNode(graph, command.node);

    case 'remove-nodes':
      return withoutEdges(
        withoutNodes(
          graph,
          command.nodes.map((node) => node.id),
        ),
        command.edges.map((edge) => edge.id),
      );

    case 'move-nodes':
      return movedNodes(graph, command.ids, command.to);

    case 'add-edge':
      return withEdge(graph, command.edge);

    case 'remove-edges':
      return withoutEdges(
        graph,
        command.edges.map((edge) => edge.id),
      );

    case 'set-options': {
      const node = graph.nodes[command.nodeId];
      if (!node) return graph;
      return {
        ...graph,
        nodes: { ...graph.nodes, [command.nodeId]: { ...node, options: command.to } },
      };
    }
  }
}

export function revertCommand(graph: GraphData, command: Command): GraphData {
  switch (command.kind) {
    case 'add-node':
      return withoutNodes(graph, [command.node.id]);

    case 'remove-nodes': {
      // Nodes first, then their edges: an edge with no endpoints would be
      // invalid for the instant between the two steps. Both go back at the
      // index they came from, lowest first so later indices stay correct.
      let next = graph;
      const nodes = command.nodes.map((node, i) => ({ node, index: command.nodeIndices[i] }));
      for (const { node, index } of [...nodes].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))) {
        next = withNode(next, node, index);
      }
      const edges = command.edges.map((edge, i) => ({ edge, index: command.edgeIndices[i] }));
      for (const { edge, index } of [...edges].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))) {
        next = withEdge(next, edge, index);
      }
      return next;
    }

    case 'move-nodes':
      return movedNodes(graph, command.ids, command.from);

    case 'add-edge':
      return withoutEdges(graph, [command.edge.id]);

    case 'remove-edges': {
      let next = graph;
      const edges = command.edges.map((edge, i) => ({ edge, index: command.edgeIndices[i] }));
      for (const { edge, index } of [...edges].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))) {
        next = withEdge(next, edge, index);
      }
      return next;
    }

    case 'set-options': {
      const node = graph.nodes[command.nodeId];
      if (!node) return graph;
      return {
        ...graph,
        nodes: { ...graph.nodes, [command.nodeId]: { ...node, options: command.from } },
      };
    }
  }
}
