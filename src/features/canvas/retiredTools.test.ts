import { beforeEach, describe, expect, it } from 'vitest';

import { isToolId } from '@/features/registry';
import { encodeBase64 } from '@/lib/base64';

import { GRAPH_STORAGE_KEY, loadGraph } from './persistence';
import { migrateRetiredOptions } from './retiredTools';
import { decodeParamToGraph } from './share';

/**
 * THE MERGE MIGRATION.
 *
 * `markdown` and `html-text` became `text-convert`. Saved canvases and shared
 * links out in the world still name them, and both routes have to keep working
 * - a canvas someone left open last week, and a link someone pasted into an
 * issue months ago.
 *
 * Both are exercised end to end through their real entry points rather than by
 * calling the migration function: the thing worth proving is that a genuine
 * saved payload loads, not that a mapping function maps.
 */

/** A v3 save containing both retired tools, wired together. */
function legacyGraph(): string {
  return JSON.stringify({
    version: 3,
    nodes: [
      {
        id: 'n1',
        toolId: 'html-text',
        position: { x: 8, y: 16 },
        options: { mode: 'markdown', bullet: '*', unsupported: 'text' },
        inputs: { input: '<p>hello</p>' },
      },
      {
        id: 'n2',
        toolId: 'markdown',
        position: { x: 400, y: 16 },
        options: { direction: 'md-to-html', headingIds: false, linkify: true },
        inputs: {},
      },
    ],
    edges: [
      { id: 'e1', from: { nodeId: 'n1', portId: 'output' }, to: { nodeId: 'n2', portId: 'input' } },
    ],
    nextId: 3,
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('the retired ids themselves', () => {
  it('are gone from the registry', () => {
    // The loader is keyed by ToolId, so an id the manifest does not know
    // cannot reach a dynamic import at all - which is what stops an old graph
    // asking for a chunk that no longer exists.
    expect(isToolId('markdown')).toBe(false);
    expect(isToolId('html-text')).toBe(false);
    expect(isToolId('text-convert')).toBe(true);
  });
});

describe('a saved canvas', () => {
  it('loads, with both nodes rewritten and the wire intact', () => {
    window.localStorage.setItem(GRAPH_STORAGE_KEY, legacyGraph());

    const result = loadGraph();

    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') return;

    expect(result.graph.nodeOrder).toEqual(['n1', 'n2']);
    expect(result.graph.nodes.n1?.toolId).toBe('text-convert');
    expect(result.graph.nodes.n2?.toolId).toBe('text-convert');
    // The wire survives: the nodes are the same nodes under a new name.
    expect(result.graph.edgeOrder).toHaveLength(1);
  });

  it('keeps each node doing the job it was doing', () => {
    window.localStorage.setItem(GRAPH_STORAGE_KEY, legacyGraph());
    const result = loadGraph();
    if (result.status !== 'loaded') throw new Error('expected the graph to load');

    // html-text in markdown mode only ever read HTML.
    expect(result.graph.nodes.n1?.options).toMatchObject({
      source: 'html',
      target: 'markdown',
      bullet: '*',
      unsupported: 'text',
    });

    // markdown in md-to-html direction.
    expect(result.graph.nodes.n2?.options).toMatchObject({
      source: 'markdown',
      target: 'html',
      headingIds: false,
      linkify: true,
    });
  });

  it('keeps the typed input', () => {
    window.localStorage.setItem(GRAPH_STORAGE_KEY, legacyGraph());
    const result = loadGraph();
    if (result.status !== 'loaded') throw new Error('expected the graph to load');

    expect(result.graph.nodes.n1?.inputs).toEqual({ input: '<p>hello</p>' });
  });

  it('carries a v2 save through both steps, keeping its typed input', () => {
    /*
     * The chain case, and the one that nearly broke. v2 -> v3 moves a node's
     * single `input` string onto its first port, and it finds the port name in
     * the LIVE registry - where a retired id no longer appears. Without the
     * retired-tool fallback the input would vanish on the way past, in exactly
     * the nodes v3 -> v4 exists to rescue.
     */
    window.localStorage.setItem(
      GRAPH_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        nodes: [
          {
            id: 'n1',
            toolId: 'markdown',
            position: { x: 0, y: 0 },
            options: { direction: 'html-to-md' },
            input: '<h1>kept</h1>',
          },
        ],
        edges: [],
        nextId: 2,
      }),
    );

    const result = loadGraph();
    if (result.status !== 'loaded') throw new Error('expected the graph to load');

    expect(result.graph.nodes.n1?.toolId).toBe('text-convert');
    expect(result.graph.nodes.n1?.inputs).toEqual({ input: '<h1>kept</h1>' });
    expect(result.graph.nodes.n1?.options).toMatchObject({ source: 'html', target: 'markdown' });
  });

  it('leaves every other tool alone', () => {
    window.localStorage.setItem(
      GRAPH_STORAGE_KEY,
      JSON.stringify({
        version: 3,
        nodes: [
          {
            id: 'n1',
            toolId: 'base64',
            position: { x: 0, y: 0 },
            options: { mode: 'decode' },
            inputs: {},
          },
        ],
        edges: [],
        nextId: 2,
      }),
    );

    const result = loadGraph();
    if (result.status !== 'loaded') throw new Error('expected the graph to load');

    expect(result.graph.nodes.n1?.toolId).toBe('base64');
    expect(result.graph.nodes.n1?.options).toEqual({ mode: 'decode' });
  });
});

describe('an old share link', () => {
  /**
   * Encodes an arbitrary payload the way an older build would have.
   *
   * Built by hand rather than with the encoder, because the encoder can only
   * produce the CURRENT format - and a v1 link is exactly what this is for.
   * The stream is assembled explicitly because jsdom's Blob has no `stream()`,
   * the same reason share.ts has its own `streamOf`.
   */
  async function legacyLink(payload: unknown): Promise<string> {
    const source = new ReadableStream<BufferSource>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
        controller.close();
      },
    });

    const reader = source.pipeThrough(new CompressionStream('deflate-raw')).getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }

    return encodeBase64(bytes, { urlSafe: true, padding: false, wrapAt: 0 });
  }

  const v1Link = (nodes: readonly unknown[]): Promise<string> =>
    legacyLink({ v: 1, n: nodes, e: [] });

  it('migrates rather than being refused', async () => {
    /*
     * MIGRATE, NOT REJECT. A link is something people paste into a chat or an
     * issue and come back to weeks later, and the mapping is exact, so
     * breaking every previously-shared pipeline containing a Markdown node
     * would be a cost with nothing bought.
     */
    const param = await v1Link([
      ['n1', 'markdown', 0, 0, { direction: 'html-to-md', bullet: '+' }],
    ]);

    const result = await decodeParamToGraph(param);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(result.graph.nodes.n1?.toolId).toBe('text-convert');
    expect(result.graph.nodes.n1?.options).toMatchObject({
      source: 'html',
      target: 'markdown',
      bullet: '+',
    });
  });

  it('migrates html-text links too', async () => {
    const param = await v1Link([['n1', 'html-text', 0, 0, { mode: 'text', tables: 'drop' }]]);
    const result = await decodeParamToGraph(param);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.graph.nodes.n1?.options).toMatchObject({
      source: 'html',
      target: 'text',
      tables: 'drop',
    });
  });

  it('still refuses a link that is broken in any other way, whole', async () => {
    /*
     * The all-or-nothing property is what the migration must not weaken. It
     * rewrites ids BEFORE the schema runs, so the schema is still the last
     * word: a payload that fails it for any reason is refused entire, and no
     * part of it reaches the canvas.
     */
    const param = await v1Link([
      ['n1', 'markdown', 0, 0, {}],
      ['n2', 'not-a-real-tool', 0, 0, {}],
    ]);

    const result = await decodeParamToGraph(param);

    expect(result.status).toBe('error');
    // Not "one node loaded and one skipped".
    expect(result).not.toHaveProperty('graph');
  });

  it('refuses a version from the future rather than half-reading it', async () => {
    const param = await legacyLink({ v: 99, n: [], e: [] });

    const result = await decodeParamToGraph(param);

    expect(result.status).toBe('error');
  });
});

