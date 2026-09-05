import { diffLines, diffWordsWithSpace, type Change } from 'diff';

import { fail, ok, type JsonValue, type ToolResult } from '@/features/registry/types';

/**
 * Line diffing, with optional word-level refinement.
 *
 * The Myers algorithm is not hand-rolled here. jsdiff is maintained, widely
 * exercised and has the awkward parts right. Writing our own would be a fun
 * afternoon and a permanent liability.
 *
 * What this module DOES own is three things jsdiff has no opinion about:
 *
 *  1. WHAT COUNTS AS THE SAME LINE. Line endings, case and whitespace are
 *     normalised HERE, into a separate comparison copy, rather than by handing
 *     jsdiff its own `ignoreWhitespace`. One normalisation path means one set
 *     of rules to explain, and it is the only way to express "ignore all
 *     whitespace", which jsdiff's line differ cannot do at all.
 *  2. THE SHAPE OF THE RESULT. jsdiff returns runs ("these six lines were
 *     removed"), which is convenient for producing a patch and useless for
 *     rendering an accessible, line-numbered view. The runs are expanded into
 *     rows, each of which knows its own line numbers on BOTH sides.
 *  3. WHAT THE COMPARISON THREW AWAY. Every normalisation is a difference the
 *     user will not see in the rows, so each one is reported as a fact of its
 *     own. A diff that says "identical" about two texts that are not identical
 *     is the worst failure this tool has, because nobody reports it.
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
  /**
   * The line, from the side this row belongs to. A `same` row carries the
   * CHANGED side's text, matching jsdiff's own convention for a run that
   * compared equal without being identical.
   */
  readonly text: string;
  /**
   * The ORIGINAL side's text, on a `same` row whose two sides are not actually
   * identical - which is what "ignore case" and "ignore whitespace" produce.
   *
   * Null when the two sides agree exactly, which is the common case.
   *
   * This field is why the row model can be trusted. Without it a `same` row
   * asserts that both sides read the way the changed side does, the old text
   * is unrecoverable, and the unified patch emits context lines that do not
   * match the file it claims to patch. It was exactly that: `git apply`
   * rejected our own output.
   */
  readonly oldText: string | null;
  /** Word-level breakdown, when refinement found a paired line worth refining. */
  readonly parts: readonly RowPart[] | null;
  /**
   * True when this row's counterpart differs from it only in characters that
   * do not render: a BOM, a zero-width space, a combining sequence against its
   * precomposed form, a non-breaking space against a space.
   *
   * A `-foo` / `+foo` pair that looks like two identical lines is the single
   * most confusing thing a diff can show, and the reader has no way to work
   * out what happened from the rendering alone. Saying so is the whole fix.
   */
  readonly invisible: boolean;
}

export interface DiffStats {
  readonly added: number;
  readonly removed: number;
  readonly unchanged: number;
  /** Unchanged rows whose two sides differ in something the options ignored. */
  readonly ignored: number;
}

/** How a text terminates its lines. `none` means it holds at most one line. */
export type LineEnding = 'lf' | 'crlf' | 'cr' | 'mixed' | 'none';

/**
 * What the comparison ignored, reported so the rows do not have to lie.
 *
 * Every field here describes a real difference between the two inputs that
 * does NOT appear as a changed row.
 */
export interface DiffNotes {
  readonly lineEndings: { readonly original: LineEnding; readonly changed: LineEnding };
  readonly finalNewline: { readonly original: boolean; readonly changed: boolean };
  /**
   * True when either input contains an explicit bidirectional formatting
   * control.
   *
   * Those characters reorder the text around them, so a line can render as
   * something other than what it contains - the "trojan source" family. In a
   * diff that matters more than anywhere else, because the entire point of
   * reading one is to believe what you see. The view isolates each row so the
   * reordering cannot escape its cell, and says that they are present.
   */
  readonly bidiControls: boolean;
}

/** Why word-level refinement did or did not run. */
export type RefinementState = 'off' | 'applied' | 'skipped-too-large';

export interface DiffReport {
  readonly rows: readonly DiffRow[];
  readonly stats: DiffStats;
  /** True when the two inputs are the same string, character for character. */
  readonly identical: boolean;
  /**
   * True when the comparison found no added or removed lines.
   *
   * Distinct from `identical` on purpose: with an ignore option on, or with
   * only the line endings changed, these two disagree - and it is precisely
   * then that "the two inputs are identical" would be a lie.
   */
  readonly equal: boolean;
  readonly notes: DiffNotes;
  readonly refinement: RefinementState;
  /** Carried through so the view can collapse the runs the patch would omit. */
  readonly context: number;
}

