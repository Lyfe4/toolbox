import { getManifestEntry, isToolId } from '@/features/registry';
import { z } from '@/lib/zod';

import { EMPTY_GRAPH, type GraphData } from './types';

/**
 * Graph persistence.
 *
 * The key is namespaced and versioned. Everything read back is untrusted -
 * it is user-writable, it may have been written by an older build, and it may
 * simply be corrupt - so it is parsed with Zod and cross-checked against the
 * live tool registry before it is allowed anywhere near the store.
 */
export const GRAPH_STORAGE_KEY = 'patchbay:graph:v3';

/** Bump when the persisted shape changes, and add a migration below. */
export const CURRENT_GRAPH_VERSION = 3;

const pointSchema = z.object({
  // z.number() already rejects NaN and Infinity in Zod 4.
  x: z.number(),
  y: z.number(),
});

const portRefSchema = z.object({
  nodeId: z.string().min(1),
  portId: z.string().min(1),
});

const nodeSchema = z.object({
  id: z.string().min(1),
  // Checked against the registry as well as the type, so a graph referring to
  // a tool that no longer exists is rejected rather than rendering a blank box.
  toolId: z.string().refine(isToolId, 'Unknown tool'),
  position: pointSchema,
  options: z.record(z.string(), z.unknown()),
  /** User data, per input port. Saved locally; never in a share URL. */
  inputs: z.record(z.string(), z.string()),
});

const edgeSchema = z.object({
  id: z.string().min(1),
  from: portRefSchema,
  to: portRefSchema,
});

const persistedSchema = z.object({
  version: z.literal(CURRENT_GRAPH_VERSION),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  nextId: z.number().int().positive(),
});

export type PersistedGraph = z.output<typeof persistedSchema>;

export type LoadResult =
  | { readonly status: 'empty' }
  | { readonly status: 'loaded'; readonly graph: GraphData }
  | { readonly status: 'rejected'; readonly message: string };

/** Flattens the normalised store shape into something compact to store. */
export function toPersisted(graph: GraphData): PersistedGraph {
  return {
    version: CURRENT_GRAPH_VERSION,
    nodes: graph.nodeOrder.flatMap((id) => {
      const node = graph.nodes[id];
      return node ? [{ ...node, options: { ...node.options } }] : [];
    }),
    edges: graph.edgeOrder.flatMap((id) => {
      const edge = graph.edges[id];
      return edge ? [edge] : [];
    }),
    nextId: graph.nextId,
  };
}

/**
 * Upgrades an older payload to the current version.
 *
 * Migrations chain: v1 is rewritten to v2 and handed straight back in, so each
 * step only has to know about the one before it. Whatever comes out is still
 * validated against the current schema, so a migration is allowed to be
 * optimistic - it cannot let a malformed graph through.
 */
function migrate(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const version = (raw as { version?: unknown }).version;

  switch (version) {
    case 1:
      return migrate(migrateV1ToV2(raw as Record<string, unknown>));
    case 2:
      return migrateV2ToV3(raw as Record<string, unknown>);
    case CURRENT_GRAPH_VERSION:
      return raw;
    default:
      // Unknown or missing version: refuse rather than guess at the shape.
      return null;
  }
}

/**
 * v1 -> v2.
 *
 * v2 moved execution status off the node (it is derived, not document state)
 * and added the node's typed-in `input`. A v1 graph has neither, so the status
 * is dropped and the input starts empty - the structure is preserved, and the
 * user only has to retype what was never saved in the first place.
 */
function migrateV1ToV2(raw: Record<string, unknown>): unknown {
  // A corrupt `nodes` is passed through untouched rather than quietly replaced
  // with an empty array: silently repairing it would turn a broken save into a
  // successfully-loaded empty canvas with no explanation.
  if (!Array.isArray(raw.nodes)) return { ...raw, version: 2 };
  const nodes: readonly unknown[] = raw.nodes;

  return {
    ...raw,
    version: 2,
    nodes: nodes.map((node): unknown => {
      if (typeof node !== 'object' || node === null) return node;

      // Rebuilt field by field rather than by deleting `status`, so a v1 node
      // cannot smuggle any other stale field through either.
      const source = node as Record<string, unknown>;
      const carried: Record<string, unknown> = {};
      for (const key of ['id', 'toolId', 'position', 'options']) {
        if (key in source) carried[key] = source[key];
      }
      return { ...carried, input: '' };
    }),
  };
}

