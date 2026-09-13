import type { OptionField } from '@/features/registry/types';
import { z } from '@/lib/zod';

import { COLOR_FORMATS } from './color';

export const colorOptionsSchema = z.object({
  target: z.enum(COLOR_FORMATS).default('hex'),
  /**
   * Decimal places for the notations that carry fractions. Hex and rgb() are
   * integer-quantised and ignore it, which the field description says.
   *
   * FOUR, NOT THREE, AND THE NUMBER IS MEASURED RATHER THAN CHOSEN.
   *
   * 266 colours - this repository's own primitives, every hex literal in the
   * CSS shipped in node_modules, and the six sRGB corners - were written as
   * oklch() at each precision and read back, both by this tool's own parser
   * and by painting them in Firefox and sampling the pixel. The two agree
   * exactly:
   *
   *     precision   oklch wrong   worst channel error
   *             1     262 / 266               82/255
   *             2     245 / 266               43/255
   *             3      23 / 266                3/255
   *             4       0 / 266                    -
   *
   * So at the old default of three, roughly one colour in twelve did not
   * survive being converted - `oklch(0.702 0.322 328.36)` for `#ff00ff` paints
   * as rgb(255, 3, 255). Not a rounding curiosity: pasting that into a
   * stylesheet is a different colour from the one that was typed in, and
   * nothing said so.
   *
   * hsl() is exact from one decimal place, so it never needed this; oklch's
   * chroma runs 0-0.4, which puts three decimal places at about a quarter of
   * the resolution the same digits give hsl. One shared control still makes
   * sense - two would be a worse panel for a problem the higher default
   * already solves - but its default has to serve the notation that needs
   * more.
   */
  precision: z.number().int().min(0).max(6).default(4),
});

export type ColorOptions = z.output<typeof colorOptionsSchema>;

export const colorDefaultOptions: ColorOptions = colorOptionsSchema.parse({});

export const colorOptionFields: readonly OptionField<ColorOptions>[] = [
  {
    key: 'target',
    label: 'Convert to',
    control: 'select',
    choices: [
      { value: 'hex', label: 'Hex' },
      { value: 'rgb', label: 'rgb()' },
      { value: 'hsl', label: 'hsl()' },
      { value: 'oklch', label: 'oklch()' },
    ],
  },
  {
    key: 'precision',
    label: 'Decimal places',
    description:
      'Applies to hsl() and oklch(). Hex and rgb() are whole numbers by definition. Below four, oklch() stops round-tripping.',
    control: 'number',
    min: 0,
    max: 6,
    step: 1,
  },
];
