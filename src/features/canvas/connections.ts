import { canConnect, getManifestEntry, type InputPort, type OutputPort } from '@/features/registry';

import type {
  CanvasEdge,
  ConnectionCheck,
  ConnectionRejection,
  GraphData,
  NodeId,
  PortRef,
} from './types';

/**
 * Connection rules.
 *
 * Every refusal carries a written reason. A canvas that simply refuses to
 * accept a wire, with no explanation, is unusable for everyone and completely
 * opaque to a screen-reader user - so the reason is part of the return value,
 * not something the UI has to guess at.
 */

function reject(rejection: ConnectionRejection): ConnectionCheck {
  return { ok: false, rejection };
}

/** The output port an edge leaves from, or null if it does not exist. */
export function outputPortOf(graph: GraphData, ref: PortRef): OutputPort | null {
  const node = graph.nodes[ref.nodeId];
  if (!node) return null;
  return getManifestEntry(node.toolId).outputs.find((port) => port.id === ref.portId) ?? null;
}

/** The input port an edge arrives at, or null if it does not exist. */
export function inputPortOf(graph: GraphData, ref: PortRef): InputPort | null {
  const node = graph.nodes[ref.nodeId];
  if (!node) return null;
  return getManifestEntry(node.toolId).inputs.find((port) => port.id === ref.portId) ?? null;
}

/** The edge already occupying an input port, if any. */
export function edgeInto(graph: GraphData, ref: PortRef): CanvasEdge | null {
  for (const id of graph.edgeOrder) {
    const edge = graph.edges[id];
    if (edge?.to.nodeId === ref.nodeId && edge.to.portId === ref.portId) return edge;
  }
  return null;
}

/** Every node reachable downstream of `start`, following edges forwards. */
function reachableFrom(graph: GraphData, start: NodeId): ReadonlySet<NodeId> {
  const seen = new Set<NodeId>();
  const stack: NodeId[] = [start];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);

    for (const id of graph.edgeOrder) {
      const edge = graph.edges[id];
      if (edge?.from.nodeId === current) stack.push(edge.to.nodeId);
    }
  }

  return seen;
}

/**
 * Would wiring `from` into `to` be legal?
 *
 * Checked in order of cheapness, so the common refusals do no graph walking.
 * The cycle test is last because it is the only one that traverses.
 */
export function checkConnection(graph: GraphData, from: PortRef, to: PortRef): ConnectionCheck {
  if (from.nodeId === to.nodeId) {
    return reject({ reason: 'same-node', message: 'A node cannot be wired to itself.' });
  }

  const output = outputPortOf(graph, from);
  const input = inputPortOf(graph, to);
  if (!output || !input) {
    return reject({ reason: 'type-mismatch', message: 'That port no longer exists.' });
  }

  for (const id of graph.edgeOrder) {
    const edge = graph.edges[id];
    if (
      edge?.from.nodeId === from.nodeId &&
      edge.from.portId === from.portId &&
      edge.to.nodeId === to.nodeId &&
      edge.to.portId === to.portId
    ) {
      return reject({ reason: 'duplicate', message: 'Those ports are already connected.' });
    }
  }

  if (!canConnect(output, input)) {
    return reject({
      reason: 'type-mismatch',
      message: `${output.label} carries ${output.types.join(' or ')}, and ${input.label} accepts ${input.types.join(' or ')}.`,
    });
  }

  if (edgeInto(graph, to) !== null) {
    return reject({
      reason: 'occupied',
      message: `${input.label} already has a connection. Remove it first, or pick another input.`,
    });
  }

  // A cycle exists if the target can already reach the source: adding the wire
  // would close the loop. Checked BEFORE the edge is committed, never after.
  if (reachableFrom(graph, to.nodeId).has(from.nodeId)) {
    return reject({
      reason: 'cycle',
      message: 'That would create a loop, and data has to flow one way.',
    });
  }

  return { ok: true };
}

export interface ConnectionTarget {
  readonly nodeId: NodeId;
  readonly portId: string;
  readonly nodeLabel: string;
  readonly portLabel: string;
  readonly types: readonly string[];
}

/**
 * Every input port that `from` could legally be wired into.
 *
 * This is what the keyboard connection flow lists, so a keyboard user is
 * offered exactly the choices a pointer user would be allowed to drop onto -
 * no more, and no fewer.
 */
export function validTargetsFor(graph: GraphData, from: PortRef): readonly ConnectionTarget[] {
  const targets: ConnectionTarget[] = [];

  for (const nodeId of graph.nodeOrder) {
    const node = graph.nodes[nodeId];
    if (!node) continue;

    const entry = getManifestEntry(node.toolId);
    for (const port of entry.inputs) {
      const to: PortRef = { nodeId, portId: port.id };
      if (!checkConnection(graph, from, to).ok) continue;

      targets.push({
        nodeId,
        portId: port.id,
        nodeLabel: entry.name,
        portLabel: port.label,
        types: port.types,
      });
    }
  }

  return targets;
}

/** Edges attached to any of the given nodes, in either direction. */
export function edgesTouching(graph: GraphData, nodeIds: readonly NodeId[]): readonly CanvasEdge[] {
  const ids = new Set(nodeIds);
  const touching: CanvasEdge[] = [];

  for (const id of graph.edgeOrder) {
    const edge = graph.edges[id];
    if (edge && (ids.has(edge.from.nodeId) || ids.has(edge.to.nodeId))) touching.push(edge);
  }

  return touching;
}

/** How many wires touch a node. Announced as part of its accessible name. */
export function connectionCount(graph: GraphData, nodeId: NodeId): number {
  return edgesTouching(graph, [nodeId]).length;
}
