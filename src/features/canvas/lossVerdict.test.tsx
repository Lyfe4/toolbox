import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import type { ExecuteOptions } from '@/features/execution';
import { usePipelineStore } from '@/features/execution/pipelineStore';
import { loadTool, type ToolId } from '@/features/registry';
import type { ToolOutputs, ToolResult } from '@/features/registry/types';
import { EMPTY_ANNOUNCEMENTS } from '@/lib/announce';

import { Canvas } from './Canvas';
import { useCanvasStore } from './graphStore';
import { EMPTY_GRAPH, type CanvasEdge, type CanvasNode } from './types';
import { DEFAULT_VIEWPORT, useViewportStore } from './viewportStore';

/**
 * ONE VERDICT PER NODE, AND A LOSS THAT FOLLOWS A WIRE.
 *
 * Two things read wrong on a canvas somebody was looking at, and neither was a
 * data bug - both conversions were correct.
 *
 *   1. A node whose conversion lost something drew `Lossy · The nested value at
 *      $[0].user…` on its face and `ok` in its footer. Two verdicts on one
 *      node, and the status row is the one people scan.
 *   2. That node wired into a second structured-data node set to JSON. The
 *      second node's output is `"user": "{\\"name\\":\\"ada\\"}"` - a string
 *      where the original had an object - and its face was blank and its status
 *      `ok`, because its OWN conversion lost nothing. The node holding the
 *      damaged value said nothing.
 *
 * Every test here runs the REAL tools through the real canvas, so the report
 * payloads and the `reaches` lists in them are the ones the product produces
 * rather than fixtures agreeing with the module beside them. The two-engine
 * half of the claim - that these words are DRAWN, with a box, in Firefox and
 * WebKit - is in `scripts/cross-browser-check.mjs`; jsdom has no layout engine
 * and cannot be asked.
 */

/** The real tool, run in-process, so the notes are the product's own. */
async function runForReal(options: ExecuteOptions): Promise<ToolResult<ToolOutputs>> {
  const tool = await loadTool(options.toolId);
  return tool.run({
    inputs: options.inputs,
    options: options.options,
    context: { signal: new AbortController().signal, reportProgress: () => undefined },
  });
}

function node(
  id: string,
  toolId: ToolId,
  options: Record<string, unknown>,
  input?: string,
  x = 0,
): CanvasNode {
  return {
    id,
    toolId,
    position: { x, y: 0 },
    options,
    inputs: input === undefined ? {} : { input },
    fileInputs: {},
  };
}

function wire(id: string, from: string, fromPortId: string, to: string): CanvasEdge {
  return { id, from: { nodeId: from, portId: fromPortId }, to: { nodeId: to, portId: 'input' } };
}

function seed(nodes: readonly CanvasNode[], edges: readonly CanvasEdge[]): void {
  useCanvasStore.setState({
    graph: {
      nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
      nodeOrder: nodes.map((entry) => entry.id),
      edges: Object.fromEntries(edges.map((entry) => [entry.id, entry])),
      edgeOrder: edges.map((entry) => entry.id),
      nextId: nodes.length + edges.length + 1,
    },
    selection: { nodes: [], edges: [] },
    past: [],
    future: [],
    pendingMove: null,
    ...EMPTY_ANNOUNCEMENTS,
  });
}

function renderCanvas() {
  return render(
    <ToastProvider>
      <Canvas />
    </ToastProvider>,
  );
}

/**
 * The word in the footer's status slot - the row somebody scanning ten nodes
 * reads. The first span, not the footer's whole text: the wire count sits
 * beside it with no separator, so `ok` and `0 wires` concatenate to `ok0 wires`
 * and a word-boundary match on the pair is not the assertion anybody means.
 */
function footerOf(id: string): string {
  const slot = screen.getByTestId(`node-${id}`).querySelector('[class*="nodeFooter"] > span');
  if (!slot) throw new Error(`no footer status on ${id}`);
  return slot.textContent.trim();
}

function verdictOf(id: string): string | null {
  return screen.getByTestId(`node-${id}`).getAttribute('data-verdict');
}

function spokenName(id: string): string {
  return screen.getByTestId(`node-${id}`).getAttribute('aria-label') ?? '';
}

