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
/**
 * The node's own border.
 *
 * Counted because `CanvasNode.position` is the BORDER box's top-left, while a
 * CSS `top` on an absolutely positioned child is measured from the padding
 * edge - one pixel further down. Leaving it out is what put every wire a pixel
 * above its port, and the drift only got worse from there.
 */
export const NODE_BORDER = 1;
export const HEADER_HEIGHT = 24;
export const PORT_ROW_HEIGHT = 24;
export const BODY_PADDING = 8;
/*
 * Two full lines of summary or guidance, plus its padding.
 *
 * Was 32, which is 24px of content against a 13px line box - 1.85 lines. Every
 * two-line tool summary was already being shaved, and the blocked-node
 * guidance was cut mid-sentence. 40 is 2 lines (26px) with room, and stays on
 * the 8px baseline.
 */
export const SUMMARY_HEIGHT = 40;

/** Lines the summary box is sized for. Asserted against the real box. */
export const SUMMARY_LINES = 2;
export const FOOTER_HEIGHT = 24;
/**
 * The typed-input editor: a 48px box plus the 4px gap under it.
 *
 * Matched to the CSS rather than rounded up. Over-reserving here left the
 * footer floating a few pixels above the node's bottom edge.
 */
export const INPUT_HEIGHT = 52;

/**
 * Clear space between the input stack and the output stack.
 *
 * The two are separate lists, and they are laid out as separate lists: inputs
 * from the top, then a gap, then outputs. Side-by-side columns of unequal
 * length read as ROWS - "DOCUMENT goes with CONVERTED" - which is a
 * relationship that does not exist.
 */
export const PORT_STACK_GAP = 8;

/**
 * How far in from the node's edge a connector glyph's centre sits.
 *
 * The glyph is 11px across, so this leaves it comfortably inside the panel
 * instead of straddling the border. Wires attach here too; the wire layer sits
 * beneath the nodes, so the last few pixels are hidden and a wire reads as
 * terminating cleanly at the edge.
 */
export const PORT_GLYPH_INSET = 14;

/** The invisible grab area around a port, measured from the glyph's centre. */
export const PORT_HIT_RADIUS = 18;

/**
 * How far from a port a drop may land and still connect.
 *
 * Ports are 11px targets on a plane that pans and zooms. Requiring a direct
 * hit means missing, and missing means the wire silently vanishes. Snapping
 * within this radius - to the NEAREST compatible port, never an incompatible
 * one - is what makes the drag forgiving without making it inaccurate.
 */
export const PORT_SNAP_RADIUS = 28;

/** Minor grid squares between two major rules. */
export const GRID_MAJOR_EVERY = 8;

/**
 * The grid's background-size and -position for a viewport.
 *
 * WHY ONE TILE AND NOT TWO
 *
 * The grid used to be four background layers: a minor pair tiled at
 * `GRID * zoom` and a major pair at `GRID * 8 * zoom`. Mathematically those
 * are phase-locked - one is exactly eight of the other - but they are
 * rasterised INDEPENDENTLY, and each tile is rounded to device pixels on its
 * own. At 90% the minor tile is 7.2px and the major is 57.6px; round them
 * separately and the major rule stops landing on a minor one. That is the
 * clustering and the dropout: whole runs of minor lines vanish while the
 * major rules drift out of step.
 *
 * Now there is ONE tile per axis, at the major size, with the minor lines
 * drawn inside it as fractions of that same tile (see canvas.module.css). One
 * rounding, applied once, and the minor lines are positioned as percentages
 * of whatever it rounds to - so they cannot drift from the major rule at any
 * zoom.
 *
 * The offset is reduced modulo the tile here rather than left to the browser.
 * `background-position` wraps on its own, but after panning to a large offset
 * the value handed over is a big float and the wrap loses precision; taking
 * the remainder first keeps the number small.
 */
export function gridStyle(viewport: { x: number; y: number; zoom: number }): {
  readonly backgroundSize: string;
  readonly backgroundPosition: string;
} {
  /*
   * Rounded FIRST, then everything else is measured against the rounded value.
   *
   * The browser only ever sees three decimal places, so that is the tile the
   * offset has to live inside. Wrapping against the unrounded tile can emit an
   * offset of exactly one whole (rounded) tile - a full period out of range.
   * Invisible, but the invariant is worth keeping true rather than nearly so.
   */
  const tile = round(GRID * GRID_MAJOR_EVERY * viewport.zoom);
  const size = `${tile.toFixed(3)}px ${tile.toFixed(3)}px`;

  return {
    backgroundSize: `${size}, ${size}`,
    backgroundPosition: `${offsetFor(viewport.x, tile)}px ${offsetFor(viewport.y, tile)}px`,
  };
}

/** Three decimals is far below a device pixel and keeps the string short. */
function round(value: number): number {
  return Number(value.toFixed(3));
}

/**
 * The offset actually written into the style: wrapped, rounded, and pulled
 * back to zero if the rounding pushed it up onto the tile boundary.
 *
 * An offset of one whole tile is the same picture as an offset of none, so
 * this changes nothing visually - it just keeps "the offset is inside the
 * tile" true of the emitted string and not only of the maths behind it.
 */
function offsetFor(value: number, tile: number): string {
  const wrapped = round(wrapToTile(value, tile));
  return (wrapped >= tile ? 0 : wrapped).toFixed(3);
}

/**
 * A pan offset reduced into [0, tile).
 *
 * Anchored to the world origin: the grid is a picture of where nodes snap, so
 * it has to follow the world rather than the viewport's corner. The double
 * remainder is what keeps a negative offset positive.
 */
