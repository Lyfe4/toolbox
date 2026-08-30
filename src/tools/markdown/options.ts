import type { OptionField } from '@/features/registry/types';
import { z } from '@/lib/zod';

/**
 * Every field has a `.default()`, which is what makes `markdownDefaultOptions`
 * one call rather than a hand-maintained copy of the schema.
 *
 * WHICH OPTIONS APPLY WHEN. This tool runs in two directions and most options
 * only mean something in one of them:
 *
 *   - `headingIds` and `linkify` describe how HTML is GENERATED, so they apply
 *     to markdown → html.
 *   - `bullet`, `emphasis`, `strong`, `fence`, `headingStyle` and
 *     `unsupported` describe how MARKDOWN is WRITTEN, so they apply to
 *     html → markdown.
 *
 * They are all present in both directions rather than hidden, because the
 * options panel renders a flat list and a control that appears and disappears
 * as you flip a switch is harder to reason about than one that is simply
 * inert. Each label says which direction it governs.
 */
export const markdownOptionsSchema = z.object({
  direction: z.enum(['md-to-html', 'html-to-md']).default('md-to-html'),

  /* --- Markdown → HTML ------------------------------------------------- */
  headingIds: z.boolean().default(true),
  linkify: z.boolean().default(true),

  /* --- HTML → Markdown ------------------------------------------------- */
  bullet: z.enum(['-', '*', '+']).default('-'),
  emphasis: z.enum(['_', '*']).default('_'),
  strong: z.enum(['*', '_']).default('*'),
  fence: z.enum(['`', '~']).default('`'),
  headingStyle: z.enum(['atx', 'setext']).default('atx'),
  unsupported: z.enum(['keep', 'text', 'drop']).default('keep'),
});

/**
 * `z.output<typeof schema>` is the type AFTER parsing, so every default has
 * been applied and every field is present. `z.input` would leave them optional.
 */
export type MarkdownOptions = z.output<typeof markdownOptionsSchema>;

export const markdownDefaultOptions: MarkdownOptions = markdownOptionsSchema.parse({});

export const markdownOptionFields: readonly OptionField<MarkdownOptions>[] = [
  {
    key: 'direction',
    label: 'Direction',
    control: 'select',
    choices: [
      { value: 'md-to-html', label: 'Markdown → HTML' },
      { value: 'html-to-md', label: 'HTML → Markdown' },
    ],
  },
  {
    key: 'headingIds',
    label: 'Heading ids (→ HTML)',
    control: 'toggle',
    description:
      'Adds an id to every heading so it can be linked to. Prefixed user-content- to stop author ids clobbering globals.',
  },
  {
    key: 'linkify',
    label: 'Link bare URLs (→ HTML)',
    control: 'toggle',
    description: 'GitHub turns a bare https:// or www. into a link. Off leaves it as text.',
  },
  {
    key: 'bullet',
    label: 'Bullet marker (→ Markdown)',
    control: 'select',
    choices: [
      { value: '-', label: '- hyphen' },
      { value: '*', label: '* asterisk' },
      { value: '+', label: '+ plus' },
    ],
  },
  {
    key: 'emphasis',
    label: 'Emphasis delimiter (→ Markdown)',
    control: 'select',
    choices: [
      { value: '_', label: '_underscore_' },
      { value: '*', label: '*asterisk*' },
    ],
  },
  {
    key: 'strong',
    label: 'Strong delimiter (→ Markdown)',
    control: 'select',
    choices: [
      { value: '*', label: '**asterisks**' },
      { value: '_', label: '__underscores__' },
    ],
  },
  {
    key: 'fence',
    label: 'Code fence (→ Markdown)',
    control: 'select',
    choices: [
      { value: '`', label: '``` backticks' },
      { value: '~', label: '~~~ tildes' },
    ],
  },
  {
    key: 'headingStyle',
    label: 'Heading style (→ Markdown)',
    control: 'select',
    choices: [
      { value: 'atx', label: '# ATX' },
      { value: 'setext', label: 'Setext underline' },
    ],
    description: 'Setext can only express two levels, so h3 and below stay ATX regardless.',
  },
  {
    key: 'unsupported',
    label: 'Markup Markdown cannot express (→ Markdown)',
    control: 'select',
    choices: [
      { value: 'keep', label: 'Keep as inline HTML' },
      { value: 'text', label: 'Keep the text, drop the tag' },
      { value: 'drop', label: 'Drop it entirely' },
    ],
  },
];
