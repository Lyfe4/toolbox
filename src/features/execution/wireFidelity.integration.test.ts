import { describe, expect, it } from 'vitest';

import type { CanvasNode, GraphData } from '@/features/canvas/types';
import { getManifestEntry, loadTool } from '@/features/registry';
import { isJsonObject, type ToolOutputs, type ToolResult } from '@/features/registry/types';
import { encodeBase64, textToBytes } from '@/lib/base64';

import { createExecutionEngine, type ExecuteOptions } from './engine';
import { runPipeline, type PipelineState } from './graph';

/**
 * WHAT A WIRE DOES TO A VALUE, ASKED WITH AN INSTRUMENT RATHER THAN BY
 * READING THE ENGINE.
 *
 * The claim under test is that a value arriving at the next tool is the value
 * that left the last one - every space, every line ending, the trailing
 * newline or its absence, and the bytes of anything that is not text. Reading
 * `buildInputs` says the same thing in two lines, and that is exactly the kind
 * of evidence this repository has been wrong on before: it says what the code
 * intends, not what the whole path does.
 *
 * So the instrument is the diff tool. `identical` is true only when its two
 * inputs are the same string character for character - it is computed before
 * any of the comparison options touch anything - so a wire that changed one
 * space makes it false. One side arrives along a wire; the other is typed into
 * the node the way a person types into the box on `/tools`. They have to
 * agree, and where they cannot the reason is named rather than tolerated.
 *
 * THE PAYLOADS ARE THE POINT. Every one is something an editor, a shell or an
 * LLM really produces, and every one is invisible on screen: a CRLF, a missing
 * final newline, a tab against four spaces, a NUL, a BOM, an astral character
 * that is two UTF-16 code units, a combining sequence.
 */

function makeEngine() {
  const engine = createExecutionEngine({
    createWorker: () => {
      throw new Error('no worker in jsdom');
    },
    loadTool,
    // Main-thread strategy: this is about the seam between two tools, not
    // about worker plumbing, which only a real browser can exercise.
    getExecutionMeta: (id) => ({ ...getManifestEntry(id).execution, strategy: 'main' }),
    setTimer: (callback, ms) => window.setTimeout(callback, ms),
    clearTimer: (handle) => {
      window.clearTimeout(handle);
    },
  });

  return (options: ExecuteOptions): Promise<ToolResult<ToolOutputs>> => engine.execute(options);
}

type Wire = readonly [string, string, string, string];

function graphOf(nodes: readonly CanvasNode[], wires: readonly Wire[]): GraphData {
  const edges: Record<string, GraphData['edges'][string]> = {};
  const edgeOrder: string[] = [];

  wires.forEach(([fromNode, fromPort, toNode, toPort], index) => {
    const id = `e${index.toString()}`;
    edgeOrder.push(id);
    edges[id] = {
      id,
      from: { nodeId: fromNode, portId: fromPort },
      to: { nodeId: toNode, portId: toPort },
    };
  });

  return {
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    nodeOrder: nodes.map((node) => node.id),
    edges,
    edgeOrder,
    nextId: nodes.length + wires.length + 1,
  };
}

function node(
  id: string,
  toolId: CanvasNode['toolId'],
  options: Record<string, unknown> = {},
  inputs: Record<string, string> = {},
): CanvasNode {
  return { id, toolId, position: { x: 0, y: 0 }, options, inputs, fileInputs: {} };
}

const DIFF_OPTIONS = {
  ignoreWhitespace: 'none',
  ignoreCase: false,
  refineWords: false,
  context: 3,
};

/** The diff tool's own verdict on whether its two inputs were the same string. */
function identicalAt(states: PipelineState, id: string): boolean {
  const value = states[id]?.outputs?.changes;
  if (value?.type !== 'json') throw new Error(`no report on ${id}.changes`);
  const report = value.data;
  if (!isJsonObject(report)) throw new Error('the diff report is not an object');
  return report.identical === true;
}

