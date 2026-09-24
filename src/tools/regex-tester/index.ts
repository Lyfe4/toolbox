import {
  defineTool,
  eraseTool,
  ok,
  type ErasedTool,
  type JsonValue,
} from '@/features/registry/types';
import { decodeDocument, hasByteOrderMark } from '@/lib/text';

import { diagnose, type Diagnosis, type Note } from './diagnose';
import { flagsFor, regexDefaultOptions, regexOptionFields, regexOptionsSchema } from './options';
import { capturingGroupNames, parsePattern } from './pattern';
import { compilePattern, DEFAULT_LIMITS, runRegex, toJson, toSummary } from './run';

/**
 * Test a regular expression against some text.
 *
 * Runs in a worker with a short timeout, because a user-supplied pattern can
 * backtrack catastrophically and there is no way to interrupt the engine from
 * inside. See the long note at the top of run.ts. `timeoutMessage` is what the
 * user sees when that fires, and it names the real cause.
 *
 * The other half of the tool is the part that runs AFTER the match: a pattern
 * that found nothing is the case people actually bring here, and "0 matches"
 * on its own is not an answer. See diagnose.ts.
 */
export const regexTesterTool = defineTool({
  id: 'regex-tester',
  name: 'Regex',
  summary: 'Test a regular expression against text, with groups and replacement.',
  category: 'text',

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

  optionsSchema: regexOptionsSchema,
  defaultOptions: regexDefaultOptions,
  optionFields: regexOptionFields,

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

  run: ({ inputs, options }) => {
    const arrived = inputs.input;
    const subject = arrived.type === 'text' ? ok(arrived.text) : decodeDocument(arrived.bytes);
    if (!subject.ok) return subject;
    /*
     * The decoder removes a byte order mark and the box keeps one, so the same
     * file has two subjects depending on how it arrived. Every other document
     * port says so; this one did not, and the matrix said it did.
     */
    const removedMark = arrived.type === 'bytes' && hasByteOrderMark(arrived.bytes);

    const flags = flagsFor(options);
    const compiled = compilePattern(options.pattern, flags);
    if (!compiled.ok) return compiled;

    // Parsed for the group NAMES, which `match.groups` cannot supply by
    // number. A pattern the reader cannot parse still runs; it just gets an
    // unnamed listing, because the engine has already agreed it is valid.
    const parsed = parsePattern(options.pattern, options.unicode === 'v');
    const names = parsed.ok ? capturingGroupNames(parsed.value) : [];

    const startedAt = DEFAULT_LIMITS.now();
    const report = runRegex(
      compiled.value,
      subject.value,
      options.mode === 'replace' ? options.replacement : null,
      DEFAULT_LIMITS,
      names,
    );
    const elapsedMs = DEFAULT_LIMITS.now() - startedAt;

    const diagnosed = diagnose({
      pattern: options.pattern,
      flags,
      subject: subject.value,
      report,
      mode: options.mode,
      replacement: options.replacement,
      elapsedMs,
    });
    const diagnosis: Diagnosis = removedMark
      ? { ...diagnosed, notes: [MARK_REMOVED, ...diagnosed.notes] }
      : diagnosed;

    return ok({
      output: {
        type: 'text',
        text: report.replaced ?? toSummary(report),
      } as const,
      matches: {
        type: 'json',
        data: toJson(report, {
          pattern: options.pattern,
          flags,
          mode: options.mode,
          replacement: options.mode === 'replace' ? options.replacement : null,
          ...diagnosisJson(diagnosis),
        }),
      } as const,
    });
  },
});

/** Said when a dropped file's byte order mark was removed by the decoder. */
const MARK_REMOVED: Note = {
  level: 'info',
  title: 'A byte order mark was removed',
  body: 'The file began with a BOM, which declares the encoding rather than being part of the document. It is dropped when bytes are decoded at a document port, here and everywhere else, so the subject starts at the first real character. Pasting the same file into the box keeps it, because nothing decodes anything there.',
};

/** The diagnosis, flattened into the JSON payload the view reads. */
function diagnosisJson(diagnosis: Diagnosis): Readonly<Record<string, JsonValue>> {
  return {
    notes: diagnosis.notes.map((note) => ({
      level: note.level,
      title: note.title,
      body: note.body,
    })),
    risk: {
      level: diagnosis.risk.level,
      findings: diagnosis.risk.findings.map((finding) => ({
        level: finding.level,
        fragment: finding.fragment,
        start: finding.start,
        end: finding.end,
        message: finding.message,
      })),
    },
  };
}

const erased: ErasedTool = eraseTool(regexTesterTool);
export default erased;
