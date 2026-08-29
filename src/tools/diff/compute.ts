import { diffLines, diffWordsWithSpace, type Change } from 'diff';

import { fail, ok, type JsonValue, type ToolResult } from '@/features/registry/types';

/**
 * Line diffing, with optional word-level refinement.
 *
 * The Myers algorithm is not hand-rolled here. jsdiff is maintained, widely
 * exercised and has the awkward parts right - the `ignoreWhitespace` and
 * `ignoreCase` comparators, the trailing-newline edge cases, the abort
 * options. Writing our own would be a fun afternoon and a permanent liability.
 *
 * What this module DOES own is the shape of the result. jsdiff returns runs
 * ("these six lines were removed"), which is convenient for producing a patch
 * and useless for rendering an accessible, line-numbered view. So the runs are
 * expanded into rows, each of which knows its own line numbers on both sides.
 */

/** A row is one line, on one side or both. */
export type RowKind = 'add' | 'remove' | 'same';

/** One word-level segment within a refined row. */
export interface RowPart {
  readonly text: string;
  readonly changed: boolean;
}

export interface DiffRow {
  readonly kind: RowKind;
  /** 1-based line number in the original, or null for an added line. */
  readonly oldLine: number | null;
  /** 1-based line number in the changed text, or null for a removed line. */
  readonly newLine: number | null;
  readonly text: string;
  /** Word-level breakdown, when refinement found a paired line. */
  readonly parts: readonly RowPart[] | null;
}

export interface DiffStats {
  readonly added: number;
  readonly removed: number;
  readonly unchanged: number;
}

export interface DiffReport {
  readonly rows: readonly DiffRow[];
  readonly stats: DiffStats;
  readonly identical: boolean;
}

export interface DiffSettings {
  readonly ignoreWhitespace: boolean;
  readonly ignoreCase: boolean;
  readonly refineWords: boolean;
  readonly context: number;
}

/**
 * Upper bound on rows.
 *
 * Not a performance tuning knob: a diff of two large, wholly different files
 * produces a row per line of both, and rendering a hundred thousand list items
 * is how a tab dies. Refusing with a clear message beats freezing.
 */
export const MAX_ROWS = 20_000;

/**
 * Upper bound on the edit distance jsdiff is asked to search for.
 *
 * Myers runs in O(ND), so two large files with nothing in common are the
 * expensive case - and also the least useful diff anyone ever read. Handing
 * jsdiff a `maxEditLength` makes it give up and return undefined instead of
 * grinding, which is turned into a plain refusal below. Without it the only
 * backstop would be the worker timeout, and "it took too long" is a much worse
 * answer than "these two files have nothing in common".
 */
export const MAX_EDIT_DISTANCE = 4_000;

/**
 * Splits text into lines, without inventing a trailing empty one.
 *
 * Exported because it defines what this tool means by "a line", and the tests
 * pin that definition: `'a
b'` is two lines and `'a
'` is one, so a
 * trailing newline is a terminator rather than an empty final line.
 */
