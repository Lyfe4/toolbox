import { getManifestEntry, isToolId } from '@/features/registry';
import type { Bytes } from '@/features/registry/types';
import { decodeBase64, encodeBase64 } from '@/lib/base64';
import { setOwnProperty } from '@/lib/safeObject';
import { z } from '@/lib/zod';

import { snapToGrid } from './geometry';
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

export const SHARE_FORMAT_VERSION = 1;

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

  const payload = sharePayloadSchema.safeParse(parsed);
  if (!payload.success) {
    // Includes the version check: a link from a future format is refused
    // cleanly rather than half-understood.
    return {
      status: 'error',
      message: 'That shared pipeline link is in a format this version cannot read.',
    };
  }

  return { status: 'ok', graph: fromSharePayload(payload.data) };
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

  payload.e.forEach(([fromNode, fromPort, toNode, toPort], index) => {
    if (!(fromNode in nodes) || !(toNode in nodes)) return;
    const id = `e${index.toString()}`;
    edges[id] = {
      id,
      from: { nodeId: fromNode, portId: fromPort },
      to: { nodeId: toNode, portId: toPort },
    };
    edgeOrder.push(id);
  });

  if (nodeOrder.length === 0) return EMPTY_GRAPH;

  return {
    nodes,
    nodeOrder,
    edges,
    edgeOrder,
    nextId: nodeOrder.length + edgeOrder.length + 1,
  };
}

/** The full link for a graph, ready to copy. */
export async function buildShareUrl(graph: GraphData, origin: string): Promise<string> {
  const param = await encodeGraphToParam(graph);
  return `${origin}/?${SHARE_PARAM}=${param}`;
}
