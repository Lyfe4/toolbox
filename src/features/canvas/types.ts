import type { ToolId } from '@/features/registry';

/**
 * The canvas graph model.
 *
 * Normalised: nodes and edges live in records keyed by id, with separate order
 * arrays. Lookups by id are O(1) - which matters because wire rendering,
 * cycle detection and hit-testing all do them constantly - while the order
 * arrays keep iteration stable so the tab order and the persisted file do not
 * shuffle between sessions.
 */

export type NodeId = string;
export type EdgeId = string;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface CanvasNode {
  readonly id: NodeId;
  readonly toolId: ToolId;
  /** World coordinates of the top-left corner, always snapped to the grid. */
  readonly position: Point;
  readonly options: Readonly<Record<string, unknown>>;
  /**
   * Text the user typed into this node, keyed by input port id. A port takes
   * typed input only while nothing is wired into it.
   *
   * Keyed per port rather than a single string because a tool can have more
   * than one required input - `diff` compares two - and feeding only the first
   * would leave the second permanently blocked.
   *
   * USER DATA: persisted locally, and deliberately never in a share URL.
   */
  readonly inputs: Readonly<Record<string, string>>;
}

/*
 * Execution status deliberately does NOT live on the node. It is derived from
 * a run, not part of the document: keeping it here would put it in the undo
 * history and in the saved file, and "this node succeeded" is not something
 * anyone wants to undo or reload. It lives in the pipeline store instead.
 */

/** One end of a wire: a specific port on a specific node. */
export interface PortRef {
  readonly nodeId: NodeId;
  readonly portId: string;
}

export interface CanvasEdge {
  readonly id: EdgeId;
  readonly from: PortRef;
  readonly to: PortRef;
}

export interface GraphData {
  readonly nodes: Readonly<Record<NodeId, CanvasNode>>;
  readonly nodeOrder: readonly NodeId[];
  readonly edges: Readonly<Record<EdgeId, CanvasEdge>>;
  readonly edgeOrder: readonly EdgeId[];
  /** Monotonic id source. Persisted, so a reload cannot reissue an id. */
  readonly nextId: number;
}

export const EMPTY_GRAPH: GraphData = {
  nodes: {},
  nodeOrder: [],
  edges: {},
  edgeOrder: [],
  nextId: 1,
};

/** Why a proposed connection was refused. Rendered and announced verbatim. */
export type ConnectionRejection =
  | { readonly reason: 'same-node'; readonly message: string }
  | { readonly reason: 'type-mismatch'; readonly message: string }
  | { readonly reason: 'occupied'; readonly message: string }
  | { readonly reason: 'duplicate'; readonly message: string }
  | { readonly reason: 'cycle'; readonly message: string };

export type ConnectionCheck =
  { readonly ok: true } | { readonly ok: false; readonly rejection: ConnectionRejection };
