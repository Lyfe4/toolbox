import { describe, expect, it } from 'vitest';

import { checkConnection, firstRefusedEdge } from '@/features/canvas/connections';
import { instantiatePreset, PIPELINE_PRESETS } from '@/features/canvas/presets';
import type { GraphData } from '@/features/canvas/types';
import { textToBytes } from '@/lib/base64';

import { loadTool } from './loader';
import { getManifestEntry, TOOL_MANIFEST, type ToolId, type ToolManifestEntry } from './manifest';
import { DATA_TYPES, type DataType, type ToolRunContext, type ToolValue } from './types';

/**
 * THE PORT SET, JUDGED AS A SET.
 *
 * `registry.test.ts` asserts each tool agrees with its own manifest entry.
 * This file asserts the things that are only true of the whole collection -
 * the conventions, which connections are legal, and which pipelines a person
 * would actually want to build can actually be built - because every one of
 * those was decided tool by tool as each was written and had never been read
 * end to end.
 *
 * Each `it` here corresponds to a decision recorded in the audit. A test that
 * merely restates the manifest would be worthless; these are the ones that
 * fail if a future port is added without the set being reconsidered.
 */

const context: ToolRunContext = {
  signal: new AbortController().signal,
  reportProgress: () => undefined,
};

const ids = TOOL_MANIFEST.map((entry) => entry.id);

/* ========================================================================== *
 * Conventions
 * ========================================================================== */

