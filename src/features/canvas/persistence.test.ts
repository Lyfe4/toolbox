import { beforeEach, describe, expect, it, vi } from 'vitest';

import { firstRefusedEdge } from './connections';
import {
  createDebouncedSaver,
  CURRENT_GRAPH_VERSION,
  GRAPH_STORAGE_KEY,
  loadGraph,
  saveGraph,
  toPersisted,
} from './persistence';
import { EMPTY_GRAPH, type GraphData } from './types';

const graph: GraphData = {
  nodes: {
    n1: {
      id: 'n1',
      toolId: 'base64',
      position: { x: 8, y: 16 },
      options: {},
      inputs: {},
      fileInputs: {},
    },
    n2: {
      id: 'n2',
      toolId: 'structured-data',
      position: { x: 400, y: 16 },
      options: { target: 'yaml' },
      inputs: {},
      fileInputs: {},
    },
  },
  nodeOrder: ['n1', 'n2'],
  edges: {
    e1: {
      id: 'e1',
      from: { nodeId: 'n1', portId: 'output' },
      to: { nodeId: 'n2', portId: 'input' },
    },
  },
  edgeOrder: ['e1'],
  nextId: 3,
};

describe('graph persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('reports an empty canvas when nothing is stored', () => {
    expect(loadGraph()).toEqual({ status: 'empty' });
  });

  it('round-trips a graph', () => {
    saveGraph(graph);
    const result = loadGraph();

    expect(result.status).toBe('loaded');
    if (result.status === 'loaded') {
      expect(result.graph.nodeOrder).toEqual(['n1', 'n2']);
      expect(result.graph.edgeOrder).toEqual(['e1']);
      expect(result.graph.nodes.n2?.options).toEqual({ target: 'yaml' });
      expect(result.graph.nextId).toBe(3);
    }
  });

  it('stores under a namespaced, versioned key', () => {
    saveGraph(graph);
    expect(window.localStorage.getItem(GRAPH_STORAGE_KEY)).toContain(
      `"version":${CURRENT_GRAPH_VERSION.toString()}`,
    );
    // The KEY stays at v3 while the payload moves on: they version separately,
    // so a save is migrated rather than orphaned.
    expect(GRAPH_STORAGE_KEY).toBe('patchbay:graph:v3');
  });

  /*
   * Every one of these used to be a crash waiting to happen. A saved graph is
   * user-writable data from an unknown past build, so each case must produce an
   * empty canvas and an explanation - never an exception, and never a
   * half-restored graph.
   */
  it.each([
    ['not json at all', 'unparseable text'],
    ['{"version":9,"nodes":[],"edges":[],"nextId":1}', 'a newer version'],
    ['{"nodes":[],"edges":[],"nextId":1}', 'a missing version'],
    ['{"version":3,"nodes":"nope","edges":[],"nextId":1}', 'a wrong node type'],
    ['{"version":3,"nodes":[],"edges":[],"nextId":0}', 'an invalid counter'],
    [
      '{"version":3,"nodes":[{"id":"n1","toolId":"ghost-tool","position":{"x":0,"y":0},"options":{},"inputs":{}}],"edges":[],"nextId":2}',
      'a tool that no longer exists',
    ],
    [
      '{"version":3,"nodes":[{"id":"n1","toolId":"base64","position":{"x":"left","y":0},"options":{},"inputs":{}}],"edges":[],"nextId":2}',
      'a non-numeric position',
    ],
  ])('rejects %s (%s) with a message rather than throwing', (payload) => {
    window.localStorage.setItem(GRAPH_STORAGE_KEY, payload);

    const result = loadGraph();
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.message).toMatch(/reset/);
    }
  });

  /*
   * WAS "drops edges whose endpoints are gone rather than rejecting the whole
   * graph", AND THE DROP WAS THE WRONG HALF OF THE CHOICE.
   *
   * Loading with the wire quietly removed is a canvas that looks like the
   * user's and is not: the node below it goes from wired to blocked, and
   * nothing anywhere says a connection was thrown away. Every wire now goes
   * through `checkConnection` on the way in - the same function a pointer drop
   * uses - and one it refuses rejects the save with the reason.
   *
   * Nothing in the app can write such a save. Every route into the store goes
   * through `checkConnection`, and any new command clears the redo branch, so
   * a dangling edge means a file edited by hand or written by another build.
   */
  it('rejects a save whose edge names a node that is gone, with the reason', () => {
    window.localStorage.setItem(
      GRAPH_STORAGE_KEY,
      JSON.stringify({
        version: 3,
        nodes: [{ id: 'n1', toolId: 'base64', position: { x: 0, y: 0 }, options: {}, inputs: {} }],
        edges: [
          {
            id: 'e1',
            from: { nodeId: 'n1', portId: 'output' },
            to: { nodeId: 'gone', portId: 'input' },
          },
        ],
        nextId: 2,
      }),
    );

    const result = loadGraph();
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.message).toMatch(/reset/);
      expect(result.message).toContain('That port no longer exists.');
    }
  });

  /*
   * Migration is the only reason old saves are not simply thrown away. A user
   * who leaves a pipeline on the canvas and comes back after an update should
   * find it, so each of these asserts the structure survives AND that the typed
   * input lands on the right port rather than a guessed one.
   */
  it('migrates a v2 save, moving the single input onto the first port', () => {
    window.localStorage.setItem(
      'patchbay:graph:v3',
      JSON.stringify({
        version: 2,
        nodes: [
          {
            id: 'n1',
            toolId: 'base64',
            position: { x: 0, y: 0 },
            options: { mode: 'decode' },
            input: 'aGk=',
          },
        ],
        edges: [],
        nextId: 2,
      }),
    );

    const result = loadGraph();
    expect(result.status).toBe('loaded');
    if (result.status === 'loaded') {
      // base64's first input port is called "input"; the id comes from the
      // registry, so this stays right even if the port is renamed.
      expect(result.graph.nodes.n1?.inputs).toEqual({ input: 'aGk=' });
      expect(result.graph.nodes.n1?.options).toEqual({ mode: 'decode' });
    }
  });

  it('migrates a v1 save, which never had any input to carry', () => {
    window.localStorage.setItem(
      GRAPH_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        nodes: [
          {
            id: 'n1',
            toolId: 'base64',
            position: { x: 0, y: 0 },
            options: {},
            status: 'idle',
          },
        ],
        edges: [],
        nextId: 2,
      }),
    );

    const result = loadGraph();
    expect(result.status).toBe('loaded');
    if (result.status === 'loaded') {
      expect(result.graph.nodes.n1?.inputs).toEqual({});
      // `status` was document state in v1 and is derived now; it must not have
      // ridden along into the restored node.
      expect(result.graph.nodes.n1).not.toHaveProperty('status');
    }
  });

  it('flattens to a compact shape', () => {
    const persisted = toPersisted(graph);
    expect(persisted.nodes).toHaveLength(2);
    expect(persisted.edges).toHaveLength(1);
    expect(persisted.version).toBe(CURRENT_GRAPH_VERSION);
  });
});

