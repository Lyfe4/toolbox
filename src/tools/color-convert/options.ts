import type { OptionField } from '@/features/registry/types';
import { z } from '@/lib/zod';

import { COLOR_FORMATS } from './color';

export const colorOptionsSchema = z.object({
  target: z.enum(COLOR_FORMATS).default('hex'),
  /**
   * Decimal places for the notations that carry fractions. Hex and rgb() are
   * integer-quantised and ignore it, which the field description says.
   */
  precision: z.number().int().min(0).max(6).default(3),
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
    description: 'Applies to hsl() and oklch(). Hex and rgb() are whole numbers by definition.',
    control: 'number',
    min: 0,
    max: 6,
    step: 1,
  },
];
