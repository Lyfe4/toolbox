import {
  defineTool,
  eraseTool,
  ok,
  type ErasedTool,
  type ValueOfType,
} from '@/features/registry/types';
import { bytesToText } from '@/lib/base64';

import { computeDiff, toJson, toUnified } from './compute';
import { diffDefaultOptions, diffOptionFields, diffOptionsSchema } from './options';

/**
 * Whatever arrived on a port, as text.
 *
 * The parameter type is exactly what the port declares, so the switch is
 * exhaustive: widening a port to a fourth data type is a compile error here
 * rather than a silently missing branch.
 */
function asText(value: ValueOfType<'text' | 'json' | 'bytes'>): string {
  switch (value.type) {
    case 'text':
      return value.text;
    case 'bytes':
      return bytesToText(value.bytes);
    case 'json':
      return JSON.stringify(value.data, null, 2);
  }
}

/**
 * Compare two texts.
 *
 * The first tool with two required inputs, which is the point: on the canvas
 * both ports must be satisfied before the node runs, and in the runner both
 * get their own editor.
 *
 * Two outputs, deliberately different in kind. `output` is a unified patch -
 * portable, pipeable, paste-into-a-review text. `changes` is the structured
 * form, which the output view renders as a numbered list of rows so a screen
 * reader gets "line 12, removed: ..." rather than a wall of prefixed text.
 */
export const diffTool = defineTool({
  id: 'diff',
  name: 'Diff',
  summary: 'Compare two texts line by line, with word-level highlighting.',
  category: 'text',

  inputs: [
    {
      id: 'original',
      label: 'Original',
      types: ['text', 'json', 'bytes'],
      required: true,
      description: 'The text to compare against.',
    },
    {
      id: 'changed',
      label: 'Changed',
      types: ['text', 'json', 'bytes'],
      required: true,
      description: 'The text to compare.',
    },
  ],

  outputs: [
    {
      id: 'output',
      label: 'Unified patch',
      types: ['text'],
      description: 'Standard unified diff, ready to paste into a review or apply.',
    },
    {
      id: 'changes',
      label: 'Changes',
      types: ['json'],
      description: 'Row-by-row structure, rendered here as an accessible diff.',
      presentation: 'diff',
    },
  ],

  optionsSchema: diffOptionsSchema,
  defaultOptions: diffDefaultOptions,
  optionFields: diffOptionFields,

  execution: {
    strategy: 'worker',
    requiresWasm: false,
    wasmModules: [],
    requiresOffscreenCanvas: false,
    reportsProgress: false,
    // Myers is O(ND); two large and wholly different files are the slow case,
    // and the row cap in compute.ts stops the pathological end of it.
    timeoutMs: 20_000,
    maxInputBytes: 8 * 1024 * 1024,
  },

  run: ({ inputs, options }) => {
    const original = asText(inputs.original);
    const changed = asText(inputs.changed);

    const report = computeDiff(original, changed, {
      ignoreWhitespace: options.ignoreWhitespace,
      ignoreCase: options.ignoreCase,
      refineWords: options.refineWords,
      context: options.context,
    });
    if (!report.ok) return report;

    return ok({
      output: { type: 'text', text: toUnified(report.value, options.context) } as const,
      changes: { type: 'json', data: toJson(report.value) } as const,
    });
  },
});

const erased: ErasedTool = eraseTool(diffTool);
export default erased;
