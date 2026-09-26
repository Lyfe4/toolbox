import {
  defineTool,
  eraseTool,
  ok,
  type ColorPayload,
  type ErasedTool,
} from '@/features/registry/types';
import { lossLine, lost, notesToJson, type ToolNote } from '@/lib/notes';

import { formatAll, formatColor, parseColor, type ColorFormat, type ParsedColor } from './color';
import { colorConvertMeta } from './meta';
import { colorDefaultOptions, colorOptionFields, colorOptionsSchema } from './options';

/** The target notation as a person writes it, for the report summary. */
const FORMAT_WORDS: Readonly<Record<ColorFormat, string>> = {
  hex: 'hex',
  rgb: 'rgb()',
  hsl: 'hsl()',
  oklch: 'oklch()',
};

/**
 * `saturation 110% and lightness -5%` - so the note reads as a sentence
 * rather than as a list, which is what a node prints on its own face.
 */
function joinComponents(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

/**
 * Convert a colour between hex, rgb(), hsl() and oklch().
 *
 * The `swatch` output carries the parsed colour as a `color` value rather than
 * a string, which is what lets the output view draw a real preview and compute
 * contrast without re-parsing, and what lets the colour be wired into another
 * node later without a lossy round-trip through text.
 */
export const colorConvertTool = defineTool({
  ...colorConvertMeta,

  optionsSchema: colorOptionsSchema,
  defaultOptions: colorDefaultOptions,
  optionFields: colorOptionFields,

  run: ({ inputs, options }) => {
    const { input } = inputs;

    /*
     * A wired-in colour is already parsed, and has nothing to report: it
     * reached this port as a `ColorPayload`, which is sRGB by construction, so
     * no clamp and no gamut question can have happened on the way in. The
     * adjustments are a fact about READING TEXT.
     */
    const wired = (color: ColorPayload): { ok: true; value: ParsedColor } => ({
      ok: true,
      value: { color, clamped: [], outOfGamut: false },
    });
    const parsed = input.type === 'color' ? wired(input.color) : parseColor(input.text);
    if (!parsed.ok) return parsed;

    const { color, clamped, outOfGamut } = parsed.value;
    const written = input.type === 'color' ? null : input.text.trim();

    /*
     * The nearest sRGB colour, as hex.
     *
     * Hex rather than the target notation, and deliberately: the note has to
     * name a colour the reader can compare against what they typed, and hex is
     * the one spelling that is the same in every notation's report row. It is
     * also the answer that does not move when `precision` does.
     */
    const nearest = formatColor(color, 'hex', options.precision);
    const notes: ToolNote[] = [];

    /*
     * WHICH PORTS THE ADJUSTMENT IS IN: all three, because it happened in the
     * READ half. `output`, `swatch` and `all` are three spellings of one
     * parsed colour, and the parsed colour is the thing that moved - unlike
     * `structured-data`, where a write-half loss leaves the parsed source
     * intact on a second port. There is no port here that escapes it.
     */
    const reaches = ['output', 'swatch', 'all'];

    if (outOfGamut && written !== null) {
      notes.push(
        lost(
          `${written} is outside sRGB; the nearest is ${nearest}`,
          `OKLCH can name colours no sRGB screen can show, and that one is outside the gamut. Every notation here describes ${nearest} instead, which is the nearest sRGB colour, clipped per channel. The contrast table describes ${nearest} too - so if you are checking whether a wide-gamut colour passes AA, the answer you are reading is about the clipped colour rather than about the one you typed.`,
          reaches,
        ),
      );
    }

    if (clamped.length > 0 && written !== null) {
      notes.push(
        lost(
          `${written} was clamped to ${nearest}`,
          `${written} names ${clamped.length === 1 ? 'a component' : 'components'} outside the range the notation allows - ${joinComponents(clamped)} - so ${clamped.length === 1 ? 'it was' : 'they were'} clamped to the nearest legal value. CSS clamps the same way, so ${nearest} is the colour a browser would paint for that text too; the risk is that a number typed by mistake produces a colour rather than an error.`,
          reaches,
        ),
      );
    }

    const losses = lossLine(notes);

    return ok({
      output: {
        type: 'text',
        text: formatColor(color, options.target, options.precision),
      } as const,
      swatch: { type: 'color', color } as const,
      all: { type: 'json', data: formatAll(color, options.precision) } as const,
      report: {
        type: 'json',
        data: {
          summary: `${nearest} as ${FORMAT_WORDS[options.target]}${losses === null ? '' : ` · ${losses}`}`,
          notes: notesToJson(notes),
        },
      } as const,
    });
  },
});

const erased: ErasedTool = eraseTool(colorConvertTool);
export default erased;
