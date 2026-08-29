import { describe, expect, it } from 'vitest';

import { encodeBase64 } from '@/lib/base64';

import {
  buildShareUrl,
  decodeParamToGraph,
  encodeGraphToParam,
  fromSharePayload,
  MAX_SHARE_PARAM_LENGTH,
  sharePayloadSchema,
  toSharePayload,
} from './share';

import type { CanvasNode, GraphData } from './types';

function node(
  id: string,
  toolId: 'base64' | 'structured-data' | 'hash',
  input: string,
): CanvasNode {
  return {
    id,
    toolId,
    position: { x: 0, y: 0 },
    options: { mode: 'decode' },
    inputs: { input },
  };
}

/** A representative four-node pipeline, wired in a chain. */
function pipeline(): GraphData {
  const nodes = [
    { ...node('n1', 'base64', 'SGVsbG8sIHBhdGNoYmF5'), position: { x: 0, y: 0 } },
    {
      ...node('n2', 'structured-data', ''),
      position: { x: 320, y: 0 },
      options: { source: 'auto', target: 'yaml', indent: 2, sortKeys: true, delimiter: 'comma' },
    },
    {
      ...node('n3', 'hash', ''),
      position: { x: 640, y: 0 },
      options: { algorithm: 'sha-256', encoding: 'hex', outputCase: 'lower' },
    },
    {
      ...node('n4', 'hash', ''),
      position: { x: 640, y: 240 },
      options: { algorithm: 'md5', encoding: 'base64', outputCase: 'lower' },
    },
  ];

  return {
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    nodeOrder: nodes.map((n) => n.id),
    edges: {
      e1: {
        id: 'e1',
        from: { nodeId: 'n1', portId: 'output' },
        to: { nodeId: 'n2', portId: 'input' },
      },
      e2: {
        id: 'e2',
        from: { nodeId: 'n2', portId: 'output' },
        to: { nodeId: 'n3', portId: 'input' },
      },
      e3: {
        id: 'e3',
        from: { nodeId: 'n1', portId: 'output' },
        to: { nodeId: 'n4', portId: 'input' },
      },
    },
    edgeOrder: ['e1', 'e2', 'e3'],
    nextId: 8,
  };
}

/* ========================================================================== *
 * The rule that matters most
 * ========================================================================== */

describe('user data never enters a share link', () => {
  const secrets = [
    'SGVsbG8sIHBhdGNoYmF5',
    'hunter2',
    'eyJhbGciOiJIUzI1NiJ9.secret.payload',
    'BEGIN RSA PRIVATE KEY',
  ];

  it('omits typed input from the payload', () => {
    const graph = pipeline();
    const payload = toSharePayload(graph);
    const json = JSON.stringify(payload);

    expect(json).not.toContain('SGVsbG8sIHBhdGNoYmF5');
    // Structure and options survive; content does not.
    expect(json).toContain('base64');
    expect(json).toContain('sha-256');
  });

  it.each(secrets)('never encodes %j into the URL', async (secret) => {
    const graph = pipeline();
    const withSecret: GraphData = {
      ...graph,
      nodes: {
        ...graph.nodes,
        n1: { ...node('n1', 'base64', secret), position: { x: 0, y: 0 } },
      },
    };

    const param = await encodeGraphToParam(withSecret);

    // The compressed form must not contain it, and neither must what it
    // decompresses back to.
    expect(param).not.toContain(secret);
    const decoded = await decodeParamToGraph(param);
    expect(decoded.status).toBe('ok');
    if (decoded.status === 'ok') {
      expect(JSON.stringify(decoded.graph)).not.toContain(secret);
      // Every node comes back with an empty input, whatever was typed.
      for (const id of decoded.graph.nodeOrder) {
        expect(decoded.graph.nodes[id]?.inputs).toEqual({});
      }
    }
  });

  it('has no field for input in the payload schema at all', () => {
    // Belt and braces: even a hand-crafted payload cannot carry input.
    const withInput = sharePayloadSchema.safeParse({
      v: 1,
      n: [['n1', 'base64', 0, 0, {}, 'smuggled']],
      e: [],
    });
    expect(withInput.success).toBe(false);
  });
});

/* ========================================================================== *
 * Round trip
 * ========================================================================== */

/*
 * Options DO travel in a share link - that is the point of one. A JWT signing
 * key is an option by the type system's reckoning and a credential by any
 * other, so a tool can name such keys and they are dropped on the way out.
 */
describe('secret options never enter a share link', () => {
  const withKey: GraphData = {
    nodes: {
      n1: {
        id: 'n1',
        toolId: 'jwt-decode',
        position: { x: 0, y: 0 },
        options: { key: 'super-secret-signing-key', keyEncoding: 'utf8', clockToleranceSec: 30 },
        inputs: {},
      },
    },
    nodeOrder: ['n1'],
    edges: {},
    edgeOrder: [],
    nextId: 2,
  };

  it('drops the option the tool declared secret', () => {
    const options = toSharePayload(withKey).n[0]?.[4];
    expect(options).toEqual({ keyEncoding: 'utf8', clockToleranceSec: 30 });
    expect(options).not.toHaveProperty('key');
  });

  it('keeps the secret out of the encoded parameter entirely', async () => {
    const param = await encodeGraphToParam(withKey);
    const url = await buildShareUrl(withKey, 'https://patchbay.test');

    // The payload is compressed, so decode it back rather than searching the
    // ciphertext-looking base64 for a substring that could never appear.
    const restored = await decodeParamToGraph(param);
    expect(restored.status).toBe('ok');
    if (restored.status !== 'ok') return;
    expect(restored.graph.nodes.n1?.options).not.toHaveProperty('key');
    expect(url).not.toContain('super-secret');
  });

  it('does not disturb the options of a tool with no secrets', () => {
    const options = toSharePayload(pipeline()).n[1]?.[4];
    expect(options).toMatchObject({ target: 'yaml', indent: 2 });
  });
});