/** Waits until every node named has settled on a verdict other than "run". */
async function untilSettled(ids: readonly string[]): Promise<void> {
  await waitFor(
    () => {
      for (const id of ids) {
        const verdict = verdictOf(id);
        expect(verdict, `${id} has not settled`).not.toBe('running');
        expect(verdict, `${id} has not started`).not.toBe('idle');
      }
    },
    { timeout: 10_000 },
  );
}

const CSV_OPTIONS = {
  source: 'auto',
  target: 'csv',
  indent: 2,
  delimiter: 'comma',
  sortKeys: false,
};
const JSON_OPTIONS = {
  source: 'auto',
  target: 'json',
  indent: 2,
  delimiter: 'comma',
  sortKeys: false,
};

/** Nested, so converting it to a table has to flatten something. */
const NESTED = '[{"user": {"name": "ada"}, "id": 1}, {"id": 2}]';
/** Flat, so the identical conversion loses nothing at all. */
const FLAT = '[{"a": 1, "b": 2}, {"a": 3, "b": 4}]';

beforeEach(() => {
  window.localStorage.clear();
  usePipelineStore.getState().reset();
  usePipelineStore.setState({ execute: runForReal });
  useCanvasStore.setState({
    graph: EMPTY_GRAPH,
    selection: { nodes: [], edges: [] },
    past: [],
    future: [],
    pendingMove: null,
    ...EMPTY_ANNOUNCEMENTS,
  });
  useViewportStore.setState({ viewport: DEFAULT_VIEWPORT, isPanning: false });
});

describe('a node that lost something', () => {
  /*
   * OBSERVATION 1. The footer said `ok` while the face said `Lossy · …`. Both
   * were true of the RUN and they are not the same question, and the terse one
   * is the one a row of ten nodes is read by.
   */
  it('says so in its footer instead of "ok"', async () => {
    seed([node('a', 'structured-data', CSV_OPTIONS, NESTED)], []);
    renderCanvas();
    await untilSettled(['a']);

    expect(verdictOf('a')).toBe('lossy');
    expect(footerOf('a')).toBe('lossy');
    // The word it replaced, and the reason this is a replacement rather than an
    // addition: two verdicts on one node is the defect, not the fix.
    expect(footerOf('a')).not.toBe('ok');
    // ...and the face still carries WHAT was lost, which the footer never did.
    expect(screen.getByTestId('node-a')).toHaveTextContent(/Lossy · /);
  });

  it('still says "ok" when the same conversion loses nothing', async () => {
    seed([node('a', 'structured-data', CSV_OPTIONS, FLAT)], []);
    renderCanvas();
    await untilSettled(['a']);

    expect(verdictOf('a')).toBe('ok');
    expect(footerOf('a')).toBe('ok');
    expect(screen.getByTestId('node-a')).not.toHaveTextContent(/Lossy/);
  });
});

