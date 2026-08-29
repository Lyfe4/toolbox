import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDebouncedSaver,
  GRAPH_STORAGE_KEY,
  loadGraph,
  saveGraph,
  toPersisted,
} from './persistence';
import { EMPTY_GRAPH, type GraphData } from './types';

const graph: GraphData = {
  nodes: {
    n1: { id: 'n1', toolId: 'base64', position: { x: 8, y: 16 }, options: {}, status: 'idle' },
    n2: {
      id: 'n2',
      toolId: 'structured-data',
      position: { x: 400, y: 16 },
      options: { target: 'yaml' },
      status: 'idle',
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
    expect(window.localStorage.getItem(GRAPH_STORAGE_KEY)).toContain('"version":1');
    expect(GRAPH_STORAGE_KEY).toBe('patchbay:graph:v1');
  });

  /*
   * Every one of these used to be a crash waiting to happen. A saved graph is
   * user-writable data from an unknown past build, so each case must produce an
   * empty canvas and an explanation - never an exception, and never a
   * half-restored graph.
   */
  it.each([
    ['not json at all', 'unparseable text'],
    ['{"version":2,"nodes":[],"edges":[],"nextId":1}', 'a newer version'],
    ['{"nodes":[],"edges":[],"nextId":1}', 'a missing version'],
    ['{"version":1,"nodes":"nope","edges":[],"nextId":1}', 'a wrong node type'],
    ['{"version":1,"nodes":[],"edges":[],"nextId":0}', 'an invalid counter'],
    [
      '{"version":1,"nodes":[{"id":"n1","toolId":"ghost-tool","position":{"x":0,"y":0},"options":{},"status":"idle"}],"edges":[],"nextId":2}',
      'a tool that no longer exists',
    ],
    [
      '{"version":1,"nodes":[{"id":"n1","toolId":"base64","position":{"x":"left","y":0},"options":{},"status":"idle"}],"edges":[],"nextId":2}',
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

  it('drops edges whose endpoints are gone rather than rejecting the whole graph', () => {
    window.localStorage.setItem(
      GRAPH_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: 'n1', toolId: 'base64', position: { x: 0, y: 0 }, options: {}, status: 'idle' },
        ],
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
    expect(result.status).toBe('loaded');
    if (result.status === 'loaded') {
      expect(result.graph.nodeOrder).toEqual(['n1']);
      expect(result.graph.edgeOrder).toEqual([]);
    }
  });

  it('flattens to a compact shape', () => {
    const persisted = toPersisted(graph);
    expect(persisted.nodes).toHaveLength(2);
    expect(persisted.edges).toHaveLength(1);
    expect(persisted.version).toBe(1);
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
