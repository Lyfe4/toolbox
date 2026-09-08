import { getManifestEntry, isToolId } from '@/features/registry';
import type { Bytes } from '@/features/registry/types';
import { decodeBase64, encodeBase64 } from '@/lib/base64';
import { setOwnProperty } from '@/lib/safeObject';
import { z } from '@/lib/zod';

import { safeNextId } from './commands';
import { firstRefusedEdge } from './connections';
import { snapToGrid } from './geometry';
import { currentInputPortId, currentOutputPortId } from './retiredPorts';
import { isRetiredToolId, migrateRetiredOptions, REPLACEMENT_TOOL_ID } from './retiredTools';
import { MAX_SHARE_PARAM_LENGTH, SHARE_PARAM } from './shareSearch';
import { EMPTY_GRAPH, type CanvasEdge, type CanvasNode, type GraphData } from './types';

/**
 * SHAREABLE PIPELINE LINKS
 *
 * A link carries the SHAPE of a pipeline - which tools, where, wired how, with
 * which settings - and nothing else.
 *
 * It never carries what the user typed. `CanvasNode.inputs` is deliberately
 * absent from the payload below and from the schema that reads one back: a
 * share link is something people paste into chat and issue trackers, and the
 * whole premise of Patchbay is that pasted data does not leave the machine.
 * A URL is the one place it could accidentally escape, so the omission is
 * enforced by `toSharePayload` and asserted by share.test.ts.
 */

export const SHARE_FORMAT_VERSION = 3;

// Re-exported so callers have one import for everything share-related, while
// the route keeps importing the tiny module directly.
export { MAX_SHARE_PARAM_LENGTH, SHARE_PARAM } from './shareSearch';

const MAX_DECOMPRESSED_BYTES = 256 * 1024;
const MAX_NODES = 100;
const MAX_EDGES = 300;

/* ========================================================================== *
 * Payload shape
 * ========================================================================== */

/** [id, toolId, x, y, options] - positional, because this goes in a URL. */
const sharedNodeSchema = z.tuple([
  z.string().min(1).max(32),
  // Checked against the live registry, so a hostile link cannot name a tool
  // that does not exist and cannot trigger a dynamic import of an arbitrary id.
  z.string().refine(isToolId, 'Unknown tool'),
  // z.number() already rejects NaN and Infinity in Zod 4.
  z.number(),
  z.number(),
  z.record(z.string(), z.unknown()),
]);

/** [fromNode, fromPort, toNode, toPort] */
const sharedEdgeSchema = z.tuple([
  z.string().min(1).max(32),
  z.string().min(1).max(32),
  z.string().min(1).max(32),
  z.string().min(1).max(32),
]);

export const sharePayloadSchema = z.object({
  v: z.literal(SHARE_FORMAT_VERSION),
  n: z.array(sharedNodeSchema).max(MAX_NODES),
  e: z.array(sharedEdgeSchema).max(MAX_EDGES),
});

export type SharePayload = z.output<typeof sharePayloadSchema>;

/* ========================================================================== *
 * Encoding
 * ========================================================================== */

/**
 * Options minus anything the tool declared a secret.
 *
 * Options DO travel in a share link - that is the point, a link should
 * reproduce the pipeline as configured. A JWT signing key is configuration by
 * the type system's reckoning and a credential by any other, so the tool names
 * it in `secretOptionKeys` and it is dropped here.
 *
 * Built by copying the keys that are allowed rather than deleting the ones
 * that are not, so a bug in the key list omits an option rather than leaking
 * one.
 */
function shareableOptions(node: CanvasNode): Record<string, unknown> {
  const secrets = new Set<string>(getManifestEntry(node.toolId).secretOptionKeys ?? []);
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node.options)) {
    if (!secrets.has(key)) setOwnProperty(out, key, value);
  }

  return out;
}

/**
 * Structure only. Note what is NOT read from the node: `inputs`.
 *
 * Written as an explicit field list rather than a spread-and-delete, so adding
 * a field to CanvasNode cannot silently start leaking it into share links.
 */