/** How much whitespace the comparison is allowed to ignore. */
export type WhitespaceMode = 'none' | 'trailing' | 'all';

export interface DiffSettings {
  readonly whitespace: WhitespaceMode;
  readonly ignoreCase: boolean;
  readonly refineWords: boolean;
  readonly context: number;
}

/* ========================================================================== *
 * Limits
 * ========================================================================== */

/**
 * Upper bound on rows.
 *
 * Not a performance tuning knob: a diff of two large, wholly different files
 * produces a row per line of both, and rendering a hundred thousand list items
 * is how a tab dies. Refusing with a clear message beats freezing.
 */
export const MAX_ROWS = 20_000;

/**
 * Upper bound on the edit distance jsdiff is asked to search for, in lines.
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
 * Longest line word-level refinement will look inside.
 *
 * Refinement is the same O(ND) Myers search over word tokens, and it had NO
 * bound at all: two dissimilar 34 kB lines - which is what a pair of minified
 * bundles is - took 124 seconds, so the worker timeout fired at 20 and the
 * user was told the diff took too long. Measured: ~0.4 s at 2 kB, ~5 s at
 * 8 kB, ~124 s at 34 kB, all from the SAME two-row line diff.
 *
 * A line this long cannot be read word by word anyway, so nothing is lost.
 */
export const MAX_REFINE_LINE_LENGTH = 4_000;

/**
 * Upper bound on the word-level edit distance, in tokens.
 *
 * With this in hand a hopeless refinement aborts in milliseconds rather than
 * minutes: the same 42 kB pair that ran for two minutes unbounded returns
 * `undefined` in 13 ms. `maxEditLength` rather than jsdiff's `timeout` option
 * deliberately - a wall-clock bound makes the OUTPUT depend on how busy the
 * machine was, which is not something a diff may do.
 */
export const MAX_REFINE_EDITS = 200;

/**
 * Total characters refinement will process across the whole comparison.
 *
 * Per-line bounds do not compose: twenty thousand individually cheap rows are
 * not cheap. Checked BEFORE any refinement runs rather than as a running
 * budget, so the answer is the same for every row - a diff where the first
 * hundred lines are refined and the rest are not would look like a bug.
 */
export const MAX_REFINE_TOTAL_CHARS = 400_000;

/**
 * How much of a line must survive an edit for the word-level view to be worth
 * showing.
 *
 * Refinement pairs a removal with an addition and asks jsdiff what changed
 * within them. On two lines that have nothing to do with each other it still
 * answers - "alpha beta gamma" against "wholly different words here" comes
 * back as every word changed and the two SPACES unchanged, which reads as
 * "only the spacing survived" and is worse than saying nothing. So the
 * unchanged material is measured, ignoring parts that are only whitespace,
 * and below this share of the longer line the whole-line form is kept.
 *
 * 0.3 rather than something higher because a heavily but genuinely edited line
 * is still worth refining; rather than something lower because the failure
 * mode below it is noise presented as information.
 */
export const MIN_REFINEMENT_YIELD = 0.3;

/* ========================================================================== *
 * Normalisation
 * ========================================================================== */

/**
 * Collapses CRLF and lone CR to LF.
 *
 * NOT an option, and that is a decision worth defending. A file saved on
 * Windows compared against the same file saved on a Mac used to report every
 * single line as removed and re-added, with the two sides of each pair
 * rendering identically - the reader saw `-foo` above `+foo` and could not
 * possibly tell why. That output is not merely unhelpful: it hides the real
 * changes among thousands of phantom ones.
 *
 * The line-ending change is a real difference, so it is not discarded. It is
 * reported once, as itself, in `notes.lineEndings`. One sentence carries
 * strictly more information than ten thousand rows of it.
 *
 * A lone CR is a line terminator too. Left alone, a classic-Mac file is a
 * single enormous line and the diff is useless in a different way.
 */
export function normaliseNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

