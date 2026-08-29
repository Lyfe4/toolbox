import { create } from 'zustand';

import { getManifestEntry, type ToolId } from '@/features/registry';

import { applyCommand, describeCommand, revertCommand, type Command } from './commands';
import { checkConnection, edgesTouching } from './connections';
import { GRID, snapPoint, snapToGrid } from './geometry';
import {
  EMPTY_GRAPH,
  type CanvasEdge,
  type ConnectionCheck,
  type EdgeId,
  type GraphData,
  type NodeId,
  type Point,
  type PortRef,
} from './types';

/** What is currently selected. Nodes and wires are selected independently. */
export interface Selection {
  readonly nodes: readonly NodeId[];
  readonly edges: readonly EdgeId[];
}

const NO_SELECTION: Selection = { nodes: [], edges: [] };

/**
 * A message for the canvas live region.
 *
 * `seq` increments on every announcement so that saying the same thing twice
 * in a row still re-renders and is therefore re-announced - a live region that
 * receives identical text is silent.
 */
export interface Announcement {
  readonly text: string;
  readonly seq: number;
}

export interface CanvasStore {
  readonly graph: GraphData;
  readonly selection: Selection;
  readonly past: readonly Command[];
  readonly future: readonly Command[];
  readonly announcement: Announcement;
  /** Set while a pointer drag is in flight, so it becomes one undo step. */
  readonly pendingMove: {
    readonly ids: readonly NodeId[];
    readonly from: Record<NodeId, Point>;
  } | null;

  readonly announce: (text: string) => void;
  readonly addNode: (toolId: ToolId, position: Point) => NodeId;
  readonly duplicateSelection: () => void;
  readonly deleteSelection: () => void;
  readonly nudgeNodes: (ids: readonly NodeId[], delta: Point) => void;
  readonly beginMove: (ids: readonly NodeId[]) => void;
  readonly dragMove: (delta: Point) => void;
  readonly endMove: () => void;
  readonly connect: (from: PortRef, to: PortRef) => ConnectionCheck;
  readonly removeEdges: (ids: readonly EdgeId[]) => void;
  readonly setNodeOptions: (nodeId: NodeId, options: Readonly<Record<string, unknown>>) => void;
  readonly select: (selection: Partial<Selection>) => void;
  readonly toggleNode: (id: NodeId) => void;
  readonly clearSelection: () => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly replaceGraph: (graph: GraphData) => void;
}

