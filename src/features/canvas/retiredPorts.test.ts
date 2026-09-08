import { describe, expect, it } from 'vitest';

import { legacyShareLink } from '@/lib/testing/shareLink';

import { firstRefusedEdge } from './connections';
import { currentInputPortId, currentOutputPortId, migrateInputKeys } from './retiredPorts';
import { decodeParamToGraph, SHARE_FORMAT_VERSION } from './share';

/**
 * THE PORT RENAME MIGRATION, on the share-link route.
 *
 * The saved-canvas route is covered in `persistence.test.ts`, next to the
 * other graph migrations. This file is the link, because a link is the harder
 * promise: it is something a person pasted into an issue months ago and comes
 * back to, and it must either come back as the pipeline they built or be
 * refused outright. Never half of it.
 *
 * Exercised through `decodeParamToGraph` - the real entry point - rather than
 * by calling the migration, because what is worth proving is that a genuine
 * old link works, not that a lookup table looks things up.
 */

const v2Link = (nodes: readonly unknown[], edges: readonly unknown[]): Promise<string> =>
  legacyShareLink({ v: 2, n: nodes, e: edges });

describe('a v2 link naming the old output ports', () => {
  /*
   * A hash node is the end of two of the five shipped presets, so "a link with
   * a hash node in it" is not a hypothetical shape - it is the shape most
   * shared pipelines have.
   */
  const nodes = [
    ['n1', 'hash', 0, 0, { algorithm: 'sha-256' }],
    ['n2', 'hash', 320, 0, { algorithm: 'md5' }],
    ['n3', 'diff', 640, 0, {}],
    ['n4', 'image-convert', 0, 300, {}],
    ['n5', 'structured-data', 320, 300, {}],
  ];

  it('migrates every renamed port and restores the whole pipeline', async () => {
    const param = await v2Link(nodes, [
      ['n1', 'digest', 'n3', 'original'],
      ['n2', 'digest', 'n3', 'changed'],
      ['n4', 'info', 'n5', 'input'],
    ]);

    const result = await decodeParamToGraph(param);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    const ports = result.graph.edgeOrder.map((id) => result.graph.edges[id]?.from.portId);
    expect(ports).toEqual(['output', 'output', 'report']);

    // The receiving ends are untouched, and so is everything else.
    expect(result.graph.edgeOrder).toHaveLength(3);
    expect(result.graph.nodeOrder).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
    expect(result.graph.nodes.n1?.options).toEqual({ algorithm: 'sha-256' });
  });

  /*
   * The migration's guarantee, and the reason it is not simply "the link
   * loads": what comes out is a graph whose every wire is one this build could
   * have made by hand. A rename the table missed fails here.
   */
  it('produces a graph whose every wire passes the connection check', async () => {
    const param = await v2Link(nodes, [
      ['n1', 'digest', 'n3', 'original'],
      ['n2', 'digest', 'n3', 'changed'],
    ]);

    const result = await decodeParamToGraph(param);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(firstRefusedEdge(result.graph)).toBeNull();
  });

  /*
   * The port rename is per TOOL, so it must not fire on a tool that happens to
   * have a port of the same name. Nothing in the set has an `info` port any
   * more, but `output` exists on every tool - a table applied blindly would
   * rewrite ids that were already right.
   */
  it('leaves ports that were never renamed alone', async () => {
    const param = await v2Link(
      [
        ['n1', 'base64', 0, 0, { mode: 'decode' }],
        ['n2', 'structured-data', 320, 0, {}],
        ['n3', 'diff', 640, 0, {}],
      ],
      [
        ['n1', 'output', 'n2', 'input'],
        ['n2', 'data', 'n3', 'original'],
      ],
    );

    const result = await decodeParamToGraph(param);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    const ports = result.graph.edgeOrder.map((id) => result.graph.edges[id]?.from.portId);
    expect(ports).toEqual(['output', 'data']);
  });
});

