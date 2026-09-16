import type { OptionField } from '@/features/registry/types';
import { z } from '@/lib/zod';

import { COLOR_FORMATS } from './color';

/**
 * The most decimal places the panel will offer.
 *
 * A named constant because the TEST for the option's range needs the same
 * number, and reading it back off a Zod schema is not something Zod promises.
 * A test that hard-codes a bound is a test that stops guarding it the day the
 * bound moves - which is exactly what the property test this replaced did with
 * the number six.
 */
export const MAX_PRECISION = 6;

export const colorOptionsSchema = z.object({
  target: z.enum(COLOR_FORMATS).default('hex'),
  /**
   * Decimal places for the notations that carry fractions. Hex and rgb() are
   * integer-quantised and ignore it, which the field description says.
   *
   * FIVE, AND THE NUMBER IS MEASURED OVER THE WHOLE CUBE RATHER THAN OVER A
   * CORPUS.
   *
   * It was four, and four was measured too - over 266 colours: this
   * repository's own primitives, every hex literal in the CSS shipped in
   * node_modules, and the six sRGB corners, written as oklch() at each
   * precision and read back both by this tool's parser and by painting them in
   * Firefox and sampling the pixel. Nothing in that corpus failed at four, and
   * the conclusion drawn from it - that four round-trips - was wrong.
   *
   * All 16,777,216 sRGB colours, written as oklch() and read back:
   *
   *     precision   colours that come back a different colour
   *             3                                  3,532,330
   *             4                                     13,626
   *             5                                          0
   *             6                                          0
   *
   * The 13,626 are not scattered. They are saturated cyans and teals with the
   * red channel pinned at 0 - `#00bec7` writes as `oklch(0.729 0.1239 200.83)`
   * and reads back `#01bec7` - which is exactly the shape a 266-colour corpus
   * is least likely to hold and a randomised property test least likely to
   * hit. 13,626 of 16.7 million is one colour in 1,231, so a 400-case run
   * finds one about 28% of the time: `round-trips every notation exactly at
   * the default precision` had been failing roughly one run in four, at the
   * fourth decimal place of a cyan, for as long as the default was four -
   * which is a lottery rather than a test, and is why the replacement sweeps a
   * fixed stride through the cube instead.
   *
   * hsl() is exact from one decimal place and rgb() and hex are integers, so
   * this is oklch's requirement alone; oklch's chroma runs 0-0.4, which puts
   * the same digit count at about a quarter of the resolution it gives hsl.
   * One shared control is still the right panel - two would be a worse one for
   * a problem the higher default solves outright - but its default has to
   * serve the notation that needs most.
   */
  precision: z.number().int().min(0).max(MAX_PRECISION).default(5),
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
      'Applies to hsl() and oklch(). Hex and rgb() are whole numbers by definition. Below five, oklch() stops round-tripping.',
    control: 'number',
    min: 0,
    max: 6,
    step: 1,
  },
];
