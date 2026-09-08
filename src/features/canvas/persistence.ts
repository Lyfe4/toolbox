import { getManifestEntry, isToolId } from '@/features/registry';
import { z } from '@/lib/zod';

import { safeNextId } from './commands';
import { firstRefusedEdge } from './connections';
import { currentInputPortId, currentOutputPortId, migrateInputKeys } from './retiredPorts';
import {
  isRetiredToolId,
  migrateRetiredOptions,
  REPLACEMENT_TOOL_ID,
  retiredFirstInputPort,
} from './retiredTools';
import { EMPTY_GRAPH, type GraphData } from './types';

/**
 * Graph persistence.
 *
 * The key is namespaced and versioned. Everything read back is untrusted -
 * it is user-writable, it may have been written by an older build, and it may
 * simply be corrupt - so it is parsed with Zod and cross-checked against the
 * live tool registry before it is allowed anywhere near the store.
 *
 * THE KEY AND THE PAYLOAD VERSION ARE DECOUPLED, DELIBERATELY. The payload
 * carries its own `version` and is migrated in place, so the key only has to
 * change when a save becomes genuinely unreadable rather than merely old.
 * Bumping it alongside CURRENT_GRAPH_VERSION would orphan exactly the data the
 * migration chain exists to rescue: the reader would look under a key nothing
 * had ever been written to, find nothing, and present an empty canvas as if
 * that were the user's own.
 */
export const GRAPH_STORAGE_KEY = 'patchbay:graph:v3';

/** Bump when the persisted shape changes, and add a migration below. */
export const CURRENT_GRAPH_VERSION = 6;

const pointSchema = z.object({
  // z.number() already rejects NaN and Infinity in Zod 4.
  x: z.number(),
  y: z.number(),
});

const portRefSchema = z.object({
  nodeId: z.string().min(1),
  portId: z.string().min(1),
});

/**
 * A file chosen for an input port: what it was called and how big it was.
 *
 * NO BYTES, AND THAT IS THE WHOLE DESIGN. A file is session state - see
 * `attachmentStore` - so what survives a reload is the smallest true statement
 * about it, which is enough for the node to say `"photo.png" needs choosing
 * again` instead of coming back looking as though nobody ever fed it.
 *
 * `size` is bounded so a hand-edited save cannot claim a negative or fractional
 * one; it is only ever printed, but a value that is only ever printed is
 * exactly the kind that stops being checked.
 */
