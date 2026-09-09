import type { OptionField } from '@/features/registry/types';
import { z } from '@/lib/zod';

export const regexOptionsSchema = z.object({
  /** The pattern itself, without delimiters. */
  pattern: z.string().max(4_096).default(''),
  mode: z.enum(['match', 'replace']).default('match'),
  /** Used only in replace mode. `$1`, `$<name>`, `$&`, `` $` `` and `$'` work. */
  replacement: z.string().max(4_096).default(''),
  global: z.boolean().default(true),
  ignoreCase: z.boolean().default(false),
  multiline: z.boolean().default(false),
  dotAll: z.boolean().default(false),
  /**
   * `u` and `v` are MUTUALLY EXCLUSIVE - `new RegExp('a', 'uv')` throws - so
   * they are one choice rather than two toggles. Two checkboxes that cannot
   * both be ticked is a state the user can enter and then has to be told off
   * for; a select cannot represent it at all.
   *
   * The union is a MIGRATION, not indecision. This option used to be a plain
   * boolean, and options travel in share links and in the saved canvas - so a
   * link made before `v` existed still carries `unicode: true`. Zod strips
   * keys it does not recognise, which would have turned that into a silently
   * missing flag: the same pattern, quietly matching different text. Reading
   * the old spelling costs one line and removes the whole class of complaint.
   */
  unicode: z
    .union([
      z.enum(['none', 'u', 'v']),
      z.boolean().transform((on) => (on ? ('u' as const) : ('none' as const))),
    ])
    .default('none'),
  sticky: z.boolean().default(false),
});

export type RegexOptions = z.output<typeof regexOptionsSchema>;

export const regexDefaultOptions: RegexOptions = regexOptionsSchema.parse({});

/**
 * Assembles the flag string from the individual toggles.
 *
 * This is the USER's flag string, and it is what error messages and notes
 * talk about. The `d` flag this tool adds for itself is added at compile
 * time and deliberately never appears here - it changes nothing about what
 * matches, and offering it as a toggle would be offering a switch with no
 * observable effect.
 */
export function flagsFor(options: RegexOptions): string {
  return [
    options.global ? 'g' : '',
    options.ignoreCase ? 'i' : '',
    options.multiline ? 'm' : '',
    options.dotAll ? 's' : '',
    options.unicode === 'none' ? '' : options.unicode,
    options.sticky ? 'y' : '',
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
    description: '$1 for a group, $<name> for a named group, $& for the match, $$ for a dollar.',
    control: 'text',
    placeholder: '$1',
    // Shown only in replace mode. The value survives being hidden, so
    // switching to match mode and back does not lose what was typed.
    when: (options) => options.mode === 'replace',
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
    label: 'Unicode',
    description:
      'u reads the pattern as code points and enables \\p{...}. v adds set operations inside [...] and properties that match more than one character.',
    control: 'select',
    choices: [
      { value: 'none', label: 'Off' },
      { value: 'u', label: 'Unicode (u)' },
      { value: 'v', label: 'Unicode sets (v)' },
    ],
  },
  {
    key: 'sticky',
    label: 'Sticky (y)',
    description:
      'The match must start exactly where the last one ended, so matches have to be consecutive from the start.',
    control: 'toggle',
  },
];