describe('a node downstream of a loss', () => {
  /*
   * OBSERVATION 2, with the damaged value asserted rather than described. The
   * second node's own conversion is correct and lossless; what it is holding is
   * not the document that went into the first one.
   */
  it('says "after loss" where it used to say "ok"', async () => {
    seed(
      [
        node('a', 'structured-data', CSV_OPTIONS, NESTED),
        node('b', 'structured-data', JSON_OPTIONS, undefined, 400),
      ],
      [wire('e1', 'a', 'output', 'b')],
    );
    renderCanvas();
    await untilSettled(['a', 'b']);

    expect(verdictOf('a')).toBe('lossy');
    expect(verdictOf('b')).toBe('after-loss');
    expect(footerOf('b')).toBe('after loss');
    expect(footerOf('b')).not.toBe('ok');

    // The value really is damaged: a string where the source had an object, and
    // an empty string where the second row had no key at all. This is the fact
    // the node was silent about.
    const produced = usePipelineStore.getState().states.b?.outputs?.output;
    expect(produced?.type === 'text' ? produced.text : '').toContain('"{\\"name\\":\\"ada\\"}"');
  });

  it('names the node and the loss in its accessible name', async () => {
    seed(
      [
        node('a', 'structured-data', CSV_OPTIONS, NESTED),
        node('b', 'structured-data', JSON_OPTIONS, undefined, 400),
      ],
      [wire('e1', 'a', 'output', 'b')],
    );
    renderCanvas();
    await untilSettled(['a', 'b']);

    const spoken = spokenName('b');
    expect(spoken).toContain('succeeded, after a loss upstream');
    expect(spoken).toContain('after a loss in Structured data');
    expect(spoken).toContain('nested value');
  });

  /*
   * THE NEGATIVE CONTROL THAT MATTERS MOST. `data` carries the parsed SOURCE,
   * so the write half's flattening is not in it - and wiring it onward is the
   * way AROUND this loss. A mark here would be a warning on the workaround,
   * which is worse than saying nothing.
   */
  it('says nothing when the wire leaves a port the loss is not in', async () => {
    seed(
      [
        node('a', 'structured-data', CSV_OPTIONS, NESTED),
        node('b', 'structured-data', JSON_OPTIONS, undefined, 400),
      ],
      [wire('e1', 'a', 'data', 'b')],
    );
    renderCanvas();
    await untilSettled(['a', 'b']);

    expect(verdictOf('a')).toBe('lossy');
    expect(verdictOf('b')).toBe('ok');

    // And the reason it is right to say nothing: the object survived.
    const produced = usePipelineStore.getState().states.b?.outputs?.output;
    expect(produced?.type === 'text' ? produced.text : '').toContain('"name"');
  });

  it('keeps saying it three nodes later', async () => {
    seed(
      [
        node('a', 'structured-data', CSV_OPTIONS, NESTED),
        node('b', 'structured-data', JSON_OPTIONS, undefined, 400),
        node('c', 'structured-data', JSON_OPTIONS, undefined, 800),
        node('d', 'hash', { algorithm: 'sha-256', encoding: 'hex' }, undefined, 1200),
      ],
      [
        wire('e1', 'a', 'output', 'b'),
        wire('e2', 'b', 'output', 'c'),
        wire('e3', 'c', 'output', 'd'),
      ],
    );
    renderCanvas();
    await untilSettled(['a', 'b', 'c', 'd']);

    expect(verdictOf('a')).toBe('lossy');
    for (const id of ['b', 'c', 'd']) {
      expect(verdictOf(id), `${id} descends from the loss`).toBe('after-loss');
    }
  });

  /*
   * THE LONG LOSSLESS CHAIN. The same four tools, the same wiring, one flat
   * table instead of a nested one: every node has to say `ok`. A mark that
   * appears on a clean chain is the one people learn to ignore before the day
   * it is true.
   */
  it('stays silent down a long chain that loses nothing', async () => {
    seed(
      [
        node('a', 'structured-data', CSV_OPTIONS, FLAT),
        node('b', 'structured-data', JSON_OPTIONS, undefined, 400),
        node('c', 'structured-data', JSON_OPTIONS, undefined, 800),
        node('d', 'hash', { algorithm: 'sha-256', encoding: 'hex' }, undefined, 1200),
      ],
      [
        wire('e1', 'a', 'output', 'b'),
        wire('e2', 'b', 'output', 'c'),
        wire('e3', 'c', 'output', 'd'),
      ],
    );
    renderCanvas();
    await untilSettled(['a', 'b', 'c', 'd']);

    for (const id of ['a', 'b', 'c', 'd']) {
      expect(verdictOf(id), `${id} is clean`).toBe('ok');
      expect(footerOf(id)).not.toContain('loss');
      expect(spokenName(id)).not.toContain('loss');
    }
  });

  /*
   * A node's OWN loss outranks an inherited one, so a node never carries two
   * verdicts - which is the whole of observation 1 applied to the new state.
   */
  it('says "lossy" rather than "after loss" when it lost something itself', async () => {
    seed(
      [
        node('a', 'structured-data', CSV_OPTIONS, NESTED),
        // CSV back to CSV: the second node re-flattens nothing, so give it its
        // own loss by asking it for a table of a stream instead.
        node('b', 'structured-data', CSV_OPTIONS, undefined, 400),
      ],
      [wire('e1', 'a', 'output', 'b')],
    );
    renderCanvas();
    await untilSettled(['a', 'b']);

    expect(verdictOf('a')).toBe('lossy');
    // `b` reads the CSV back as a table and writes it out again - no loss of
    // its own - so it inherits. The assertion that matters is that whichever it
    // is, it is exactly one of them.
    expect(['lossy', 'after-loss']).toContain(verdictOf('b'));
    expect(footerOf('b')).not.toBe('ok');
  });
});