export function wrapToTile(offset: number, tile: number): number {
  if (!Number.isFinite(tile) || tile <= 0) return 0;
  return ((offset % tile) + tile) % tile;
}

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

/**
 * Rows of ports a node shows.
 *
 * The SUM of both sides, not the taller of them: the two stacks follow each
 * other down the node rather than sharing rows.
 */
export function portRowCount(entry: ToolManifestEntry): number {
  return entry.inputs.length + entry.outputs.length;
}

/** The gap only exists when there is something on both sides of it. */
export function portStackGap(entry: ToolManifestEntry): number {
  return entry.inputs.length > 0 && entry.outputs.length > 0 ? PORT_STACK_GAP : 0;
}

export function nodeHeight(entry: ToolManifestEntry, typedInputs = 0): number {
  return (
    NODE_BORDER * 2 +
    HEADER_HEIGHT +
    SUMMARY_HEIGHT +
    BODY_PADDING * 2 +
    portRowCount(entry) * PORT_ROW_HEIGHT +
    portStackGap(entry) +
    typedInputs * INPUT_HEIGHT +
    FOOTER_HEIGHT
  );
}

/**
 * The input ports a node takes typed text for: every input port with no wire.
 *
 * The editors sit BELOW the ports, so adding one changes the node's height
 * without moving any connector - wire geometry is unaffected.
 */
export function typedInputPorts(graph: GraphData, node: CanvasNode): readonly string[] {
  const wired = new Set<string>();
  for (const edgeId of graph.edgeOrder) {
    const edge = graph.edges[edgeId];
    if (edge?.to.nodeId === node.id) wired.add(edge.to.portId);
  }

  return getManifestEntry(node.toolId)
    .inputs.filter((port) => !wired.has(port.id))
    .map((port) => port.id);
}

/** How many typed-input editors a node shows. */
export function typedInputCount(graph: GraphData, node: CanvasNode): number {
  return typedInputPorts(graph, node).length;
}

export type PortSide = 'input' | 'output';

/**
 * Vertical centre of a port, relative to the node's top edge.
 *
 * THE single source of truth for where a port is. The wire layer reads it, and
 * so does the DOM (through `portTopStyle`), so the two cannot disagree - which
 * they previously did, by nine pixels, because the view had its own copy of
 * the arithmetic and the draft wire had a third.
 */
export function portOffsetY(entry: ToolManifestEntry, side: PortSide, index: number): number {
  const top = NODE_BORDER + HEADER_HEIGHT + SUMMARY_HEIGHT + BODY_PADDING;
  const stack = side === 'input' ? 0 : entry.inputs.length * PORT_ROW_HEIGHT + portStackGap(entry);

  return top + stack + index * PORT_ROW_HEIGHT + PORT_ROW_HEIGHT / 2;
}

/**
 * The CSS inset for a port row, measured from the node's padding edge.
 *
 * The glyph's centre has to land `PORT_GLYPH_INSET` inside the node's BORDER
 * box, but a CSS inset is measured from the padding edge - one border further
 * in. Same correction as `portTopStyle`, same reason, and set inline for the
 * same reason: so no stylesheet holds a second copy of the number.
 */
export function portInsetStyle(glyphWidth: number): number {
  return PORT_GLYPH_INSET - glyphWidth / 2 - NODE_BORDER;
}

/**
 * The CSS `top` for a port row, positioned against the node.
 *
 * Derived from `portOffsetY` rather than computed alongside it. The row is
 * PORT_ROW_HEIGHT tall and its centre must land on the offset, and `top` is
 * measured from the padding edge - inside the border - hence the subtraction.
 */
export function portTopStyle(entry: ToolManifestEntry, side: PortSide, index: number): number {
  return portOffsetY(entry, side, index) - PORT_ROW_HEIGHT / 2 - NODE_BORDER;
}

/** World-space position of a port's connector glyph, at its exact centre. */
export function portPosition(
  entry: ToolManifestEntry,
  node: CanvasNode,
  side: PortSide,
  index: number,
): Point {
  return {
    x: node.position.x + (side === 'output' ? NODE_WIDTH - PORT_GLYPH_INSET : PORT_GLYPH_INSET),
    y: node.position.y + portOffsetY(entry, side, index),
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

  const entry = getManifestEntry(node.toolId);
  const index = portIndex(entry, side, portId);
  return index === null ? null : portPosition(entry, node, side, index);
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

export function nodeRect(node: CanvasNode, typedInputs = 0): Rect {
  return {
    x: node.position.x,
    y: node.position.y,
    width: NODE_WIDTH,
    height: nodeHeight(getManifestEntry(node.toolId), typedInputs),
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
    const rect = nodeRect(node, typedInputCount(graph, node));
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }

  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Clear air left between a newly placed subgraph and what is already there. */
export const PLACEMENT_GAP = 64;

/**
 * Moves an origin below everything already on the canvas, if it would land on
 * top of it.
 *
 * Only the vertical axis is adjusted. Presets read left-to-right - a chain of
 * nodes wired in a row - so pushing sideways would march them off the edge,
 * while pushing down puts the new graph on its own line, which is how anyone
 * would arrange them by hand.
 *
 * Nothing moves when the canvas is empty or the origin is already clear, so
 * placing the first preset still lands exactly where the user is looking.
 */
export function clearOfExistingNodes(graph: GraphData, origin: Point): Point {
  const bounds = graphBounds(graph);
  if (!bounds) return origin;

  const belowExisting = bounds.y + bounds.height + PLACEMENT_GAP;
  if (origin.y >= belowExisting) return origin;

  // Horizontally disjoint graphs do not need moving at all.
  if (origin.x >= bounds.x + bounds.width + PLACEMENT_GAP) return origin;

  return { x: origin.x, y: belowExisting };
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
