import {
  defineTool,
  eraseTool,
  ok,
  type ColorPayload,
  type ErasedTool,
} from '@/features/registry/types';
import { lossLine, lost, notesToJson, type ToolNote } from '@/lib/notes';

import { formatAll, formatColor, parseColor, type ColorFormat, type ParsedColor } from './color';
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
    {
      id: 'output',
      label: 'Converted',
      types: ['text'],
      description: 'The colour written in the target notation.',
    },
    {
      id: 'swatch',
      // 'Swatch', not 'Colour'. The input port is called 'Colour', and a node
      // reading `Colour` on the left and `Colour` on the right says nothing
      // about which is which - on a 224px node the labels are all there is.
      label: 'Swatch',
      types: ['color'],
      description: 'The parsed colour, previewed with its contrast against black and white.',
    },
    {
      id: 'all',
      // Was 'Every notation', which is 14 characters against an 84px label box
      // and was therefore drawn as 'Every notat…' on every node that had one.
      label: 'Notations',
      types: ['json'],
      description: 'The same colour as hex, rgb(), hsl() and oklch() at once.',
    },
    {
      /*
       * THE CHANNEL THIS TOOL DID NOT HAVE.
       *
       * Every other shipped tool that changes a value has somewhere to say so;
       * this one did not, and that single absence is what four findings in
       * `docs/test-findings.md` have in common. `oklch(0.7 0.4 150)` came back
       * as `oklch(0.7587 0.25817 142.5)` - lightness up, chroma down by 35%,
       * hue moved 7.5 degrees - with no warning anywhere, and the conversion
       * matrix recorded the cell as `lossy, told` regardless.
       *
       * It could not be fixed by writing a better sentence somewhere, because
       * the matrix's own definition of `lossy, told` is "told on the panel on
       * /tools AND on the canvas node", and a canvas node reads `warn` notes
       * off a port presented as a `report`. With no such port there was no
       * arrangement of words that could reach the bar.
       *
       * ADDITIVE, so no share link and no saved canvas changes: a new output
       * id is one more port to wire, never a different one.
       */
      id: 'report',
      label: 'Report',
      types: ['json'],
      description: 'What the parser had to change about the colour to answer.',
      presentation: 'report',
    },
  ],

  optionsSchema: colorOptionsSchema,
  defaultOptions: colorDefaultOptions,
  optionFields: colorOptionFields,

  execution: {
    strategy: 'main',
    requiresOffscreenCanvas: false,
    timeoutMs: 5_000,
    // A colour is a few dozen characters. The cap is generous for a pasted
    // list that turns out to be one line, and absurd for anything else.
    maxInputBytes: 4 * 1024,
  },

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
