import type { PipelineState } from '@/features/execution/graph';
import { getManifestEntry } from '@/features/registry';

import { lossNotesOf } from './resultSummary';

import type { GraphData, NodeId } from './types';

/**
 * FOLLOWING A LOSS ALONG A WIRE.
 *
 * Round three put what a conversion lost on the face of the node that lost it.
 * That is right, and it stops at that node: wire a lossy JSON → CSV node into a
 * second node and the second one reads `ok` with nothing on its face, because
 * its OWN conversion lost nothing. The node holding the damaged value is silent
 * and the warning sits on the node whose output is one step behind it - and
 * three nodes along there is nothing at all.
 *
 * WHAT A DOWNSTREAM NODE CAN HONESTLY CLAIM, which is not what the node that
 * lost something claims. "The nested value at $[0].user was written into the
 * cell as JSON" is a fact about a conversion that happened. Nothing here can
 * say whether the damage is still IN the second node's output: a regex over a
 * flattened cell might never touch it, a hash of it is a hash of a document
 * that is not the original, and neither is knowable from a graph.
 *
 * What IS knowable, exactly and without guessing, is PROVENANCE: the value this
 * node worked from descends, through wires, from a conversion that lost
 * something. That is the claim, and it is the only one made. See
 * `CanvasNodeView` for how it is worded on screen - `after loss`, in the place
 * the node's own verdict goes, rather than as a second warning stacked on top
 * of one.
 *
 * TWO THINGS STOP IT BECOMING NOISE, and both are structural rather than a
 * judgement about how loud to be.
 *
 *   1. IT TRAVELS PER PORT, NOT PER NODE. A tool says which of its output ports
 *      a loss is in (`ToolNote.reaches`), and only wires leaving one of those
 *      carry it. `structured-data` is why: converting to CSV flattens a nested
 *      object in the WRITE half, so the damage is in `output` and `data` - the
 *      parsed source, the port whose description is "for wiring into another
 *      tool" - still holds the object. Wiring `data` onward is the way AROUND
 *      the loss, and a mark on it would be a warning on the workaround.
 *   2. IT REPLACES `ok`, IT DOES NOT ADD TO IT. A node says `ok`, `lossy` or
 *      `after loss` - one verdict, never two. So a canvas where half the nodes
 *      descend from a loss is a canvas where the other half say `ok`, and the
 *      contrast a person scans for is still there.
 *
 * A `report` port never carries it onward in either direction. That port holds
 * the DESCRIPTION of the run, not the document, so a node fed from it is not
 * holding a damaged value - it is holding the account of the damage.
 */

/** Where the value a node is working from was lost, if it was. */
export interface LossTrace {
  /** The nearest node upstream whose own run lost something. */
  readonly origin: NodeId;
  /** That node's tool, named as the manifest names it. */
  readonly toolName: string;
  /** That node's first loss, verbatim - the sentence it prints on its face. */
  readonly title: string;
  /**
   * How many distinct nodes upstream lost something.
   *
   * At least 1. The accessible name says "and N more" above one, for the same
   * reason `lossSummary` does: one whole sentence and a count beats two half
   * sentences at 224px.
   */
  readonly origins: number;
}

/** An origin and how many wires away it is, while the walk is still running. */
type Reached = ReadonlyMap<NodeId, number>;

const NONE: Reached = new Map<NodeId, number>();

/**
 * Every node's provenance, in one walk.
 *
 * Memoised per node and computed lazily from a node's predecessors, so the
 * whole graph costs one pass over the edges however the canvas is shaped.
 *
 * CYCLE-TOLERANT ON PURPOSE, where `topologicalOrder` throws. That function is
 * right to throw: it runs inside an executor, where a cycle means a connection
 * was made without the check that refuses one, and executing a subset of the
 * graph would hide a bug. This runs inside a RENDER, where the same throw would
 * take the canvas down and show the user a blank plane instead of the thing
 * they are trying to debug. Re-entering a node in progress contributes nothing
 * and the walk finishes.
 */
