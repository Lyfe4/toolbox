import type { OptionField } from '@/features/registry/types';
import { z } from '@/lib/zod';

/**
 * The whitespace option was a boolean, and its label - "treat lines that
 * differ only in spacing as unchanged" - described something it did not do.
 * jsdiff's `ignoreWhitespace` trims each line; `foo   bar` against `foo bar`
 * was still a change. Two different behaviours are wanted often enough that
 * one toggle could not honestly cover them, so this is now a three-way choice
 * matching what `diff` and `git diff` actually offer.
 *
 * THE KEY DID NOT CHANGE, deliberately. Tool options travel in saved canvases
 * and in share links, and a renamed key silently drops back to its default -
 * so someone's link would quietly start comparing whitespace again. The
 * preprocess maps the old boolean onto the new values, which makes every
 * existing link keep meaning what it meant. `ignoreWhitespace: 'none'` reads
 * a little oddly in the schema; a stale share link reading a little oddly on
 * screen would be worse.
 */
const whitespace = z.preprocess(
  (value) => (value === true ? 'trailing' : value === false ? 'none' : value),
  z.enum(['none', 'trailing', 'all']),
);

export const diffOptionsSchema = z.object({
  ignoreWhitespace: whitespace.default('none'),
  ignoreCase: z.boolean().default(false),
  /** Word-level highlighting within lines that were edited rather than replaced. */
  refineWords: z.boolean().default(true),
  /**
   * Unchanged lines kept around each change - in the unified output, and in
   * the rendered view, which collapses the runs the patch would have omitted.
   */
  context: z.number().int().min(0).max(20).default(3),
});

export type DiffOptions = z.output<typeof diffOptionsSchema>;

export const diffDefaultOptions: DiffOptions = diffOptionsSchema.parse({});

export const diffOptionFields: readonly OptionField<DiffOptions>[] = [
  {
    key: 'ignoreWhitespace',
    label: 'Whitespace',
    description:
      'Leading and trailing covers indentation and trailing spaces. All whitespace also ignores spacing inside a line, which can hide a real change.',
    control: 'select',
    choices: [
      { value: 'none', label: 'Compare it' },
      { value: 'trailing', label: 'Ignore leading and trailing' },
      { value: 'all', label: 'Ignore all whitespace' },
    ],
  },
  {
    key: 'ignoreCase',
    label: 'Ignore case',
    description: 'Compares case-insensitively. The output is never case-folded.',
    control: 'toggle',
  },
  {
    key: 'refineWords',
    label: 'Highlight changed words',
    description: 'Marks the changed words within a line that was edited rather than replaced.',
    control: 'toggle',
  },
  {
    key: 'context',
    label: 'Context lines',
    description: 'Unchanged lines shown either side of each change.',
    control: 'number',
    min: 0,
    max: 20,
    step: 1,
  },
];
