import type { OptionField } from '@/features/registry/types';
import { z } from '@/lib/zod';

import { SOURCE_FORMATS, TARGET_FORMATS } from './detect';

/**
 * `source` and `target`, the same shape as the structured-data tool, so the
 * pair reads as one idea rather than two tools that happen to sit together.
 *
 * Plain text is a TARGET only. See the tool's README - text has no structure
 * to read, so text-as-a-source would be escape-and-wrap, a different operation
 * wearing the same control.
 */
export const textConvertOptionsSchema = z.object({
  source: z.enum(['auto', ...SOURCE_FORMATS]).default('auto'),
  target: z.enum(TARGET_FORMATS).default('html'),

  /* --- Producing HTML ---------------------------------------------------- */
  headingIds: z.boolean().default(true),
  linkify: z.boolean().default(true),

  /* --- Producing Markdown ------------------------------------------------ */
  bullet: z.enum(['-', '*', '+']).default('-'),
  emphasis: z.enum(['_', '*']).default('_'),
  strong: z.enum(['*', '_']).default('*'),
  fence: z.enum(['`', '~']).default('`'),
  headingStyle: z.enum(['atx', 'setext']).default('atx'),
  /*
   * THE ONE DEFAULT THE MERGE HAD TO PICK. `markdown` defaulted this to
   * `keep`, `html-text` to `text`, and one tool cannot have two.
   *
   * `text` wins, on the evidence. `keep` sounds like the safe choice - it
   * preserves markup Markdown cannot express - but a `<div>` is markup
   * Markdown cannot express, and keeping an element means writing it out
   * VERBATIM, subtree and all. Real pasted HTML is usually wrapped in one, so
   * `keep` turns the commonest input into a document that converts to itself.
   * A default that can silently no-op is worse than one that unwraps a
   * container it was never asked to keep, and `keep` is one control away.
   */
  unsupported: z.enum(['keep', 'text', 'drop']).default('text'),

  /* --- Producing plain text ---------------------------------------------- */
  keepLinkUrls: z.boolean().default(true),
  listMarker: z.enum(['-', '*', 'none']).default('-'),
  tables: z.enum(['rows', 'drop']).default('rows'),
});

export type TextConvertOptions = z.output<typeof textConvertOptionsSchema>;

export const textConvertDefaultOptions: TextConvertOptions = textConvertOptionsSchema.parse({});

/**
 * VISIBILITY IS A FUNCTION OF `target`, AND OF NOTHING ELSE.
 *
 * This is the whole answer to the panel-stability problem. Every conditional
 * option here is an output setting - how to write HTML, how to write Markdown,
 * how to write text - so each one belongs to exactly one target format. That
 * gives three possible layouts instead of a combinatorial number, and the
 * panel only ever changes shape when the user deliberately changes the target.
 * Toggling "linkify" or picking a different bullet never reflows anything.
 *
 * `source` is deliberately NOT part of any predicate, even though it would be
 * defensible: with `target: 'markdown'`, a Markdown source is a reformat and
 * an HTML source is a conversion, but they write Markdown the same way. Making
 * the panel depend on two controls instead of one would double the layouts for
 * no gain.
 *
 * The old labels carried "(→ Markdown)" suffixes because every option was
 * always visible and had to say when it applied. They are gone: a control that
 * only appears when it applies does not need to explain that it applies.
 */
const whenTarget =
  (target: TextConvertOptions['target']) =>
  (options: TextConvertOptions): boolean =>
    options.target === target;

