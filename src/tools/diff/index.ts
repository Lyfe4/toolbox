import {
  defineTool,
  eraseTool,
  ok,
  type ErasedTool,
  type ToolResult,
  type ValueOfType,
} from '@/features/registry/types';
import { decodeDocument } from '@/lib/text';

import { computeDiff, toJson, toUnified } from './compute';
import { diffDefaultOptions, diffOptionFields, diffOptionsSchema } from './options';

/**
 * Whatever arrived on a port, as text.
 *
 * The parameter type is exactly what the port declares, so the switch is
 * exhaustive: widening a port to a fourth data type is a compile error here
 * rather than a silently missing branch.
 *
 * BYTES ARE DECODED STRICTLY, and they were not. `bytesToText` replaces every
 * invalid sequence with U+FFFD, which is the right choice where it lives - a
 * preview of decoded base64 is more use than a refusal - and the wrong one
 * here. Two PNGs wired into these ports produced a confident, well-formed
 * unified diff of two walls of replacement characters: an answer that looks
 * like an answer and means nothing, which is the failure mode this repository
 * keeps finding. It now says which port could not be read, because with two
 * document ports "those bytes" is not an answer.
 *
 * A LOSSLESS `json` stringify is still fine, and the asymmetry with `hash` is
 * deliberate. Serialising a structure to compare it picks an indentation, and
 * that choice changes how the comparison READS; picking one to fingerprint a
 * structure would change the digest, which is a number people compare across
 * machines. So `diff` accepts `json` and `hash` does not.
 */
function asText(value: ValueOfType<'text' | 'json' | 'bytes'>, label: string): ToolResult<string> {
  switch (value.type) {
    case 'text':
      return ok(value.text);
    case 'bytes':
      return decodeDocument(value.bytes, label);
    case 'json':
      return ok(JSON.stringify(value.data, null, 2));
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
    const original = asText(inputs.original, 'Original');
    if (!original.ok) return original;
    const changed = asText(inputs.changed, 'Changed');
    if (!changed.ok) return changed;

    const report = computeDiff(original.value, changed.value, {
      // The option key still says "ignore"; its value now says how much. See
      // the note in options.ts for why the key was not renamed.
      whitespace: options.ignoreWhitespace,
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
