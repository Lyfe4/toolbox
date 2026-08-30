import { canConnect, getManifestEntry, type InputPort, type OutputPort } from '@/features/registry';

import { portIndex, portPosition, PORT_SNAP_RADIUS, type PortSide } from './geometry';

import type {
  CanvasEdge,
  ConnectionCheck,
  ConnectionRejection,
  GraphData,
  NodeId,
  Point,
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
  /** Which side of its node this port is on. */
  readonly side: PortSide;
}

/**
 * Every input port that `from` could legally be wired into.
 *
 * This is what the keyboard connection flow lists, so a keyboard user is
 * offered exactly the choices a pointer user would be allowed to drop onto -
 * no more, and no fewer.
 */
export function validTargetsFor(graph: GraphData, from: PortRef): readonly ConnectionTarget[] {
  return validPartnersFor(graph, { ref: from, side: 'output' });
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

/* ========================================================================== *
 * Dragging in either direction
 * ========================================================================== */

/** One end of a drag: which port, and which side of a node it is on. */
export interface PortEnd {
  readonly ref: PortRef;
  readonly side: PortSide;
}

/**
 * Puts a pair of ends the right way round for `checkConnection`.
 *
 * A wire always runs output -> input. A DRAG may be made in either direction,
 * because insisting the user start from the correct end is a rule the canvas
 * can simply absorb. Returns null when both ends are the same side, which is
 * not a wire at all.
 */
export function orientEnds(
  a: PortEnd,
  b: PortEnd,
): { readonly from: PortRef; readonly to: PortRef } | null {
  if (a.side === b.side) return null;
  return a.side === 'output' ? { from: a.ref, to: b.ref } : { from: b.ref, to: a.ref };
}

/**
 * Every port `origin` could legally be wired to, whichever end it is.
 *
 * The mirror of the old output-only version. A drag from an input looks for
 * outputs and a drag from an output looks for inputs, and both run through the
 * same `checkConnection` - so a target offered here is a target that will
 * actually be accepted, in either direction, by pointer or by keyboard.
 */
export function validPartnersFor(graph: GraphData, origin: PortEnd): readonly ConnectionTarget[] {
  const wanted: PortSide = origin.side === 'output' ? 'input' : 'output';
  const partners: ConnectionTarget[] = [];

  for (const nodeId of graph.nodeOrder) {
    const node = graph.nodes[nodeId];
    if (!node) continue;

    const entry = getManifestEntry(node.toolId);
    const ports = wanted === 'input' ? entry.inputs : entry.outputs;

    for (const port of ports) {
      const oriented = orientEnds(origin, { ref: { nodeId, portId: port.id }, side: wanted });
      if (!oriented) continue;
      if (!checkConnection(graph, oriented.from, oriented.to).ok) continue;

      partners.push({
        nodeId,
        portId: port.id,
        nodeLabel: entry.name,
        portLabel: port.label,
        types: port.types,
        side: wanted,
      });
    }
  }

  return partners;
}

/* ========================================================================== *
 * Snapping
 * ========================================================================== */

export interface SnapResult {
  readonly ref: PortRef;
  readonly side: PortSide;
  readonly distance: number;
}

/**
 * The nearest port to a world point that `origin` could legally connect to.
 *
 * Geometric rather than a DOM hit test. `elementFromPoint` finds whatever the
 * pointer is exactly over, which for an 11px glyph on a plane that pans and
 * zooms means "nothing" most of the time - and a missed drop looks identical
 * to a broken one. Measuring distance also lets the NEAREST candidate win when
 * two are close, which a hit test cannot do.
 *
 * Only legal partners are considered, so snapping can never drag a drop onto a
 * port that would then refuse it.
 */
export function nearestCompatiblePort(
  graph: GraphData,
  origin: PortEnd,
  at: Point,
  radius = PORT_SNAP_RADIUS,
): SnapResult | null {
  let best: SnapResult | null = null;

  for (const partner of validPartnersFor(graph, origin)) {
    const node = graph.nodes[partner.nodeId];
    if (!node) continue;

    const entry = getManifestEntry(node.toolId);
    const index = portIndex(entry, partner.side, partner.portId);
    if (index === null) continue;

    const point = portPosition(entry, node, partner.side, index);
    const distance = Math.hypot(point.x - at.x, point.y - at.y);
    if (distance > radius) continue;
    if (best && best.distance <= distance) continue;

    best = {
      ref: { nodeId: partner.nodeId, portId: partner.portId },
      side: partner.side,
      distance,
    };
  }

  return best;
}

/**
 * The port under or nearest a world point, legal or not.
 *
 * Used for the refusal path: releasing over an incompatible port has to be
 * able to SAY why, which means finding it even though it is not a candidate.
 */
export function nearestPortOfSide(
  graph: GraphData,
  side: PortSide,
  at: Point,
  radius = PORT_SNAP_RADIUS,
): SnapResult | null {
  let best: SnapResult | null = null;

  for (const nodeId of graph.nodeOrder) {
    const node = graph.nodes[nodeId];
    if (!node) continue;

    const entry = getManifestEntry(node.toolId);
    const ports = side === 'input' ? entry.inputs : entry.outputs;

    ports.forEach((port, index) => {
      const point = portPosition(entry, node, side, index);
      const distance = Math.hypot(point.x - at.x, point.y - at.y);
      if (distance > radius) return;
      if (best && best.distance <= distance) return;
      best = { ref: { nodeId, portId: port.id }, side, distance };
    });
  }

  return best;
}