/** What terminators a text actually uses. */
export function lineEndingOf(value: string): LineEnding {
  const crlf = value.includes('\r\n');
  const cr = /\r(?!\n)/.test(value);
  const lf = /(?<!\r)\n/.test(value);

  const kinds = [crlf, cr, lf].filter(Boolean).length;
  if (kinds === 0) return 'none';
  if (kinds > 1) return 'mixed';
  if (crlf) return 'crlf';
  if (cr) return 'cr';
  return 'lf';
}

/**
 * Explicit bidirectional formatting controls: the embedding and override pair,
 * the isolate family, and the two directional marks.
 *
 * Not `\p{Cf}` wholesale - a soft hyphen or a zero-width joiner is invisible
 * but reorders nothing, and warning about those would train people to ignore
 * the warning.
 */
const BIDI_CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/**
 * Characters that occupy no width of their own.
 *
 * `\p{Cf}` covers the format characters - the BOM, the word joiner, the bidi
 * controls above - and the zero-width space is named explicitly because its
 * category has moved between Unicode versions.
 *
 * Variation selectors are deliberately NOT here. They are invisible in
 * themselves but they change how the character before them is drawn, so a diff
 * that differs only in one is a diff you really can see.
 */
const ZERO_WIDTH = /[\p{Cf}\u200B]/gu;

/** Spaces that render as an ordinary space without being one. */
const SPACE_LOOKALIKES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/gu;

/**
 * A key that is equal for two strings that render the same way.
 *
 * NFC folds a combining sequence onto its precomposed form, so `cafe` + U+0301
 * and `cafe-acute` collapse together; the two substitutions handle characters
 * that are invisible or that impersonate a space. Homoglyphs are deliberately
 * NOT folded - Cyrillic a really is a different letter, and deciding which
 * lookalikes to merge is a bottomless pit with no correct answer.
 */
function visualKey(value: string): string {
  return value.replace(ZERO_WIDTH, '').replace(SPACE_LOOKALIKES, ' ').normalize('NFC');
}

/** True when two different strings would be indistinguishable on screen. */
function rendersTheSame(left: string, right: string): boolean {
  return left !== right && visualKey(left) === visualKey(right);
}

/**
 * Splits text into lines, without inventing a trailing empty one.
 *
 * Exported because it defines what this tool means by "a line", and the tests
 * pin that definition: two lines for `a`, newline, `b`, and one line for `a`
 * followed by a newline - so a trailing newline is a terminator rather than an
 * empty final line.
 */
