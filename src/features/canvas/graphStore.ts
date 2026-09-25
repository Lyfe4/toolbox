import { create } from 'zustand';

import { getManifestEntry, type ToolId } from '@/features/registry';
import {
  appendAnnouncement,
  EMPTY_ANNOUNCEMENTS,
  type Announcement,
  type AnnouncementSlice,
} from '@/lib/announce';
import { counted } from '@/lib/plural';

import { useAttachmentStore } from './attachmentStore';
import { applyCommand, describeCommand, revertCommand, type Command } from './commands';
import { checkConnection, edgesTouching } from './connections';
import { GRID, snapPoint, snapToGrid } from './geometry';
import { getPreset, instantiatePreset } from './presets';
import {
  EMPTY_GRAPH,
  type CanvasEdge,
  type ConnectionCheck,
  type EdgeId,
  type FileInputRef,
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
 * WHAT THE LAST STRUCTURAL ACTION CREATED, for the motion that acknowledges it.
 *
 * A wire drawing itself in, a node settling, a port flicking and a timing
 * figure counting up are all answers to one question - "did the thing I just
 * did happen?" - so they share one trigger, and it is an EVENT rather than a
 * duration: nodes here run in 1-8ms, under a frame, and nothing tied to how
 * long something took would ever be seen.
 *
 * Written only by the four actions that create something - adding a node,
 * a preset, a duplicate, a wire - and never by undo, redo or loading a
 * document. Those restore things rather than make them, and a canvas of
 * forty nodes all settling at once on every reload is exactly the consumer
 * app this is not. `seq` is the identity of one arrival: two in a row on the
 * same port are two flicks, which a boolean could not say.
 */
export interface Arrivals {
  readonly seq: number;
  readonly nodes: readonly NodeId[];
  /**
   * Whole edges rather than ids, so the ports a wire touches are known without
   * looking the wire up in a graph that is replaced on every frame of a drag.
   */
  readonly edges: readonly CanvasEdge[];
}

const NO_ARRIVALS: Arrivals = { seq: 0, nodes: [], edges: [] };

export type { Announcement };

/**
 * Groups the position chatter a held arrow key produces.
 *
 * Every repeat announces, and reading all of them would leave a screen-reader
 * user hearing where the node used to be for seconds after it stopped. Queued
 * messages on this channel supersede one another; anything already spoken is
 * left alone. See `@/lib/announce`.
 */
const MOVE_CHANNEL = 'canvas-move';

export interface CanvasStore extends AnnouncementSlice {
  readonly graph: GraphData;
  readonly selection: Selection;
  readonly past: readonly Command[];
  readonly future: readonly Command[];
  readonly arrivals: Arrivals;
  /**
   * The nodes whose NEXT timing figure may count up: the ones the latest
   * arrival added, or landed a wire on.
   *
   * Emptied by any change to a value - typed input, an option, a file -
   * anywhere on the canvas, so nothing counts while somebody is typing: a
   * node added blocked and then fed by the keyboard would otherwise count up
   * on the first keystroke's run, which is the one moment motion must not
   * happen. Its own field rather than part of `arrivals`, so disarming it does
   * not hand the wire layer a new arrival and start a finished draw again.
   */
  readonly countArmed: readonly NodeId[];
  /** Set while a pointer drag is in flight, so it becomes one undo step. */
  readonly pendingMove: {
    readonly ids: readonly NodeId[];
    readonly from: Record<NodeId, Point>;
  } | null;

  readonly announce: (text: string, channel?: string) => void;
  readonly addNode: (toolId: ToolId, position: Point) => NodeId;
  readonly duplicateSelection: () => void;
  readonly applyPreset: (presetId: string, origin: Point) => void;
  readonly deleteSelection: () => void;
  readonly nudgeNodes: (ids: readonly NodeId[], delta: Point) => void;
  readonly beginMove: (ids: readonly NodeId[]) => void;
  readonly dragMove: (delta: Point) => void;
  readonly endMove: () => void;
  readonly connect: (from: PortRef, to: PortRef) => ConnectionCheck;
  readonly removeEdges: (ids: readonly EdgeId[]) => void;
  /**
   * `coalesce` merges this into the previous options change on the same node,
   * so typing into an option field is one undo step rather than one per
   * keystroke. See `setNodeOptions` below.
   */
  readonly setNodeOptions: (
    nodeId: NodeId,
    options: Readonly<Record<string, unknown>>,
    coalesce?: boolean,
  ) => void;
  readonly setNodeInput: (nodeId: NodeId, portId: string, value: string) => void;
  /**
   * Records or clears the file on an input port.
   *
   * The BYTES are not here - they are in `attachmentStore`, and the caller has
   * already put them there. This writes only what the document may keep: a
   * name, a size and a token.
   */
  readonly setNodeFile: (nodeId: NodeId, portId: string, ref: FileInputRef | null) => void;
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

    /*
     * The same merge for options, and for the same reason.
     *
     * Options are a graph edit on the canvas - they are part of the document,
     * they travel in a share link, and they belong in the undo history. That
     * makes typing a regex pattern into the inspector one history entry per
     * KEYSTROKE, which buries whatever the user actually wants to undo under
     * forty steps of their own typing.
     *
     * Merging keeps the OLDER `from`, so one undo returns to the value before
     * the run of edits began - the same inverse a coalesced drag has. The
     * caller decides when to ask: the inspector merges text and number fields
     * and never merges a toggle or a select, because a discrete choice is a
     * deliberate act worth its own step.
     */
    if (
      coalesce &&
      command.kind === 'set-options' &&
      top?.kind === 'set-options' &&
      top.nodeId === command.nodeId
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

  /*
   * Appends to a LOG rather than overwriting a single value.
   *
   * Two announcements in one React batch used to produce one render carrying
   * only the second, so the first was gone before any element had held it.
   * The log is what `LiveRegion` drains, one message at a time - see
   * `@/lib/announce` for why this is one problem rather than the several
   * unrelated-looking ones it kept being mistaken for.
   */
  const announce = (text: string, channel?: string): void => {
    set((state) => appendAnnouncement(state, text, channel));
  };

  const arrive = (
    nodes: readonly NodeId[],
    edges: readonly CanvasEdge[],
    timing: readonly NodeId[],
  ): void => {
    set((state) => ({
      arrivals: { seq: state.arrivals.seq + 1, nodes, edges },
      countArmed: timing,
    }));
  };

  /**
   * Undo, redo and a replaced document retire the last arrival rather than
   * leave it standing: a node id restored by redo, or reused by the next
   * document - every canvas starts at `n1` - must not inherit an arrival that
   * was about something else.
   */
  const retireArrivals = (): void => {
    arrive([], [], []);
  };

  /** A value edit ends every pending count-up. See `countArmed`. */
  const disarmTiming = (): void => {
    if (get().countArmed.length === 0) return;
    set({ countArmed: [] });
  };

  return {
    graph: EMPTY_GRAPH,
    selection: NO_SELECTION,
    past: [],
    future: [],
    arrivals: NO_ARRIVALS,
    countArmed: [],
    ...EMPTY_ANNOUNCEMENTS,
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
          inputs: {},
          fileInputs: {},
        },
      });

      set({ selection: { nodes: [id], edges: [] } });
      arrive([id], [], [id]);
      announce(`Added ${entry.name}. Selected.`);
      return id;
    },

    applyPreset: (presetId, origin) => {
      const preset = getPreset(presetId);
      if (!preset) return;

      const { graph } = get();
      const { nodes, edges } = instantiatePreset(preset, snapPoint(origin), graph.nextId);

      push({ kind: 'add-subgraph', label: preset.name, nodes, edges });
      const ids = nodes.map((node) => node.id);
      set({ selection: { nodes: ids, edges: [] } });
      arrive(ids, edges, ids);
      announce(
        `Loaded the ${preset.name} pipeline: ${nodes.length.toString()} nodes, ${edges.length.toString()} wires. No data included.`,
      );
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

        /*
         * A DUPLICATE GETS THE ORIGINAL'S FILES TOO.
         *
         * `...source` copies `fileInputs`, which names files the attachment
         * store holds under the SOURCE node's id - so without this the copy
         * would claim a file it could not produce and sit there as though the
         * canvas had been reloaded. The value is immutable and handed to the
         * engine by borrow, so two nodes sharing one is not a hazard; it is the
         * same fan-out a wire into two inputs already is.
         *
         * The token `attach` issues is deliberately discarded: the copy carries
         * the SOURCE's reference, and it is the same file, so it should hash to
         * the same cache key rather than to a new one.
         */
        const attachments = useAttachmentStore.getState();
        for (const portId of Object.keys(source.fileInputs)) {
          const loaded = attachments.attachmentFor(sourceId, portId);
          if (loaded) attachments.attach(id, portId, loaded);
        }

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
          },
        });
      }

      if (created.length === 0) return;
      set({ selection: { nodes: created, edges: [] } });
      arrive(created, [], created);
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
      announce(`Deleted ${counted(removed, 'item')}.`);
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
        MOVE_CHANNEL,
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
        MOVE_CHANNEL,
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
      // The node the wire lands on is the one that runs because of it.
      arrive([], [{ id, from, to }], [to.nodeId]);

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
      announce(`Removed ${counted(edges.length, 'wire')}.`);
    },

    setNodeOptions: (nodeId, options, coalesce = false) => {
      const node = get().graph.nodes[nodeId];
      if (!node) return;
      disarmTiming();
      push({ kind: 'set-options', nodeId, from: node.options, to: options }, coalesce);
    },

    setNodeInput: (nodeId, portId, value) => {
      // Typing is not an undo step: it would put one entry in the history per
      // keystroke. The text is user data that is saved locally anyway.
      const node = get().graph.nodes[nodeId];
      if (!node || node.inputs[portId] === value) return;
      disarmTiming();

      set((state) => ({
        graph: {
          ...state.graph,
          nodes: {
            ...state.graph.nodes,
            [nodeId]: { ...node, inputs: { ...node.inputs, [portId]: value } },
          },
        },
      }));
    },

    /*
     * CHOOSING A FILE IS NOT AN UNDO STEP, for the reason typing is not: it is
     * input data rather than a change to the pipeline's shape, and `inputs`
     * established that input stays out of the history. It would also be an
     * entry undo could not honour once the session ended - the reference would
     * come back pointing at bytes nothing holds - so the one thing an undoable
     * version would add is a step that sometimes cannot be taken.
     */
    setNodeFile: (nodeId, portId, ref) => {
      const node = get().graph.nodes[nodeId];
      if (!node) return;
      disarmTiming();

      // Filtered rather than deleted: a computed `delete` is what the lint
      // rules refuse, and rebuilding says exactly which key is going.
      const fileInputs: Record<string, FileInputRef> = Object.fromEntries(
        Object.entries(node.fileInputs).filter(([id]) => id !== portId),
      );
      if (ref !== null) fileInputs[portId] = ref;

      set((state) => ({
        graph: {
          ...state.graph,
          nodes: { ...state.graph.nodes, [nodeId]: { ...node, fileInputs } },
        },
      }));
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
      retireArrivals();
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
      retireArrivals();
      announce(`Redid ${describeCommand(command)}.`);
    },

    replaceGraph: (graph) => {
      /*
       * EVERY FILE GOES WITH THE GRAPH THAT WAS HOLDING IT.
       *
       * Node ids are reused across documents - every canvas starts at `n1` -
       * so an attachment surviving a replacement would silently hand the
       * previous canvas's file to whatever the new one happens to call `n1`.
       * That is the same reasoning `pipelineStore.reset` already follows for
       * results, and here it would be worse than a stale answer: it is one
       * user's data appearing in a pipeline somebody else shared with them.
       */
      useAttachmentStore.getState().resetAttachments();

      // Loading a saved graph is not an undoable step: there is nothing
      // sensible to go back to, and keeping the history would let undo
      // "delete" a graph the user never created in this session.
      set({ graph, selection: NO_SELECTION, past: [], future: [] });
      retireArrivals();
    },
  };
});
