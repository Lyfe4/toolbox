import type { ToolManifestEntry } from '@/features/registry/types';

/**
 * What the rest of the app knows about this tool without loading its code:
 * the manifest imports this file eagerly and `index.ts` spreads it into the
 * definition, so the two cannot disagree. Data only - no import may bring
 * code into the initial bundle (`registry.test.ts` holds that).
 */
export const structuredDataMeta = {
  id: 'structured-data',
  name: 'Structured data',
  summary: 'Convert between JSON, YAML, CSV and TSV, with auto-detection.',
  category: 'data',
  keywords: ['json', 'yaml', 'csv', 'tsv', 'convert', 'format', 'parse'],

  inputs: [
    {
      id: 'input',
      label: 'Document',
      // Bytes as well as text: a document very often arrives as raw bytes -
      // straight from a dropped file, or out of a base64 decode - and refusing
      // those made the most obvious pipeline in the product impossible.
      types: ['text', 'json', 'bytes'],
      required: true,
      description: 'Paste a document, drop a file, or wire in data from another tool.',
    },
  ],

  outputs: [
    {
      id: 'output',
      label: 'Converted',
      types: ['text'],
      description: 'The document serialised in the target format.',
      /*
       * WHAT THE DOCUMENT AMOUNTS TO, not its first line.
       *
       * `output` is written FROM the value on `data` - `writeTarget(data, ...)`
       * below - so the item or key count of one is the item or key count of the
       * other, whichever of the four formats it came out in. Without this a
       * node reads `[` for every pretty-printed JSON document, `---` for every
       * YAML stream and its column names for every table.
       */
      measuredBy: 'data',
    },
    {
      id: 'data',
      label: 'Parsed data',
      types: ['json'],
      description: 'The parsed structure, for wiring into another tool.',
    },
    {
      /*
       * WHAT IT DECIDED, AND WHAT THE CONVERSION COST.
       *
       * This tool guesses the source format on every run by default, and until
       * now it never said which one it picked - so a semicolon export read as
       * YAML, or two lines of YAML read as a one-row table, were wrong answers
       * with nothing on screen to question. `text-convert` has had a `Detected`
       * output for exactly this reason since it was written.
       *
       * It carries the losses too, because they are the same hole: three of
       * this tool's conversions lose something real - a nested value flattened
       * into a cell, a key absent from a row, an integer past 2^53 - and a
       * `ToolResult` is a value or an error, so there was nowhere for any of
       * them to go. One port turns four silent losses into told ones.
       *
       * ADDITIVE, which is why it could be done at all: a new output port
       * breaks no share link and no saved canvas. See retiredPorts.ts for what
       * the alternative costs.
       */
      id: 'report',
      label: 'Detected',
      types: ['json'],
      description: 'The format and delimiter it decided on, and anything the conversion lost.',
      presentation: 'report',
    },
  ],

  execution: {
    strategy: 'worker',
    requiresOffscreenCanvas: false,
    timeoutMs: 15_000,
    maxInputBytes: 16 * 1024 * 1024,
  },
} as const satisfies ToolManifestEntry;