export function linesOf(value: string): readonly string[] {
  if (value === '') return [];
  const lines = value.split('\n');
  // Text ending in a newline splits to a final '' that is not a real line.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * The form of a line the comparison actually looks at.
 *
 * `trailing` is leading AND trailing, which is what every diff tool means by
 * the phrase and what `String.prototype.trim` does; `all` strips every
 * whitespace character in the line, matching `git diff -w`. Both use the
 * JavaScript definition of whitespace, which includes the non-breaking space -
 * stated because a user who loses a NBSP to it deserves to know why.
 */
function comparisonForm(line: string, settings: DiffSettings): string {
  const spaced =
    settings.whitespace === 'all'
      ? line.replace(/\s+/gu, '')
      : settings.whitespace === 'trailing'
        ? line.trim()
        : line;
  return settings.ignoreCase ? spaced.toLowerCase() : spaced;
}

/**
 * The whole text, as the comparison sees it.
 *
 * THE TRAILING NEWLINE IS LOAD-BEARING, twice over, and the misalignment guard
 * in `computeDiff` is what found it:
 *
 *  - Without it, a text whose last line is empty joins to something that
 *    splits back into one line fewer, so the rows and the line arrays
 *    disagree. Comparing an empty text against a single space, with
 *    whitespace trimmed, is the smallest case: one normalises to no lines and
 *    the other to one empty line, and joined without a terminator both are the
 *    empty string.
 *  - With it, the last line carries the same terminator as every other line,
 *    which is what jsdiff's `ignoreNewlineAtEof` used to be compensating for.
 *    That option is no longer passed, because there is nothing left for it to
 *    fix.
 */
function comparisonText(lines: readonly string[], settings: DiffSettings): string {
  if (lines.length === 0) return '';
  return `${lines.map((line) => comparisonForm(line, settings)).join('\n')}\n`;
}

/* ========================================================================== *
 * Word-level refinement
 * ========================================================================== */

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
 * True when this removal run and the one after it are "these lines were
 * edited" rather than two unrelated blocks.
 *
 * Same length, paired by position. Unequal runs are left alone: pairing three
 * lines against seven by position produces fragments of unrelated text.
 *
 * ONE function because two callers need the same answer - the main loop, and
 * the budget walk that decides up front whether refinement runs at all. If
 * those two disagreed about which runs pair, the budget would be measured for
 * a different set of rows than the one that gets refined.
 */
function pairsWithNext(runs: readonly Run[], index: number): boolean {
  const run = runs[index];
  const next = runs[index + 1];
  return run?.kind === 'remove' && next?.kind === 'add' && next.lines.length === run.lines.length;
}

interface Refinement {
  readonly removed: readonly RowPart[];
  readonly added: readonly RowPart[];
}

/**
 * Refines a removed/added pair into word-level segments, or returns null when
 * doing so would not help.
 *
 * `diffWordsWithSpace` rather than `diffWords`, and that is load-bearing:
 * `diffWords` reports common runs using the NEW side's whitespace, so
 * concatenating the parts of a removed row does not give back the removed row.
 * A property test asserts parts.join('') === text, and `diffWords` fails it.
 */
function refine(oldLine: string, newLine: string, settings: DiffSettings): Refinement | null {
  if (oldLine.length > MAX_REFINE_LINE_LENGTH || newLine.length > MAX_REFINE_LINE_LENGTH) {
    return null;
  }

  const parts = diffWordsWithSpace(oldLine, newLine, {
    ignoreCase: settings.ignoreCase,
    maxEditLength: MAX_REFINE_EDITS,
  });
  // Undefined means jsdiff gave up: these two lines are not a line and its
  // edit, whatever the run pairing thought.
  if (parts === undefined) return null;

  const removed: RowPart[] = [];
  const added: RowPart[] = [];
  let kept = 0;

  for (const part of parts) {
    /*
     * A whitespace-only change is not a change when ALL whitespace is being
     * ignored: highlighting the spacing, in the mode whose whole purpose is to
     * look past it, is the panel arguing with itself.
     *
     * `all` and not `trailing`, which is the narrower and easier mistake to
     * make. Under `trailing` a line that differs only in its leading or
     * trailing whitespace never reaches refinement at all - it is an unchanged
     * row - so a space change that DOES reach here is inside the line, where
     * `trailing` does not ignore it and it really is the change.
     *
     * Flipping the flag rather than dropping the part is what keeps
     * parts.join('') equal to the row's text.
     */
    const ignorable = settings.whitespace === 'all' && part.value.trim() === '';

    if (part.added) added.push({ text: part.value, changed: !ignorable });
    else if (part.removed) removed.push({ text: part.value, changed: !ignorable });
    else {
      removed.push({ text: part.value, changed: false });
      added.push({ text: part.value, changed: false });
      // Whitespace that happens to line up is not evidence that these are the
      // same line: two unrelated sentences share their spaces.
      if (part.value.trim() !== '') kept += part.value.length;
    }
  }

  const span = Math.max(oldLine.length, newLine.length);
  if (span === 0 || kept / span < MIN_REFINEMENT_YIELD) return null;

  return { removed, added };
}

/**
 * Decides, once, whether word-level refinement runs at all.
 *
 * Up front rather than per row: a comparison where the first hundred lines are
 * refined and the rest are not looks like a bug and is impossible to explain.
 */
function refinementState(
  runs: readonly Run[],
  originalLines: readonly string[],
  changedLines: readonly string[],
  settings: DiffSettings,
): RefinementState {
  if (!settings.refineWords) return 'off';

  let oldLine = 0;
  let newLine = 0;
  let budget = 0;

  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    if (!run) continue;

    if (run.kind === 'same') {
      oldLine += run.lines.length;
      newLine += run.lines.length;
      continue;
    }
    if (run.kind === 'add') {
      newLine += run.lines.length;
      continue;
    }

    if (pairsWithNext(runs, index)) {
      for (let offset = 0; offset < run.lines.length; offset += 1) {
        budget += (originalLines[oldLine + offset] ?? '').length;
        budget += (changedLines[newLine + offset] ?? '').length;
      }
      newLine += run.lines.length;
      index += 1;
    }
    oldLine += run.lines.length;
  }

  return budget > MAX_REFINE_TOTAL_CHARS ? 'skipped-too-large' : 'applied';
}

/* ========================================================================== *
 * The comparison
 * ========================================================================== */