/* ========================================================================== *
 * v4 -> v5: the renamed output ports
 * ========================================================================== */

describe('a v4 save whose wires name the old port ids', () => {
  /*
   * The port audit renamed `hash.digest` to `output` and `image-convert.info`
   * to `report`. A port id is not a label - it is two of the four fields of
   * every edge, and the key of a node's typed input - so a save naming the old
   * one has to be rewritten.
   *
   * WHAT NOT REWRITING IT LOOKED LIKE MATTERS, because "the wire stops
   * working" undersells it. An edge leaving `hash.digest` still leaves a node
   * that exists and arrives at a port that exists, so nothing refuses it: the
   * engine looks for a value on an output port called `digest`, finds none,
   * and reports `Nothing arrived on Original` on the node BELOW - a node that
   * is correctly wired and did nothing wrong. The rest of the pipeline runs
   * normally. That is a canvas which works except for the thing it was built
   * to do, with nothing on screen to say which wire is the problem.
   */
  const v4 = {
    version: 4,
    nextId: 5,
    nodes: [
      { id: 'n1', toolId: 'hash', position: { x: 0, y: 0 }, options: {}, inputs: { input: 'abc' } },
      { id: 'n2', toolId: 'hash', position: { x: 320, y: 0 }, options: {}, inputs: { input: 'x' } },
      { id: 'n3', toolId: 'diff', position: { x: 640, y: 0 }, options: {}, inputs: {} },
      { id: 'n4', toolId: 'image-convert', position: { x: 0, y: 300 }, options: {}, inputs: {} },
      {
        id: 'n5',
        toolId: 'structured-data',
        position: { x: 320, y: 300 },
        options: {},
        inputs: {},
      },
    ],
    edges: [
      {
        id: 'e1',
        from: { nodeId: 'n1', portId: 'digest' },
        to: { nodeId: 'n3', portId: 'original' },
      },
      {
        id: 'e2',
        from: { nodeId: 'n2', portId: 'digest' },
        to: { nodeId: 'n3', portId: 'changed' },
      },
      { id: 'e3', from: { nodeId: 'n4', portId: 'info' }, to: { nodeId: 'n5', portId: 'input' } },
    ],
  };

  it('rewrites every renamed output port and keeps the pipeline whole', () => {
    window.localStorage.setItem(GRAPH_STORAGE_KEY, JSON.stringify(v4));

    const result = loadGraph();
    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') return;

    expect(result.graph.edges.e1?.from.portId).toBe('output');
    expect(result.graph.edges.e2?.from.portId).toBe('output');
    expect(result.graph.edges.e3?.from.portId).toBe('report');

    // Nothing else moved: same nodes, same wiring, same typed input.
    expect(result.graph.nodeOrder).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
    expect(result.graph.edgeOrder).toEqual(['e1', 'e2', 'e3']);
    expect(result.graph.edges.e1?.to).toEqual({ nodeId: 'n3', portId: 'original' });
    expect(result.graph.nodes.n1?.inputs).toEqual({ input: 'abc' });
  });

  /*
   * The migration's own guarantee, stated as a test rather than as a comment:
   * what comes out is a graph every wire of which `checkConnection` accepts.
   * If a rename were ever missed, this fails here rather than on the canvas.
   */
  it('produces a graph whose every wire passes the connection check', () => {
    window.localStorage.setItem(GRAPH_STORAGE_KEY, JSON.stringify(v4));

    const result = loadGraph();
    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') return;
    expect(firstRefusedEdge(result.graph)).toBeNull();
  });

  /*
   * A save that still names a port nothing has after every migration has run
   * is refused WHOLE, with the reason. Loading it with the wire quietly
   * dropped would hand back a canvas that looks like the user's and is not.
   */
  it('refuses a save naming a port no migration knows about', () => {
    window.localStorage.setItem(
      GRAPH_STORAGE_KEY,
      JSON.stringify({
        ...v4,
        version: CURRENT_GRAPH_VERSION,
        // Stamped as current, so no migration runs and the nodes have to
        // already be in the current shape.
        nodes: v4.nodes.map((node) => ({ ...node, fileInputs: {} })),
        edges: [
          {
            id: 'e1',
            from: { nodeId: 'n1', portId: 'fingerprint' },
            to: { nodeId: 'n3', portId: 'original' },
          },
        ],
      }),
    );

    const result = loadGraph();
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.message).toContain('That port no longer exists.');
  });

  /*
   * The whole chain in one go. A v1 save contains a retired TOOL and, once
   * that tool is rewritten, may contain a retired PORT - so the two migrations
   * have to compose, which is why the persisted chain hands each step's output
   * back into `migrate` rather than running them in a fixed sequence.
   */
  it('migrates a v1 save with a retired tool and a renamed port together', () => {
    window.localStorage.setItem(
      GRAPH_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        nextId: 3,
        nodes: [
          {
            id: 'n1',
            toolId: 'markdown',
            status: 'ok',
            position: { x: 0, y: 0 },
            options: { direction: 'html-to-md' },
          },
          { id: 'n2', toolId: 'hash', status: 'idle', position: { x: 320, y: 0 }, options: {} },
        ],
        edges: [
          {
            id: 'e1',
            from: { nodeId: 'n1', portId: 'output' },
            to: { nodeId: 'n2', portId: 'input' },
          },
        ],
      }),
    );

    const result = loadGraph();
    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') return;

    expect(result.graph.nodes.n1?.toolId).toBe('text-convert');
    expect(result.graph.nodes.n1?.options).toMatchObject({ source: 'html', target: 'markdown' });
    expect(firstRefusedEdge(result.graph)).toBeNull();
  });
});

