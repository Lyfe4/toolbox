import { getManifestEntry, type ToolManifestEntry } from '@/features/registry';

import type { CanvasNode, GraphData, NodeId, Point } from './types';

/**
 * All canvas measurements in one place.
 *
 * Node size is DERIVED rather than measured from the DOM. A wire has to land
 * exactly on its port, and reading layout back would mean a measure/paint
 * round trip on every move. Computing both the node's height and its port
 * positions from the same function keeps them in step by construction.
 */

/** The baseline everything snaps to. Matches --raw-space-8 in the tokens. */
export const GRID = 8;

export const NODE_WIDTH = 224;
export const HEADER_HEIGHT = 24;
export const PORT_ROW_HEIGHT = 24;
export const BODY_PADDING = 8;
export const SUMMARY_HEIGHT = 32;
export const FOOTER_HEIGHT = 24;

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2.5;

export function snapToGrid(value: number): number {
  // `|| 0` collapses -0 to 0. Negative zero compares equal to zero but is a
  // different value to Object.is and to a deep-equality check, and
  // JSON.stringify writes it as "0" - so a saved -0 would not round-trip.
  return Math.round(value / GRID) * GRID || 0;
}

export function snapPoint(point: Point): Point {
  return { x: snapToGrid(point.x), y: snapToGrid(point.y) };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Rows of ports a node shows: the taller of its two sides. */
export function portRowCount(entry: ToolManifestEntry): number {
  return Math.max(entry.inputs.length, entry.outputs.length);
}

export function nodeHeight(entry: ToolManifestEntry): number {
  return (
    HEADER_HEIGHT +
    SUMMARY_HEIGHT +
    portRowCount(entry) * PORT_ROW_HEIGHT +
    BODY_PADDING * 2 +
    FOOTER_HEIGHT
  );
}

/** Vertical centre of the port at `index`, relative to the node's top edge. */
export function portOffsetY(index: number): number {
  return (
    HEADER_HEIGHT + SUMMARY_HEIGHT + BODY_PADDING + index * PORT_ROW_HEIGHT + PORT_ROW_HEIGHT / 2
  );
}

export type PortSide = 'input' | 'output';

/** World-space position of a port's connector. */
export function portPosition(node: CanvasNode, side: PortSide, index: number): Point {
  return {
    x: node.position.x + (side === 'output' ? NODE_WIDTH : 0),
    y: node.position.y + portOffsetY(index),
  };
}

/** Looks up a port's index on its node, or null when the port is unknown. */
export function portIndex(entry: ToolManifestEntry, side: PortSide, portId: string): number | null {
  const ports = side === 'input' ? entry.inputs : entry.outputs;
  const index = ports.findIndex((port) => port.id === portId);
  return index === -1 ? null : index;
}

export function portPositionById(
  graph: GraphData,
  nodeId: NodeId,
  side: PortSide,
  portId: string,
): Point | null {
  const node = graph.nodes[nodeId];
  if (!node) return null;

  const index = portIndex(getManifestEntry(node.toolId), side, portId);
  return index === null ? null : portPosition(node, side, index);
}

/**
 * Cubic bezier from one port to another.
 *
 * The control points push horizontally, so a wire leaves an output rightwards
 * and enters an input leftwards regardless of where the nodes sit. The offset
 * grows with distance but is clamped, so a long wire does not balloon and a
 * very short one does not fold back on itself.
 */
export function wirePath(from: Point, to: Point): string {
  const distance = Math.abs(to.x - from.x);
  const control = clamp(distance * 0.5, 24, 160);

  return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} C ${(from.x + control).toFixed(1)} ${from.y.toFixed(1)}, ${(to.x - control).toFixed(1)} ${to.y.toFixed(1)}, ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function nodeRect(node: CanvasNode): Rect {
  return {
    x: node.position.x,
    y: node.position.y,
    width: NODE_WIDTH,
    height: nodeHeight(getManifestEntry(node.toolId)),
  };
}

/** Bounding box of every node, or null for an empty graph. */
export function graphBounds(graph: GraphData): Rect | null {
  if (graph.nodeOrder.length === 0) return null;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const id of graph.nodeOrder) {
    const node = graph.nodes[id];
    if (!node) continue;
    const rect = nodeRect(node);
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }

  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * The spatial tab order: top-to-bottom, then left-to-right.
 *
 * Rows are bucketed to a coarse band before sorting so nodes that read as
 * "the same row" to a person do not swap places over a two-pixel difference.
 */
export const TAB_ORDER_ROW_HEIGHT = 64;

export function spatialOrder(graph: GraphData): readonly NodeId[] {
  return [...graph.nodeOrder]
    .map((id) => graph.nodes[id])
    .filter((node): node is CanvasNode => node !== undefined)
    .sort((a, b) => {
      const rowA = Math.floor(a.position.y / TAB_ORDER_ROW_HEIGHT);
      const rowB = Math.floor(b.position.y / TAB_ORDER_ROW_HEIGHT);
      if (rowA !== rowB) return rowA - rowB;
      if (a.position.x !== b.position.x) return a.position.x - b.position.x;
      // Final tiebreak on id, so the order is total and never flickers.
      return a.id.localeCompare(b.id);
    })
    .map((node) => node.id);
}
