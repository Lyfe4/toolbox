import { defineTool, eraseTool, ok, type ErasedTool } from '@/features/registry/types';

import { formatAll, formatColor, parseColor } from './color';
import { colorDefaultOptions, colorOptionFields, colorOptionsSchema } from './options';

/**
 * Convert a colour between hex, rgb(), hsl() and oklch().
 *
 * The `swatch` output carries the parsed colour as a `color` value rather than
 * a string, which is what lets the output view draw a real preview and compute
 * contrast without re-parsing, and what lets the colour be wired into another
 * node later without a lossy round-trip through text.
 */
export const colorConvertTool = defineTool({
  id: 'color-convert',
  name: 'Colour',
  summary: 'Convert between hex, rgb(), hsl() and oklch(), with contrast checks.',
  category: 'colour',

  inputs: [
    {
      id: 'input',
      label: 'Colour',
      types: ['text', 'color'],
      required: true,
      description: '#3b82f6, rgb(59 130 246), hsl(217 91% 60%) or oklch(0.62 0.19 259).',
    },
  ],

  outputs: [
    { id: 'output', label: 'Converted', types: ['text'] },
    {
      id: 'swatch',
      label: 'Colour',
      types: ['color'],
      description: 'The parsed colour, previewed with its contrast against black and white.',
    },
    {
      id: 'all',
      label: 'Every notation',
      types: ['json'],
      description: 'The same colour in all four notations, for wiring into another tool.',
    },
  ],

  optionsSchema: colorOptionsSchema,
  defaultOptions: colorDefaultOptions,
  optionFields: colorOptionFields,

  execution: {
    strategy: 'main',
    requiresWasm: false,
    wasmModules: [],
    requiresOffscreenCanvas: false,
    reportsProgress: false,
    timeoutMs: 5_000,
    // A colour is a few dozen characters. The cap is generous for a pasted
    // list that turns out to be one line, and absurd for anything else.
    maxInputBytes: 4 * 1024,
  },

  run: ({ inputs, options }) => {
    const { input } = inputs;

    // A wired-in colour is already parsed; only text needs interpreting.
    const parsed =
      input.type === 'color' ? { ok: true as const, value: input.color } : parseColor(input.text);
    if (!parsed.ok) return parsed;

    const color = parsed.value;

    return ok({
      output: {
        type: 'text',
        text: formatColor(color, options.target, options.precision),
      } as const,
      swatch: { type: 'color', color } as const,
      all: { type: 'json', data: formatAll(color, options.precision) } as const,
    });
  },
});

const erased: ErasedTool = eraseTool(colorConvertTool);
export default erased;
