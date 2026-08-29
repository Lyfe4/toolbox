import { defineTool, eraseTool, ok, type ErasedTool } from '@/features/registry/types';

import { DELIMITERS, detectFormat, parseSource, serialise, sortKeysDeep } from './convert';
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
      types: ['text', 'json'],
      required: true,
      description: 'Paste a document, drop a file, or wire in JSON from another tool.',
    },
  ],

  outputs: [
    { id: 'output', label: 'Converted', types: ['text'] },
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
    requiresWasm: false,
    wasmModules: [],
    reportsProgress: false,
    timeoutMs: 15_000,
    maxInputBytes: 16 * 1024 * 1024,
  },

  run: ({ inputs, options }) => {
    const { input } = inputs;
    const delimiter = DELIMITERS[options.delimiter];

    // A wired-in 'json' value is already parsed; only text needs a parser.
    const parsed =
      input.type === 'json'
        ? ok(input.data)
        : parseSource(
            input.text,
            options.source === 'auto' ? detectFormat(input.text) : options.source,
            delimiter,
          );

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
