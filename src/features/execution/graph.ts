import type { CanvasEdge, CanvasNode, GraphData, NodeId } from '@/features/canvas/types';
import { getManifestEntry } from '@/features/registry';
import type {
  ToolError,
  ToolInputs,
  ToolOutputs,
  ToolResult,
  ToolValue,
} from '@/features/registry/types';

import type { ExecuteOptions } from './engine';

/**
 * PIPELINE EXECUTION
 *
 * Runs a canvas graph in dependency order: every node waits for the nodes that
 * feed it, independent branches run side by side, and nothing runs twice if
 * nothing it depends on has changed.
 */

export type NodeRunStatus = 'idle' | 'blocked' | 'running' | 'ok' | 'error' | 'upstream-failed';

export interface NodeRunState {
  readonly status: NodeRunStatus;
  readonly outputs: ToolOutputs | null;
  readonly error: ToolError | null;
  readonly durationMs: number | null;
  /** Why this node cannot run yet. Shown on the node and announced. */
  readonly blockedReason: string | null;
  /** The node that actually failed, when this one is only downstream of it. */
  readonly failedUpstream: NodeId | null;
  /** The cache key this state was produced for. */
  readonly key: string;
}

export type PipelineState = Readonly<Record<NodeId, NodeRunState>>;

export interface PipelineSummary {
  readonly states: PipelineState;
  readonly ran: number;
  readonly cached: number;
  /** Nodes that failed themselves. Never counts the nodes downstream of them. */
  readonly failed: number;
  /**
   * Nodes that never ran because something upstream failed.
   *
   * Counted separately because it is the number a person actually wants when
   * one node breaks a long chain. The summary used to report only `failed`, so
   * a five-node pipeline with a broken first node announced "1 failure" and
   * said nothing at all about the four nodes that produced no answer - the
   * counts did not add up to the graph, and the missing four were the point.
   */
  readonly skipped: number;
  readonly blocked: number;
  readonly durationMs: number;
  readonly cancelled: boolean;
}

/** Node id -> the state and key it was last computed with. */
export type PipelineCache = Map<NodeId, NodeRunState>;

const IDLE: NodeRunState = {
  status: 'idle',
  outputs: null,
  error: null,
  durationMs: null,
  blockedReason: null,
  failedUpstream: null,
  key: '',
};

export function idleState(): NodeRunState {
  return IDLE;
}

/* ========================================================================== *
 * Topological order
 * ========================================================================== */

export class CycleError extends Error {
  constructor(public readonly remaining: readonly NodeId[]) {
    super(
      `The pipeline contains a cycle involving ${remaining.length.toString()} nodes. ` +
        'Connections are checked for cycles before they are made, so reaching this ' +
        'point means a connection was created without that check.',
    );
    this.name = 'CycleError';
  }
}

/**
 * Kahn's algorithm: repeatedly take a node with nothing left feeding it.
 *
 * Throws rather than returning a partial order. A cycle here is not a user
 * error - `checkConnection` already refuses to create one - so it means a bug,
 * and quietly executing a subset of the graph would hide it.
 */