/**
 * Payloads, as the base64 a `base64` node decodes back into bytes.
 *
 * base64 is the upstream because it is the only tool here that can be made to
 * produce an ARBITRARY value: whatever bytes are wanted, encoded. Everything
 * else transforms what it is given, which would put the transformation between
 * the payload and the assertion.
 */
const PAYLOADS: readonly (readonly [string, string])[] = [
  ['a trailing newline', 'first\nsecond\n'],
  ['no trailing newline', 'first\nsecond'],
  ['CRLF line endings', 'first\r\nsecond\r\n'],
  ['a lone CR', 'first\rsecond'],
  ['mixed line endings', 'first\r\nsecond\nthird\r'],
  ['a tab where spaces would look the same', 'indented:\n\tvalue\n'],
  ['trailing spaces on a line', 'first   \nsecond\n'],
  ['a run of blank lines', 'first\n\n\n\nsecond\n'],
  ['a NUL byte', 'before\u0000after'],
  ['an astral character, two UTF-16 code units', 'score: \u{1d11e}'],
  ['an emoji with a zero-width joiner', 'family: \u{1f468}\u200d\u{1f469}\u200d\u{1f467}'],
  ['a combining sequence against its precomposed form', 'e\u0301 and \u00e9'],
  ['a non-breaking space', 'ten\u00a0kilograms'],
  ['a right-to-left override', 'admin\u202egnp.sj\u202c'],
  ['only whitespace', '   \n\t\n'],
  ['one character', 'x'],
];

describe('a value crossing a wire', () => {
  it.each(PAYLOADS)('arrives exactly as it left: %s', async (_name, payload) => {
    const encoded = encodeBase64(textToBytes(payload), {
      urlSafe: false,
      padding: true,
      wrapAt: 0,
    });

    const graph = graphOf(
      [
        node('source', 'base64', { mode: 'decode' }, { input: encoded }),
        // `changed` is typed in, which is the `/tools` textarea path; `original`
        // arrives on the wire. The tool compares the two.
        node('compare', 'diff', DIFF_OPTIONS, { changed: payload }),
      ],
      [['source', 'output', 'compare', 'original']],
    );

    const summary = await runPipeline(graph, { execute: makeEngine() });

    expect(summary.failed).toBe(0);
    expect(summary.ran).toBe(2);
    expect(identicalAt(summary.states, 'compare')).toBe(true);
  });

  /*
   * THE INSTRUMENT HAS TO BE ABLE TO SAY NO.
   *
   * Every assertion above is `identical === true`, and a comparison that
   * always said true would satisfy all sixteen. These are the smallest
   * possible differences in the same payloads - one line ending, one trailing
   * newline, one space - and each has to come back false.
   */
  it.each([
    ['a changed line ending', 'first\nsecond\n', 'first\r\nsecond\n'],
    ['a gained final newline', 'first\nsecond', 'first\nsecond\n'],
    ['a gained trailing space', 'first\nsecond\n', 'first \nsecond\n'],
    ['a tab swapped for spaces', 'a\tb', 'a    b'],
    ['a precomposed character', 'e\u0301', '\u00e9'],
    ['a non-breaking space swapped for a space', 'ten\u00a0kg', 'ten kg'],
  ])('is not fooled by %s', async (_name, sent, typed) => {
    const encoded = encodeBase64(textToBytes(sent), { urlSafe: false, padding: true, wrapAt: 0 });

    const graph = graphOf(
      [
        node('source', 'base64', { mode: 'decode' }, { input: encoded }),
        node('compare', 'diff', DIFF_OPTIONS, { changed: typed }),
      ],
      [['source', 'output', 'compare', 'original']],
    );

    const summary = await runPipeline(graph, { execute: makeEngine() });

    expect(summary.failed).toBe(0);
    expect(identicalAt(summary.states, 'compare')).toBe(false);
  });

  /*
   * THE ONE DOCUMENTED EXCEPTION, ASSERTED AS ITSELF.
   *
   * A UTF-8 byte order mark is removed when bytes are decoded at a document
   * port - `TextDecoder` does it, and every tool that reads a document goes
   * through `decodeDocument`. It is the conventional and almost always wanted
   * behaviour, and it is still a byte that went into the wire and did not come
   * out, so it belongs in the matrix and here rather than in nobody's head.
   *
   * On the canvas that means the BOM is gone by the time the downstream tool
   * sees the text; typing the same document into the box on `/tools` keeps it,
   * because nothing decoded anything. That is the one place where the two
   * routes give different answers for the same document.
   */
  it('drops a UTF-8 byte order mark when bytes are read as a document', async () => {
    const withBom = '\ufeffname,age\n';
    const encoded = encodeBase64(textToBytes(withBom), {
      urlSafe: false,
      padding: true,
      wrapAt: 0,
    });

    const graph = graphOf(
      [
        node('source', 'base64', { mode: 'decode' }, { input: encoded }),
        node('compare', 'diff', DIFF_OPTIONS, { changed: withBom }),
        node('stripped', 'diff', DIFF_OPTIONS, { changed: 'name,age\n' }),
      ],
      [
        ['source', 'output', 'compare', 'original'],
        ['source', 'output', 'stripped', 'original'],
      ],
    );

    const summary = await runPipeline(graph, { execute: makeEngine() });

    expect(summary.failed).toBe(0);
    // The BOM did not survive the decode...
    expect(identicalAt(summary.states, 'compare')).toBe(false);
    // ...and what arrived is the same document without it, rather than
    // anything else having changed.
    expect(identicalAt(summary.states, 'stripped')).toBe(true);
  });
});