export function linesOf(value: string): readonly string[] {
  if (value === '') return [];
  const lines = value.split('\n');
  // Text ending in a newline splits to a final '' that is not a real line.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Refines a removed/added pair into word-level segments.
 *
 * Only run on lines that are plausibly the "same" line edited, which is why it
 * pairs by position within the run. Two unrelated lines would produce a
 * meaningless soup of fragments, so the whole-line form is kept when the runs
 * are of different lengths.
 */
function refine(
  oldLine: string,
  newLine: string,
  ignoreCase: boolean,
): { readonly removed: readonly RowPart[]; readonly added: readonly RowPart[] } {
  const parts = diffWordsWithSpace(oldLine, newLine, { ignoreCase });

  const removed: RowPart[] = [];
  const added: RowPart[] = [];

  for (const part of parts) {
    if (part.added) added.push({ text: part.value, changed: true });
    else if (part.removed) removed.push({ text: part.value, changed: true });
    else {
      removed.push({ text: part.value, changed: false });
      added.push({ text: part.value, changed: false });
    }
  }

  return { removed, added };
}

/** Groups the raw changes into runs so removals and additions can be paired. */
interface Run {
  readonly kind: RowKind;
  readonly lines: readonly string[];
}

function toRuns(changes: readonly Change[]): readonly Run[] {
  return changes.map((change) => ({
    kind: change.added ? 'add' : change.removed ? 'remove' : 'same',
    lines: linesOf(change.value),
  }));
}

/**
 * Case-insensitive line comparison.
 *
 * jsdiff's line differ has `ignoreWhitespace` but not `ignoreCase` - that
 * option only exists on the character and word differs. So the STRUCTURE is
 * computed from case-folded copies, and every row's text is then read back
 * from the original line arrays by line number. The user sees what they typed;
 * only the comparison ignored case.
 */
function foldCase(value: string, ignoreCase: boolean): string {
  return ignoreCase ? value.toLowerCase() : value;
}

export function computeDiff(
  original: string,
  changed: string,
  settings: DiffSettings,
): ToolResult<DiffReport> {
  const originalLines = linesOf(original);
  const changedLines = linesOf(changed);

  const changes = diffLines(
    foldCase(original, settings.ignoreCase),
    foldCase(changed, settings.ignoreCase),
    {
      ignoreWhitespace: settings.ignoreWhitespace,
      /*
       * Without this, comparing a three-line text against a four-line one
       * reports the shared last line as changed - because "the lazy dog" and
       * "the lazy dog\n" are different tokens to jsdiff. Nobody means that.
       * (jsdiff ignores this flag when `ignoreWhitespace` is on, which is
       * harmless: that option already subsumes it.)
       */
      ignoreNewlineAtEof: true,
      maxEditLength: MAX_EDIT_DISTANCE,
    },
  );

  if (changes === undefined) {
    return fail('limit-exceeded', 'Those two texts are too different to compare line by line.', {
      detail: `More than ${MAX_EDIT_DISTANCE.toLocaleString('en')} lines differ, at which point a diff is not a useful way to read them.`,
    });
  }

  const runs = toRuns(changes);
  const total = runs.reduce((sum, run) => sum + run.lines.length, 0);
  if (total > MAX_ROWS) {
    return fail('limit-exceeded', 'That comparison is too large to display line by line.', {
      detail: `It would produce ${total.toLocaleString('en')} rows; the limit is ${MAX_ROWS.toLocaleString('en')}.`,
    });
  }

  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let added = 0;
  let removed = 0;
  let unchanged = 0;

  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    if (!run) continue;

    if (run.kind === 'same') {
      // The run's own values are the case-folded ones, so only its LENGTH is
      // used; each row's text is read back from the original line arrays.
      const sameEnd = newLine + run.lines.length;
      while (newLine < sameEnd) {
        oldLine += 1;
        newLine += 1;
        unchanged += 1;
        // The new side's text, matching jsdiff's own convention for a run that
        // compared equal without being identical.
        rows.push({
          kind: 'same',
          oldLine,
          newLine,
          text: changedLines[newLine - 1] ?? '',
          parts: null,
        });
      }
      continue;
    }

    if (run.kind === 'add') {
      const addEnd = newLine + run.lines.length;
      while (newLine < addEnd) {
        newLine += 1;
        added += 1;
        rows.push({
          kind: 'add',
          oldLine: null,
          newLine,
          text: changedLines[newLine - 1] ?? '',
          parts: null,
        });
      }
      continue;
    }

    // A removal run. Look ahead for an addition run of the same length: that
    // is the "these lines were edited" case worth refining.
    const next = runs[index + 1];
    const pairable =
      settings.refineWords && next?.kind === 'add' && next.lines.length === run.lines.length;

    const removalStart = oldLine;
    const additionStart = newLine;

    run.lines.forEach((_, offset) => {
      oldLine += 1;
      removed += 1;
      const text = originalLines[oldLine - 1] ?? '';
      const partner = pairable ? (changedLines[additionStart + offset] ?? '') : null;
      const parts = partner === null ? null : refine(text, partner, settings.ignoreCase).removed;
      rows.push({ kind: 'remove', oldLine, newLine: null, text, parts });
    });

    if (pairable) {
      next.lines.forEach((_, offset) => {
        newLine += 1;
        added += 1;
        const text = changedLines[newLine - 1] ?? '';
        const partner = originalLines[removalStart + offset] ?? '';
        rows.push({
          kind: 'add',
          oldLine: null,
          newLine,
          text,
          parts: refine(partner, text, settings.ignoreCase).added,
        });
      });
      // The addition run has been consumed as part of the pair.
      index += 1;
    }
  }

  return ok({
    rows,
    stats: { added, removed, unchanged },
    identical: added === 0 && removed === 0,
  });
}

/* ========================================================================== *
 * Unified patch text
 * ========================================================================== */

/** Inclusive row-index range covered by one hunk. */
interface Span {
  start: number;
  end: number;
}

function hunkSpans(rows: readonly DiffRow[], context: number): readonly Span[] {
  const spans: Span[] = [];

  rows.forEach((row, index) => {
    if (row.kind === 'same') return;
    const start = Math.max(0, index - context);
    const end = Math.min(rows.length - 1, index + context);
    const last = spans[spans.length - 1];

    // Merge into the previous hunk when the context windows touch, which is
    // what makes a real unified diff readable rather than a stutter of @@s.
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else spans.push({ start, end });
  });

  return spans;
}

const SIGN: Record<RowKind, string> = { add: '+', remove: '-', same: ' ' };

/**
 * Renders rows as a unified diff.
 *
 * This is the pipeable output: it is the format `git apply` and every code
 * host understands, so the node can be wired onward or pasted into a review.
 */
export function toUnified(report: DiffReport, context: number): string {
  if (report.identical) return '';

  const lines: string[] = ['--- original', '+++ changed'];

  for (const span of hunkSpans(report.rows, context)) {
    const slice = report.rows.slice(span.start, span.end + 1);

    const oldNumbers = slice.flatMap((row) => (row.oldLine === null ? [] : [row.oldLine]));
    const newNumbers = slice.flatMap((row) => (row.newLine === null ? [] : [row.newLine]));

    // A hunk that only adds lines has no old line number of its own; unified
    // format writes the line it comes after, with a count of zero.
    const oldStart = oldNumbers[0] ?? 0;
    const newStart = newNumbers[0] ?? 0;

    lines.push(
      `@@ -${oldStart.toString()},${oldNumbers.length.toString()} +${newStart.toString()},${newNumbers.length.toString()} @@`,
    );
    for (const row of slice) lines.push(`${SIGN[row.kind]}${row.text}`);
  }

  return `${lines.join('\n')}\n`;
}

/* ========================================================================== *
 * JSON view
 * ========================================================================== */

/**
 * The structured form, for the accessible renderer and for downstream tools.
 *
 * Written out field by field rather than cast, because `DiffRow` is an
 * interface with optional-shaped members and `JsonValue` is a closed recursive
 * type: the compiler will not accept one as the other without being shown that
 * every field really is JSON.
 */
export function toJson(report: DiffReport): JsonValue {
  return {
    stats: { ...report.stats },
    identical: report.identical,
    rows: report.rows.map((row) => ({
      kind: row.kind,
      oldLine: row.oldLine,
      newLine: row.newLine,
      text: row.text,
      parts: row.parts === null ? null : row.parts.map((part) => ({ ...part })),
    })),
  };
}