export function computeDiff(
  original: string,
  changed: string,
  settings: DiffSettings,
): ToolResult<DiffReport> {
  const notes: DiffNotes = {
    lineEndings: { original: lineEndingOf(original), changed: lineEndingOf(changed) },
    finalNewline: { original: /[\r\n]$/.test(original), changed: /[\r\n]$/.test(changed) },
    bidiControls: BIDI_CONTROLS.test(original) || BIDI_CONTROLS.test(changed),
  };

  const originalLines = linesOf(normaliseNewlines(original));
  const changedLines = linesOf(normaliseNewlines(changed));

  /*
   * The structure is computed from normalised copies and every row's text is
   * then read back from the real line arrays by line number. The user sees
   * exactly what they typed; only the comparison ignored anything.
   *
   * Both sides are joined WITHOUT a trailing newline, which is why jsdiff's
   * `ignoreNewlineAtEof` is no longer passed: splitting into lines already
   * discarded the distinction between a final line with and without its
   * terminator, so the token that used to make an untouched last line look
   * rewritten cannot arise. The difference itself is not lost - it is in
   * `notes.finalNewline`.
   */
  const changes = diffLines(
    comparisonText(originalLines, settings),
    comparisonText(changedLines, settings),
    { maxEditLength: MAX_EDIT_DISTANCE },
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

  const refinement = refinementState(runs, originalLines, changedLines, settings);
  const refining = refinement === 'applied';

  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  let ignored = 0;

  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    if (!run) continue;

    if (run.kind === 'same') {
      // The run's own values are the normalised ones, so only its LENGTH is
      // used; each row's text is read back from the real line arrays.
      const sameEnd = newLine + run.lines.length;
      while (newLine < sameEnd) {
        oldLine += 1;
        newLine += 1;
        unchanged += 1;
        const newText = changedLines[newLine - 1] ?? '';
        const oldText = originalLines[oldLine - 1] ?? '';
        const differs = oldText !== newText;
        if (differs) ignored += 1;
        rows.push({
          kind: 'same',
          oldLine,
          newLine,
          text: newText,
          oldText: differs ? oldText : null,
          parts: null,
          invisible: differs && rendersTheSame(oldText, newText),
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
          oldText: null,
          parts: null,
          invisible: false,
        });
      }
      continue;
    }

    // A removal run, and possibly its matching addition run - see pairsWithNext.
    const next = runs[index + 1];
    const pairable = next !== undefined && pairsWithNext(runs, index);

    const removalStart = oldLine;
    const additionStart = newLine;

    // Computed once per pair and read from both sides, so the two rows of a
    // pair can never disagree about what changed within them.
    const refined: (Refinement | null)[] = run.lines.map((_, offset) => {
      if (!pairable || !refining) return null;
      const before = originalLines[removalStart + offset] ?? '';
      const after = changedLines[additionStart + offset] ?? '';
      return refine(before, after, settings);
    });

    run.lines.forEach((_, offset) => {
      oldLine += 1;
      removed += 1;
      const text = originalLines[oldLine - 1] ?? '';
      const partner = pairable ? (changedLines[additionStart + offset] ?? '') : null;
      rows.push({
        kind: 'remove',
        oldLine,
        newLine: null,
        text,
        oldText: null,
        parts: refined[offset]?.removed ?? null,
        invisible: partner !== null && rendersTheSame(text, partner),
      });
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
          oldText: null,
          parts: refined[offset]?.added ?? null,
          invisible: rendersTheSame(partner, text),
        });
      });
      // The addition run has been consumed as part of the pair.
      index += 1;
    }
  }

  /*
   * A diff that quietly misaligns is worse than one that refuses. Every line
   * of each input must appear exactly once, so if the run lengths and the line
   * arrays ever disagree - which is what the `?? ''` fallbacks above would
   * otherwise paper over, as blank rows in the middle of a file - say so
   * rather than rendering a plausible lie.
   */
  if (oldLine !== originalLines.length || newLine !== changedLines.length) {
    return fail('internal', 'The comparison did not line up and has been discarded.', {
      detail: `Covered ${oldLine.toString()} of ${originalLines.length.toString()} original lines and ${newLine.toString()} of ${changedLines.length.toString()} changed lines.`,
    });
  }

  return ok({
    rows,
    stats: { added, removed, unchanged, ignored },
    identical: original === changed,
    equal: added === 0 && removed === 0,
    notes,
    refinement,
    context: settings.context,
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

/** GNU diff's marker for a file whose last line has no terminator. */
const NO_NEWLINE = '\\ No newline at end of file';

/**
 * The line number a zero-length side of a hunk comes AFTER.
 *
 * Unified format writes `-N,0` where N is the last line that exists before the
 * insertion point, and 0 only at the very start of the file. Emitting `-0,0`
 * for an insertion in the middle - which this did - produces a patch `git
 * apply` refuses, and it only showed up below three context lines, because
 * above that every hunk happens to contain a line from both sides.
 */
function precedingLine(
  rows: readonly DiffRow[],
  start: number,
  side: (row: DiffRow) => number | null,
): number {
  for (let index = start - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row) continue;
    const line = side(row);
    if (line !== null) return line;
  }
  return 0;
}

/**
 * True when this row is the last line of a side that has no final newline.
 *
 * Without the marker, applying the patch silently appends a terminator the
 * file did not have. A context row only earns it when NEITHER side has a final
 * newline: the marker describes both at once, so claiming it while the sides
 * disagree would misdescribe one of them. That case - a final newline added or
 * removed with nothing else changed - has no representation in unified format
 * here, and is reported in `notes.finalNewline` instead.
 */
function endsWithoutNewline(
  report: DiffReport,
  row: DiffRow,
  lastOldLine: number,
  lastNewLine: number,
): boolean {
  const { original, changed } = report.notes.finalNewline;
  const lastOld = row.oldLine === lastOldLine;
  const lastNew = row.newLine === lastNewLine;

  if (row.kind === 'remove') return lastOld && !original;
  if (row.kind === 'add') return lastNew && !changed;
  return lastOld && lastNew && !original && !changed;
}

/**
 * Renders rows as a unified diff.
 *
 * This is the pipeable output: the format `git apply` and every code host
 * understands, so the node can be wired onward or pasted into a review.
 *
 * CONTEXT LINES COME FROM THE ORIGINAL. When an ignore option is on, the two
 * sides of an unchanged row are not the same string, and only one of them can
 * appear. It has to be the pre-image, or the patch does not describe the file
 * it claims to be a patch for. That is also what `git diff -w` does.
 *
 * The file headers name no path, because this tool has none. Applying the
 * result therefore means substituting real names into the `---`/`+++` lines
 * first; the hunks themselves are correct as written.
 */
export function toUnified(report: DiffReport, context: number): string {
  if (report.equal) return '';

  const rows = report.rows;
  const lines: string[] = ['--- original', '+++ changed'];

  const lastOldLine = rows.reduce((best, row) => Math.max(best, row.oldLine ?? 0), 0);
  const lastNewLine = rows.reduce((best, row) => Math.max(best, row.newLine ?? 0), 0);

  for (const span of hunkSpans(rows, context)) {
    const slice = rows.slice(span.start, span.end + 1);

    const oldNumbers = slice.flatMap((row) => (row.oldLine === null ? [] : [row.oldLine]));
    const newNumbers = slice.flatMap((row) => (row.newLine === null ? [] : [row.newLine]));

    const oldStart = oldNumbers[0] ?? precedingLine(rows, span.start, (row) => row.oldLine);
    const newStart = newNumbers[0] ?? precedingLine(rows, span.start, (row) => row.newLine);

    lines.push(
      `@@ -${oldStart.toString()},${oldNumbers.length.toString()} +${newStart.toString()},${newNumbers.length.toString()} @@`,
    );

    for (const row of slice) {
      // The pre-image for a context line; the row's own text otherwise.
      const text = row.kind === 'same' ? (row.oldText ?? row.text) : row.text;
      lines.push(`${SIGN[row.kind]}${text}`);
      if (endsWithoutNewline(report, row, lastOldLine, lastNewLine)) lines.push(NO_NEWLINE);
    }
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
    equal: report.equal,
    context: report.context,
    refinement: report.refinement,
    notes: {
      lineEndings: { ...report.notes.lineEndings },
      finalNewline: { ...report.notes.finalNewline },
      bidiControls: report.notes.bidiControls,
    },
    rows: report.rows.map((row) => ({
      kind: row.kind,
      oldLine: row.oldLine,
      newLine: row.newLine,
      text: row.text,
      oldText: row.oldText,
      invisible: row.invisible,
      parts: row.parts === null ? null : row.parts.map((part) => ({ ...part })),
    })),
  };
}