const fileInputSchema = z.object({
  name: z.string().min(1).max(512),
  size: z.number().int().nonnegative(),
  token: z.number().int().nonnegative(),
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
  /** Names of files chosen per input port. Saved locally; never in a URL. */
  fileInputs: z.record(z.string(), fileInputSchema),
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
      return node
        ? [{ ...node, options: { ...node.options }, fileInputs: { ...node.fileInputs } }]
        : [];
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
      return migrate(migrateV2ToV3(raw as Record<string, unknown>));
    case 3:
      return migrate(migrateV3ToV4(raw as Record<string, unknown>));
    case 4:
      return migrate(migrateV4ToV5(raw as Record<string, unknown>));
    case 5:
      return migrateV5ToV6(raw as Record<string, unknown>);
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
  if (!Array.isArray(raw.nodes)) return { ...raw, version: 3 };
  const nodes: readonly unknown[] = raw.nodes;

  return {
    ...raw,
    version: 3,
    nodes: nodes.map((node): unknown => {
      if (typeof node !== 'object' || node === null) return node;

      const source = node as Record<string, unknown>;
      const { input, ...rest } = source;
      const toolId = source.toolId;

      // The port id comes from the registry rather than being assumed to be
      // "input", so this stays correct if a tool ever renames its first port.
      /*
       * The retired-tool fallback is not optional here. This looks the port
       * name up in the LIVE registry, and `markdown` and `html-text` are no
       * longer in it - so without the second branch, a v2 graph containing
       * either of them would lose its typed input on the way through, in
       * exactly the nodes the v3 -> v4 step below exists to rescue.
       */
      const firstPort =
        typeof toolId === 'string' && isToolId(toolId)
          ? getManifestEntry(toolId).inputs[0]?.id
          : typeof toolId === 'string'
            ? retiredFirstInputPort(toolId)
            : undefined;

      const inputs =
        typeof input === 'string' && input !== '' && firstPort !== undefined
          ? { [firstPort]: input }
          : {};

      return { ...rest, inputs };
    }),
  };
}

/**
 * v3 -> v4.
 *
 * v4 merged the `markdown` and `html-text` tools into `text-convert`. A saved
 * canvas can contain either id, so each such node is rewritten to the new id
 * with the equivalent source/target pair. Positions, wires and typed inputs are
 * untouched: the node is the same node doing the same job under a new name.
 *
 * Every other node passes through unread. A migration that rebuilt nodes it had
 * no reason to touch would be a chance to break something for nothing.
 */
function migrateV3ToV4(raw: Record<string, unknown>): unknown {
  if (!Array.isArray(raw.nodes)) return { ...raw, version: 4 };
  const nodes: readonly unknown[] = raw.nodes;

  return {
    ...raw,
    version: 4,
    nodes: nodes.map((node): unknown => {
      if (typeof node !== 'object' || node === null) return node;

      const source = node as Record<string, unknown>;
      if (!isRetiredToolId(source.toolId)) return node;

      const options = migrateRetiredOptions(source.toolId, source.options);
      return { ...source, toolId: REPLACEMENT_TOOL_ID, options: options ?? {} };
    }),
  };
}

/**
 * v4 -> v5.
 *
 * v5 renamed two output ports: `hash.digest` and `image-convert.info` became
 * `output` and `report`. A port id is not a label - it is the key of a node's
 * typed input and two of the four fields of every edge - so a saved canvas
 * naming the old one has to be rewritten rather than merely tolerated.
 *
 * WHAT TOLERATING IT LOOKED LIKE, because "the wire just stops working" is not
 * what happened. An edge leaving `hash.digest` still leaves a node that exists
 * and arrives at a port that exists, so nothing refuses it: the engine looks
 * for a value on an output port called `digest`, finds none, and reports
 * `Nothing arrived on Input` on the node BELOW - which is correctly wired and
 * did nothing wrong. Everything else in the pipeline runs. That is a canvas
 * that works except for the one thing it was built to do, and nothing on
 * screen says which wire is the problem.
 *
 * The rename table lives in `retiredPorts.ts` and is shared with the
 * share-link migration, which has to make exactly the same rewrite.
 *
 * Nodes are rebuilt only where a rename applies; the tool id of each ENDPOINT
 * is what decides, so this needs the node list before it can touch the edges.
 */
function migrateV4ToV5(raw: Record<string, unknown>): unknown {
  /*
   * The literal 5, not `CURRENT_GRAPH_VERSION`. Each step in the chain hands
   * its output back to `migrate`, which dispatches on the version it finds - so
   * a step that stamps "current" claims to have done every later step too. This
   * read `CURRENT_GRAPH_VERSION` while it WAS the last step, which made adding
   * v6 the moment a v4 save would have skipped the v5 -> v6 step entirely.
   */
  const version = 5;
  if (!Array.isArray(raw.nodes)) return { ...raw, version };
  const nodes: readonly unknown[] = raw.nodes;

  /*
   * Tool id per node id, for the edge pass below. Built from whatever is
   * there: an entry that is not shaped like a node contributes nothing and is
   * left for the schema to refuse, and an edge whose endpoint is unknown maps
   * through no table and is refused later by `firstRefusedEdge`.
   */
  const toolOf = new Map<string, unknown>();
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue;
    const source = node as Record<string, unknown>;
    if (typeof source.id === 'string') toolOf.set(source.id, source.toolId);
  }

  const migratedNodes = nodes.map((node): unknown => {
    if (typeof node !== 'object' || node === null) return node;
    const source = node as Record<string, unknown>;
    const inputs = migrateInputKeys(source.toolId, source.inputs);
    // Untouched where nothing moved, so a migration cannot be the thing that
    // breaks a node it had no reason to read.
    return inputs === source.inputs ? node : { ...source, inputs };
  });

  const edges: readonly unknown[] = Array.isArray(raw.edges) ? raw.edges : [];
  const migratedEdges = edges.map((edge): unknown => {
    if (typeof edge !== 'object' || edge === null) return edge;
    const source = edge as Record<string, unknown>;
    const from = source.from;
    const to = source.to;
    if (typeof from !== 'object' || from === null) return edge;
    if (typeof to !== 'object' || to === null) return edge;

    const fromRef = from as Record<string, unknown>;
    const toRef = to as Record<string, unknown>;

    return {
      ...source,
      from: {
        ...fromRef,
        portId: currentOutputPortId(toolOf.get(String(fromRef.nodeId)), fromRef.portId),
      },
      to: {
        ...toRef,
        portId: currentInputPortId(toolOf.get(String(toRef.nodeId)), toRef.portId),
      },
    };
  });

  return { ...raw, version, nodes: migratedNodes, edges: migratedEdges };
}