describe('naming conventions across the whole set', () => {
  /*
   * `resultSummary` shows the FIRST declared output on a node, on the grounds
   * that "the first port is the tool's answer and the rest are its working".
   * That was true of eight of the nine tools and `hash` called its answer
   * `digest`, which made the rule a per-tool lookup rather than something the
   * shape of the set guaranteed. The rename cost a migration; this is what it
   * bought.
   */
  it.each(ids)('%s calls its first output `output`', (id) => {
    expect(getManifestEntry(id).outputs[0]?.id).toBe('output');
  });

  /*
   * The mirror on the input side, and the exception is deliberate rather than
   * an oversight: `diff` takes two documents and neither is "the" input, so
   * both are named (`original`, `changed`). A tool with ONE input has nothing
   * to distinguish and calling it anything else is a fact a reader has to look
   * up - which is exactly what the v2 -> v3 graph migration had to do.
   */
  it.each(ids)('%s calls its only input `input`, or names every one of several', (id) => {
    const inputs = getManifestEntry(id).inputs;
    if (inputs.length === 1) {
      expect(inputs[0]?.id).toBe('input');
      return;
    }
    expect(inputs.map((port) => port.id)).not.toContain('input');
  });

  it.each(ids)('%s has unique port ids on each side', (id) => {
    const entry = getManifestEntry(id);
    expect(new Set(entry.inputs.map((port) => port.id)).size).toBe(entry.inputs.length);
    expect(new Set(entry.outputs.map((port) => port.id)).size).toBe(entry.outputs.length);
  });

  /*
   * A node is 224px wide and the label box inside it is 84px, so an output
   * called the same thing as an input is two identical words facing each other
   * across a node with nothing to tell them apart. `color-convert` had exactly
   * that - an input labelled 'Colour' and a `swatch` output labelled 'Colour'
   * - and the input is the one that could not be renamed, because a colour
   * converter's input is a colour.
   */
  it.each(ids)('%s uses no label twice across its ports', (id) => {
    const entry = getManifestEntry(id);
    const labels = [...entry.inputs, ...entry.outputs].map((port) => port.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  /*
   * THE LABEL BUDGET, and it is arithmetic rather than taste.
   *
   * `.portLabel` is `max-inline-size: 84px`, and a port label is drawn
   * uppercase at 10px with 0.09em tracking - about 7.4px a character, so about
   * eleven characters before the ellipsis. Three labels were over it when this
   * audit ran: 'Every notation' (14), 'Converted image' (15) and 'Detected
   * source' (15), all three drawn on every node that had one as a word and a
   * half.
   *
   * The cap here is 13 rather than 11, because two labels deliberately sit
   * over the budget and get a tooltip instead: 'Rendered HTML' and 'Unified
   * patch'. In both, the extra word is information the port's data TYPE cannot
   * carry - both ports are `text`, and which text is the whole question - so
   * shortening them would cost more than the ellipsis does. Past 13 a label is
   * mostly ellipsis, which is the line.
   *
   * `scripts/cross-browser-check.mjs` measures the real thing in real engines;
   * jsdom has no layout, so this is a budget rather than a measurement.
   */
  it.each(ids)('%s keeps every label inside the 13-character budget', (id) => {
    const entry = getManifestEntry(id);
    for (const port of [...entry.inputs, ...entry.outputs]) {
      expect(port.label.length, `${id}.${port.id} is "${port.label}"`).toBeLessThanOrEqual(13);
    }
  });

  /*
   * Every port explains itself, because a port's description is now the only
   * documentation of it that reaches a person on either route - the Ports panel
   * on a tool page, and the input editor's placeholder on both. Four ports had
   * none when this audit ran, base64's `output` among them, which is the port
   * whose behaviour most needs a sentence: it carries text one way and bytes
   * the other.
   */
  it.each(ids)('%s describes every port', (id) => {
    const entry = getManifestEntry(id);
    for (const port of [...entry.inputs, ...entry.outputs]) {
      expect(port.description ?? '', `${id}.${port.id}`).not.toBe('');
      expect(port.description, `${id}.${port.id}`).toBeDefined();
    }
  });

  /*
   * Every input is required, and that is a finding rather than a coincidence:
   * no tool in the set does anything useful with a missing input. The
   * assertion exists so that adding an optional port is a deliberate act with
   * a reason attached, since `InputsOf` makes an optional port's value
   * `| undefined` and the tool then has to have an answer for its absence.
   */
  it('has no optional input port anywhere in the set', () => {
    // Read through the widened type on purpose. `as const` in the manifest
    // narrows `required` to the literal `true`, so `!port.required` is
    // statically false and the linter is right to call it unnecessary - which
    // is a stronger guarantee than this test, but not one a reader can see.
    const entries: readonly ToolManifestEntry[] = TOOL_MANIFEST;
    const optional = entries.flatMap((entry) =>
      entry.inputs.filter((port) => !port.required).map((port) => `${entry.id}.${port.id}`),
    );
    expect(optional).toEqual([]);
  });
});

/* ========================================================================== *
 * The type system's granularity
 * ========================================================================== */

describe('the data types', () => {
  /*
   * A DATA TYPE EARNS ITS PLACE WHEN A PORT CARRIES IT.
   *
   * `image` and `datetime` were in `DATA_TYPES` and no port on any tool
   * declared either. `image` was worse than unused: the app's rule everywhere
   * else is that binary travels as `bytes` and the SNIFF says what it is,
   * which is what makes `image-convert -> hash` and `image-convert -> base64`
   * legal - so a separate `image` type would have made exactly those wires
   * illegal. Both also appeared in the canvas's own port legend, as types the
   * canvas could not produce.
   */
  it.each(DATA_TYPES)('%s is carried by at least one port', (type) => {
    const carried = TOOL_MANIFEST.some((entry) =>
      [...entry.inputs, ...entry.outputs].some((port) =>
        (port.types as readonly DataType[]).includes(type),
      ),
    );
    expect(carried).toBe(true);
  });

  /** Both directions: a type nothing produces is a port nothing can fill. */
  it.each(DATA_TYPES)('%s is both produced and accepted somewhere', (type) => {
    const produced = TOOL_MANIFEST.some((entry) =>
      entry.outputs.some((port) => (port.types as readonly DataType[]).includes(type)),
    );
    const accepted = TOOL_MANIFEST.some((entry) =>
      entry.inputs.some((port) => (port.types as readonly DataType[]).includes(type)),
    );
    expect({ produced, accepted }).toEqual({ produced: true, accepted: true });
  });
});

/* ========================================================================== *
 * Which wires are legal
 * ========================================================================== */

function twoNodeGraph(fromTool: string, toTool: string): GraphData {
  return {
    nodes: {
      a: { id: 'a', toolId: fromTool as never, position: { x: 0, y: 0 }, options: {}, inputs: {} },
      b: { id: 'b', toolId: toTool as never, position: { x: 400, y: 0 }, options: {}, inputs: {} },
    },
    nodeOrder: ['a', 'b'],
    edges: {},
    edgeOrder: [],
    nextId: 3,
  };
}

function wireIsLegal(fromTool: string, fromPort: string, toTool: string, toPort: string): boolean {
  return checkConnection(
    twoNodeGraph(fromTool, toTool),
    { nodeId: 'a', portId: fromPort },
    { nodeId: 'b', portId: toPort },
  ).ok;
}

describe('wires that were useful and illegal', () => {
  /*
   * THE TWO SERIOUS FINDINGS OF THE AUDIT, and they are the same finding
   * twice: a port that reads a DOCUMENT refused bytes, so a document arriving
   * as bytes - from a base64 decode, or a dropped file - had no way in.
   * `structured-data` had already widened its own document port for exactly
   * this reason and recorded that refusing them "made the most obvious
   * pipeline in the product impossible"; two more tools had the same port and
   * not the same fix.
   */
  it('lets a base64 decode feed the regex subject', () => {
    expect(wireIsLegal('base64', 'output', 'regex-tester', 'input')).toBe(true);
  });

  it('lets a base64 decode feed the text converter', () => {
    expect(wireIsLegal('base64', 'output', 'text-convert', 'input')).toBe(true);
  });

  /*
   * The gap was between the two ROUTES rather than inside either. A tool page
   * has always accepted a dropped log file on the regex tool, because the
   * runner decodes a text-sniffed file before handing it over; the canvas
   * could not wire the same bytes in at all. One tool that accepts a file in
   * one place and refuses it in the other is drift, not a decision.
   */
  it.each<ToolId>(['regex-tester', 'text-convert', 'structured-data', 'diff', 'hash', 'base64'])(
    '%s accepts bytes on every port that reads a document',
    (id) => {
      const inputs = getManifestEntry(id).inputs;
      for (const port of inputs) {
        expect(port.types, `${id}.${port.id}`).toContain('bytes');
      }
    },
  );
});

describe('wires that are deliberately still illegal', () => {
  /*
   * A DIGEST IS COMPARED ACROSS MACHINES; A DIFF IS READ ON ONE.
   *
   * `structured-data`'s `data` port carries a parsed structure, and wiring it
   * into `hash` looks obviously useful - the tool's own header even describes
   * "a CSV converted to JSON and fingerprinted". It is refused, and the reason
   * is that the digest of a STRUCTURE is undefined until someone picks a
   * serialisation: key order and indentation change the bytes, so they change
   * the number. `structured-data`'s `output` port is where that choice is made
   * explicitly, with `sortKeys` and `indent` to control it, and it carries
   * text - so the pipeline works and the digest means something.
   *
   * `diff` DOES accept `json` and the asymmetry is the point: an indentation
   * choice changes how a comparison reads and not whether it is true, and
   * refusing structures there would make "diff two JSON documents" impossible.
   */
  it('refuses a parsed structure at the hash input', () => {
    expect(wireIsLegal('structured-data', 'data', 'hash', 'input')).toBe(false);
  });

  it('accepts a parsed structure at both diff inputs', () => {
    expect(wireIsLegal('structured-data', 'data', 'diff', 'original')).toBe(true);
    expect(wireIsLegal('structured-data', 'data', 'diff', 'changed')).toBe(true);
  });

  /*
   * The two ports that take a short LITERAL rather than a document: a compact
   * token and a colour. Neither has a sensible reading of arbitrary bytes, and
   * both have a size limit that says the same thing - jwt-decode caps its
   * input at 256 kB and color-convert at 4 kB.
   */
  it('refuses bytes at the token and colour inputs', () => {
    expect(getManifestEntry('jwt-decode').inputs[0]?.types).toEqual(['text']);
    expect(getManifestEntry('color-convert').inputs[0]?.types).toEqual(['text', 'color']);
  });
});

describe('pipelines a person would actually build', () => {
  /*
   * Each of these is a sentence somebody would say out loud. They are asserted
   * as WIRES rather than run end to end - `composition.integration.test.ts`
   * runs the values through - because what is in question here is whether the
   * port set permits the shape at all.
   */
  it.each([
    [
      'decode a payload and convert the JSON inside it',
      'base64',
      'output',
      'structured-data',
      'input',
    ],
    ['decode a payload and grep it', 'base64', 'output', 'regex-tester', 'input'],
    ['decode a mail body and clean up its HTML', 'base64', 'output', 'text-convert', 'input'],
    ['fingerprint a converted document', 'structured-data', 'output', 'hash', 'input'],
    ['fingerprint a converted image', 'image-convert', 'output', 'hash', 'input'],
    ['put a converted image in a data URI', 'image-convert', 'output', 'base64', 'input'],
    [
      'export an image conversion report as YAML',
      'image-convert',
      'report',
      'structured-data',
      'input',
    ],
    ["export a token's claims as YAML", 'jwt-decode', 'output', 'structured-data', 'input'],
    ['export a regex report as YAML', 'regex-tester', 'matches', 'structured-data', 'input'],
    ['diff two parsed structures', 'structured-data', 'data', 'diff', 'original'],
    ['diff two digests', 'hash', 'output', 'diff', 'original'],
    [
      're-notate a parsed colour without a text round trip',
      'color-convert',
      'swatch',
      'color-convert',
      'input',
    ],
    ['render Markdown and fingerprint the HTML', 'text-convert', 'rendered', 'hash', 'input'],
    [
      'replace with a regex, then diff against the source',
      'regex-tester',
      'output',
      'diff',
      'changed',
    ],
  ])('can build: %s', (_name, fromTool, fromPort, toTool, toPort) => {
    expect(wireIsLegal(fromTool, fromPort, toTool, toPort)).toBe(true);
  });
});

describe('the shipped presets', () => {
  /*
   * A preset names ports as strings, so it is the one place in the app that
   * can reference a port that does not exist - and it did not fail loudly when
   * it did: the engine finds no value on the named output and reports
   * `Nothing arrived on ...` against the node BELOW. Every preset wire now
   * goes through the same check a pointer drop does.
   */
  it.each(PIPELINE_PRESETS.map((preset) => [preset.id, preset] as const))(
    '%s wires only connections checkConnection accepts',
    (_id, preset) => {
      const { nodes, edges } = instantiatePreset(preset, { x: 0, y: 0 }, 1);
      const graph: GraphData = {
        nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
        nodeOrder: nodes.map((node) => node.id),
        edges: Object.fromEntries(edges.map((edge) => [edge.id, edge])),
        edgeOrder: edges.map((edge) => edge.id),
        nextId: nodes.length + edges.length + 1,
      };

      expect(firstRefusedEdge(graph)).toBeNull();
      // A preset with no wires would pass the line above by doing nothing.
      expect(edges.length).toBeGreaterThan(0);
    },
  );
});

/* ========================================================================== *
 * What the renamed and widened ports actually do
 * ========================================================================== */

describe('the renamed output ports', () => {
  it('hash produces its digest on `output`', async () => {
    const tool = await loadTool('hash');
    const result = await tool.run({
      inputs: { input: { type: 'text', text: 'abc' } },
      options: { algorithm: 'sha-256', encoding: 'hex', outputCase: 'lower' },
      context,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value)).toEqual(['output']);
    expect(result.value.output).toEqual({
      type: 'text',
      text: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    });
  });

  it('has no tool left producing a port called `digest` or `info`', async () => {
    for (const id of ids) {
      const tool = await loadTool(id);
      const portIds = tool.outputs.map((port) => port.id);
      expect(portIds, id).not.toContain('digest');
      expect(portIds, id).not.toContain('info');
    }
  });
});

describe('the widened document ports', () => {
  const bytesValue = (text: string): ToolValue => ({
    type: 'bytes',
    bytes: textToBytes(text),
    mediaType: null,
    filename: null,
  });

  /** Bytes that are not valid UTF-8: a lone continuation byte. */
  const notText = (): ToolValue => ({
    type: 'bytes',
    bytes: new Uint8Array([0x48, 0x69, 0xff, 0xfe, 0x00, 0x80]),
    mediaType: null,
    filename: null,
  });

  it('searches bytes wired into the regex subject', async () => {
    const tool = await loadTool('regex-tester');
    const result = await tool.run({
      inputs: { input: bytesValue('alpha beta alpha') },
      options: { pattern: 'alpha', mode: 'match', global: true },
      context,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const matches = result.value.matches;
    expect(matches?.type).toBe('json');
    if (matches?.type !== 'json') return;
    expect(matches.data).toMatchObject({ count: 2 });
  });

  it('converts bytes wired into the text converter', async () => {
    const tool = await loadTool('text-convert');
    const result = await tool.run({
      inputs: { input: bytesValue('# Heading\n') },
      options: { source: 'markdown', target: 'html', headingIds: false, linkify: true },
      context,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const output = result.value.output;
    expect(output?.type === 'text' ? output.text : '').toContain('<h1>Heading</h1>');
  });

  /*
   * A TOO-WIDE TYPE MUST REFUSE CLEARLY, NOT GUESS.
   *
   * The risk of accepting bytes on a document port is that non-text bytes get
   * decoded to replacement characters and processed anyway - a confident,
   * well-formed answer about content nobody wrote. `diff` did exactly that
   * before this audit: two PNGs on its two ports produced a valid unified diff
   * of two walls of U+FFFD. Every document port now decodes strictly.
   */
  it.each<[ToolId, Record<string, ToolValue>, Record<string, unknown>]>([
    ['regex-tester', { input: notText() }, { pattern: 'a', mode: 'match' }],
    ['text-convert', { input: notText() }, {}],
    ['structured-data', { input: notText() }, {}],
  ])('%s refuses bytes that are not text', async (id, inputs, options) => {
    const tool = await loadTool(id);
    const result = await tool.run({ inputs, options, context });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/could not be read as text|not text/i);
  });

  /** With two document ports, "those bytes" is not an answer. */
  it('names which diff port could not be read', async () => {
    const tool = await loadTool('diff');
    const result = await tool.run({
      inputs: { original: { type: 'text', text: 'a' }, changed: notText() },
      options: {},
      context,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe('Changed could not be read as text.');
  });
});
