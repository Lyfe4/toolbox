import { defineTool, eraseTool, ok, type ErasedTool } from '@/features/registry/types';
import { lossLine, notesToJson } from '@/lib/notes';

import { convert, type Dependencies } from './convert';
import { timestampDefaultOptions, timestampOptionFields, timestampOptionsSchema } from './options';
import { readVintage, type Vintage } from './vintage';
import { lookupZone } from './zones';

/**
 * The engine's tz data vintage, asked once per page: it is a fact about the
 * browser, fifteen `Intl` calls, and the same answer every time.
 */
let vintage: Vintage | null = null;

/** The browser's zones and the browser's vintage. */
const engine: Dependencies = {
  lookupZone,
  vintage: () => {
    vintage ??= readVintage((name) => {
      const found = lookupZone(name);
      return found.ok ? found.zone : null;
    });
    return vintage;
  },
};

/**
 * Convert between Unix time, RFC 3339 and readable dates in any IANA zone.
 *
 * `output` is the answer in the chosen notation; `all` is every notation of
 * the same instant, exactly, which is what a wire wants when the next tool
 * needs a different one; `report` says what the conversion could not carry.
 */
export const timestampTool = defineTool({
  id: 'timestamp',
  name: 'Timestamp',
  summary: 'Convert between Unix time, RFC 3339 and readable dates in any time zone.',
  category: 'encoding',

  inputs: [
    {
      id: 'input',
      label: 'Timestamp',
      /*
       * `json` so that a decoded JWT's `exp` can be wired in: jwt-decode's one
       * output is `json`, and a text-only port would make the wire illegal to
       * draw. Field names the member. Not `bytes`: a timestamp is a short
       * literal, like a colour, and the port rules keep bytes for documents.
       */
      types: ['text', 'json'],
      required: true,
      description:
        '1727308800, 2024-09-26T08:00:00+02:00 or Thu, 26 Sep 2024 06:00:00 GMT - or wired JSON, with Field naming the member.',
    },
  ],

  outputs: [
    {
      id: 'output',
      label: 'Converted',
      types: ['text'],
      description: 'The instant in the chosen notation.',
    },
    {
      id: 'all',
      label: 'Notations',
      types: ['json'],
      description:
        'The same instant as Unix time in every unit, RFC 3339 and a readable date at once, each exact.',
    },
    {
      id: 'report',
      label: 'Report',
      types: ['json'],
      description: 'What was read, what was assumed, and anything the conversion could not carry.',
      presentation: 'report',
    },
  ],

  optionsSchema: timestampOptionsSchema,
  defaultOptions: timestampDefaultOptions,
  optionFields: timestampOptionFields,

  execution: {
    // Main thread: a parse and a handful of `Intl` calls on a short string.
    // A worker round trip would cost more than the work.
    strategy: 'main',
    requiresOffscreenCanvas: false,
    timeoutMs: 5_000,
    // A timestamp is a few dozen characters. The cap is for a wired JSON
    // value, which Field then reads one member of.
    maxInputBytes: 256 * 1024,
  },

  run: ({ inputs, options }) => {
    const { input } = inputs;
    const converted = convert(
      input.type === 'json'
        ? { type: 'json', data: input.data }
        : { type: 'text', text: input.text },
      options,
      engine,
    );
    if (!converted.ok) return converted;
    const { output, all, summary, from, to, notes } = converted.value;
    const losses = lossLine(notes);

    return ok({
      output: { type: 'text', text: output } as const,
      all: { type: 'json', data: all } as const,
      report: {
        type: 'json',
        data: {
          summary: `${summary}${losses === null ? '' : ` · ${losses}`}`,
          from: { format: from },
          to: { format: to },
          notes: notesToJson(notes),
        },
      } as const,
    });
  },
});

const erased: ErasedTool = eraseTool(timestampTool);
export default erased;
