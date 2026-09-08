import { describe, expect, it, vi } from 'vitest';

import type { CanvasNode, GraphData } from '@/features/canvas/types';
import { getManifestEntry, loadTool } from '@/features/registry';
import type { ToolOutputs, ToolResult, ToolValue } from '@/features/registry/types';

import { createExecutionEngine, type ExecuteOptions } from './engine';
import { runPipeline, type PipelineCache, type PipelineState } from './graph';

/**
 * THE SEAMS BETWEEN TOOLS.
 *
 * Every tool here has been hardened on its own. This file is about what
 * happens BETWEEN them: values crossing ports, buffers shared by several
 * consumers, a failure part-way down a chain, a cache serving one wiring's
 * answer to another's question.
 *
 * These are real graphs run through the real engine with the real tool
 * modules. A fake executor pins scheduling; only real tools can show that a
 * value survived four hops with its meaning intact.
 */

function makeEngine() {
  const engine = createExecutionEngine({
    createWorker: () => {
      throw new Error('no worker in jsdom');
    },
    loadTool,
    // Main-thread strategy so this exercises the tools, not worker plumbing.
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
  return { id, toolId, position: { x: 0, y: 0 }, options, inputs };
}

function textAt(states: PipelineState, id: string, port: string): string {
  const value = states[id]?.outputs?.[port];
  if (value?.type !== 'text') throw new Error(`no text on ${id}.${port}`);
  return value.text;
}

function bytesAt(states: PipelineState, id: string, port: string): Uint8Array {
  const value = states[id]?.outputs?.[port];
  if (value?.type !== 'bytes') throw new Error(`no bytes on ${id}.${port}`);
  return value.bytes;
}

const SHA256 = { algorithm: 'sha-256', encoding: 'hex' } as const;
const MD5 = { algorithm: 'md5', encoding: 'hex' } as const;

/* ========================================================================== *
 * Long chains
 * ========================================================================== */

describe('a long chain', () => {
  /*
   * Five hops, four different tools, and a value whose meaning has to survive
   * every one of them. Each pair here has its own passing test somewhere; what
   * this checks is that composing them does not quietly lose or reinterpret
   * anything on the way through.
   */
  it('carries a value through five tools and agrees with doing it by hand', async () => {
    // {"name":"ada","tags":["x","y"]}
    const payload = 'eyJuYW1lIjoiYWRhIiwidGFncyI6WyJ4IiwieSJdfQ==';

    const graph = graphOf(
      [
        node('decode', 'base64', { mode: 'decode' }, { input: payload }),
        node('yaml', 'structured-data', { source: 'auto', target: 'yaml', indent: 2 }),
        node('back', 'structured-data', { source: 'auto', target: 'json', indent: 0 }),
        node('encode', 'base64', { mode: 'encode' }),
        node('digest', 'hash', SHA256),
      ],
      [
        ['decode', 'output', 'yaml', 'input'],
        ['yaml', 'output', 'back', 'input'],
        ['back', 'output', 'encode', 'input'],
        ['encode', 'output', 'digest', 'input'],
      ],
    );

    const summary = await runPipeline(graph, { execute: makeEngine() });

    expect(summary.failed).toBe(0);
    expect(summary.ran).toBe(5);

    // JSON -> YAML -> JSON is a round trip, so the far end is the value we
    // started from rather than something that merely looks like it.
    expect(textAt(summary.states, 'back', 'output')).toBe('{"name":"ada","tags":["x","y"]}');
    expect(textAt(summary.states, 'encode', 'output')).toBe(payload);
    expect(textAt(summary.states, 'digest', 'output')).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* ========================================================================== *
 * Binary across several hops
 * ========================================================================== */

describe('binary data across several hops', () => {
  /*
   * Buffer ownership has bitten before: a transferred ArrayBuffer is detached
   * in the sender, and a detached buffer produces a zero-length result several
   * steps later with nothing to explain it. This drives real bytes through
   * four hops and checks the bytes at the far end, not just that nothing threw.
   */
  it('round-trips bytes through encode, decode and a digest', async () => {
    const original = 'the quick brown fox';
    const encoded = 'dGhlIHF1aWNrIGJyb3duIGZveA==';

    const graph = graphOf(
      [
        node('decode', 'base64', { mode: 'decode' }, { input: encoded }),
        node('reencode', 'base64', { mode: 'encode' }),
        node('redecode', 'base64', { mode: 'decode' }),
        node('digest', 'hash', SHA256),
      ],
      [
        ['decode', 'output', 'reencode', 'input'],
        ['reencode', 'output', 'redecode', 'input'],
        ['redecode', 'output', 'digest', 'input'],
      ],
    );

    const summary = await runPipeline(graph, { execute: makeEngine() });

    expect(summary.failed).toBe(0);
    expect(textAt(summary.states, 'reencode', 'output')).toBe(encoded);

    const bytes = bytesAt(summary.states, 'redecode', 'output');
    expect(bytes.byteLength).toBe(original.length);
    expect(new TextDecoder().decode(bytes)).toBe(original);
  });

  /*
   * TWELVE consumers, not two.
   *
   * The existing fan-out test uses two, which passes even if the buffer is
   * detached on the LAST hand-off rather than the first. Twelve is past the
   * concurrency bound of four, so the value is also handed out across several
   * scheduling waves - which is when a shared buffer is most likely to have
   * been moved out from under a later consumer.
   */
  it('hands the same bytes to twelve consumers across several waves', async () => {
    const consumers = Array.from({ length: 12 }, (_, index) => `h${index.toString()}`);

    const graph = graphOf(
      [
        node('src', 'base64', { mode: 'decode' }, { input: 'aGVsbG8gd29ybGQ=' }),
        ...consumers.map((id) => node(id, 'hash', SHA256)),
      ],
      consumers.map((id) => ['src', 'output', id, 'input'] as const),
    );

    const summary = await runPipeline(graph, { execute: makeEngine() });

    expect(summary.failed).toBe(0);
    // The digest of the literal bytes "hello world". A detached buffer would
    // give the empty-input digest instead, which is a perfectly valid-looking
    // 64 hex characters - so the value is asserted, not the shape.
    for (const id of consumers) {
      expect(textAt(summary.states, id, 'output')).toBe(
        'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
      );
    }
  });

  /*
   * The same bytes, one run later, served from the cache.
   *
   * The cached state holds the actual output values, so a cached `ok` hands a
   * downstream node a buffer that has already been through one round of
   * structured cloning. If anything along that path had taken ownership rather
   * than borrowing, the second run would hash nothing.
   */
  it('keeps cached bytes usable on the next run', async () => {
    const cache: PipelineCache = new Map();
    const execute = makeEngine();

    const graph = graphOf(
      [
        node('src', 'base64', { mode: 'decode' }, { input: 'aGVsbG8gd29ybGQ=' }),
        node('a', 'hash', SHA256),
      ],
      [['src', 'output', 'a', 'input']],
    );

    await runPipeline(graph, { execute, cache });

    // A second node appears; `src` is now a cache hit whose bytes feed a run
    // that has never seen them before.
    const grown = graphOf(
      [
        node('src', 'base64', { mode: 'decode' }, { input: 'aGVsbG8gd29ybGQ=' }),
        node('a', 'hash', SHA256),
        node('b', 'hash', MD5),
      ],
      [
        ['src', 'output', 'a', 'input'],
        ['src', 'output', 'b', 'input'],
      ],
    );

    const summary = await runPipeline(grown, { execute, cache });

    expect(summary.states.src?.status).toBe('ok');
    expect(textAt(summary.states, 'b', 'output')).toBe('5eb63bbbe01eeed093cb22bb8f5acdc3');
  });
});

/* ========================================================================== *
 * Shapes: fan-out, diamonds, rejoins
 * ========================================================================== */

describe('graph shapes', () => {
  /*
   * A DIAMOND. One source, two branches doing different work, rejoining at a
   * node that needs both. The rejoin is the interesting part: it is the only
   * shape where a node's two inputs have a shared ancestor, and where getting
   * the wiring confused produces an answer rather than an error.
   */
  it('rejoins two branches of a diamond at a two-input node', async () => {
    const graph = graphOf(
      [
        node('src', 'base64', { mode: 'decode' }, { input: 'aGVsbG8gd29ybGQ=' }),
        node('left', 'hash', SHA256),
        node('right', 'hash', MD5),
        node('cmp', 'diff', {}),
      ],
      [
        ['src', 'output', 'left', 'input'],
        ['src', 'output', 'right', 'input'],
        ['left', 'output', 'cmp', 'original'],
        ['right', 'output', 'cmp', 'changed'],
      ],
    );

    const summary = await runPipeline(graph, { execute: makeEngine() });

    expect(summary.failed).toBe(0);
    expect(summary.ran).toBe(4);

    const patch = textAt(summary.states, 'cmp', 'output');
    // The sha-256 is on the "-" side and the md5 on the "+" side, which is the
    // only evidence that `original` and `changed` were not silently swapped.
    expect(patch).toContain('-b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    expect(patch).toContain('+5eb63bbbe01eeed093cb22bb8f5acdc3');
  });

  /*
   * ONE BRANCH FAILING MUST NOT TAKE THE OTHER WITH IT.
   *
   * Independent branches share a worker and a scheduler. A failure in one has
   * to reach the nodes below it and nothing else - not the sibling branch, and
   * not the run as a whole.
   */
  it('isolates a failed branch from its sibling', async () => {
    const graph = graphOf(
      [
        node('bad', 'base64', { mode: 'decode' }, { input: '!!!! not base64 !!!!' }),
        node('badSink', 'hash', SHA256),
        node('good', 'base64', { mode: 'decode' }, { input: 'aGVsbG8gd29ybGQ=' }),
        node('goodSink', 'hash', SHA256),
      ],
      [
        ['bad', 'output', 'badSink', 'input'],
        ['good', 'output', 'goodSink', 'input'],
      ],
    );

    const summary = await runPipeline(graph, { execute: makeEngine() });

    expect(summary.states.bad?.status).toBe('error');
    expect(summary.states.badSink?.status).toBe('upstream-failed');
    // The sibling ran to completion and produced the right answer.
    expect(textAt(summary.states, 'goodSink', 'output')).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    );

    expect(summary.failed).toBe(1);
    expect(summary.ran).toBe(2);
    // The node that never got to try is counted, and counted separately.
    expect(summary.skipped).toBe(1);
  });

  /*
   * A failure part-way down a chain names the node that ACTUALLY broke, all
   * the way to the end, rather than each node blaming the one above it. On a
   * six-node chain the difference is between one message pointing at the cause
   * and five pointing at each other.
   */
  it('points every downstream node at the node that actually failed', async () => {
    const chain = ['a', 'b', 'c', 'd', 'e'];
    const graph = graphOf(
      [
        node('a', 'base64', { mode: 'decode' }, { input: '!!!! not base64 !!!!' }),
        ...chain.slice(1).map((id) => node(id, 'hash', SHA256)),
      ],
      chain.slice(1).map((id, index) => {
        const from = chain[index] ?? '';
        // Every tool's first output is `output`, base64 and hash alike, so
        // this no longer has to know which tool it is wiring from.
        return [from, 'output', id, 'input'] as const;
      }),
    );

    const summary = await runPipeline(graph, { execute: makeEngine() });

    expect(summary.states.a?.status).toBe('error');
    for (const id of chain.slice(1)) {
      expect(summary.states[id]?.status).toBe('upstream-failed');
      expect(summary.states[id]?.failedUpstream).toBe('a');
      // Downstream nodes carry no error of their own: only the node that broke
      // shows a message, or five nodes shout the same thing.
      expect(summary.states[id]?.error).toBeNull();
    }
    expect(summary.failed).toBe(1);
    expect(summary.skipped).toBe(4);
  });
});

/* ========================================================================== *
 * Type boundaries
 * ========================================================================== */

describe('type boundaries between tools', () => {
  /*
   * A PORT'S DECLARED TYPES ARE A PROMISE ABOUT WHAT MIGHT COME OUT, NOT WHAT
   * WILL.
   *
   * base64's output carries text when encoding and bytes when decoding, so a
   * wire into a text-only port is legal to draw and may still deliver bytes.
   * The runtime check has to catch that, on the node that received it, with a
   * message naming the actual type - and it must not take the rest of the run
   * down with it.
   *
   * THE CONSUMER IS `jwt-decode` AND IT USED TO BE `regex-tester`, which is
   * this pair's own record of the port audit. Two text-only ports are left in
   * the set, and both of them are ports that take a short literal: a compact
   * token and a colour. Every port that reads a DOCUMENT now accepts `bytes`
   * as well, so the refusal these tests are about is no longer reachable from
   * a tool that reads one.
   */
  it('refuses bytes at a text-only port without disturbing anything else', async () => {
    const graph = graphOf(
      [
        node('src', 'base64', { mode: 'decode' }, { input: 'aGVsbG8=' }),
        node('jwt', 'jwt-decode'),
        node('digest', 'hash', SHA256),
      ],
      [
        ['src', 'output', 'jwt', 'input'],
        ['src', 'output', 'digest', 'input'],
      ],
    );

    const summary = await runPipeline(graph, { execute: makeEngine() });

    expect(summary.states.jwt?.status).toBe('error');
    expect(summary.states.jwt?.error?.code).toBe('unsupported-type');
    expect(summary.states.jwt?.error?.message).toContain('bytes');
    // The sibling on the same output port is untouched.
    expect(summary.states.digest?.status).toBe('ok');
  });

  /*
   * The same wire, the other way round: encoding produces text, so the tool
   * RUNS. Nothing about the document changed except one option, so this is the
   * case where a stale cache would be most tempting - and a served refusal
   * would say the wire is illegal for a value it never saw.
   *
   * What it runs on is base64 output, which is not a token, so the second
   * outcome is still a failure. The assertion is about WHICH failure: a
   * `parse-error` from inside the tool is a tool that was handed a value and
   * read it, where `unsupported-type` is a value the port refused to accept.
   */
  it('stops refusing the wire on type once the upstream produces text', async () => {
    const cache: PipelineCache = new Map();
    const execute = makeEngine();

    const wires: readonly Wire[] = [['src', 'output', 'jwt', 'input']];
    const consumer = node('jwt', 'jwt-decode');

    const decoding = graphOf(
      [node('src', 'base64', { mode: 'decode' }, { input: 'aGVsbG8=' }), consumer],
      wires,
    );
    const first = await runPipeline(decoding, { execute, cache });
    expect(first.states.jwt?.error?.code).toBe('unsupported-type');

    const encoding = graphOf(
      [node('src', 'base64', { mode: 'encode' }, { input: 'aGVsbG8=' }), consumer],
      wires,
    );
    const second = await runPipeline(encoding, { execute, cache });
    expect(second.states.jwt?.error?.code).toBe('parse-error');
  });

  /*
   * JSON is not text, even when it prints like text. structured-data offers
   * both, and the two ports carry genuinely different values - which is the
   * thing the cache key used to be unable to tell apart.
   */
  it('carries json and text out of the same node as different values', async () => {
    const graph = graphOf(
      [
        node(
          'src',
          'structured-data',
          { source: 'auto', target: 'yaml', indent: 2 },
          { input: '{"a":1}' },
        ),
        // diff is the only consumer that accepts text AND json, so it is the
        // only place the two ports can be compared without a type refusal
        // getting in the way first.
        node('fromText', 'diff', {}, { changed: 'nothing' }),
        node('fromJson', 'diff', {}, { changed: 'nothing' }),
      ],
      [
        ['src', 'output', 'fromText', 'original'],
        ['src', 'data', 'fromJson', 'original'],
      ],
    );

    const summary = await runPipeline(graph, { execute: makeEngine() });

    expect(summary.failed).toBe(0);
    // YAML on one side, the parsed structure on the other. Same node, same
    // run, two genuinely different values.
    expect(textAt(summary.states, 'fromText', 'output')).not.toBe(
      textAt(summary.states, 'fromJson', 'output'),
    );
  });
});

/* ========================================================================== *
 * The pipelines the port audit made possible
 * ========================================================================== */

describe('bytes arriving at a document port', () => {
  /*
   * BOTH OF THESE WERE IMPOSSIBLE TO WIRE, and neither was hard to want.
   *
   * `regex-tester` and `text-convert` declared `types: ['text']` on an input
   * that reads a document, so base64's decoded output - which is `bytes` - had
   * no legal wire into either. `structured-data` had widened the same port
   * some time before, recording that refusing bytes "made the most obvious
   * pipeline in the product impossible"; these two tools had the same port and
   * not the same fix.
   *
   * Run end to end with real values rather than asserted as legal wires -
   * `ports.test.ts` does the legality - because what is in question is whether
   * the value survives the hop with its meaning intact.
   */
  it('greps a base64-decoded log file', async () => {
    // Three log lines, newline-separated, in base64: `GET /a 200`, `GET /b
    // 500`, `GET /c 500`.
    const payload = 'R0VUIC9hIDIwMApHRVQgL2IgNTAwCkdFVCAvYyA1MDA=';

    const graph = graphOf(
      [
        node('decode', 'base64', { mode: 'decode' }, { input: payload }),
        node('grep', 'regex-tester', { pattern: '[0-9]{3}$', mode: 'match', multiline: true }),
      ],
      [['decode', 'output', 'grep', 'input']],
    );

    const summary = await runPipeline(graph, { execute: makeEngine() });

    expect(summary.failed).toBe(0);
    const matches = summary.states.grep?.outputs?.matches;
    expect(matches?.type).toBe('json');
    if (matches?.type !== 'json') return;
    // Three lines, three status codes - so the newlines survived the decode
    // and the multiline anchor is looking at real text.
    expect(matches.data).toMatchObject({ count: 3 });
  });

  it('cleans up a base64-decoded HTML mail body', async () => {
    // "<div><p>Hello <b>there</b></p></div>" in base64.
    const payload = 'PGRpdj48cD5IZWxsbyA8Yj50aGVyZTwvYj48L3A+PC9kaXY+';

    const graph = graphOf(
      [
        node('decode', 'base64', { mode: 'decode' }, { input: payload }),
        node('clean', 'text-convert', { source: 'html', target: 'markdown', unsupported: 'text' }),
      ],
      [['decode', 'output', 'clean', 'input']],
    );

    const summary = await runPipeline(graph, { execute: makeEngine() });

    expect(summary.failed).toBe(0);
    expect(textAt(summary.states, 'clean', 'output').trim()).toBe('Hello **there**');
  });

  /*
   * And the refusal, on the same wire, with a value that is not text. Accepting
   * bytes is only safe because the decode is strict: a lenient one turns bytes
   * nobody can read into a confident answer about content nobody wrote, which
   * is what `diff` used to do with two PNGs.
   */
  it('refuses bytes that are not text, on the node that received them', async () => {
    // 0x89 'PNG' - the real signature, and not valid UTF-8.
    const graph = graphOf(
      [
        node('decode', 'base64', { mode: 'decode' }, { input: 'iVBORw0=' }),
        node('grep', 'regex-tester', { pattern: 'a', mode: 'match' }),
        node('digest', 'hash', SHA256),
      ],
      [
        ['decode', 'output', 'grep', 'input'],
        ['decode', 'output', 'digest', 'input'],
      ],
    );

    const summary = await runPipeline(graph, { execute: makeEngine() });

    expect(summary.states.grep?.status).toBe('error');
    expect(summary.states.grep?.error?.message).toContain('could not be read as text');
    // The sibling on the same output port is untouched: `hash` wants bytes.
    expect(summary.states.digest?.status).toBe('ok');
  });
});

/* ========================================================================== *
 * Cache correctness across rewiring
 * ========================================================================== */

describe('the cache across a rewiring', () => {
  /*
   * THE WORST BUG IN THIS FILE, WITH REAL TOOLS.
   *
   * Swap the two wires into a diff node and the previous key was unchanged, so
   * the cached patch was served for the reversed comparison. The result is a
   * well-formed unified diff with the two sides the wrong way round: correct
   * looking, wrong, and completely silent.
   */
  it('re-runs a diff when its two inputs are swapped', async () => {
    const cache: PipelineCache = new Map();
    const execute = makeEngine();

    const nodes = [
      node('a', 'hash', SHA256, { input: 'AAA' }),
      node('b', 'hash', MD5, { input: 'BBB' }),
      node('cmp', 'diff', {}),
    ];

    const forwards = await runPipeline(
      graphOf(nodes, [
        ['a', 'output', 'cmp', 'original'],
        ['b', 'output', 'cmp', 'changed'],
      ]),
      { execute, cache },
    );

    const backwards = await runPipeline(
      graphOf(nodes, [
        ['b', 'output', 'cmp', 'original'],
        ['a', 'output', 'cmp', 'changed'],
      ]),
      { execute, cache },
    );

    // The two hashes are still cached - only the diff had to run again.
    expect(backwards.cached).toBe(2);
    expect(backwards.ran).toBe(1);

    const one = textAt(forwards.states, 'cmp', 'output');
    const other = textAt(backwards.states, 'cmp', 'output');
    expect(one).not.toBe(other);
    // Each patch removes what the other adds, which is what a reversed
    // comparison actually means.
    expect(one).toContain('-cb1ad2119d8fafb69566510ee712661f9f14b83385006ef92aec47f523a38358');
    expect(other).toContain('+cb1ad2119d8fafb69566510ee712661f9f14b83385006ef92aec47f523a38358');
  });

  /*
   * The other end of the same wire. Moving a consumer from one output port to
   * another on the SAME upstream node left the key unchanged, so the previous
   * port's value was served for the new one - a digest of the YAML reported as
   * the digest of the parsed JSON.
   */
  it('re-runs a consumer moved to another output port of the same node', async () => {
    const cache: PipelineCache = new Map();
    const execute = makeEngine();

    const nodes = [
      node(
        'src',
        'structured-data',
        { source: 'auto', target: 'yaml', indent: 2 },
        { input: '{"a":1}' },
      ),
      node('cmp', 'diff', {}, { changed: 'nothing' }),
    ];

    const fromText = await runPipeline(graphOf(nodes, [['src', 'output', 'cmp', 'original']]), {
      execute,
      cache,
    });
    const fromJson = await runPipeline(graphOf(nodes, [['src', 'data', 'cmp', 'original']]), {
      execute,
      cache,
    });

    // The source is still cached; only the consumer had to run again.
    expect(fromJson.cached).toBe(1);
    expect(fromJson.ran).toBe(1);
    expect(textAt(fromText.states, 'cmp', 'output')).not.toBe(
      textAt(fromJson.states, 'cmp', 'output'),
    );
  });

  /*
   * ...and the guard against over-correcting. Running the same graph twice
   * must still be a full cache hit, or the fix has simply turned the cache
   * off.
   */
  it('still serves an unchanged graph entirely from cache', async () => {
    const cache: PipelineCache = new Map();
    const execute = vi.fn(makeEngine());

    const graph = graphOf(
      [
        node('a', 'hash', SHA256, { input: 'AAA' }),
        node('b', 'hash', MD5, { input: 'BBB' }),
        node('cmp', 'diff', {}),
      ],
      [
        ['a', 'output', 'cmp', 'original'],
        ['b', 'output', 'cmp', 'changed'],
      ],
    );

    await runPipeline(graph, { execute, cache });
    const second = await runPipeline(graph, { execute, cache });

    expect(second.cached).toBe(3);
    expect(second.ran).toBe(0);
    expect(execute).toHaveBeenCalledTimes(3);
  });
});

/* ========================================================================== *
 * The graph changing under a run
 * ========================================================================== */

describe('a graph that changes while it is running', () => {
  /*
   * DELETING A NODE MID-RUN.
   *
   * A run holds the graph it started with, so it finishes computing a node
   * that no longer exists. What must not happen is the result of that node
   * surviving into the next run's view of the world, or its cache entry
   * outliving it - the entry holds the node's entire output, which for an
   * image is megabytes, for as long as the tab is open.
   */
  it('drops the cache entry for a node that has been deleted', async () => {
    const cache: PipelineCache = new Map();
    const execute = makeEngine();

    const both = graphOf(
      [
        node('keep', 'hash', SHA256, { input: 'AAA' }),
        node('gone', 'hash', SHA256, { input: 'BBB' }),
      ],
      [],
    );
    await runPipeline(both, { execute, cache });
    expect(cache.has('gone')).toBe(true);

    const trimmed = graphOf([node('keep', 'hash', SHA256, { input: 'AAA' })], []);
    const summary = await runPipeline(trimmed, { execute, cache });

    expect(cache.has('gone')).toBe(false);
    expect(cache.has('keep')).toBe(true);
    // And the state map describes the graph that ran, not the one before it.
    expect(Object.keys(summary.states)).toEqual(['keep']);
  });

  /*
   * CANCELLATION IS NOT A RESULT.
   *
   * A cancelled node used to be cached as an error, under a key computed from
   * a document that had not changed - so the next run was a cache HIT and the
   * node reported "Cancelled." forever without ever executing again. Editing
   * the node was the only way out, and nothing said so.
   */
  it('re-runs a node that was cancelled rather than caching the cancellation', async () => {
    const cache: PipelineCache = new Map();
    const controller = new AbortController();
    let executions = 0;

    const execute = async (options: ExecuteOptions): Promise<ToolResult<ToolOutputs>> => {
      executions += 1;
      await Promise.resolve();
      if (options.signal?.aborted) {
        return { ok: false, error: { code: 'cancelled', message: 'Cancelled.' } };
      }
      const output: ToolValue = { type: 'text', text: 'digest' };
      return { ok: true, value: { output } };
    };

    const graph = graphOf([node('a', 'hash', SHA256, { input: 'AAA' })], []);

    const running = runPipeline(graph, { execute, cache, signal: controller.signal });
    controller.abort();
    const cancelled = await running;

    expect(cancelled.cancelled).toBe(true);
    // Not an error, and not a failure the user has to explain to themselves:
    // the node simply has not run.
    expect(cancelled.states.a?.status).toBe('idle');
    expect(cache.has('a')).toBe(false);

    const again = await runPipeline(graph, { execute, cache });
    expect(again.states.a?.status).toBe('ok');
    expect(again.ran).toBe(1);
    expect(executions).toBe(2);
  });

  /*
   * A node downstream of a cancelled one has not failed either. It has to
   * report that it is waiting, not that something upstream broke - the
   * distinction is the difference between "press run again" and "go and find
   * the bug in the node above".
   */
  it('leaves a node downstream of a cancelled one blocked rather than failed', async () => {
    const controller = new AbortController();
    const execute = async (options: ExecuteOptions): Promise<ToolResult<ToolOutputs>> => {
      await Promise.resolve();
      if (options.signal?.aborted) {
        return { ok: false, error: { code: 'cancelled', message: 'Cancelled.' } };
      }
      const output: ToolValue = { type: 'text', text: 'value' };
      return { ok: true, value: { output } };
    };

    const graph = graphOf(
      [node('a', 'hash', SHA256, { input: 'AAA' }), node('b', 'hash', MD5)],
      [['a', 'output', 'b', 'input']],
    );

    const running = runPipeline(graph, { execute, signal: controller.signal });
    controller.abort();
    const summary = await running;

    expect(summary.states.a?.status).toBe('idle');
    expect(summary.states.b?.status).not.toBe('upstream-failed');
    expect(summary.states.b?.status).not.toBe('error');
  });
});
