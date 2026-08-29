import type { OptionField } from '@/features/registry/types';
import { z } from '@/lib/zod';

export const diffOptionsSchema = z.object({
  ignoreWhitespace: z.boolean().default(false),
  ignoreCase: z.boolean().default(false),
  /** Word-level highlighting within lines that were edited rather than replaced. */
  refineWords: z.boolean().default(true),
  /** Unchanged lines kept around each change in the unified output. */
  context: z.number().int().min(0).max(20).default(3),
});

export type DiffOptions = z.output<typeof diffOptionsSchema>;

export const diffDefaultOptions: DiffOptions = diffOptionsSchema.parse({});

export const diffOptionFields: readonly OptionField<DiffOptions>[] = [
  {
    key: 'ignoreWhitespace',
    label: 'Ignore whitespace',
    description: 'Treat lines that differ only in spacing as unchanged.',
    control: 'toggle',
  },
  {
    key: 'ignoreCase',
    label: 'Ignore case',
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
