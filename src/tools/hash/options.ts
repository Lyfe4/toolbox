import type { OptionField } from '@/features/registry/types';
import { z } from '@/lib/zod';

import { HASH_ALGORITHMS } from './digest';

export const hashOptionsSchema = z.object({
  algorithm: z.enum(HASH_ALGORITHMS).default('sha-256'),
  encoding: z.enum(['hex', 'base64']).default('hex'),
  outputCase: z.enum(['lower', 'upper']).default('lower'),
});

export type HashOptions = z.output<typeof hashOptionsSchema>;

export const hashDefaultOptions: HashOptions = hashOptionsSchema.parse({});

export const hashOptionFields: readonly OptionField<HashOptions>[] = [
  {
    key: 'algorithm',
    label: 'Algorithm',
    description: 'MD5 and SHA-1 are broken for security. Use them only for checksums.',
    control: 'select',
    choices: [
      { value: 'md5', label: 'MD5 (broken)' },
      { value: 'sha-1', label: 'SHA-1 (broken)' },
      { value: 'sha-256', label: 'SHA-256' },
      { value: 'sha-384', label: 'SHA-384' },
      { value: 'sha-512', label: 'SHA-512' },
    ],
  },
  {
    key: 'encoding',
    label: 'Output encoding',
    control: 'select',
    choices: [
      { value: 'hex', label: 'Hexadecimal' },
      { value: 'base64', label: 'Base64' },
    ],
  },
  {
    key: 'outputCase',
    label: 'Case',
    description: 'Applies to hex only. Base64 is case-significant and never folded.',
    control: 'select',
    choices: [
      { value: 'lower', label: 'Lowercase' },
      { value: 'upper', label: 'Uppercase' },
    ],
  },
];
