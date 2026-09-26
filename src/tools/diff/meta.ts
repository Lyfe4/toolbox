import type { ToolManifestEntry } from '@/features/registry/types';

/**
 * What the rest of the app knows about this tool without loading its code:
 * the manifest imports this file eagerly and `index.ts` spreads it into the
 * definition, so the two cannot disagree. Data only - no import may bring
 * code into the initial bundle (`registry.test.ts` holds that).
 */
export const diffMeta = {
  id: 'diff',
  name: 'Diff',
  summary: 'Compare two texts line by line, with word-level highlighting.',
  category: 'text',
  keywords: ['compare', 'patch', 'unified', 'changes', 'delta'],

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
      /*
       * A patch's first line is `--- original` whatever the two documents
       * were, and an identical pair produces an empty patch, so a node said
       * either one constant or `Empty` and never `+12 -3`. `changes` is the
       * same comparison as a structure, and `diffSummary` already reads it.
       */
      measuredBy: 'changes',
    },
    {
      id: 'changes',
      label: 'Changes',
      types: ['json'],
      description: 'Row-by-row structure, rendered here as an accessible diff.',
      presentation: 'diff',
    },
  ],

  execution: {
    strategy: 'worker',
    requiresOffscreenCanvas: false,
    // Myers is O(ND); two large and wholly different files are the slow case,
    // and the row cap in compute.ts stops the pathological end of it.
    timeoutMs: 20_000,
    maxInputBytes: 8 * 1024 * 1024,
  },
} as const satisfies ToolManifestEntry;
