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

/**
 * A FILE CHOSEN FOR AN INPUT PORT, AS THE DOCUMENT REMEMBERS IT.
 *
 * The bytes are NOT here and never will be. A `File` is not serialisable, a
 * graph is saved to localStorage and shared by URL, and megabytes of somebody's
 * photograph belong in neither - so the document keeps the smallest true
 * statement it can make, "this port was fed a file called this", and the bytes
 * live in `attachmentStore` for the length of the session.
 *
 * That split is what turns a reload from a crash or a silently empty node into
 * a sentence: the node comes back knowing it was fed `photo.png` and knowing it
 * cannot produce it, and says so. See `docs/architecture.md`.
 *
 * `token` distinguishes two files with the same name and the same size, which
 * name and size alone cannot. It is part of the node's cache key, so replacing
 * a file always re-runs the node rather than serving the previous answer.
 */
export interface FileInputRef {
  readonly name: string;
  readonly size: number;
  readonly token: number;
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
  /**
   * Files chosen for input ports, keyed by input port id. Names and sizes only.
   *
   * A file OUTRANKS typed text on the same port, and a wire outranks both:
   * wire, then file, then text. Each of those is a more deliberate act than the
   * one after it, and drawing a control whose contents the run would ignore is
   * the defect the inspector already avoids for a wired port.
   *
   * USER DATA, and more revealing than `inputs` in one respect - a filename can
   * say `Q3-layoffs.xlsx` - so it is persisted locally and never in a share
   * URL, enforced by `toSharePayload` and asserted by `share.test.ts`.
   */
  readonly fileInputs: Readonly<Record<string, FileInputRef>>;
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
