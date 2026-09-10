import { defineTool, eraseTool, ok, type ErasedTool } from '@/features/registry/types';

import {
  checkJsonInput,
  decodeDocument,
  DELIMITERS,
  parseAuto,
  parseSource,
  serialise,
  sortKeysDeep,
} from './convert';
import {
  structuredDataDefaultOptions,
  structuredDataOptionFields,
  structuredDataOptionsSchema,
} from './options';

/**
 * Convert between JSON, YAML, CSV and TSV.
 *
 * This tool exists to prove three things about the design:
 *
 *   1. Options that genuinely change behaviour, including auto-detection.
 *   2. Parse failures reported as structured errors with a line and column,
 *      never thrown across the execution boundary.
 *   3. Multiple outputs from one run - the rendered document and the parsed
 *      structure, so the canvas can wire either onward.
 */
export const structuredDataTool = defineTool({
  id: 'structured-data',
  name: 'Structured data',
  summary: 'Convert between JSON, YAML, CSV and TSV, with auto-detection.',
  category: 'data',

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
    },
    {
      id: 'data',
      label: 'Parsed data',
      types: ['json'],
      description: 'The parsed structure, for wiring into another tool.',
    },
  ],

  optionsSchema: structuredDataOptionsSchema,
  defaultOptions: structuredDataDefaultOptions,
  optionFields: structuredDataOptionFields,

  execution: {
    strategy: 'worker',
    requiresOffscreenCanvas: false,
    reportsProgress: false,
    timeoutMs: 15_000,
    maxInputBytes: 16 * 1024 * 1024,
  },

  run: ({ inputs, options }) => {
    const { input } = inputs;
    const delimiter = DELIMITERS[options.delimiter];

    // A wired-in 'json' value is already parsed. Bytes are decoded strictly -
    // see `decodeDocument` for why UTF-16 with a byte order mark is the one
    // encoding other than UTF-8 that gets through.
    let source: string;
    if (input.type === 'json') {
      source = '';
    } else if (input.type === 'bytes') {
      const decoded = decodeDocument(input.bytes);
      if (!decoded.ok) return decoded;
      source = decoded.value;
    } else {
      source = input.text;
    }

    /*
     * A value wired in on the `json` port is already parsed, so it skips the
     * parser - but NOT the guards. It is the one route into this tool whose
     * shape nothing in this file has checked, and `sortKeysDeep` and
     * `JSON.stringify` are both recursive: a value nested a few thousand deep
     * threw `RangeError` straight out of `run`, which the execution contract
     * says can never happen.
     */
    const parsed =
      input.type === 'json'
        ? checkJsonInput(input.data)
        : options.source === 'auto'
          ? parseAuto(source, delimiter)
          : parseSource(source, options.source, delimiter);

    if (!parsed.ok) return parsed;

    const data = options.sortKeys ? sortKeysDeep(parsed.value) : parsed.value;

    const rendered = serialise(data, options.target, { indent: options.indent, delimiter });
    if (!rendered.ok) return rendered;

    return ok({
      output: { type: 'text', text: rendered.value } as const,
      data: { type: 'json', data } as const,
    });
  },
});

const erased: ErasedTool = eraseTool(structuredDataTool);
export default erased;