describe('the option mapping', () => {
  it('maps every direction and mode the old tools had', () => {
    expect(migrateRetiredOptions('markdown', { direction: 'md-to-html' })).toMatchObject({
      source: 'markdown',
      target: 'html',
    });
    expect(migrateRetiredOptions('markdown', { direction: 'html-to-md' })).toMatchObject({
      source: 'html',
      target: 'markdown',
    });
    expect(migrateRetiredOptions('html-text', { mode: 'markdown' })).toMatchObject({
      source: 'html',
      target: 'markdown',
    });
    expect(migrateRetiredOptions('html-text', { mode: 'text' })).toMatchObject({
      source: 'html',
      target: 'text',
    });
  });

  it('falls back to each old tool default when the key is missing or junk', () => {
    expect(migrateRetiredOptions('markdown', {})).toMatchObject({ target: 'html' });
    expect(migrateRetiredOptions('markdown', { direction: 'nonsense' })).toMatchObject({
      target: 'html',
    });
    expect(migrateRetiredOptions('html-text', { mode: 42 })).toMatchObject({ target: 'markdown' });
  });

  it('drops values it does not recognise rather than passing them through', () => {
    // Saved options are user-writable and a share link is attacker-controlled,
    // so every value is re-checked rather than spread across.
    const mapped = migrateRetiredOptions('markdown', {
      bullet: 'evil',
      fence: '`',
      direction: 'md-to-html',
      somethingElse: 'nope',
    });

    expect(mapped).not.toHaveProperty('bullet');
    expect(mapped).not.toHaveProperty('somethingElse');
    expect(mapped).not.toHaveProperty('direction');
    expect(mapped).toMatchObject({ fence: '`' });
  });

  it('returns null for an id that was never retired', () => {
    expect(migrateRetiredOptions('base64', {})).toBeNull();
  });

  it('survives options that are not an object at all', () => {
    expect(migrateRetiredOptions('markdown', null)).toMatchObject({ target: 'html' });
    expect(migrateRetiredOptions('html-text', 'nonsense')).toMatchObject({ target: 'markdown' });
  });
});
