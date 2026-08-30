import type { ToolId } from '@/features/registry';

import { NODE_WIDTH } from './geometry';

import type { CanvasEdge, CanvasNode, Point } from './types';

/**
 * Example pipelines, loadable in one click from the palette.
 *
 * STRUCTURE ONLY. A preset says which tools to place and how to wire them; it
 * ships no input data, exactly like a share link. Each one drops in with empty
 * inputs and every node blocked until the user provides something, which is
 * the honest state for "here is the shape, bring your own data".
 */
export interface PresetNode {
  readonly toolId: ToolId;
  readonly offset: Point;
  readonly options: Readonly<Record<string, unknown>>;
}

/** [fromIndex, fromPort, toIndex, toPort] - indices into `nodes`. */
export type PresetWire = readonly [number, string, number, string];

export interface PipelinePreset {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly nodes: readonly PresetNode[];
  readonly wires: readonly PresetWire[];
}

const COLUMN = NODE_WIDTH + 96;
const ROW = 232;

export const PIPELINE_PRESETS: readonly PipelinePreset[] = [
  {
    id: 'decode-and-convert',
    name: 'Decode, then convert',
    summary: 'Base64-decode a payload and turn the JSON inside it into YAML.',
    nodes: [
      { toolId: 'base64', offset: { x: 0, y: 0 }, options: { mode: 'decode' } },
      {
        toolId: 'structured-data',
        offset: { x: COLUMN, y: 0 },
        options: { source: 'auto', target: 'yaml', indent: 2 },
      },
    ],
    wires: [[0, 'output', 1, 'input']],
  },
  {
    id: 'fingerprint-csv',
    name: 'Fingerprint a CSV',
    summary: 'Convert CSV to JSON, then take a SHA-256 of the result.',
    nodes: [
      {
        toolId: 'structured-data',
        offset: { x: 0, y: 0 },
        options: { source: 'csv', target: 'json', indent: 0, sortKeys: true },
      },
      {
        toolId: 'hash',
        offset: { x: COLUMN, y: 0 },
        options: { algorithm: 'sha-256', encoding: 'hex' },
      },
    ],
    wires: [[0, 'output', 1, 'input']],
  },
  {
    id: 'encode-and-compare',
    name: 'Encode, then compare digests',
    summary: 'Base64-encode an input and fan the result into a SHA-256 and an MD5.',
    nodes: [
      { toolId: 'base64', offset: { x: 0, y: 0 }, options: { mode: 'encode' } },
      {
        toolId: 'hash',
        offset: { x: COLUMN, y: -ROW / 2 },
        options: { algorithm: 'sha-256', encoding: 'hex' },
      },
      {
        toolId: 'hash',
        offset: { x: COLUMN, y: ROW / 2 },
        options: { algorithm: 'md5', encoding: 'hex' },
      },
    ],
    // One output feeding two inputs: the fan-out case that made borrow-by-
    // default necessary in the execution engine.
    wires: [
      [0, 'output', 1, 'input'],
      [0, 'output', 2, 'input'],
    ],
  },
  {
    id: 'clean-pasted-html',
    name: 'Clean up pasted HTML',
    summary: 'Strip messy HTML down to Markdown, then render it back as clean, sanitised markup.',
    nodes: [
      {
        toolId: 'text-convert',
        offset: { x: 0, y: 0 },
        options: {
          source: 'html',
          target: 'markdown',
          bullet: '-',
          emphasis: '_',
          fence: '`',
          unsupported: 'text',
        },
      },
      {
        toolId: 'text-convert',
        offset: { x: COLUMN, y: 0 },
        options: { source: 'markdown', target: 'html', headingIds: true, linkify: true },
      },
    ],
    wires: [[0, 'output', 1, 'input']],
  },
];

export function getPreset(id: string): PipelinePreset | null {
  return PIPELINE_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * Turns a preset into concrete nodes and edges, numbered from `nextId` so they
 * cannot collide with whatever is already on the canvas.
 */
export function instantiatePreset(
  preset: PipelinePreset,
  origin: Point,
  nextId: number,
): { readonly nodes: readonly CanvasNode[]; readonly edges: readonly CanvasEdge[] } {
  let counter = nextId;

  const nodes = preset.nodes.map((spec): CanvasNode => {
    const id = `n${counter.toString()}`;
    counter += 1;
    return {
      id,
      toolId: spec.toolId,
      position: { x: origin.x + spec.offset.x, y: origin.y + spec.offset.y },
      options: { ...spec.options },
      // No bundled data, ever.
      inputs: {},
    };
  });

  const edges = preset.wires.flatMap((wire): CanvasEdge[] => {
    const [fromIndex, fromPort, toIndex, toPort] = wire;
    const from = nodes[fromIndex];
    const to = nodes[toIndex];
    if (!from || !to) return [];

    const id = `e${counter.toString()}`;
    counter += 1;
    return [
      { id, from: { nodeId: from.id, portId: fromPort }, to: { nodeId: to.id, portId: toPort } },
    ];
  });

  return { nodes, edges };
}
