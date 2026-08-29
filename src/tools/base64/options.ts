import { z } from 'zod';

import type { OptionField } from '@/features/registry/types';

/**
 * Every field has a `.default()`, which is what makes `defaultOptions` below a
 * single call rather than a hand-maintained duplicate of the schema.
 */
export const base64OptionsSchema = z.object({
  mode: z.enum(['encode', 'decode']).default('encode'),
  urlSafe: z.boolean().default(false),
  padding: z.boolean().default(true),
  wrapAt: z.number().int().min(0).max(200).default(0),
});

/**
 * `z.output<typeof schema>` is the type AFTER parsing, so the defaults have
 * been applied and every field is present. `z.input` would make them optional.
 */
export type Base64Options = z.output<typeof base64OptionsSchema>;

export const base64DefaultOptions: Base64Options = base64OptionsSchema.parse({});

export const base64OptionFields: readonly OptionField<Base64Options>[] = [
  {
    key: 'mode',
    label: 'Mode',
    control: 'select',
    choices: [
      { value: 'encode', label: 'Encode' },
      { value: 'decode', label: 'Decode' },
    ],
  },
  {
    key: 'urlSafe',
    label: 'URL-safe alphabet',
    description: 'Use - and _ instead of + and /. Decoding accepts both either way.',
    control: 'toggle',
  },
  {
    key: 'padding',
    label: 'Padding',
    description: 'Append = characters so the output length is a multiple of four.',
    control: 'toggle',
  },
  {
    key: 'wrapAt',
    label: 'Wrap at column',
    description: '0 for a single line. 64 for PEM, 76 for MIME.',
    control: 'number',
    min: 0,
    max: 200,
    step: 4,
  },
];