describe('a v5 save, from before a node could be fed a file', () => {
  const v5 = {
    version: 5,
    nextId: 3,
    nodes: [
      {
        id: 'n1',
        toolId: 'hash',
        position: { x: 0, y: 0 },
        options: { algorithm: 'md5' },
        inputs: { input: 'abc' },
      },
      { id: 'n2', toolId: 'image-convert', position: { x: 320, y: 0 }, options: {}, inputs: {} },
    ],
    edges: [],
  };

  /*
   * v6 added `fileInputs`, and it has to be PRESENT rather than absent: every
   * reader downstream of the schema indexes it as a record. A v5 node was never
   * fed a file, so the map is empty - the structure is preserved and the user
   * loses nothing that was ever saved.
   */
  it('loads, with an empty file map on every node', () => {
    window.localStorage.setItem(GRAPH_STORAGE_KEY, JSON.stringify(v5));

    const result = loadGraph();
    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') return;

    expect(result.graph.nodes.n1?.fileInputs).toEqual({});
    expect(result.graph.nodes.n2?.fileInputs).toEqual({});
    // And nothing else moved.
    expect(result.graph.nodes.n1?.inputs).toEqual({ input: 'abc' });
    expect(result.graph.nodes.n1?.options).toEqual({ algorithm: 'md5' });
  });

  /*
   * THE STEP BEFORE IT HAS TO STAMP 5, NOT "CURRENT".
   *
   * Migrations chain: each step rewrites the payload and hands it back to the
   * dispatcher, which reads the `version` it finds. `migrateV4ToV5` wrote
   * `CURRENT_GRAPH_VERSION`, which was correct for exactly as long as it was
   * the last step - and wrong the moment v6 existed, because a v4 save would
   * then have arrived claiming to have had the v5 -> v6 step run over it and
   * skipped it. It is only observable from a v4 save, which is why it is
   * asserted here rather than beside the v6 schema.
   */
  it('does not let an older save skip the step, however long the chain gets', () => {
    const v4 = {
      ...v5,
      version: 4,
      nodes: v5.nodes.map((node) => ({ ...node })),
    };
    window.localStorage.setItem(GRAPH_STORAGE_KEY, JSON.stringify(v4));

    const result = loadGraph();
    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') return;
    expect(result.graph.nodes.n1?.fileInputs).toEqual({});
  });

  /*
   * A save that names a file is read back with the name and the size and
   * nothing that could be the file itself. This is the round trip the whole
   * persistence answer rests on.
   */
  it('round-trips a file reference without its contents', () => {
    const withFile = {
      ...v5,
      version: CURRENT_GRAPH_VERSION,
      nodes: v5.nodes.map((node) => ({
        ...node,
        fileInputs:
          node.id === 'n2' ? { input: { name: 'holiday.png', size: 2048, token: 4 } } : {},
      })),
    };
    window.localStorage.setItem(GRAPH_STORAGE_KEY, JSON.stringify(withFile));

    const result = loadGraph();
    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') return;

    expect(result.graph.nodes.n2?.fileInputs.input).toEqual({
      name: 'holiday.png',
      size: 2048,
      token: 4,
    });
  });

  /*
   * And a hand-edited one is refused rather than trusted. `localStorage` is
   * neither signed nor beyond a user's reach, and a `size` that is negative or
   * fractional is only ever printed - which is exactly the kind of value that
   * stops being checked.
   */
  it('refuses a file reference whose size is not a whole count of bytes', () => {
    const broken = {
      ...v5,
      version: CURRENT_GRAPH_VERSION,
      nodes: v5.nodes.map((node) => ({
        ...node,
        fileInputs: node.id === 'n2' ? { input: { name: 'x', size: -1, token: 0 } } : {},
      })),
    };
    window.localStorage.setItem(GRAPH_STORAGE_KEY, JSON.stringify(broken));

    expect(loadGraph().status).toBe('rejected');
  });
});

