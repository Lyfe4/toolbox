import type { OptionField } from '@/features/registry/types';
import { z } from '@/lib/zod';

/**
 * `mode` picks the target; the rest are the settings for whichever target is
 * selected. As with the markdown tool, controls for the other mode stay
 * visible rather than appearing and disappearing - the panel is a flat list,
 * and every label says which mode it governs.
 */
export const htmlTextOptionsSchema = z.object({
  mode: z.enum(['markdown', 'text']).default('markdown'),

  /* --- HTML → Markdown -------------------------------------------------- */
  bullet: z.enum(['-', '*', '+']).default('-'),
  emphasis: z.enum(['_', '*']).default('_'),
  fence: z.enum(['`', '~']).default('`'),
  unsupported: z.enum(['keep', 'text', 'drop']).default('text'),

  /* --- HTML → plain text ------------------------------------------------ */
  keepLinkUrls: z.boolean().default(true),
  listMarker: z.enum(['-', '*', 'none']).default('-'),
  tables: z.enum(['rows', 'drop']).default('rows'),
});

export type HtmlTextOptions = z.output<typeof htmlTextOptionsSchema>;

export const htmlTextDefaultOptions: HtmlTextOptions = htmlTextOptionsSchema.parse({});

export const htmlTextOptionFields: readonly OptionField<HtmlTextOptions>[] = [
  {
    key: 'mode',
    label: 'Convert to',
    control: 'select',
    choices: [
      { value: 'markdown', label: 'Markdown' },
      { value: 'text', label: 'Plain text' },
    ],
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
    key: 'fence',
    label: 'Code fence (→ Markdown)',
    control: 'select',
    choices: [
      { value: '`', label: '``` backticks' },
      { value: '~', label: '~~~ tildes' },
    ],
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
  {
    key: 'keepLinkUrls',
    label: 'Keep link URLs (→ text)',
    control: 'toggle',
    description: 'Writes the URL in brackets after the link text, when it adds anything.',
  },
  {
    key: 'listMarker',
    label: 'List marker (→ text)',
    control: 'select',
    choices: [
      { value: '-', label: '- hyphen' },
      { value: '*', label: '* asterisk' },
      { value: 'none', label: 'None' },
    ],
  },
  {
    key: 'tables',
    label: 'Tables (→ text)',
    control: 'select',
    choices: [
      { value: 'rows', label: 'Tab-separated rows' },
      { value: 'drop', label: 'Drop them' },
    ],
    description: 'Tab-separated because that is what survives a paste into a spreadsheet.',
  },
];
