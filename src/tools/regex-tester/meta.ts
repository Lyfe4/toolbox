import type { ToolManifestEntry } from '@/features/registry/types';

/**
 * What the rest of the app knows about this tool without loading its code:
 * the manifest imports this file eagerly and `index.ts` spreads it into the
 * definition, so the two cannot disagree. Data only - no import may bring
 * code into the initial bundle (`registry.test.ts` holds that).
 */
export const regexTesterMeta = {
  id: 'regex-tester',
  name: 'Regex',
  summary: 'Test a regular expression against text, with groups and replacement.',
  category: 'text',
  keywords: ['regexp', 'pattern', 'match', 'replace', 'capture group'],

  inputs: [
    {
      id: 'input',
      label: 'Subject',
      /*
       * Bytes as well as text, because a log file is the canonical subject for
       * a regular expression and a file is bytes.
       *
       * The gap this closes was between the two routes rather than inside
       * either: the tool PAGE has always accepted a dropped log file, because
       * the runner decodes a text-sniffed file before handing it over. On the
       * canvas the same file arriving through a base64 decode could not be
       * wired in at all, since `bytes` and `text` do not overlap. One tool that
       * accepts a file in one place and refuses it in the other is the kind of
       * drift this audit exists to find.
       *
       * Decoded strictly, so a PNG on this port says it is not text instead of
       * being searched as mojibake and reporting matches at offsets into
       * characters nobody wrote.
       */
      types: ['text', 'bytes'],
      required: true,
      description: 'The text to search, or a text file. The pattern itself is an option.',
    },
  ],

  outputs: [
    {
      id: 'output',
      label: 'Result',
      types: ['text'],
      description: 'The replaced text, or a list of matches with their offsets.',
      /*
       * The count, because the first line of this port cannot carry it. In
       * match mode it is the first row of a listing that may have been cut
       * short; in replace mode a pattern that matched NOTHING returns the
       * subject unchanged, which on a node's face is indistinguishable from a
       * replacement that worked.
       */
      measuredBy: 'matches',
    },
    {
      id: 'matches',
      label: 'Matches',
      types: ['json'],
      description: 'Pattern, flags, every match with its groups, and the risk notes.',
      // The structured output IS the view model, the same bargain the diff
      // tool makes: one payload, rendered as a highlight here and readable as
      // plain JSON anywhere else.
      presentation: 'regex',
    },
  ],

  execution: {
    strategy: 'worker',
    requiresOffscreenCanvas: false,
    /*
     * Two seconds. Short on purpose: measured, every honest pattern tried
     * against the largest subject this tool accepts - two million characters
     * of Apache log - finishes in under 25 ms, so a run that reaches two
     * seconds is overwhelmingly a backtracking blow-up rather than honest
     * work. Waiting thirty seconds to say so would just be thirty seconds of
     * a dead tab.
     */
    timeoutMs: 2_000,
    timeoutMessage:
      'That pattern is too slow on this input and was stopped. It is almost certainly backtracking catastrophically - nested quantifiers like (a+)+ are the usual cause.',
    maxInputBytes: 4 * 1024 * 1024,
  },
} as const satisfies ToolManifestEntry;
