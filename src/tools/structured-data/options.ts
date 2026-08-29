import { z } from 'zod';

import type { OptionField } from '@/features/registry/types';

import { DELIMITERS, FORMATS } from './convert';

export const structuredDataOptionsSchema = z.object({
  source: z.enum(['auto', ...FORMATS]).default('auto'),
  target: z.enum(FORMATS).default('json'),
  indent: z.number().int().min(0).max(8).default(2),
  delimiter: z
    .enum(Object.keys(DELIMITERS) as [keyof typeof DELIMITERS, ...(keyof typeof DELIMITERS)[]])
    .default('comma'),
  sortKeys: z.boolean().default(false),
});

export type StructuredDataOptions = z.output<typeof structuredDataOptionsSchema>;

export const structuredDataDefaultOptions: StructuredDataOptions =
  structuredDataOptionsSchema.parse({});

export const structuredDataOptionFields: readonly OptionField<StructuredDataOptions>[] = [
  {
    key: 'source',
    label: 'Source format',
    description: 'Auto-detect tries JSON, then delimited text, then YAML.',
    control: 'select',
    choices: [
      { value: 'auto', label: 'Auto-detect' },
      { value: 'json', label: 'JSON' },
      { value: 'yaml', label: 'YAML' },
      { value: 'csv', label: 'CSV' },
      { value: 'tsv', label: 'TSV' },
    ],
  },
  {
    key: 'target',
    label: 'Target format',
    control: 'select',
    choices: [
      { value: 'json', label: 'JSON' },
      { value: 'yaml', label: 'YAML' },
      { value: 'csv', label: 'CSV' },
      { value: 'tsv', label: 'TSV' },
    ],
  },
  {
    key: 'delimiter',
    label: 'CSV delimiter',
    description: 'Used for CSV only. TSV is always tab-separated.',
    control: 'select',
    choices: [
      { value: 'comma', label: 'Comma' },
      { value: 'semicolon', label: 'Semicolon' },
      { value: 'tab', label: 'Tab' },
      { value: 'pipe', label: 'Pipe' },
    ],
  },
  {
    key: 'indent',
    label: 'Indent',
    description: 'Spaces per level for JSON and YAML. 0 makes JSON compact.',
    control: 'number',
    min: 0,
    max: 8,
    step: 1,
  },
  {
    key: 'sortKeys',
    label: 'Sort keys',
    description: 'Sort object keys alphabetically, recursively. Array order is kept.',
    control: 'toggle',
  },
];
