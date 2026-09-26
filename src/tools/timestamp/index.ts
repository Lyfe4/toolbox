import { defineTool, eraseTool, ok, type ErasedTool } from '@/features/registry/types';
import { lossLine, notesToJson } from '@/lib/notes';

import { convert, type Dependencies } from './convert';
import { timestampMeta } from './meta';
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
  ...timestampMeta,

  optionsSchema: timestampOptionsSchema,
  defaultOptions: timestampDefaultOptions,
  optionFields: timestampOptionFields,

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