export function toSharePayload(graph: GraphData): SharePayload {
  return {
    v: SHARE_FORMAT_VERSION,
    n: graph.nodeOrder.flatMap((id): SharePayload['n'] => {
      const node = graph.nodes[id];
      if (!node) return [];
      return [[node.id, node.toolId, node.position.x, node.position.y, shareableOptions(node)]];
    }),
    e: graph.edgeOrder.flatMap((id): SharePayload['e'] => {
      const edge = graph.edges[id];
      if (!edge) return [];
      return [[edge.from.nodeId, edge.from.portId, edge.to.nodeId, edge.to.portId]];
    }),
  };
}

/** One-shot source stream. Built by hand because jsdom's Blob has no stream(). */
function streamOf(bytes: Bytes): ReadableStream<BufferSource> {
  // Typed as BufferSource because that is what CompressionStream's writable
  // side accepts, and pipeThrough matches the two exactly.
  return new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Drains a stream, refusing to grow past `limit`.
 *
 * The cap is enforced WHILE reading rather than afterwards: a decompression
 * bomb is a short input that expands enormously, so checking the total at the
 * end would mean having already allocated it.
 */
async function drain(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.length;
      if (total > limit) throw new Error('Payload is too large.');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function deflate(bytes: Bytes): Promise<Uint8Array> {
  return drain(
    streamOf(bytes).pipeThrough(new CompressionStream('deflate-raw')),
    MAX_DECOMPRESSED_BYTES,
  );
}

async function inflate(bytes: Bytes): Promise<Uint8Array> {
  return drain(
    streamOf(bytes).pipeThrough(new DecompressionStream('deflate-raw')),
    MAX_DECOMPRESSED_BYTES,
  );
}

/** Compact JSON -> deflate -> URL-safe base64, unpadded. */
export async function encodeGraphToParam(graph: GraphData): Promise<string> {
  const json = JSON.stringify(toSharePayload(graph));
  const compressed = await deflate(new TextEncoder().encode(json));
  return encodeBase64(compressed, { urlSafe: true, padding: false, wrapAt: 0 });
}

/* ========================================================================== *
 * Decoding
 * ========================================================================== */

export type ShareResult =
  | { readonly status: 'ok'; readonly graph: GraphData }
  | { readonly status: 'error'; readonly message: string };

const BAD_LINK = 'That shared pipeline link could not be read, so the canvas was left empty.';

/**
 * Rewrites an older payload to the current format.
 *
 * MIGRATE, NOT REJECT, and the reasoning is about what a share link is for. A
 * link is something people paste into a chat or an issue and come back to
 * weeks later; breaking every previously-shared pipeline that happened to
 * contain a Markdown node - or a hash node, for the v2 step - would be a real
 * cost to real people, and both mappings are exact.
 *
 * RUN BEFORE VALIDATION, deliberately. The schema checks tool ids against the
 * live registry, so a v1 link naming `markdown` would be refused outright if
 * this ran afterwards. Rewriting first and validating second means the schema
 * is still the last word on every field - the migration is allowed to be
 * optimistic because it cannot let anything through.
 *
 * THE ALL-OR-NOTHING PROPERTY IS UNCHANGED. This returns a new payload; it
 * never mutates a graph or applies anything. If what comes out fails the
 * schema for any reason, the link is refused whole, exactly as before. There
 * is no path here that half-applies a pipeline.
 */
function migrateSharePayload(parsed: unknown): unknown {
  if (typeof parsed !== 'object' || parsed === null) return parsed;

  const payload = parsed as Record<string, unknown>;

  // Chained, the same way the persisted graph's migrations chain: each step
  // knows only about the one before it, and the v1 step's output goes back in
  // so the v2 step sees CURRENT tool ids rather than retired ones - which
  // matters, because the port rename it applies is looked up per tool.
  if (payload.v === 1) return migrateSharePayload(shareV1ToV2(payload));
  if (payload.v === 2) return shareV2ToV3(payload);
  return parsed;
}

/** v1 -> v2: the two retired tools become `text-convert`. */
function shareV1ToV2(payload: Record<string, unknown>): unknown {
  if (!Array.isArray(payload.n)) return { ...payload, v: 2 };
  const nodes: readonly unknown[] = payload.n;

  return {
    ...payload,
    v: 2,
    n: nodes.map((node): unknown => {
      // Positional tuples: [id, toolId, x, y, options]. Anything not shaped
      // like one is left alone for the schema to reject.
      if (!Array.isArray(node) || node.length < 5) return node;

      const [id, toolId, x, y, options] = node as readonly unknown[];
      if (!isRetiredToolId(toolId)) return node;

      return [id, REPLACEMENT_TOOL_ID, x, y, migrateRetiredOptions(toolId, options) ?? {}];
    }),
  };
}

/**
 * v2 -> v3: two output ports were renamed.
 *
 * `hash.digest` became `output` and `image-convert.info` became `report`, and
 * a link's edges are the only place those ids appear in a payload - a link
 * carries no typed input, so there are no input keys to rewrite.
 *
 * WHY A LINK NAMING THE OLD PORT COULD NOT SIMPLY BE REFUSED. A link is
 * something people paste into a chat or an issue and come back to weeks later,
 * and half the shipped presets end in a hash node. Refusing them would break
 * real pipelines belonging to real people for a rename made for tidiness.
 *
 * WHY IT COULD NOT SIMPLY BE ACCEPTED EITHER. The edge would still name a node
 * that exists and an input port that exists, so nothing refuses it: the
 * recipient gets a canvas that draws the wire, runs the upstream node, and
 * reports `Nothing arrived on Input` on the node below it. Half-applied is the
 * one outcome a share link must never have.
 *
 * The table is shared with the persisted-graph migration - see
 * `retiredPorts.ts`, which explains what each rename was for.
 */
function shareV2ToV3(payload: Record<string, unknown>): unknown {
  const v = SHARE_FORMAT_VERSION;
  if (!Array.isArray(payload.n)) return { ...payload, v };

  const nodes: readonly unknown[] = payload.n;
  const toolOf = new Map<string, unknown>();
  for (const node of nodes) {
    if (!Array.isArray(node) || node.length < 2) continue;
    const [id, toolId] = node as readonly unknown[];
    if (typeof id === 'string') toolOf.set(id, toolId);
  }

  const edges: readonly unknown[] = Array.isArray(payload.e) ? payload.e : [];

  return {
    ...payload,
    v,
    e: edges.map((edge): unknown => {
      // [fromNode, fromPort, toNode, toPort]. Anything else is the schema's
      // problem, not this function's.
      if (!Array.isArray(edge) || edge.length < 4) return edge;

      const [fromNode, fromPort, toNode, toPort] = edge as readonly unknown[];
      return [
        fromNode,
        currentOutputPortId(toolOf.get(String(fromNode)), fromPort),
        toNode,
        currentInputPortId(toolOf.get(String(toNode)), toPort),
      ];
    }),
  };
}

/**
 * Rebuilds a graph from a link.
 *
 * Every step can fail on hostile input and every step therefore returns a
 * message rather than throwing: bounded length, valid base64, valid deflate
 * stream, valid UTF-8, valid JSON, matching schema, known tool ids, and
 * finally edges whose endpoints actually exist. Nothing is applied until all
 * of that passes, so a partly-valid link produces an empty canvas rather than
 * half a pipeline.
 */
export async function decodeParamToGraph(param: string): Promise<ShareResult> {
  if (param.length > MAX_SHARE_PARAM_LENGTH) {
    return { status: 'error', message: 'That shared pipeline link is too long to be genuine.' };
  }

  const bytes = decodeBase64(param);
  if (!bytes.ok) return { status: 'error', message: BAD_LINK };

  let json: string;
  try {
    const inflated = await inflate(bytes.value);
    json = new TextDecoder('utf-8', { fatal: true }).decode(inflated);
  } catch {
    return { status: 'error', message: BAD_LINK };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { status: 'error', message: BAD_LINK };
  }

  // Rewrites retired tool ids before the schema sees them. See above: this
  // cannot let anything through, because the schema still runs afterwards.
  const payload = sharePayloadSchema.safeParse(migrateSharePayload(parsed));
  if (!payload.success) {
    // Includes the version check: a link from a FUTURE format is refused
    // cleanly rather than half-understood. Older ones are migrated above
    // rather than refused, so this is genuinely "cannot read" and not
    // "will not bother".
    return {
      status: 'error',
      message: 'That shared pipeline link is in a format this version cannot read.',
    };
  }

  const graph = fromSharePayload(payload.data);

  /*
   * THE LAST CHECK IS THE SAME ONE A POINTER DROP MAKES.
   *
   * The schema has said every edge is shaped like an edge and every tool id is
   * real. Only `checkConnection` can say the wires are connections THIS build
   * could make: a port that has been renamed since the link was written, two
   * wires into one input, a cycle, a node wired to itself. A hostile link can
   * carry any of those and a genuine old one can carry the first.
   *
   * Refused whole, never in part, which is the property the header of this
   * file claims and this is what makes it true of ports as well as of parsing.
   * The rejection's own sentence is included: "Input already has a connection"
   * is a fact about the link the recipient can act on, where "could not be
   * read" is a shrug.
   */
  const refused = firstRefusedEdge(graph);
  if (refused) {
    return {
      status: 'error',
      message: `That shared pipeline link has a connection this version cannot make, so nothing was applied. ${refused.rejection.message}`,
    };
  }

  return { status: 'ok', graph };
}

/** Turns a validated payload into the normalised store shape. */
export function fromSharePayload(payload: SharePayload): GraphData {
  const nodes: Record<string, CanvasNode> = {};
  const nodeOrder: string[] = [];

  for (const [id, toolId, x, y, options] of payload.n) {
    if (id in nodes) continue; // Duplicate ids in a hostile link.
    nodes[id] = {
      id,
      toolId: toolId,
      position: { x: snapToGrid(x), y: snapToGrid(y) },
      options,
      // Always empty: input never travels in a link, so it never comes back.
      inputs: {},
    };
    nodeOrder.push(id);
  }

  const edges: Record<string, CanvasEdge> = {};
  const edgeOrder: string[] = [];

  /*
   * EVERY EDGE IS KEPT, including one naming a node that is not here.
   *
   * This used to skip those, which contradicted the paragraph above it: a link
   * whose edges half survive IS a half-applied pipeline, just one where the
   * missing half is invisible rather than reported. `checkConnection` already
   * reads a missing endpoint as "that port no longer exists", so keeping the
   * edge and letting `decodeParamToGraph` refuse the link gives one rule for
   * every unusable wire instead of a filter here and a check there.
   */
  payload.e.forEach(([fromNode, fromPort, toNode, toPort], index) => {
    const id = `e${index.toString()}`;
    edges[id] = {
      id,
      from: { nodeId: fromNode, portId: fromPort },
      to: { nodeId: toNode, portId: toPort },
    };
    edgeOrder.push(id);
  });

  /*
   * An empty link is an empty canvas, and only an empty link. A payload with
   * no nodes but some EDGES is not empty, it is nonsense - and returning
   * EMPTY_GRAPH for it would drop those edges on the floor, which is the
   * silent repair this function has just stopped doing one paragraph up. Built
   * as it stands instead, so `decodeParamToGraph` refuses it by name.
   */
  if (nodeOrder.length === 0 && edgeOrder.length === 0) return EMPTY_GRAPH;

  return {
    nodes,
    nodeOrder,
    edges,
    edgeOrder,
    // Derived from the ids actually present, never from how many there are.
    // See `safeNextId` - counting was wrong for any link whose ids were
    // sparse, which is every link made after deleting anything.
    nextId: safeNextId(nodeOrder, edgeOrder),
  };
}

/** The full link for a graph, ready to copy. */
export async function buildShareUrl(graph: GraphData, origin: string): Promise<string> {
  const param = await encodeGraphToParam(graph);
  return `${origin}/?${SHARE_PARAM}=${param}`;
}