export function topologicalOrder(graph: GraphData): readonly NodeId[] {
  const indegree = new Map<NodeId, number>();
  const successors = new Map<NodeId, NodeId[]>();

  for (const id of graph.nodeOrder) {
    indegree.set(id, 0);
    successors.set(id, []);
  }

  for (const edgeId of graph.edgeOrder) {
    const edge = graph.edges[edgeId];
    if (!edge) continue;
    if (!indegree.has(edge.to.nodeId) || !indegree.has(edge.from.nodeId)) continue;
    indegree.set(edge.to.nodeId, (indegree.get(edge.to.nodeId) ?? 0) + 1);
    successors.get(edge.from.nodeId)?.push(edge.to.nodeId);
  }

  const queue = graph.nodeOrder.filter((id) => (indegree.get(id) ?? 0) === 0);
  const order: NodeId[] = [];

  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    order.push(id);

    for (const next of successors.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  if (order.length !== graph.nodeOrder.length) {
    throw new CycleError(graph.nodeOrder.filter((id) => !order.includes(id)));
  }

  return order;
}

/* ========================================================================== *
 * Cache keys
 * ========================================================================== */

/** JSON with object keys sorted, so `{a,b}` and `{b,a}` hash the same. */
function stableStringify(value: unknown): string {
  // JSON.stringify only returns undefined for values outside this branch.
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

/** FNV-1a, 32-bit. Cheap, and only ever compared for equality. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Separator between the parts of a cache key.
 *
 * A character that cannot occur in any of the parts, so two different splits
 * of the same text cannot produce the same key. It was a literal NUL byte in
 * the file until this pass, which made the source read as binary to git, grep
 * and prettier alike; the escape is the same character, spelled so a person
 * can see it.
 */
const KEY_SEPARATOR = '\u0000';

/**
 * One wire arriving at a node, as the cache key sees it.
 *
 * All three fields are load-bearing, and two of them used to be missing.
 */
export interface UpstreamRef {
  /** The input port on THIS node that the wire arrives at. */
  readonly toPortId: string;
  /** The output port on the upstream node that the wire leaves from. */
  readonly fromPortId: string;
  /** The upstream node's own cache key. */
  readonly key: string;
}

/**
 * A node's cache key.
 *
 * Built from the tool, its options, its own typed-in input, and the KEYS of
 * the nodes feeding it - not from their output values. That is the whole
 * trick: comparing upstream keys is O(1) whatever the data is, so a 30 MB
 * decoded file never has to be hashed to know whether it changed. It relies on
 * tools being deterministic, which the type system already enforces by making
 * `run` a pure function returning a ToolResult.
 *
 * WHICH PORT, NOT JUST WHICH NODE. The key used to be the sorted SET of
 * upstream keys, which made two genuinely different graphs identical:
 *
 *   - Swap the two wires into a diff node. The set is unchanged, so the cached
 *     patch is served for the reversed comparison and the diff comes back the
 *     right way round for the wiring it had a moment ago.
 *   - Move a wire from a tool's `output` port to its `data` port - the same
 *     upstream node, an entirely different value. The set is unchanged again,
 *     so the previous port's answer is served for the new one.
 *
 * Both produce an answer that looks completely plausible and is stale, which
 * is the worst failure this cache can have: nobody reports it, because nothing
 * looks wrong. The wiring is part of a node's identity, so it is part of its
 * key.
 */
export function nodeCacheKey(node: CanvasNode, upstream: readonly UpstreamRef[]): string {
  return fnv1a(
    [
      node.toolId,
      stableStringify(node.options),
      // Every typed port, in a stable order.
      JSON.stringify(Object.entries(node.inputs).sort(([a], [b]) => (a < b ? -1 : 1))),
      /*
       * Every FILE port, likewise. Name, size and token: the token is the
       * load-bearing part, because two different files can share a name and a
       * size and swapping one for the other has to re-run the node rather than
       * serve the previous answer. The bytes themselves are never hashed - for
       * a 64 MB image that would cost more than the conversion.
       */
      JSON.stringify(Object.entries(node.fileInputs).sort(([a], [b]) => (a < b ? -1 : 1))),
      // Sorted by the RECEIVING port, so the order edges happen to sit in the
      // document cannot change the key while the wiring is the same.
      [...upstream]
        .sort((a, b) => (a.toPortId < b.toPortId ? -1 : a.toPortId > b.toPortId ? 1 : 0))
        .map((ref) => `${ref.toPortId}<-${ref.fromPortId}@${ref.key}`)
        .join(','),
    ].join(KEY_SEPARATOR),
  );
}

/* ========================================================================== *
 * Running
 * ========================================================================== */

export interface RunPipelineDeps {
  readonly execute: (options: ExecuteOptions) => Promise<ToolResult<ToolOutputs>>;
  /** How many nodes may be in flight at once. */
  readonly concurrency?: number;
  /** Refuses to start beyond this many nodes, so the tab cannot be wedged. */
  readonly maxNodes?: number;
  readonly signal?: AbortSignal;
  readonly cache?: PipelineCache;
  readonly onUpdate?: (nodeId: NodeId, state: NodeRunState) => void;
  readonly now?: () => number;
  /**
   * The value of a file chosen for one of a node's input ports, if there is
   * one in this session.
   *
   * Injected rather than read from a store, so the engine stays a pure
   * function of a graph plus its dependencies and a test can drive a file
   * input without a `File`, a `FileReader` or the canvas. The document says a
   * port HAS a file (`node.fileInputs`); only this can say whether the bytes
   * are still here, which is exactly the difference between a node the user
   * just fed and a node reloaded from storage.
   */
  readonly fileInput?: (nodeId: NodeId, portId: string) => ToolValue | undefined;
}

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_MAX_NODES = 100;

interface Incoming {
  readonly portId: string;
  readonly edge: CanvasEdge;
}

function incomingByNode(graph: GraphData): Map<NodeId, Incoming[]> {
  const map = new Map<NodeId, Incoming[]>();
  for (const edgeId of graph.edgeOrder) {
    const edge = graph.edges[edgeId];
    if (!edge) continue;
    const list = map.get(edge.to.nodeId) ?? [];
    list.push({ portId: edge.to.portId, edge });
    map.set(edge.to.nodeId, list);
  }
  return map;
}

function settle(
  partial: Partial<NodeRunState> & { status: NodeRunStatus; key: string },
): NodeRunState {
  return { ...IDLE, ...partial };
}

/**
 * Executes the graph.
 *
 * Independent branches run concurrently up to `concurrency`; the bound exists
 * so that wiring twenty consumers to one source spawns four workers' worth of
 * work rather than twenty at once.
 */
export async function runPipeline(
  graph: GraphData,
  deps: RunPipelineDeps,
): Promise<PipelineSummary> {
  const started = (deps.now ?? (() => performance.now()))();
  const now = deps.now ?? (() => performance.now());
  const concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY);
  const maxNodes = deps.maxNodes ?? DEFAULT_MAX_NODES;
  const cache = deps.cache ?? new Map<NodeId, NodeRunState>();

  const order = topologicalOrder(graph);
  const states = new Map<NodeId, NodeRunState>();
  let ran = 0;
  let cached = 0;
  let failed = 0;
  let skipped = 0;
  let blocked = 0;

  /*
   * The cache outlives a run and is keyed by node id, so an entry for a
   * deleted node would sit there holding that node's whole output - which for
   * an image or a decoded file is megabytes - for as long as the tab is open.
   * Pruned here rather than on deletion because this is the one place that
   * sees both the cache and the graph it belongs to.
   */
  for (const id of cache.keys()) {
    if (!(id in graph.nodes)) cache.delete(id);
  }

  if (order.length > maxNodes) {
    for (const id of order) {
      states.set(
        id,
        settle({
          status: 'blocked',
          key: '',
          blockedReason: `This canvas has ${order.length.toString()} nodes; the executor runs at most ${maxNodes.toString()}.`,
        }),
      );
    }
    return {
      states: Object.fromEntries(states),
      ran: 0,
      cached: 0,
      failed: 0,
      skipped: 0,
      blocked: order.length,
      durationMs: now() - started,
      cancelled: false,
    };
  }

  const incoming = incomingByNode(graph);
  const emit = (id: NodeId, state: NodeRunState): void => {
    states.set(id, state);
    deps.onUpdate?.(id, state);
  };

  /** Decides a node's fate from its predecessors, or returns null to run it. */
  function preflight(node: CanvasNode, key: string): NodeRunState | null {
    const entry = getManifestEntry(node.toolId);
    const feeds = incoming.get(node.id) ?? [];

    for (const port of entry.inputs) {
      if (!port.required) continue;
      const feed = feeds.find((candidate) => candidate.portId === port.id);

      if (!feed) {
        /*
         * No wire. WIRE, THEN FILE, THEN TEXT - each a more deliberate act
         * than the one after it, and the same precedence the inspector draws.
         */
        if (deps.fileInput?.(node.id, port.id) !== undefined) continue;

        /*
         * A FILE THE DOCUMENT REMEMBERS AND THIS SESSION DOES NOT HAVE.
         *
         * The only way to reach this is a canvas that was saved with a file on
         * this port and then reloaded, because the bytes are session state by
         * design - see `attachmentStore`. Reported as its own reason rather
         * than falling through to "Needs input": the two look identical on a
         * node and are not the same problem, and telling somebody to type into
         * a port they fed a photograph is how a fixable state reads as a bug.
         */
        const remembered = node.fileInputs[port.id];
        if (remembered) {
          return settle({
            status: 'blocked',
            key,
            blockedReason:
              entry.inputs.length === 1
                ? `"${remembered.name}" needs choosing again`
                : `${port.label}: "${remembered.name}" needs choosing again`,
          });
        }

        // The port takes the node's typed-in text instead, provided it can
        // carry text and the user has actually typed something.
        const acceptsText = port.types.includes('text');
        const typed = node.inputs[port.id] ?? '';
        if (acceptsText && typed !== '') continue;

        return settle({
          status: 'blocked',
          key,
          blockedReason: acceptsText
            ? entry.inputs.length === 1
              ? 'Needs input'
              : `Needs ${port.label}`
            : /*
               * NOT "Needs a wire" any more. This port takes bytes and a file
               * is now a way to supply them, so naming only the wire described
               * half of what would work - the same class of defect as drawing
               * a control for behaviour that does not exist, in reverse.
               */
              `Needs a file or a wire into ${port.label}`,
        });
      }

      const upstream = states.get(feed.edge.from.nodeId);
      if (!upstream) return settle({ status: 'blocked', key, blockedReason: 'Waiting upstream' });

      if (upstream.status === 'error' || upstream.status === 'upstream-failed') {
        // Distinct from 'error': this node did not fail, it never got to run.
        // Only the node that actually failed shows the error message.
        return settle({
          status: 'upstream-failed',
          key,
          failedUpstream: upstream.failedUpstream ?? feed.edge.from.nodeId,
        });
      }

      if (upstream.status === 'ok' && upstream.outputs?.[feed.edge.from.portId] === undefined) {
        /*
         * The upstream ran and reported success, but has nothing on the port
         * this wire leaves from.
         *
         * The type system makes a tool produce every output it declares, but
         * that guarantee is erased at the registry boundary - `ErasedTool.run`
         * returns a loose record - so this is the one place it can be checked
         * rather than assumed. Without it the missing value simply never
         * arrived, and the DOWNSTREAM node reported "missing required input"
         * for something it was correctly wired to receive: an error on the
         * node that did nothing wrong, naming a port that is plainly connected.
         */
        return settle({
          status: 'blocked',
          key,
          blockedReason: `Nothing arrived on ${port.label}`,
        });
      }

      if (upstream.status === 'blocked' || upstream.status === 'idle') {
        // 'idle' here means the upstream node was cancelled mid-run rather
        // than never visited: it produced no value, so this node cannot run
        // and has not failed either.
        return settle({ status: 'blocked', key, blockedReason: 'Waiting upstream' });
      }
    }

    return null;
  }

  function buildInputs(node: CanvasNode): ToolInputs {
    const entry = getManifestEntry(node.toolId);
    const feeds = incoming.get(node.id) ?? [];
    const inputs: Record<string, ToolValue> = {};

    for (const port of entry.inputs) {
      const feed = feeds.find((candidate) => candidate.portId === port.id);

      if (feed) {
        const upstream = states.get(feed.edge.from.nodeId);
        const value = upstream?.outputs?.[feed.edge.from.portId];
        if (value) inputs[port.id] = value;
        continue;
      }

      /*
       * A file beats typed text, matching `preflight` above and the inspector.
       * The value was built and validated against this port at the moment it
       * was chosen, so there is nothing to decode or refuse here.
       *
       * It is handed over BY REFERENCE and the executor is called with
       * `ownership: 'borrow'`, so every consumer gets a structured clone. One
       * file feeding two nodes is the same fan-out as one output feeding two
       * inputs, and it is safe for the same reason.
       */
      const file = deps.fileInput?.(node.id, port.id);
      if (file) {
        inputs[port.id] = file;
        continue;
      }

      const typed = node.inputs[port.id] ?? '';
      if (typed !== '') inputs[port.id] = { type: 'text', text: typed };
    }

    return inputs;
  }

  async function runNode(id: NodeId): Promise<void> {
    const node = graph.nodes[id];
    if (!node) return;

    const feeds = incoming.get(id) ?? [];
    const upstream: readonly UpstreamRef[] = feeds.map((feed) => ({
      toPortId: feed.portId,
      fromPortId: feed.edge.from.portId,
      key: states.get(feed.edge.from.nodeId)?.key ?? '',
    }));
    const key = nodeCacheKey(node, upstream);

    const decided = preflight(node, key);
    if (decided) {
      emit(id, decided);
      if (decided.status === 'blocked') blocked += 1;
      if (decided.status === 'upstream-failed') skipped += 1;
      return;
    }

    // Cache hit: same tool, same options, same typed input, same upstream keys.
    const previous = cache.get(id);
    if (previous?.key === key && (previous.status === 'ok' || previous.status === 'error')) {
      cached += 1;
      emit(id, previous);
      if (previous.status === 'error') failed += 1;
      return;
    }

    emit(id, settle({ status: 'running', key }));

    const at = now();
    let result: ToolResult<ToolOutputs>;
    try {
      result = await deps.execute({
        toolId: node.toolId,
        inputs: buildInputs(node),
        options: node.options,
        // Borrow, always: on a canvas one output can feed several inputs, and
        // a transferred buffer would be detached by whichever consumer ran
        // first.
        ownership: 'borrow',
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
    } catch (error) {
      /*
       * `execute` is contractually a function that returns a ToolResult rather
       * than throwing, and the engine holds to that - but it is injected, and
       * the paths under it are not all ours. `postMessage` throws outright on
       * a value it cannot clone or when it cannot allocate the copy, which on
       * a canvas running four heavy nodes at once is a real possibility.
       *
       * Without this the rejection escaped through `void runNode(id)` as an
       * unhandled promise rejection AND the node was never emitted at all: it
       * kept whatever status it had, and the summary simply did not mention
       * it. A node that vanishes is worse than a node that fails.
       */
      result = {
        ok: false,
        error: {
          code: 'internal',
          message: 'This node could not be run.',
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }
    const durationMs = now() - at;

    /*
     * CANCELLATION IS NOT A RESULT, AND MUST NOT BE CACHED.
     *
     * A cancelled run used to be stored exactly like a real failure: the node
     * showed "Cancelled." as its own error, and - far worse - that error went
     * into the cache under a key computed from a graph that had not changed.
     * The next run was therefore a cache HIT, so the node reported a
     * cancellation forever, without ever executing again, until something
     * unrelated happened to change its key. Editing the node was the only way
     * out, and nothing on screen suggested that.
     *
     * The node goes back to idle instead: it did not fail, it did not run.
     */
    if (!result.ok && result.error.code === 'cancelled') {
      emit(id, idleState());
      return;
    }

    const state = result.ok
      ? settle({ status: 'ok', key, outputs: result.value, durationMs })
      : settle({ status: 'error', key, error: result.error, durationMs, failedUpstream: id });

    if (!result.ok) failed += 1;
    else ran += 1;

    cache.set(id, state);
    emit(id, state);
  }

  /* --- Scheduling ------------------------------------------------------- */

  const remaining = new Map<NodeId, number>();
  const successors = new Map<NodeId, NodeId[]>();
  for (const id of order) {
    /*
     * Only wires whose SOURCE still exists count towards a node's wait.
     *
     * A dangling edge - one whose `from` node is not in the graph - would
     * otherwise leave its target waiting for a node that will never run. The
     * pump resolves when nothing is active and nothing is ready, so that node
     * would not fail or block: it would simply be absent from the run's
     * states, and the canvas would go on showing whatever it last said.
     *
     * Nothing in the app should produce a dangling edge - deletion takes the
     * attached wires with it, and both loaders drop edges with missing
     * endpoints - but "should not" is how a node disappears silently.
     */
    const feeds = (incoming.get(id) ?? []).filter((feed) => feed.edge.from.nodeId in graph.nodes);
    remaining.set(id, feeds.length);
    successors.set(id, []);
  }
  for (const edgeId of graph.edgeOrder) {
    const edge = graph.edges[edgeId];
    if (edge) successors.get(edge.from.nodeId)?.push(edge.to.nodeId);
  }

  const ready = order.filter((id) => (remaining.get(id) ?? 0) === 0);
  let active = 0;
  let cancelled = false;

  await new Promise<void>((resolve) => {
    const pump = (): void => {
      if (deps.signal?.aborted) {
        cancelled = true;
        if (active === 0) resolve();
        return;
      }

      while (active < concurrency && ready.length > 0) {
        const id = ready.shift();
        if (id === undefined) break;
        active += 1;

        void runNode(id).finally(() => {
          active -= 1;
          for (const next of successors.get(id) ?? []) {
            const left = (remaining.get(next) ?? 0) - 1;
            remaining.set(next, left);
            if (left === 0) ready.push(next);
          }
          pump();
        });
      }

      if (active === 0 && ready.length === 0) resolve();
    };

    pump();
  });

  return {
    states: Object.fromEntries(states),
    ran,
    cached,
    failed,
    skipped,
    blocked,
    durationMs: now() - started,
    cancelled,
  };
}