describe('the id counter on load', () => {
  /*
   * The stored counter is a floor rather than the answer.
   *
   * It comes out of localStorage, which is neither signed nor beyond a user's
   * reach, and a counter that has fallen behind the ids stored beside it
   * reissues an id that is already taken. `withNode` treats a repeat id as an
   * update, so the canvas would overwrite an existing node in place instead of
   * adding one - no error, no clue, and the wires would still be attached.
   */
  it('never trusts a stored counter that has fallen behind the ids', () => {
    window.localStorage.setItem(
      GRAPH_STORAGE_KEY,
      JSON.stringify({
        version: CURRENT_GRAPH_VERSION,
        nextId: 1,
        nodes: [
          {
            id: 'n1',
            toolId: 'base64',
            position: { x: 0, y: 0 },
            options: {},
            inputs: {},
            fileInputs: {},
          },
          {
            id: 'n9',
            toolId: 'hash',
            position: { x: 320, y: 0 },
            options: {},
            inputs: {},
            fileInputs: {},
          },
        ],
        edges: [],
      }),
    );

    const result = loadGraph();
    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') return;

    expect(result.graph.nextId).toBeGreaterThan(9);
    expect(`n${result.graph.nextId.toString()}` in result.graph.nodes).toBe(false);
  });
});