function sameIds(a: readonly NodeId[], b: readonly NodeId[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export const useCanvasStore = create<CanvasStore>()((set, get) => {
  /**
   * Pushes a command onto the history and applies it.
   *
   * `coalesce` merges consecutive moves of the same selection into one entry,
   * so holding an arrow key is a single undo rather than forty. That merge is
   * only possible because the history stores semantic commands: two snapshots
   * cannot be combined, but two moves of the same nodes obviously can.
   */
  const push = (command: Command, coalesce = false): void => {
    const state = get();
    const top = state.past[state.past.length - 1];

    if (
      coalesce &&
      command.kind === 'move-nodes' &&
      top?.kind === 'move-nodes' &&
      sameIds(top.ids, command.ids)
    ) {
      const merged: Command = { ...command, from: top.from };
      set({
        graph: applyCommand(state.graph, command),
        past: [...state.past.slice(0, -1), merged],
        future: [],
      });
      return;
    }

    set({
      graph: applyCommand(state.graph, command),
      past: [...state.past, command],
      // Any new action abandons the redo branch, which is the standard and
      // least surprising behaviour.
      future: [],
    });
  };

  const announce = (text: string): void => {
    set((state) => ({ announcement: { text, seq: state.announcement.seq + 1 } }));
  };

  return {
    graph: EMPTY_GRAPH,
    selection: NO_SELECTION,
    past: [],
    future: [],
    announcement: { text: '', seq: 0 },
    pendingMove: null,

    announce,

    addNode: (toolId, position) => {
      const { graph } = get();
      const id: NodeId = `n${graph.nextId.toString()}`;
      const entry = getManifestEntry(toolId);

      push({
        kind: 'add-node',
        node: {
          id,
          toolId,
          position: snapPoint(position),
          options: {},
          status: 'idle',
        },
      });

      set({ selection: { nodes: [id], edges: [] } });
      announce(`Added ${entry.name}. Selected.`);
      return id;
    },

    duplicateSelection: () => {
      const { graph, selection } = get();
      if (selection.nodes.length === 0) return;

      const created: NodeId[] = [];
      let counter = graph.nextId;

      for (const sourceId of selection.nodes) {
        const source = graph.nodes[sourceId];
        if (!source) continue;

        const id: NodeId = `n${counter.toString()}`;
        counter += 1;
        created.push(id);

        push({
          kind: 'add-node',
          node: {
            ...source,
            id,
            // Offset by two grid units so the copy is visibly not the original.
            position: snapPoint({
              x: source.position.x + GRID * 3,
              y: source.position.y + GRID * 3,
            }),
            status: 'idle',
          },
        });
      }

      if (created.length === 0) return;
      set({ selection: { nodes: created, edges: [] } });
      announce(
        created.length === 1
          ? 'Duplicated node.'
          : `Duplicated ${created.length.toString()} nodes.`,
      );
    },

    deleteSelection: () => {
      const { graph, selection } = get();
      if (selection.nodes.length === 0 && selection.edges.length === 0) return;

      if (selection.edges.length > 0) {
        const edges = selection.edges
          .map((id) => graph.edges[id])
          .filter((edge): edge is CanvasEdge => edge !== undefined);
        if (edges.length > 0) {
          push({
            kind: 'remove-edges',
            edges,
            edgeIndices: edges.map((edge) => graph.edgeOrder.indexOf(edge.id)),
          });
        }
      }

      if (selection.nodes.length > 0) {
        const nodes = selection.nodes
          .map((id) => graph.nodes[id])
          .filter((node) => node !== undefined);
        // Wires attached to a deleted node go with it, and come back with it.
        const current = get().graph;
        const edges = edgesTouching(current, selection.nodes);
        if (nodes.length > 0) {
          push({
            kind: 'remove-nodes',
            nodes,
            nodeIndices: nodes.map((node) => current.nodeOrder.indexOf(node.id)),
            edges,
            edgeIndices: edges.map((edge) => current.edgeOrder.indexOf(edge.id)),
          });
        }
      }

      const removed = selection.nodes.length + selection.edges.length;
      set({ selection: NO_SELECTION });
      announce(`Deleted ${removed.toString()} ${removed === 1 ? 'item' : 'items'}.`);
    },

    nudgeNodes: (ids, delta) => {
      const { graph } = get();
      const from: Record<NodeId, Point> = {};
      const to: Record<NodeId, Point> = {};

      for (const id of ids) {
        const node = graph.nodes[id];
        if (!node) continue;
        from[id] = node.position;
        to[id] = {
          x: snapToGrid(node.position.x + delta.x),
          y: snapToGrid(node.position.y + delta.y),
        };
      }

      const moved = Object.keys(to);
      if (moved.length === 0) return;

      push({ kind: 'move-nodes', ids: moved, from, to }, true);

      const first = moved[0];
      const position = first === undefined ? undefined : to[first];
      announce(
        moved.length === 1 && position
          ? `Moved to ${position.x.toString()}, ${position.y.toString()}.`
          : `Moved ${moved.length.toString()} nodes.`,
      );
    },

    beginMove: (ids) => {
      const { graph } = get();
      const from: Record<NodeId, Point> = {};
      for (const id of ids) {
        const node = graph.nodes[id];
        if (node) from[id] = node.position;
      }
      set({ pendingMove: { ids: Object.keys(from), from } });
    },

    dragMove: (delta) => {
      const { pendingMove, graph } = get();
      if (!pendingMove) return;

      const nodes = { ...graph.nodes };
      for (const id of pendingMove.ids) {
        const start = pendingMove.from[id];
        const node = nodes[id];
        if (!start || !node) continue;
        nodes[id] = {
          ...node,
          position: {
            x: snapToGrid(start.x + delta.x),
            y: snapToGrid(start.y + delta.y),
          },
        };
      }

      // Applied directly, outside the history: a drag is one command, pushed
      // once when the pointer is released.
      set({ graph: { ...graph, nodes } });
    },

    endMove: () => {
      const { pendingMove, graph } = get();
      if (!pendingMove) return;

      const to: Record<NodeId, Point> = {};
      let changed = false;

      for (const id of pendingMove.ids) {
        const node = graph.nodes[id];
        const start = pendingMove.from[id];
        if (!node || !start) continue;
        to[id] = node.position;
        if (node.position.x !== start.x || node.position.y !== start.y) changed = true;
      }

      set({ pendingMove: null });
      if (!changed) return;

      // Rewind to the start, then push the whole move as one command so that
      // undo returns to where the drag began.
      set({
        graph: {
          ...graph,
          nodes: Object.fromEntries(
            Object.entries(graph.nodes).map(([id, node]) => {
              const start = pendingMove.from[id];
              return start ? [id, { ...node, position: start }] : [id, node];
            }),
          ),
        },
      });

      push({ kind: 'move-nodes', ids: pendingMove.ids, from: pendingMove.from, to });
      announce(
        pendingMove.ids.length === 1
          ? 'Moved node.'
          : `Moved ${pendingMove.ids.length.toString()} nodes.`,
      );
    },

    connect: (from, to) => {
      const { graph } = get();
      const check = checkConnection(graph, from, to);

      if (!check.ok) {
        announce(`Connection refused. ${check.rejection.message}`);
        return check;
      }

      const id: EdgeId = `e${graph.nextId.toString()}`;
      push({ kind: 'add-edge', edge: { id, from, to } });

      const fromNode = graph.nodes[from.nodeId];
      const toNode = graph.nodes[to.nodeId];
      const fromName = fromNode ? getManifestEntry(fromNode.toolId).name : 'node';
      const toName = toNode ? getManifestEntry(toNode.toolId).name : 'node';
      announce(`Connected ${fromName} to ${toName}.`);

      return check;
    },

    removeEdges: (ids) => {
      const { graph } = get();
      const edges = ids
        .map((id) => graph.edges[id])
        .filter((edge): edge is CanvasEdge => edge !== undefined);
      if (edges.length === 0) return;

      push({
        kind: 'remove-edges',
        edges,
        edgeIndices: edges.map((edge) => graph.edgeOrder.indexOf(edge.id)),
      });
      announce(`Removed ${edges.length.toString()} ${edges.length === 1 ? 'wire' : 'wires'}.`);
    },

    setNodeOptions: (nodeId, options) => {
      const node = get().graph.nodes[nodeId];
      if (!node) return;
      push({ kind: 'set-options', nodeId, from: node.options, to: options });
    },

    select: (selection) => {
      set((state) => ({
        selection: {
          nodes: selection.nodes ?? state.selection.nodes,
          edges: selection.edges ?? state.selection.edges,
        },
      }));
    },

    toggleNode: (id) => {
      set((state) => {
        const present = state.selection.nodes.includes(id);
        return {
          selection: {
            nodes: present
              ? state.selection.nodes.filter((other) => other !== id)
              : [...state.selection.nodes, id],
            edges: [],
          },
        };
      });
    },

    clearSelection: () => {
      set({ selection: NO_SELECTION });
    },

    undo: () => {
      const state = get();
      const command = state.past[state.past.length - 1];
      if (!command) {
        announce('Nothing to undo.');
        return;
      }

      set({
        graph: revertCommand(state.graph, command),
        past: state.past.slice(0, -1),
        future: [command, ...state.future],
        selection: NO_SELECTION,
      });
      announce(`Undid ${describeCommand(command)}.`);
    },

    redo: () => {
      const state = get();
      const command = state.future[0];
      if (!command) {
        announce('Nothing to redo.');
        return;
      }

      set({
        graph: applyCommand(state.graph, command),
        past: [...state.past, command],
        future: state.future.slice(1),
        selection: NO_SELECTION,
      });
      announce(`Redid ${describeCommand(command)}.`);
    },

    replaceGraph: (graph) => {
      // Loading a saved graph is not an undoable step: there is nothing
      // sensible to go back to, and keeping the history would let undo
      // "delete" a graph the user never created in this session.
      set({ graph, selection: NO_SELECTION, past: [], future: [] });
    },
  };
});

/** Convenience selectors, so components subscribe to as little as possible. */
export const selectGraph = (state: CanvasStore): GraphData => state.graph;
export const selectSelection = (state: CanvasStore): Selection => state.selection;