describe('the wire and the clipboard', () => {
  /*
   * "IT MUST ALSO MATCH WHAT YOU GET BY COPYING FROM ONE TOOL AND PASTING INTO
   * THE OTHER ON /tools."
   *
   * On the canvas a value moves as a typed `ToolValue`; on `/tools` a person
   * copies the rendered text and pastes it into the next tool's box, where it
   * becomes `{ type: 'text' }`. For a `text` output the two are the same string
   * and the two routes have to produce the same answer, which is what this
   * runs both ways to check.
   *
   * Where the upstream port carries `bytes` or `json` the two routes are
   * DIFFERENT BY CONSTRUCTION - there is no text on the clipboard that is the
   * bytes - and the matrix says so rather than this test pretending otherwise.
   */
  it.each([
    ['a document with CRLF endings', 'name,age\r\nada,36\r\ngrace,45\r\n'],
    ['a document with no trailing newline', 'name,age\nada,36'],
    ['a document with a tab in a value', 'name,note\nada,"has\ttab"\n'],
    ['a document with an astral character', 'name,note\nada,\u{1d11e}\n'],
  ])('gives the same answer wired as pasted, for %s', async (_name, document) => {
    const execute = makeEngine();

    // The canvas: structured-data wired into a hash.
    const graph = graphOf(
      [
        node(
          'convert',
          'structured-data',
          { source: 'auto', target: 'json', indent: 2 },
          {
            input: document,
          },
        ),
        node('digest', 'hash', { algorithm: 'sha-256', encoding: 'hex' }),
      ],
      [['convert', 'output', 'digest', 'input']],
    );

    const summary = await runPipeline(graph, { execute });
    expect(summary.failed).toBe(0);

    const converted = summary.states.convert?.outputs?.output;
    if (converted?.type !== 'text') throw new Error('the converter produced no text');
    const wired = summary.states.digest?.outputs?.output;
    if (wired?.type !== 'text') throw new Error('the hash produced no text');

    // The tool page: the same string, typed into the next tool's box.
    const pasted = await execute({
      toolId: 'hash',
      inputs: { input: { type: 'text', text: converted.text } },
      options: { algorithm: 'sha-256', encoding: 'hex' },
      ownership: 'borrow',
    });

    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    const byHand = pasted.value.output;
    if (byHand?.type !== 'text') throw new Error('the hash produced no text by hand');

    // A positive assertion beside the equality: a digest that failed to be
    // produced would satisfy `a === b` just as well as a correct one.
    expect(wired.text).toMatch(/^[0-9a-f]{64}$/);
    expect(byHand.text).toBe(wired.text);
  });
});