/**
 * v5 -> v6.
 *
 * v6 added `fileInputs`: a node can now be fed a file through the inspector,
 * and the document records the name and size of one. A v5 node was never fed
 * one, so the map is empty - and it has to be PRESENT rather than absent,
 * because every reader downstream of here treats it as a record it can index.
 *
 * Nothing else is touched. A migration that rebuilt fields it had no reason to
 * read would be a chance to break something for nothing.
 */
function migrateV5ToV6(raw: Record<string, unknown>): unknown {
  const version = CURRENT_GRAPH_VERSION;
  if (!Array.isArray(raw.nodes)) return { ...raw, version };
  const nodes: readonly unknown[] = raw.nodes;

  return {
    ...raw,
    version,
    nodes: nodes.map((node): unknown => {
      if (typeof node !== 'object' || node === null) return node;
      return { ...(node as Record<string, unknown>), fileInputs: {} };
    }),
  };
}

/**
 * Rebuilds the normalised store shape.
 *
 * EVERY EDGE IS KEPT, INCLUDING THE UNUSABLE ONES, and that is a change. This
 * used to filter out edges whose endpoints were missing, which is a silent
 * repair of a document the reader has no way to be sure it understands - and
 * the caller below now has one rule for every kind of broken wire instead of
 * a filter here and a check there. `firstRefusedEdge` sees them and refuses
 * the load, because `checkConnection` already treats a missing endpoint as
 * "that port no longer exists".
 */
function toGraphData(persisted: PersistedGraph): GraphData {
  const nodes: GraphData['nodes'] = Object.fromEntries(
    persisted.nodes.map((node) => [node.id, { ...node, toolId: node.toolId }]),
  );

  const nodeIds = new Set(persisted.nodes.map((node) => node.id));

  return {
    nodes,
    nodeOrder: persisted.nodes.map((node) => node.id),
    edges: Object.fromEntries(persisted.edges.map((edge) => [edge.id, edge])),
    edgeOrder: persisted.edges.map((edge) => edge.id),
    /*
     * The stored counter is a floor, not the answer. It comes out of
     * localStorage, which is neither signed nor beyond a user's reach, and a
     * counter that has fallen behind the ids beside it reissues an id that is
     * already taken - which overwrites a node in place rather than failing.
     */
    nextId: safeNextId(
      nodeIds,
      persisted.edges.map((edge) => edge.id),
      persisted.nextId,
    ),
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

  const graph = toGraphData(result.data);

  /*
   * THE WIRES GO THROUGH THE SAME CHECK A DRAG DOES.
   *
   * The schema can say an edge is shaped like an edge; only
   * `checkConnection` can say it is a connection this build could make. A
   * migration that missed a renamed port, a file edited by hand, a save from a
   * future build read back after a downgrade - each produces a graph that
   * LOADS and then quietly does the wrong thing, because a wire naming a port
   * nothing has is a wire the engine reads no value from and reports against
   * the node below.
   *
   * Refusing the whole save rather than dropping the wire is the same
   * all-or-nothing rule the share link follows, and for the same reason: a
   * pipeline missing one connection is not the pipeline the user built, and
   * nothing on screen would say which one went. Nothing in the app can produce
   * one - every route into the store goes through `checkConnection`, and a new
   * command clears the redo branch - so this is a guard against documents from
   * elsewhere, not a state the canvas can reach by itself.
   */
  const refused = firstRefusedEdge(graph);
  if (refused) {
    return {
      status: 'rejected',
      message: `The saved canvas had a connection this version cannot make, so it has been reset. ${refused.rejection.message}`,
    };
  }

  return { status: 'loaded', graph };
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