describe('a link this build cannot honour', () => {
  /*
   * NEVER PARTIALLY APPLIED, which is the property the whole exercise turns
   * on. Before this, an edge naming a port nothing has was applied like any
   * other: the canvas drew the wire, the upstream node ran, and the node below
   * reported `Nothing arrived on Original` - a correctly wired node blamed for
   * a wire that was never going to deliver anything. Nothing said which one.
   */
  it('refuses a link naming a port no migration knows about, and applies nothing', async () => {
    const param = await v2Link(
      [
        ['n1', 'hash', 0, 0, {}],
        ['n2', 'diff', 320, 0, {}],
      ],
      [['n1', 'fingerprint', 'n2', 'original']],
    );

    const result = await decodeParamToGraph(param);

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    // The refusal says what is wrong with the link, not merely that it is.
    expect(result.message).toContain('That port no longer exists.');
    expect(result).not.toHaveProperty('graph');
  });

  /*
   * A hostile link can also be well formed and still describe something the
   * canvas would never let anybody build. Each of these was accepted before
   * `checkConnection` guarded this route, and each produces a canvas whose
   * behaviour has no explanation on screen: two wires into one input (the
   * engine silently takes whichever comes first), and a node wired to itself
   * (which makes the run refuse the whole graph as a cycle).
   */
  it.each([
    [
      'two wires into one input',
      [
        ['n1', 'hash', 0, 0, {}],
        ['n2', 'hash', 320, 0, {}],
        ['n3', 'diff', 640, 0, {}],
      ],
      [
        ['n1', 'output', 'n3', 'original'],
        ['n2', 'output', 'n3', 'original'],
      ],
      'already has a connection',
    ],
    [
      'a node wired to itself',
      [['n1', 'text-convert', 0, 0, {}]],
      [['n1', 'output', 'n1', 'input']],
      'cannot be wired to itself',
    ],
    [
      'a type mismatch',
      [
        ['n1', 'structured-data', 0, 0, {}],
        ['n2', 'jwt-decode', 320, 0, {}],
      ],
      [['n1', 'data', 'n2', 'input']],
      'accepts text',
    ],
    [
      'a loop',
      [
        ['n1', 'text-convert', 0, 0, {}],
        ['n2', 'text-convert', 320, 0, {}],
      ],
      [
        ['n1', 'output', 'n2', 'input'],
        ['n2', 'output', 'n1', 'input'],
      ],
      'would create a loop',
    ],
  ])('refuses %s', async (_name, nodes, edges, fragment) => {
    const result = await decodeParamToGraph(await v2Link(nodes, edges));

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.message).toContain(fragment);
  });

  it('refuses a version from the future rather than half-reading it', async () => {
    const param = await legacyShareLink({ v: SHARE_FORMAT_VERSION + 1, n: [], e: [] });
    expect((await decodeParamToGraph(param)).status).toBe('error');
  });
});

describe('the rename table itself', () => {
  it('maps the two renamed output ports', () => {
    expect(currentOutputPortId('hash', 'digest')).toBe('output');
    expect(currentOutputPortId('image-convert', 'info')).toBe('report');
  });

  it('is the identity for everything else', () => {
    expect(currentOutputPortId('base64', 'output')).toBe('output');
    expect(currentOutputPortId('structured-data', 'data')).toBe('data');
    // Per tool, not per name: `digest` on a tool that never had one stays put.
    expect(currentOutputPortId('base64', 'digest')).toBe('digest');
  });

  /*
   * No input id was renamed by the audit, and that is a finding rather than a
   * gap - the convention was already sound, and only the human LABELS needed
   * work. The mapping is still applied on both routes so that renaming one
   * later is a table entry rather than the discovery that half the migration
   * was never written.
   */
  it('is the identity on the input side, which nothing has renamed', () => {
    expect(currentInputPortId('diff', 'original')).toBe('original');
    expect(currentInputPortId('hash', 'input')).toBe('input');
    expect(migrateInputKeys('hash', { input: 'abc' })).toEqual({ input: 'abc' });
  });

  it('survives values that are not strings at all', () => {
    // Everything here comes out of localStorage or a URL: untrusted, always.
    expect(currentOutputPortId(42, 'digest')).toBe('digest');
    expect(currentOutputPortId('hash', null)).toBeNull();
    expect(migrateInputKeys('hash', null)).toBeNull();
    expect(migrateInputKeys(undefined, { input: 'a' })).toEqual({ input: 'a' });
  });
});