describe('debounced saving', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
  });

  it('writes once for a burst of updates', () => {
    const saver = createDebouncedSaver(200);

    // Stands in for a drag: many store updates in quick succession.
    for (let step = 0; step < 30; step += 1) saver.save(graph);
    expect(window.localStorage.getItem(GRAPH_STORAGE_KEY)).toBeNull();

    vi.advanceTimersByTime(200);
    expect(window.localStorage.getItem(GRAPH_STORAGE_KEY)).not.toBeNull();

    vi.useRealTimers();
  });

  it('flushes immediately when asked, for unmount', () => {
    const saver = createDebouncedSaver(5000);
    saver.save(graph);
    saver.flush();
    expect(window.localStorage.getItem(GRAPH_STORAGE_KEY)).not.toBeNull();
    vi.useRealTimers();
  });

  it('never writes the initial empty graph over a real save', () => {
    saveGraph(graph);
    const before = window.localStorage.getItem(GRAPH_STORAGE_KEY);

    const saver = createDebouncedSaver(10);
    saver.save(EMPTY_GRAPH);
    saver.flush();

    expect(window.localStorage.getItem(GRAPH_STORAGE_KEY)).toBe(before);
    vi.useRealTimers();
  });

  it('cancels a pending write', () => {
    const saver = createDebouncedSaver(100);
    saver.save(graph);
    saver.cancel();
    vi.advanceTimersByTime(500);
    expect(window.localStorage.getItem(GRAPH_STORAGE_KEY)).toBeNull();
    vi.useRealTimers();
  });
});