export function traceLosses(
  graph: GraphData,
  states: PipelineState,
): ReadonlyMap<NodeId, LossTrace> {
  /** Wires arriving at a node. Built once; `graph.edges` is keyed by edge id. */
  const incoming = new Map<NodeId, { readonly from: NodeId; readonly fromPortId: string }[]>();
  for (const edgeId of graph.edgeOrder) {
    const edge = graph.edges[edgeId];
    if (!edge) continue;
    const list = incoming.get(edge.to.nodeId) ?? [];
    list.push({ from: edge.from.nodeId, fromPortId: edge.from.portId });
    incoming.set(edge.to.nodeId, list);
  }

  /** Each node's own losses, by the port they are in. Computed at most once. */
  const ownCache = new Map<NodeId, ReadonlyMap<string, string>>();

  /** Port id -> the first loss title in it, for one node's own run. */
  function own(id: NodeId): ReadonlyMap<string, string> {
    const cached = ownCache.get(id);
    if (cached) return cached;

    const byPort = new Map<string, string>();
    const node = graph.nodes[id];
    const state = states[id];

    if (node && state?.status === 'ok') {
      const entry = getManifestEntry(node.toolId);
      for (const note of lossNotesOf(entry, state.outputs)) {
        for (const portId of note.reaches) {
          // The FIRST note in a port, not the last: `lossSummary` prints the
          // first on the node's face, and the two naming different losses for
          // the same node would be the second wording this codebase keeps
          // finding out of step with the first.
          if (!byPort.has(portId)) byPort.set(portId, note.title);
        }
      }
    }

    ownCache.set(id, byPort);
    return byPort;
  }

  /** Whether a port is the one that carries the ACCOUNT of a run, not its value. */
  function isReportPort(id: NodeId, portId: string): boolean {
    const node = graph.nodes[id];
    if (!node) return false;
    const entry = getManifestEntry(node.toolId);
    return entry.outputs.find((port) => port.id === portId)?.presentation === 'report';
  }

  const reachedCache = new Map<NodeId, Reached>();
  const inProgress = new Set<NodeId>();

  function reached(id: NodeId): Reached {
    const cached = reachedCache.get(id);
    if (cached) return cached;
    if (inProgress.has(id)) return NONE;

    inProgress.add(id);
    const found = new Map<NodeId, number>();

    /** Keeps the NEAREST distance to an origin, so "which loss" is the closest. */
    const add = (origin: NodeId, hops: number): void => {
      const existing = found.get(origin);
      if (existing === undefined || hops < existing) found.set(origin, hops);
    };

    for (const feed of incoming.get(id) ?? []) {
      // The account of a run is not the run's document. Nothing travels out of
      // a report port, in either sense: not the upstream node's own loss, and
      // not anything it inherited.
      if (isReportPort(feed.from, feed.fromPortId)) continue;

      // The upstream node's own loss, but only if it is in the port this wire
      // leaves from. This is the whole of "per port, not per node".
      if (own(feed.from).has(feed.fromPortId)) add(feed.from, 1);

      /*
       * And whatever the upstream node was already working from. Its own
       * `reaches` says nothing about this, and correctly: a tool declares where
       * ITS losses went, and it has no way to know its input was already
       * damaged. Everything a node produces descends from everything it was
       * given, so an inherited loss leaves by every port but the report.
       */
      for (const [origin, hops] of reached(feed.from)) add(origin, hops + 1);
    }

    inProgress.delete(id);
    reachedCache.set(id, found);
    return found;
  }

  const traces = new Map<NodeId, LossTrace>();
  /** The document's own order, as a lookup, so the tie-break below is not O(n). */
  const rankOf = new Map<NodeId, number>(graph.nodeOrder.map((id, index) => [id, index]));

  for (const id of graph.nodeOrder) {
    const found = reached(id);
    if (found.size === 0) continue;

    /*
     * The nearest origin, and `nodeOrder` breaks a tie.
     *
     * Not an arbitrary one: two wires into a diff node from two equally distant
     * lossy nodes would otherwise name whichever the edge order happened to put
     * first, and re-ordering an unrelated edge would change the sentence a node
     * reads. `nodeOrder` is the document's own stable order.
     */
    let best: NodeId | null = null;
    let bestHops = Number.POSITIVE_INFINITY;
    let bestRank = Number.POSITIVE_INFINITY;

    for (const [origin, hops] of found) {
      const rank = rankOf.get(origin) ?? Number.POSITIVE_INFINITY;
      if (hops < bestHops || (hops === bestHops && rank < bestRank)) {
        best = origin;
        bestHops = hops;
        bestRank = rank;
      }
    }

    if (best === null) continue;
    /* A const, so the predicate below narrows: `best` is reassigned in the loop. */
    const origin: NodeId = best;
    const node = graph.nodes[origin];
    if (!node) continue;

    /*
     * The title of the loss that reached THIS node, which is not always the
     * first loss the origin reported. A node whose report holds both a rounded
     * number (in `output` and `data`) and a flattened cell (in `output` alone)
     * says the flattened one on its own face; a wire from `data` carries the
     * rounded one, and naming the flattened one on that node would describe a
     * loss the value in front of it does not have.
     */
    const byPort = own(origin);
    const viaPort = (incoming.get(id) ?? []).find(
      (feed) => feed.from === origin && byPort.has(feed.fromPortId),
    );
    const title = (viaPort ? byPort.get(viaPort.fromPortId) : undefined) ?? firstTitle(byPort);
    if (title === null) continue;

    traces.set(id, {
      origin,
      toolName: getManifestEntry(node.toolId).name,
      title,
      origins: found.size,
    });
  }

  return traces;
}

/** The first loss any port of a node carries, for an origin several hops back. */
function firstTitle(byPort: ReadonlyMap<string, string>): string | null {
  for (const title of byPort.values()) return title;
  return null;
}