export const textConvertOptionFields: readonly OptionField<TextConvertOptions>[] = [
  {
    key: 'source',
    label: 'Source format',
    description:
      'Auto-detect looks for HTML tags first, then Markdown syntax, and says what it found.',
    control: 'select',
    choices: [
      { value: 'auto', label: 'Auto-detect' },
      { value: 'markdown', label: 'Markdown' },
      { value: 'html', label: 'HTML' },
    ],
  },
  {
    key: 'target',
    label: 'Target format',
    /*
     * The description exists because the list used to read as though plain
     * text COMPETED with rich text - as though picking it were how you got
     * something to paste into a document. It is the opposite: it is the one
     * that throws the formatting away. Rich text is not a format at all here,
     * it is an action on the HTML output, so the list has to say where it
     * lives rather than leaving people to find it.
     */
    description: 'Rich text is not a target: it is what the rendered HTML output copies as.',
    control: 'select',
    choices: [
      { value: 'html', label: 'HTML' },
      { value: 'markdown', label: 'Markdown' },
      // Named for what it DOES. "Plain text" alone reads like a peer of the
      // other two rather than like the destructive one.
      { value: 'text', label: 'Plain text (strip formatting)' },
    ],
  },

  /* --- HTML ------------------------------------------------------------- */
  {
    key: 'headingIds',
    label: 'Heading ids',
    control: 'toggle',
    description:
      'Adds an id to every heading so it can be linked to. Namespaced user-content- so author ids cannot shadow globals.',
    when: whenTarget('html'),
  },
  {
    key: 'linkify',
    label: 'Link bare URLs',
    control: 'toggle',
    description: 'GitHub turns a bare https:// or www. into a link. Off leaves it as text.',
    when: whenTarget('html'),
  },

  /* --- Markdown --------------------------------------------------------- */
  {
    key: 'bullet',
    label: 'Bullet marker',
    control: 'select',
    choices: [
      { value: '-', label: '- hyphen' },
      { value: '*', label: '* asterisk' },
      { value: '+', label: '+ plus' },
    ],
    when: whenTarget('markdown'),
  },
  {
    key: 'emphasis',
    label: 'Emphasis delimiter',
    control: 'select',
    choices: [
      { value: '_', label: '_underscore_' },
      { value: '*', label: '*asterisk*' },
    ],
    when: whenTarget('markdown'),
  },
  {
    key: 'strong',
    label: 'Strong delimiter',
    control: 'select',
    choices: [
      { value: '*', label: '**asterisks**' },
      { value: '_', label: '__underscores__' },
    ],
    when: whenTarget('markdown'),
  },
  {
    key: 'fence',
    label: 'Code fence',
    control: 'select',
    choices: [
      { value: '`', label: '``` backticks' },
      { value: '~', label: '~~~ tildes' },
    ],
    when: whenTarget('markdown'),
  },
  {
    key: 'headingStyle',
    label: 'Heading style',
    control: 'select',
    choices: [
      { value: 'atx', label: '# ATX' },
      { value: 'setext', label: 'Setext underline' },
    ],
    description: 'Setext can only express two levels, so h3 and below stay ATX regardless.',
    when: whenTarget('markdown'),
  },
  {
    key: 'unsupported',
    label: 'Markup Markdown cannot express',
    control: 'select',
    choices: [
      { value: 'keep', label: 'Keep as inline HTML' },
      { value: 'text', label: 'Keep the text, drop the tag' },
      { value: 'drop', label: 'Drop it entirely' },
    ],
    when: whenTarget('markdown'),
  },

  /* --- Plain text -------------------------------------------------------- */
  {
    key: 'keepLinkUrls',
    label: 'Keep link URLs',
    control: 'toggle',
    description: 'Writes the URL in brackets after the link text, when it adds something.',
    when: whenTarget('text'),
  },
  {
    key: 'listMarker',
    label: 'List marker',
    control: 'select',
    choices: [
      { value: '-', label: '- hyphen' },
      { value: '*', label: '* asterisk' },
      { value: 'none', label: 'None' },
    ],
    when: whenTarget('text'),
  },
  {
    key: 'tables',
    label: 'Tables',
    control: 'select',
    choices: [
      { value: 'rows', label: 'Tab-separated rows' },
      { value: 'drop', label: 'Drop them' },
    ],
    description: 'Tab-separated because that is what survives a paste into a spreadsheet.',
    when: whenTarget('text'),
  },
];
