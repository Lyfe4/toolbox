import type { OptionField } from '@/features/registry/types';
import { z } from '@/lib/zod';

export const regexOptionsSchema = z.object({
  /** The pattern itself, without delimiters. */
  pattern: z.string().max(4_096).default(''),
  mode: z.enum(['match', 'replace']).default('match'),
  /** Used only in replace mode. `$1`, `$<name>` and `$&` all work. */
  replacement: z.string().max(4_096).default(''),
  global: z.boolean().default(true),
  ignoreCase: z.boolean().default(false),
  multiline: z.boolean().default(false),
  dotAll: z.boolean().default(false),
  unicode: z.boolean().default(false),
});

export type RegexOptions = z.output<typeof regexOptionsSchema>;

export const regexDefaultOptions: RegexOptions = regexOptionsSchema.parse({});

/** Assembles the flag string from the individual toggles. */
export function flagsFor(options: RegexOptions): string {
  return [
    options.global ? 'g' : '',
    options.ignoreCase ? 'i' : '',
    options.multiline ? 'm' : '',
    options.dotAll ? 's' : '',
    options.unicode ? 'u' : '',
  ].join('');
}

export const regexOptionFields: readonly OptionField<RegexOptions>[] = [
  {
    key: 'pattern',
    label: 'Pattern',
    description: 'Written without slashes. Flags are the toggles below.',
    control: 'text',
    placeholder: '\\b\\w+@\\w+\\.\\w+\\b',
  },
  {
    key: 'mode',
    label: 'Mode',
    control: 'select',
    choices: [
      { value: 'match', label: 'Find matches' },
      { value: 'replace', label: 'Replace' },
    ],
  },
  {
    key: 'replacement',
    label: 'Replacement',
    description: 'Replace mode only. $1 for a group, $<name> for a named group, $& for the match.',
    control: 'text',
    placeholder: '$1',
  },
  {
    key: 'global',
    label: 'Global (g)',
    description: 'Find every match, not just the first.',
    control: 'toggle',
  },
  { key: 'ignoreCase', label: 'Ignore case (i)', control: 'toggle' },
  {
    key: 'multiline',
    label: 'Multiline (m)',
    description: '^ and $ match at each line break rather than only at the ends.',
    control: 'toggle',
  },
  { key: 'dotAll', label: 'Dot matches newline (s)', control: 'toggle' },
  {
    key: 'unicode',
    label: 'Unicode (u)',
    description: 'Treats the pattern as code points and enables \\p{...} property escapes.',
    control: 'toggle',
  },
];