/**
 * v2 -> v3.
 *
 * v3 replaced the node's single `input` string with a map keyed by input port,
 * so a tool with two required inputs (diff) can take both. The old value
 * belonged to the tool's first port, which is where it goes.
 */
function migrateV2ToV3(raw: Record<string, unknown>): unknown {
  if (!Array.isArray(raw.nodes)) return { ...raw, version: CURRENT_GRAPH_VERSION };
  const nodes: readonly unknown[] = raw.nodes;

  return {
    ...raw,
    version: CURRENT_GRAPH_VERSION,
    nodes: nodes.map((node): unknown => {
      if (typeof node !== 'object' || node === null) return node;

      const source = node as Record<string, unknown>;
      const { input, ...rest } = source;
      const toolId = source.toolId;

      // The port id comes from the registry rather than being assumed to be
      // "input", so this stays correct if a tool ever renames its first port.
      const firstPort =
        typeof toolId === 'string' && isToolId(toolId)
          ? getManifestEntry(toolId).inputs[0]?.id
          : undefined;

      const inputs =
        typeof input === 'string' && input !== '' && firstPort !== undefined
          ? { [firstPort]: input }
          : {};

      return { ...rest, inputs };
    }),
  };
}

/** Rebuilds the normalised store shape, dropping edges with missing endpoints. */
function toGraphData(persisted: PersistedGraph): GraphData {
  const nodes: GraphData['nodes'] = Object.fromEntries(
    persisted.nodes.map((node) => [node.id, { ...node, toolId: node.toolId }]),
  );

  const nodeIds = new Set(persisted.nodes.map((node) => node.id));
  const liveEdges = persisted.edges.filter(
    (edge) => nodeIds.has(edge.from.nodeId) && nodeIds.has(edge.to.nodeId),
  );

  return {
    nodes,
    nodeOrder: persisted.nodes.map((node) => node.id),
    edges: Object.fromEntries(liveEdges.map((edge) => [edge.id, edge])),
    edgeOrder: liveEdges.map((edge) => edge.id),
    nextId: persisted.nextId,
  };
}

export function loadGraph(): LoadResult {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(GRAPH_STORAGE_KEY);
  } catch {
    // Storage can throw outright in private modes or when blocked by policy.
    return { status: 'empty' };
  }

  if (raw === null) return { status: 'empty' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'rejected', message: 'The saved canvas was not readable and has been reset.' };
  }

  const migrated = migrate(parsed);
  const result = persistedSchema.safeParse(migrated);

  if (!result.success) {
    return {
      status: 'rejected',
      message: 'The saved canvas did not match the expected format and has been reset.',
    };
  }

  return { status: 'loaded', graph: toGraphData(result.data) };
}

export function saveGraph(graph: GraphData): void {
  try {
    window.localStorage.setItem(GRAPH_STORAGE_KEY, JSON.stringify(toPersisted(graph)));
  } catch {
    // Not being able to save is not worth breaking the canvas over.
  }
}

export function clearSavedGraph(): void {
  try {
    window.localStorage.removeItem(GRAPH_STORAGE_KEY);
  } catch {
    // As above.
  }
}

/**
 * Debounced saving.
 *
 * Dragging a node produces a store update per frame. Writing all of those to
 * localStorage would serialise the whole graph sixty times a second on the
 * main thread; waiting for a pause writes once.
 */
export function createDebouncedSaver(delayMs = 500): {
  readonly save: (graph: GraphData) => void;
  readonly flush: () => void;
  readonly cancel: () => void;
} {
  let timer: number | null = null;
  let latest: GraphData | null = null;

  const write = (): void => {
    timer = null;
    if (latest === null) return;
    // Never persist an empty graph over a real one on first mount.
    if (latest === EMPTY_GRAPH) return;
    saveGraph(latest);
    latest = null;
  };

  return {
    save: (graph) => {
      latest = graph;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(write, delayMs);
    },
    flush: () => {
      if (timer !== null) window.clearTimeout(timer);
      write();
    },
    cancel: () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      latest = null;
    },
  };
}