describe('round trip', () => {
  it('restores the structure, positions, wires and options', async () => {
    const graph = pipeline();
    const param = await encodeGraphToParam(graph);
    const result = await decodeParamToGraph(param);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(result.graph.nodeOrder).toEqual(['n1', 'n2', 'n3', 'n4']);
    expect(result.graph.nodes.n3?.options).toEqual({
      algorithm: 'sha-256',
      encoding: 'hex',
      outputCase: 'lower',
    });
    expect(result.graph.nodes.n4?.position).toEqual({ x: 640, y: 240 });
    expect(result.graph.edgeOrder).toHaveLength(3);
  });

  it('produces a URL short enough to paste', async () => {
    const url = await buildShareUrl(pipeline(), 'https://patchbay.example');
    console.warn(`  [share] four-node pipeline URL: ${url.length.toString()} chars`);
    console.warn(`  [share] ${url}`);

    expect(url.length).toBeLessThan(MAX_SHARE_PARAM_LENGTH);
    expect(url.startsWith('https://patchbay.example/?p=')).toBe(true);
  });

  it('compresses: the encoded param is smaller than the raw JSON', async () => {
    const graph = pipeline();
    const raw = JSON.stringify(toSharePayload(graph));
    const param = await encodeGraphToParam(graph);

    console.warn(
      `  [share] raw JSON ${raw.length.toString()} chars -> param ${param.length.toString()} chars`,
    );
    expect(param.length).toBeLessThan(raw.length);
  });

  it('uses only URL-safe characters, so nothing needs escaping', async () => {
    const param = await encodeGraphToParam(pipeline());
    expect(param).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(param)).toBe(param);
  });

  it('round-trips an empty canvas', async () => {
    const empty: GraphData = {
      nodes: {},
      nodeOrder: [],
      edges: {},
      edgeOrder: [],
      nextId: 1,
    };
    const result = await decodeParamToGraph(await encodeGraphToParam(empty));
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.graph.nodeOrder).toEqual([]);
  });
});

/* ========================================================================== *
 * Hostile input
 * ========================================================================== */

describe('a share link is untrusted input', () => {
  it.each([
    ['not base64 at all', '!!!!not-valid!!!!'],
    [
      'valid base64 that is not a deflate stream',
      encodeBase64(new Uint8Array([1, 2, 3, 4]), { urlSafe: true, padding: false, wrapAt: 0 }),
    ],
    ['empty', ''],
  ])('rejects %s with a message and no graph', async (_label, param) => {
    const result = await decodeParamToGraph(param);
    expect(result.status).toBe('error');
    if (result.status === 'error')
      expect(result.message).toMatch(/could not be read|too long|cannot read/);
  });

  it('rejects a truncated payload', async () => {
    const param = await encodeGraphToParam(pipeline());
    const result = await decodeParamToGraph(param.slice(0, Math.floor(param.length / 2)));
    expect(result.status).toBe('error');
  });

  it('rejects a payload longer than the cap without decompressing it', async () => {
    const result = await decodeParamToGraph('A'.repeat(MAX_SHARE_PARAM_LENGTH + 1));
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.message).toMatch(/too long/);
  });

  it('rejects a tool id that is not in the registry, rather than importing it', () => {
    // The critical case: a hostile link naming "../../evil" or any unknown id
    // must fail schema validation, so nothing ever reaches the dynamic import.
    for (const evil of ['../../evil', 'http://example.com/x', 'ghost-tool', '']) {
      const result = sharePayloadSchema.safeParse({
        v: 1,
        n: [['n1', evil, 0, 0, {}]],
        e: [],
      });
      expect(result.success).toBe(false);
    }
  });

  it('rejects a payload from a different format version', () => {
    expect(sharePayloadSchema.safeParse({ v: 2, n: [], e: [] }).success).toBe(false);
    expect(sharePayloadSchema.safeParse({ n: [], e: [] }).success).toBe(false);
  });

  it('refuses an absurd number of nodes', () => {
    const many = Array.from({ length: 500 }, (_, index) => [
      `n${index.toString()}`,
      'base64',
      0,
      0,
      {},
    ]);
    expect(sharePayloadSchema.safeParse({ v: 1, n: many, e: [] }).success).toBe(false);
  });

  it('drops edges whose endpoints are missing rather than applying half a graph', () => {
    const graph = fromSharePayload({
      v: 1,
      n: [['n1', 'base64', 0, 0, {}]],
      e: [['n1', 'output', 'ghost', 'input']],
    });
    expect(graph.nodeOrder).toEqual(['n1']);
    expect(graph.edgeOrder).toEqual([]);
  });

  it('ignores duplicate node ids', () => {
    const graph = fromSharePayload({
      v: 1,
      n: [
        ['n1', 'base64', 0, 0, {}],
        ['n1', 'hash', 100, 100, {}],
      ],
      e: [],
    });
    expect(graph.nodeOrder).toEqual(['n1']);
    expect(graph.nodes.n1?.toolId).toBe('base64');
  });

  it('snaps hostile positions onto the grid', () => {
    const graph = fromSharePayload({
      v: 1,
      n: [['n1', 'base64', 3.7, -11.2, {}]],
      e: [],
    });
    expect((graph.nodes.n1?.position.x ?? 1) % 8).toBe(0);
  });
});
