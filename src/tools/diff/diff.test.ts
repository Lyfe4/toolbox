import { applyPatch } from 'diff';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ToolRunContext } from '@/features/registry/types';
import { bytesValue } from '@/features/registry/types';

import {
  computeDiff,
  lineEndingOf,
  linesOf,
  MAX_EDIT_DISTANCE,
  MAX_REFINE_EDITS,
  MAX_REFINE_LINE_LENGTH,
  MAX_REFINE_TOTAL_CHARS,
  MAX_ROWS,
  normaliseNewlines,
  toJson,
  toUnified,
  type DiffReport,
  type DiffSettings,
} from './compute';
import diffTool from './index';
import { diffOptionsSchema } from './options';

/*
 * Written as escapes on purpose. The block below is about characters that do
 * not render, and a test file that contains them literally is a test file
 * nobody can review.
 */
const BOM = '\uFEFF';
const ZWSP = '\u200B';
const ZWJ = '\u200D';
const NBSP = '\u00A0';
const SOFT_HYPHEN = '\u00AD';
const LINE_SEPARATOR = '\u2028';
/** Right-to-left override, and the pop that ends it. */
const RLO = '\u202E';
const PDF = '\u202C';
/** `e` followed by a combining acute: the decomposed form of `é`. */
const COMBINING_ACUTE_E = 'e\u0301';
/** Cyrillic small letter a, which is not Latin `a`. */
const CYRILLIC_A = '\u0430';

const context: ToolRunContext = {
  signal: new AbortController().signal,
};

const settings = (overrides: Partial<DiffSettings> = {}): DiffSettings => ({
  whitespace: 'none',
  lineEndings: 'ignore',
  ignoreCase: false,
  refineWords: true,
  context: 3,
  ...overrides,
});

function report(original: string, changed: string, overrides: Partial<DiffSettings> = {}) {
  const result = computeDiff(original, changed, settings(overrides));
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** The old side of the comparison, rebuilt from the rows alone. */
function oldSideOf(result: DiffReport): string {
  return result.rows
    .filter((row) => row.kind !== 'add')
    .map((row) => row.oldText ?? row.text)
    .join('\n');
}

/** The new side of the comparison, rebuilt from the rows alone. */
function newSideOf(result: DiffReport): string {
  return result.rows
    .filter((row) => row.kind !== 'remove')
    .map((row) => row.text)
    .join('\n');
}

/* ========================================================================== *
 * Lines
 * ========================================================================== */

describe('what counts as a line', () => {
  it('treats a trailing newline as a terminator, not as an empty last line', () => {
    expect(linesOf('a\nb')).toEqual(['a', 'b']);
    expect(linesOf('a\n')).toEqual(['a']);
    expect(linesOf('')).toEqual([]);
  });

  it('recognises every line terminator, including a lone CR', () => {
    // Caught: a classic-Mac file, whose lines are separated by CR alone, was a
    // single enormous line. Nothing about that diff was usable.
    expect(lineEndingOf('a\nb')).toBe('lf');
    expect(lineEndingOf('a\r\nb')).toBe('crlf');
    expect(lineEndingOf('a\rb')).toBe('cr');
    expect(lineEndingOf('a\r\nb\nc')).toBe('mixed');
    expect(lineEndingOf('one line')).toBe('none');
    expect(linesOf(normaliseNewlines('a\rb\rc'))).toEqual(['a', 'b', 'c']);
  });
});

/*
 * The line-ending trap, which is the single worst thing this tool did.
 *
 * The same file saved on Windows and on Linux is not one changed line, it is
 * every line changed - and each `-foo` sat directly above an identical-looking
 * `+foo`, so the reader could not tell what had happened, and any real change
 * was buried among thousands of phantom ones.
 */
describe('line endings', () => {
  it('does not report every line as changed when only the line endings differ', () => {
    const result = report('alpha\r\nbeta\r\ngamma\r\n', 'alpha\nbeta\ngamma\n');

    expect(result.equal).toBe(true);
    expect(result.stats).toEqual({ added: 0, removed: 0, unchanged: 3, ignored: 0 });
  });

  it('says that the line endings changed rather than staying silent about it', () => {
    // Normalising without reporting would trade one lie for another: the two
    // texts really are different, and the tool would be claiming they are not.
    const result = report('alpha\r\nbeta\r\n', 'alpha\nbeta\n');

    expect(result.identical).toBe(false);
    expect(result.notes.lineEndings).toEqual({ original: 'crlf', changed: 'lf', mode: 'ignore' });
  });

  it('finds the real change in a file that also changed line endings', () => {
    const result = report('alpha\r\nbeta\r\ngamma\r\n', 'alpha\nBETA\ngamma\n');

    expect(result.stats.added).toBe(1);
    expect(result.stats.removed).toBe(1);
    expect(result.rows.filter((row) => row.kind === 'add').map((row) => row.text)).toEqual([
      'BETA',
    ]);
  });

  it('reports a file whose own line endings are inconsistent', () => {
    const result = report('a\r\nb\nc', 'a\r\nb\nc');
    expect(result.notes.lineEndings.original).toBe('mixed');
  });

  it('carries no carriage return into a row, so the patch is not full of them', () => {
    const result = report('a\r\nb\r\n', 'a\r\nB\r\n');
    expect(result.rows.every((row) => !row.text.includes('\r'))).toBe(true);
    expect(toUnified(result, 3)).not.toContain('\r');
  });
});

/* ========================================================================== *
 * Structure
 * ========================================================================== */

describe('line diffing', () => {
  it('reports identical inputs as identical', () => {
    const result = report('a\nb\nc', 'a\nb\nc');
    expect(result.identical).toBe(true);
    expect(result.equal).toBe(true);
    expect(result.stats).toEqual({ added: 0, removed: 0, unchanged: 3, ignored: 0 });
  });

  it('numbers rows on both sides', () => {
    const result = report('one\ntwo\nthree', 'one\nTWO\nthree');

    const removed = result.rows.find((row) => row.kind === 'remove');
    const added = result.rows.find((row) => row.kind === 'add');

    expect(removed?.oldLine).toBe(2);
    expect(removed?.newLine).toBeNull();
    expect(added?.newLine).toBe(2);
    expect(added?.oldLine).toBeNull();
  });

  it('does not call a line changed just because a line was added after it', () => {
    // The original's last line has no trailing newline and the changed text's
    // does. Splitting into lines discards that distinction before jsdiff sees
    // it; before, the compensation was jsdiff's `ignoreNewlineAtEof`, and
    // without either the diff claims an untouched line was rewritten.
    const result = report('alpha\nbeta', 'alpha\nbeta\ngamma');

    expect(result.stats.added).toBe(1);
    expect(result.stats.removed).toBe(0);
    expect(result.rows.filter((row) => row.kind === 'add').map((row) => row.text)).toEqual([
      'gamma',
    ]);
  });

  it('counts a pure insertion', () => {
    const result = report('a\nc', 'a\nb\nc');
    expect(result.stats.added).toBe(1);
    expect(result.stats.removed).toBe(0);
  });

  it('handles both inputs empty, one empty, and one line each', () => {
    expect(report('', '').rows).toEqual([]);
    expect(report('', '').equal).toBe(true);
    expect(report('', 'a\nb').stats.added).toBe(2);
    expect(report('a\nb', '').stats.removed).toBe(2);
    expect(report('a', 'b').rows).toHaveLength(2);
  });
});

/* ========================================================================== *
 * The final newline
 * ========================================================================== */

describe('the final newline', () => {
  it('does not turn a missing final newline into a changed last line', () => {
    const result = report('a\nb\n', 'a\nb');
    expect(result.equal).toBe(true);
    expect(result.stats.removed).toBe(0);
  });

  it('still reports that the final newline changed', () => {
    // Reported rather than shown as a row: the two texts differ, and a tool
    // that answers "identical" to that is lying about a thing people care
    // about enough to have a lint rule for it.
    const result = report('a\nb\n', 'a\nb');
    expect(result.identical).toBe(false);
    expect(result.notes.finalNewline).toEqual({ original: true, changed: false });
  });

  it('marks a hunk whose last line has no terminator', () => {
    // Without the marker, applying the patch silently appends a newline the
    // file never had - which is a real, reviewable change to the file.
    const patch = toUnified(report('a\nb', 'a\nc'), 3);
    expect(patch).toContain('\\ No newline at end of file');
  });

  it('does not claim a missing terminator on a context line when only one side lacks it', () => {
    // The marker describes both sides at once, so it may never sit on a
    // context line unless BOTH sides lack the terminator.
    const lines = toUnified(report('x\na\n', 'y\na'), 3).split('\n');
    const marked = lines.filter((_, index) => lines[index + 1] === '\\ No newline at end of file');

    expect(marked).not.toHaveLength(0);
    expect(marked.every((line) => line.startsWith('-') || line.startsWith('+'))).toBe(true);
  });

  /*
   * FOUND BY APPLYING THIS TOOL'S OWN PATCHES WITH REAL `git apply`, OVER
   * EVERY FILE REVISION IN THIS REPOSITORY'S HISTORY.
   *
   * The patches applied cleanly and produced the wrong file: one whose final
   * newline had not changed. `\ No newline at end of file` is a note on a `-`
   * or `+` line, so the only way unified format can say "the terminator
   * changed" is to rewrite the last line as itself - which means the last line
   * cannot stay a context row. `git diff` opens a second hunk at the end of
   * the file to do exactly that.
   *
   * The test this replaced asserted the absence of the marker here, and its
   * reasoning was right as far as it went: the marker cannot go on a context
   * line. The missing half was that the answer is to stop making it one.
   */
  it.each([
    ['loses its final newline', 'x\na\n', 'y\na'],
    ['gains a final newline', 'x\na', 'y\na\n'],
  ])('writes the last line as a change when the file %s', (_name, before, after) => {
    const patch = toUnified(report(before, after), 3);
    expect(patch).toContain('\\ No newline at end of file');
    // The last line appears on both sides rather than as context.
    expect(patch).toContain('-a');
    expect(patch).toContain('+a');
  });

  it('writes a patch when the terminator is the only change at all', () => {
    /*
     * `equal` means no line was added or removed, and losing a trailing
     * newline adds and removes nothing - so this returned the empty string,
     * which is how this format says "the two files are the same".
     */
    const patch = toUnified(report('a\nb\n', 'a\nb'), 3);
    expect(patch).not.toBe('');
    expect(patch).toContain('@@');
    expect(patch).toContain('\\ No newline at end of file');
  });

  it('still writes nothing when the two texts really are the same', () => {
    expect(toUnified(report('a\nb\n', 'a\nb\n'), 3)).toBe('');
    expect(toUnified(report('', ''), 3)).toBe('');
  });

  it('leaves a far-away edit its own hunk rather than one huge one', () => {
    // The terminator hunk must not swallow the whole file to reach the end.
    const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].join('\n') + '\n';
    const after = ['X', '2', '3', '4', '5', '6', '7', '8', '9', '10'].join('\n');
    const patch = toUnified(report(before, after), 3);
    expect(patch.match(/^@@/gm)).toHaveLength(2);
  });
});

/* ========================================================================== *
 * The ignore options
 * ========================================================================== */

describe('ignoring whitespace', () => {
  it('ignores leading and trailing whitespace on "trailing"', () => {
    expect(report('a\n  b  \nc', 'a\nb\nc').equal).toBe(false);
    expect(report('a\n  b  \nc', 'a\nb\nc', { whitespace: 'trailing' }).equal).toBe(true);
  });

  it('does not ignore whitespace INSIDE a line on "trailing"', () => {
    // The option used to be a boolean labelled "treat lines that differ only
    // in spacing as unchanged", which is not what it did: jsdiff's
    // `ignoreWhitespace` trims, so `foo   bar` was still a change. Rather than
    // relabel a half-measure, both behaviours are now offered by name.
    expect(report('foo   bar', 'foo bar', { whitespace: 'trailing' }).equal).toBe(false);
    expect(report('foo   bar', 'foo bar', { whitespace: 'all' }).equal).toBe(true);
  });

  it('treats a tab and a run of spaces as the same indentation', () => {
    expect(report('\tfoo', '    foo', { whitespace: 'trailing' }).equal).toBe(true);
  });

  it('does not ignore an inserted blank line, at any whitespace setting', () => {
    // A blank line is a line. `git diff -w` does not drop one either; that
    // needs --ignore-blank-lines, which is a different question.
    expect(report('a\nb', 'a\n\nb', { whitespace: 'all' }).stats.added).toBe(1);
  });

  it('keeps the original text of a line it decided to ignore', () => {
    /*
     * The bug this exists for: an unchanged row carried only the CHANGED
     * side's text. With whitespace ignored, the original's indentation was
     * simply gone - unrecoverable from the output, and emitted into the
     * unified patch as a context line that does not match the file it claims
     * to patch. `git apply` rejected our own output.
     */
    const result = report('a\n    indented\nc', 'a\nindented\nc', { whitespace: 'trailing' });
    const row = result.rows[1];

    expect(row?.kind).toBe('same');
    expect(row?.text).toBe('indented');
    expect(row?.oldText).toBe('    indented');
    expect(result.stats.ignored).toBe(1);
  });

  it('leaves oldText null when the two sides really are the same string', () => {
    expect(report('a\nb', 'a\nb').rows.every((row) => row.oldText === null)).toBe(true);
  });
});

describe('ignoring case', () => {
  it('ignores case when asked, without lowercasing the output', () => {
    const result = report('Hello\nWorld', 'HELLO\nWorld', { ignoreCase: true });

    expect(result.equal).toBe(true);
    // The comparison folded case; what the user sees must not be folded.
    expect(result.rows[0]?.text).toBe('HELLO');
    expect(result.rows[0]?.oldText).toBe('Hello');
  });

  it('folds case without locale rules, so the German sharp s is still a change', () => {
    // toLowerCase is locale-independent by design: a diff whose answer depends
    // on the reader's locale is not a diff. `STRASSE` does not fold to
    // `straße`, and pretending otherwise would need a tailored casing table.
    expect(report('straße', 'STRASSE', { ignoreCase: true }).equal).toBe(false);
  });
});

describe('identical and equal are different questions', () => {
  it('separates "the same text" from "nothing the comparison cares about"', () => {
    /*
     * The view said "The two inputs are identical." whenever no rows changed.
     * With an ignore option on - or with only the line endings different -
     * that is a plain falsehood about two texts the user can see are not the
     * same, and it is the kind of wrong nobody reports because it looks right.
     */
    const folded = report('Hello', 'HELLO', { ignoreCase: true });
    expect(folded.equal).toBe(true);
    expect(folded.identical).toBe(false);

    const same = report('Hello', 'Hello');
    expect(same.equal).toBe(true);
    expect(same.identical).toBe(true);
  });
});

/* ========================================================================== *
 * Characters that do not render
 * ========================================================================== */

describe('differences that cannot be seen', () => {
  it('says so when a changed pair differs only in invisible characters', () => {
    /*
     * `-café` directly above `+café`. A combining acute against its
     * precomposed form is the commonest way to get there; a BOM and a
     * zero-width space are the others. The reader has no way to work out what
     * happened, so the row has to say it.
     */
    const combining = report(`caf${COMBINING_ACUTE_E}`, 'caf\u00E9');
    expect(combining.rows.every((row) => row.invisible)).toBe(true);

    const bom = report(`${BOM}const x = 1;`, 'const x = 1;');
    expect(bom.rows.every((row) => row.invisible)).toBe(true);

    const zeroWidth = report('total', `to${ZWSP}tal`);
    expect(zeroWidth.rows.every((row) => row.invisible)).toBe(true);
  });

  it('counts a non-breaking space as looking like a space', () => {
    expect(report(`a${NBSP}b`, 'a b').rows.every((row) => row.invisible)).toBe(true);
  });

  it('does not call an ordinary edit invisible', () => {
    expect(report('alpha', 'beta').rows.some((row) => row.invisible)).toBe(false);
    // Two spaces against one is a visible difference, not an invisible one.
    expect(report('a  b', 'a b').rows.some((row) => row.invisible)).toBe(false);
  });

  it('does not call a line invisible when it did not change at all', () => {
    /*
     * `invisible` is `differs && rendersTheSame(...)`, and round five's
     * mutation sweep turned that `&&` into `||` with nothing noticing: an
     * unchanged line renders the same as itself, so every context row in every
     * comparison would have been flagged as an invisible difference. The tests
     * above all compare pairs that DO differ, which is why none of them could
     * see it.
     */
    const result = report('keep\nchange me\nkeep too', 'keep\nchanged\nkeep too');
    const unchanged = result.rows.filter((row) => row.kind === 'same' && row.oldText === null);
    expect(unchanged.length).toBeGreaterThan(0);
    expect(unchanged.some((row) => row.invisible)).toBe(false);

    // And an added line is not an invisible difference either: there is
    // nothing for it to be invisibly different FROM.
    const added = report('a', 'a\nb').rows.filter((row) => row.kind === 'add');
    expect(added.length).toBeGreaterThan(0);
    expect(added.some((row) => row.invisible)).toBe(false);

    /*
     * AND A DIFFERENCE AN OPTION IGNORED IS NOT AN INVISIBLE ONE. `ABC` against
     * `abc` under `ignoreCase` is one row, its `oldText` is kept, and the
     * difference is perfectly visible - `visualKey` does not case-fold. This is
     * the case that separates `differs && rendersTheSame` from `differs ||
     * rendersTheSame`, because it is the only one where `differs` is true and
     * the rendering is not the same.
     */
    const cased = report('ABC', 'abc', { ignoreCase: true });
    expect(cased.rows.every((row) => row.kind === 'same')).toBe(true);
    expect(cased.rows.some((row) => row.oldText !== null)).toBe(true);
    expect(cased.rows.some((row) => row.invisible)).toBe(false);
  });

  it('does not treat lookalike letters as invisible', () => {
    // Cyrillic а against Latin a. Folding homoglyphs has no correct answer and
    // no end, so the tool does not pretend to have one.
    expect(report(`${CYRILLIC_A}lpha`, 'alpha').rows.some((row) => row.invisible)).toBe(false);
  });

  it('flags an unchanged row whose ignored difference is also invisible', () => {
    // A non-breaking space against a space, with all whitespace ignored: the
    // row is unchanged AND its two sides are indistinguishable, so it needs
    // both signals rather than either one on its own.
    const result = report(`a${NBSP}b`, 'a b', { whitespace: 'all' });
    expect(result.rows[0]?.oldText).toBe(`a${NBSP}b`);
    expect(result.rows[0]?.invisible).toBe(true);
  });

  it('reports bidirectional formatting controls, which reorder what is drawn', () => {
    /*
     * The trojan-source family. A line holding U+202E renders in a different
     * order from the one it is stored in, and a diff is exactly where somebody
     * is trusting what they see. The view isolates each row so the reordering
     * cannot escape its cell; this note is what makes the reader look.
     */
    expect(report('const x = 1;', `const x = 1; // ${RLO}evil${PDF}`).notes.bidiControls).toBe(
      true,
    );
    expect(report('const x = 1;', 'const x = 2;').notes.bidiControls).toBe(false);
  });

  it('does not warn about invisible characters that reorder nothing', () => {
    // A soft hyphen and a zero-width joiner are invisible but harmless. A
    // warning that fires on those is a warning people learn to ignore.
    expect(report(`a${SOFT_HYPHEN}b`, `a${ZWJ}b`).notes.bidiControls).toBe(false);
  });

  it('leaves right-to-left text exactly as it arrived', () => {
    // Nothing here reverses, reorders or marks up the text: containment is the
    // view's job, and doing it in the data would corrupt what the user typed.
    const before = 'greeting: \u05E9\u05DC\u05D5\u05DD';
    const after = 'greeting: \u05E2\u05D5\u05DC\u05DD';
    const result = report(before, after);

    expect(result.rows.find((row) => row.kind === 'remove')?.text).toBe(before);
    expect(result.rows.find((row) => row.kind === 'add')?.text).toBe(after);
  });
});

describe('characters outside the basic plane', () => {
  it('diffs an astral-plane character as one change, not as two halves', () => {
    // Emoji are surrogate pairs in JavaScript. A tokenizer that counted code
    // UNITS would report half a character as changed.
    const result = report('status \u{1F600} ok', 'status \u{1F601} ok');
    expect(result.stats).toMatchObject({ added: 1, removed: 1 });
  });

  it('never splits a surrogate pair across two word-level parts', () => {
    /*
     * A part holding one half of a pair renders as a replacement glyph, so the
     * word view would show damage that is not in the file. `parts.join('')`
     * would still be correct, which is exactly why this needs its own check.
     */
    const lonely = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

    fc.assert(
      fc.property(
        fc.string({ unit: 'grapheme', maxLength: 40 }),
        fc.string({ unit: 'grapheme', maxLength: 40 }),
        (left, right) => {
          const result = report(left.replaceAll('\n', 'x'), right.replaceAll('\n', 'x'));
          for (const row of result.rows) {
            for (const part of row.parts ?? []) expect(lonely.test(part.text)).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('does not fall over on a lone surrogate', () => {
    // Not valid text, but reachable: a truncated UTF-16 paste, or bytes that
    // decoded badly. It must diff or refuse, never throw.
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', maxLength: 40 }),
        fc.string({ unit: 'binary', maxLength: 40 }),
        (left, right) => {
          const result = computeDiff(left, right, settings());
          expect(result.ok || result.error.code === 'limit-exceeded').toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('treats U+2028 as text, not as a line break', () => {
    // Neither diff(1) nor git splits on it, and a tool that did would disagree
    // with every other view of the same file.
    expect(report(`a${LINE_SEPARATOR}b`, `a${LINE_SEPARATOR}c`).rows).toHaveLength(2);
  });
});

/* ========================================================================== *
 * Word-level refinement
 * ========================================================================== */

describe('word-level refinement', () => {
  it('refines an edited line into changed words', () => {
    const result = report('the quick brown fox', 'the quick red fox');

    const added = result.rows.find((row) => row.kind === 'add');
    expect(added?.parts).not.toBeNull();
    expect(added?.parts?.some((part) => part.changed && part.text.includes('red'))).toBe(true);
    expect(added?.parts?.some((part) => !part.changed && part.text.includes('quick'))).toBe(true);
  });

  it('does not refine when the runs are different lengths', () => {
    // One line out, three in: pairing them by position would produce nonsense.
    const result = report('a', 'x\ny\nz');
    expect(result.rows.every((row) => row.parts === null)).toBe(true);
  });

  it('leaves refinement off when the option is off', () => {
    const result = report('the quick fox', 'the slow fox', { refineWords: false });
    expect(result.rows.every((row) => row.parts === null)).toBe(true);
    expect(result.refinement).toBe('off');
  });

  it('refuses to refine two lines that have nothing in common', () => {
    /*
     * The soup case. "alpha beta gamma" against "wholly different words here"
     * refines to every word changed and the two SPACES unchanged, which reads
     * as "only the spacing survived" - noise presented as information, and
     * strictly worse than showing the whole line as replaced.
     */
    const result = report('alpha beta gamma', 'wholly different words here');
    expect(result.rows.every((row) => row.parts === null)).toBe(true);
  });

  it('still refines a heavily but genuinely edited line', () => {
    // The yield threshold must not be so eager that it refuses real edits.
    const result = report('const total = items.length + 1;', 'const total = entries.length + 2;');
    expect(result.rows.every((row) => row.parts !== null)).toBe(true);
  });

  it('does not highlight whitespace as a changed word when ALL whitespace is ignored', () => {
    // Marking the spacing as the change, in the mode whose whole purpose is to
    // ignore spacing, is the panel arguing with itself.
    const result = report('foo   bar baz', 'foo bar qux', { whitespace: 'all' });
    const changed = result.rows.flatMap((row) => row.parts ?? []).filter((part) => part.changed);

    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every((part) => part.text.trim() !== '')).toBe(true);
  });

  it('still highlights spacing inside a line when only trailing whitespace is ignored', () => {
    /*
     * The narrower mistake, and the one worth its own test. Under `trailing` a
     * line differing only in its leading or trailing whitespace is an
     * UNCHANGED row and never reaches refinement - so a space change that does
     * reach it is inside the line, where `trailing` does not ignore it. Marking
     * it unchanged would leave a -/+ pair with nothing highlighted in either.
     */
    const result = report('foo   bar baz', 'foo bar qux', { whitespace: 'trailing' });
    const changed = result.rows.flatMap((row) => row.parts ?? []).filter((part) => part.changed);

    expect(changed.some((part) => part.text.trim() === '')).toBe(true);
  });

  it('declines to refine two long, wholly different lines', () => {
    /*
     * THE HANG. Refinement had no bound at all, and it is the same O(ND) Myers
     * search: two dissimilar 34 kB lines - a pair of minified bundles, which
     * is precisely what someone pastes into a diff tool - took 124 seconds, so
     * the 20-second worker timeout fired and the answer was "it took too
     * long". Two bounds stop it now, each held below by a test of its own:
     * `MAX_REFINE_LINE_LENGTH` and `MAX_REFINE_EDITS`.
     *
     * This asserted `Date.now() - started < 5_000` until round twenty-six,
     * which measured the machine rather than the bound: the regression it was
     * for is a two-minute run, which vitest's own timeout fails without being
     * asked, and a 5-second stopwatch in a suite running a hundred files at
     * once is a failure waiting for a busy afternoon. What is asserted is the
     * mechanism: this pair is not refined.
     */
    const left = Array.from({ length: 4_000 }, (_, index) => `f${index.toString()}(a,b);`).join('');
    const right = Array.from({ length: 4_000 }, (_, index) => `g${index.toString()}(x,y,z);`).join(
      '',
    );

    const result = report(left, right);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((row) => row.parts === null)).toBe(true);
  });

  it('abandons refinement past MAX_REFINE_EDITS word edits, and keeps it within them', () => {
    /*
     * THE OTHER BOUND, which nothing held: the edit budget that makes a
     * hopeless comparison give up in milliseconds instead of minutes. Two lines
     * of 660 words, well under the length limit and mostly in common - so the
     * length bound and the yield rule both let them through, and only the
     * budget decides. One word in six changed is 110 removals and 110
     * additions, past the budget of 200; one in fifteen is 88, inside it.
     */
    const line = (every: number, prefix: string): string =>
      Array.from({ length: 660 }, (_, index) =>
        index % every === 0 ? `${prefix}${index.toString()}` : `w${index.toString()}`,
      ).join(' ');
    expect(line(6, 'a').length).toBeLessThan(MAX_REFINE_LINE_LENGTH);
    expect((660 / 6) * 2).toBeGreaterThan(MAX_REFINE_EDITS);
    expect((660 / 15) * 2).toBeLessThan(MAX_REFINE_EDITS);

    const tooMany = report(line(6, 'a'), line(6, 'b'));
    expect(tooMany.rows.every((row) => row.parts === null)).toBe(true);

    // The positive partner: fewer edits over the same lines are refined.
    const few = report(line(15, 'a'), line(15, 'b'));
    expect(few.rows.some((row) => row.parts !== null)).toBe(true);
  });

  it('does not look inside a line too long to read word by word', () => {
    const long = 'x'.repeat(MAX_REFINE_LINE_LENGTH + 1);
    const result = report(long, `${long}y`);
    expect(result.rows.every((row) => row.parts === null)).toBe(true);
  });

  it('refines a line of exactly the longest length, and not one longer', () => {
    /*
     * BOTH SIDES OF `MAX_REFINE_LINE_LENGTH`, because a bound only means
     * something if one document is inside it and one is outside. Round five's
     * sweep turned that `>` into `>=` with nothing noticing: every test with a
     * long line was far past the limit, and every test near it was far short.
     */
    // Words rather than one run of `x`: refinement is word-level, so a single
    // 4,000-character token is replaced wholesale and yields nothing to keep.
    const words = 'word '.repeat(MAX_REFINE_LINE_LENGTH / 5 - 1);
    const atLimit = `${words}aaaaa`;
    expect(atLimit).toHaveLength(MAX_REFINE_LINE_LENGTH);

    const refined = report(atLimit, `${words}bbbbb`);
    expect(refined.refinement).toBe('applied');
    expect(refined.rows.some((row) => row.parts !== null)).toBe(true);

    const overLimit = `${words}aaaaaa`;
    expect(overLimit).toHaveLength(MAX_REFINE_LINE_LENGTH + 1);
    const plain = report(overLimit, `${words}bbbbbb`);
    expect(plain.rows.every((row) => row.parts === null)).toBe(true);

    /*
     * AND EITHER SIDE BEING TOO LONG IS ENOUGH. The guard is an `||` over both
     * lines, and an `&&` there would refine a pair where one side is enormous
     * and the other is three characters - which is exactly the pair the bound
     * exists for, because the cost is in the longer one.
     */
    const lopsided = report(overLimit, words);
    expect(lopsided.rows.every((row) => row.parts === null)).toBe(true);
  });

  it('spends exactly the whole budget rather than stopping one character short', () => {
    /*
     * The other bound, and the same shape. `MAX_REFINE_TOTAL_CHARS` is a total
     * across the comparison, so one changed line of half of it on each side is
     * a budget of exactly the limit - which must still be spent. One character
     * more must not be.
     */
    const half = MAX_REFINE_TOTAL_CHARS / 2;
    expect(report('a'.repeat(half), 'b'.repeat(half)).refinement).toBe('applied');
    expect(report('a'.repeat(half), 'b'.repeat(half + 1)).refinement).toBe('skipped-too-large');
  });

  it('skips refinement wholesale rather than doing half of it', () => {
    /*
     * Per-line bounds do not compose: enough individually cheap rows are not
     * cheap. Decided once, up front, because a diff whose first hundred lines
     * are refined and whose rest are not looks like a bug and cannot be
     * explained to the person looking at it.
     */
    const line = 'the quick brown fox jumps over the lazy dog'.repeat(10);
    const count = 600;
    const left = Array.from({ length: count }, (_, index) => `${line}${index.toString()}`).join(
      '\n',
    );
    const right = Array.from({ length: count }, (_, index) => `${line}${index.toString()}!`).join(
      '\n',
    );

    const result = report(left, right);
    expect(result.refinement).toBe('skipped-too-large');
    expect(result.rows.every((row) => row.parts === null)).toBe(true);
  });
});

/* ========================================================================== *
 * Limits
 * ========================================================================== */

describe('limits', () => {
  it('refuses a comparison with too many rows to render', () => {
    // Nearly identical, so the diff itself is cheap; it is the ROW COUNT that
    // is refused, which is the thing that would actually kill the tab.
    const all = Array.from({ length: MAX_ROWS + 1 }, (_, index) => `line ${index.toString()}`);
    const original = all.join('\n');
    const changed = [...all.slice(0, -1), 'different'].join('\n');

    const result = computeDiff(original, changed, settings());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('limit-exceeded');
    expect(result.error.detail).toContain('rows');
  });

  it('gives up cleanly on two texts with nothing in common', () => {
    // Past MAX_EDIT_DISTANCE, Myers is asked to stop rather than grind. The
    // alternative backstop would be the worker timeout, which says far less.
    const size = MAX_EDIT_DISTANCE / 2 + 200;
    const original = Array.from({ length: size }, (_, index) => `old ${index.toString()}`).join(
      '\n',
    );
    const changed = Array.from({ length: size }, (_, index) => `new ${index.toString()}`).join(
      '\n',
    );

    const result = computeDiff(original, changed, settings());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('limit-exceeded');
    expect(result.error.message).toContain('too different');
  });
});

/* ========================================================================== *
 * Reconstruction
 * ========================================================================== */

/*
 * The invariant that makes the row model trustworthy: a diff is a description
 * of how to get from one text to the other, so reading only the old-side rows
 * must reconstruct the original exactly, and reading only the new-side rows
 * must reconstruct the changed text exactly.
 *
 * The property used to run with the ignore options OFF, which is how it stayed
 * green while an unchanged row was silently discarding the original's version
 * of itself. Options are part of the generator now.
 */
describe('reconstruction', () => {
  /*
   * Non-empty, newline-free lines. Empty lines are excluded deliberately: a
   * trailing empty line and a trailing newline are the same three characters
   * of JSON and different texts, and that ambiguity is pinned by its own test
   * above rather than smuggled into this property.
   */
  const lines = fc.array(
    fc.string({ minLength: 1, maxLength: 12 }).map((line) => line.replaceAll(/[\r\n]/gu, 'x')),
    { maxLength: 30 },
  );

  const anySettings = fc.record({
    whitespace: fc.constantFrom('none' as const, 'trailing' as const, 'all' as const),
    ignoreCase: fc.boolean(),
    refineWords: fc.boolean(),
    context: fc.integer({ min: 0, max: 5 }),
  });

  it('rebuilds both sides from the rows, whatever the options', () => {
    fc.assert(
      fc.property(lines, lines, anySettings, (left, right, overrides) => {
        const original = left.join('\n');
        const changed = right.join('\n');
        const result = report(original, changed, overrides);

        expect(oldSideOf(result)).toBe(original);
        expect(newSideOf(result)).toBe(changed);
      }),
      { numRuns: 300 },
    );
  });

  it('numbers every row consecutively on the side it belongs to', () => {
    fc.assert(
      fc.property(lines, lines, anySettings, (left, right, overrides) => {
        const result = report(left.join('\n'), right.join('\n'), overrides);

        let expectedOld = 0;
        let expectedNew = 0;

        for (const row of result.rows) {
          if (row.oldLine !== null) {
            expectedOld += 1;
            expect(row.oldLine).toBe(expectedOld);
          }
          if (row.newLine !== null) {
            expectedNew += 1;
            expect(row.newLine).toBe(expectedNew);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  /*
   * THE CONCRETE COUNTEREXAMPLE, so this cannot go back to failing one run in
   * a hundred.
   *
   * The property test above found it and then could not be made to find it
   * again: comparing "Y" with "y " under `ignoreCase` reported the common run
   * once, in the NEW side's casing, and pushed it into both rows. The removed
   * line therefore rendered as "y" - text the user never wrote - and only with
   * the option whose whole purpose is to look past case turned on.
   */
  it('renders each side in its own casing when case is being ignored', () => {
    const result = report('Y', 'y ', { ignoreCase: true, refineWords: true, context: 0 });

    for (const row of result.rows) {
      if (row.parts === null) continue;
      expect(row.parts.map((part) => part.text).join('')).toBe(row.text);
    }

    const removed = result.rows.find((row) => row.kind === 'remove');
    expect(removed?.text).toBe('Y');
    // The point: the removed row still says Y, not the y it was compared to.
    expect(removed?.parts?.map((part) => part.text).join('')).toBe('Y');
  });

  it('keeps the parts of a refined row equal to its text', () => {
    /*
     * This is why refinement uses `diffWordsWithSpace` and not `diffWords`:
     * the latter reports common runs using the NEW side's whitespace, so the
     * parts of a REMOVED row do not concatenate back to the removed row. It
     * looks like a tidier API and it silently corrupts the old side.
     */
    fc.assert(
      fc.property(fc.string(), fc.string(), anySettings, (left, right, overrides) => {
        const result = report(left, right, overrides);
        for (const row of result.rows) {
          if (row.parts === null) continue;
          expect(row.parts.map((part) => part.text).join('')).toBe(row.text);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('survives arbitrary text, including line endings and control characters', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), anySettings, (left, right, overrides) => {
        const result = computeDiff(left, right, settings(overrides));
        // No input may produce the internal-misalignment refusal.
        expect(result.ok || result.error.code === 'limit-exceeded').toBe(true);
        if (!result.ok) return;

        expect(oldSideOf(result.value)).toBe(linesOf(normaliseNewlines(left)).join('\n'));
        expect(newSideOf(result.value)).toBe(linesOf(normaliseNewlines(right)).join('\n'));
      }),
      { numRuns: 300 },
    );
  });
});

/* ========================================================================== *
 * The unified patch
 * ========================================================================== */

describe('unified output', () => {
  it('is empty when nothing changed', () => {
    expect(toUnified(report('same', 'same'), 3)).toBe('');
  });

  it('marks additions and removals with signs, not colour', () => {
    const text = toUnified(report('a\nb\nc', 'a\nB\nc'), 3);

    expect(text).toContain('--- original');
    expect(text).toContain('+++ changed');
    expect(text).toContain('-b');
    expect(text).toContain('+B');
    /*
     * THE GENERAL GRAMMAR, NOT THE ONE THIS INPUT HAPPENS TO PRODUCE.
     *
     * This used to require a comma and a count on both sides, and it passed
     * only because a three-line file against a three-line file has counts of
     * three. A count of ONE is omitted - `@@ -2 +2 @@` - which is what
     * `git diff` and GNU `diff` write and what `range` in compute.ts was fixed
     * to write last round, so the old pattern would have rejected the very
     * spelling the fix introduced. The test is named for signs rather than for
     * hunk headers; the header assertion is here to be a header assertion, so
     * it now describes every header this tool can write.
     */
    expect(text).toMatch(/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@$/m);
  });

  it('omits a count of one in the hunk header, which is what every reference writes', () => {
    // The case the pattern above could not see: one changed line, no context,
    // so both counts are one and both are left out.
    expect(toUnified(report('a\nb\nc', 'a\nB\nc'), 0)).toContain('@@ -2 +2 @@');
  });

  it('merges nearby changes into one hunk', () => {
    const original = Array.from({ length: 10 }, (_, index) => index.toString()).join('\n');
    const changed = original.replace('2', 'two').replace('4', 'four');

    const hunks = toUnified(report(original, changed), 3).match(/^@@/gm) ?? [];
    // Two changes three lines apart share their context, so one hunk.
    expect(hunks).toHaveLength(1);
  });

  it('splits distant changes into separate hunks', () => {
    const original = Array.from({ length: 40 }, (_, index) => index.toString()).join('\n');
    const changed = original.replace('\n1\n', '\none\n').replace('\n35\n', '\nthirty-five\n');

    const hunks = toUnified(report(original, changed), 3).match(/^@@/gm) ?? [];
    expect(hunks).toHaveLength(2);
  });

  it('numbers a hunk that only adds lines from the line it comes after', () => {
    /*
     * `@@ -0,0 +7,1 @@` for an insertion in the MIDDLE of a file. Unified
     * format writes the line the insertion follows, and 0 only at the start of
     * the file, so `git apply` refused our own output. It only showed up below
     * three context lines, because at three every hunk happens to contain a
     * line from both sides - which is why nobody noticed.
     */
    const original = Array.from({ length: 10 }, (_, index) => `l${index.toString()}`).join('\n');
    const patch = toUnified(report(original, original.replace('l5', 'l5\nNEW')), 0);

    // `+7` rather than `+7,1`: a count of one is omitted, which is what
    // `git diff` and GNU `diff` both write. See `range` in compute.ts.
    expect(patch).toContain('@@ -6,0 +7 @@');
  });

  it('numbers a hunk that only removes lines from the line it comes after', () => {
    const original = 'a\nb\nc';
    const patch = toUnified(report(original, 'a\nc'), 0);

    expect(patch).toContain('@@ -2 +1,0 @@');
  });

  it('numbers an insertion at the very start of the file as zero', () => {
    expect(toUnified(report('a\nb', 'X\na\nb'), 0)).toContain('@@ -0,0 +1 @@');
  });

  it('writes context lines from the original, so the patch fits the file it patches', () => {
    /*
     * With whitespace ignored, the two sides of an unchanged row are not the
     * same string, and a context line can only be one of them. It has to be
     * the pre-image or the patch does not describe the file it is a patch for.
     * `git diff -w` makes the same choice.
     */
    const patch = toUnified(report('a\n    keep\nb', 'a\nkeep\nB', { whitespace: 'trailing' }), 3);

    expect(patch).toContain('     keep');
    expect(patch).not.toMatch(/^ keep$/m);
  });
});

/*
 * jsdiff's own patch applier as an independent oracle: if applying our patch
 * to the original does not produce the changed text, the patch is wrong, and
 * no amount of eyeballing hunk headers would have told us.
 */
describe('the patch applies', () => {
  function roundTrip(original: string, changed: string, context: number): void {
    const patch = toUnified(report(original, changed, { context }), context);
    if (patch === '') {
      expect(original).toBe(changed);
      return;
    }
    expect(applyPatch(original, patch)).toBe(changed);
  }

  const original = `${Array.from({ length: 20 }, (_, index) => `line ${index.toString()}`).join('\n')}\n`;

  it('applies an insertion, a deletion and an edit at every context width', () => {
    for (const context of [0, 1, 3, 10]) {
      roundTrip(original, original.replace('line 5\n', 'line 5\nNEW\n'), context);
      roundTrip(original, original.replace('line 5\n', ''), context);
      roundTrip(original, original.replace('line 5', 'CHANGED'), context);
      roundTrip(original, original.replace('line 2', 'A').replace('line 17', 'B'), context);
    }
  });

  it('applies a patch to a file with no final newline', () => {
    roundTrip('a\nb', 'a\nc', 3);
    roundTrip('a\nb\n', 'a\nc', 3);
  });

  it('applies a patch that adds to the very start and the very end', () => {
    roundTrip(original, `first\n${original}`, 3);
    roundTrip(original, `${original}last\n`, 3);
  });

  it('applies a patch built from arbitrary line sets', () => {
    const lines = fc.array(
      fc.string({ minLength: 1, maxLength: 8 }).map((line) => line.replaceAll(/[\r\n]/gu, 'x')),
      { minLength: 1, maxLength: 20 },
    );

    fc.assert(
      fc.property(lines, lines, fc.integer({ min: 0, max: 5 }), (left, right, context) => {
        roundTrip(`${left.join('\n')}\n`, `${right.join('\n')}\n`, context);
      }),
      { numRuns: 200 },
    );
  });
});

/* ========================================================================== *
 * Things people actually paste in
 * ========================================================================== */

describe('real inputs', () => {
  it('finds one changed field in two versions of the same API response', () => {
    const body = (name: string) =>
      JSON.stringify({ id: 7, name, tags: ['a', 'b'], nested: { ok: true } }, null, 2);

    const result = report(body('before'), body('after'));
    expect(result.stats.added).toBe(1);
    expect(result.stats.removed).toBe(1);
    // One field changed on one line, so the word view should find it.
    expect(result.rows.find((row) => row.kind === 'add')?.parts).not.toBeNull();
  });

  it('compares a source file against a reindented copy of itself', () => {
    const source = ['function f() {', '  return 1;', '}'].join('\n');
    const reindented = ['function f() {', '    return 1;', '}'].join('\n');

    expect(report(source, reindented).stats.added).toBe(1);
    expect(report(source, reindented, { whitespace: 'trailing' }).equal).toBe(true);
    expect(report(source, reindented, { whitespace: 'trailing' }).stats.ignored).toBe(1);
  });

  it('compares a file against itself with only the line endings changed', () => {
    const source = ['import a from "a";', '', 'export const b = a;', ''].join('\r\n');
    const result = report(source, source.replaceAll('\r\n', '\n'));

    expect(result.equal).toBe(true);
    expect(result.notes.lineEndings).toEqual({ original: 'crlf', changed: 'lf', mode: 'ignore' });

    /*
     * THE PATCH IS NOT EMPTY ANY MORE, and that is the fix rather than a
     * regression. It used to be `''` - the one answer that means "these two
     * files are the same" - for two files that are not. It has no hunks,
     * because at this setting nothing changed line by line, and it carries the
     * fact that the rows cannot.
     */
    const patch = toUnified(result, 3);
    expect(patch).not.toContain('@@');
    expect(patch).toContain('# Line endings differ: original CRLF, changed LF.');
  });

  it('says nothing about line endings when the two files use the same ones', () => {
    // The negative control. A note that fires on an ordinary comparison is one
    // nobody reads on the day it means something.
    const result = report('a\nb\n', 'a\nB\n');
    expect(toUnified(result, 3)).not.toContain('# Line endings');
  });

  it('shows every line as changed when asked to compare the endings, and flags the pairs', () => {
    /*
     * THE OTHER HALF OF THE OPTION, and the reason it is safe to offer.
     *
     * Two lines that differ only in a carriage return draw identically, which
     * is the single most confusing thing a diff can show - so each such pair is
     * flagged `invisible`, the same flag a zero-width space or a combining
     * sequence earns. The patch keeps the CR, because a patch that wrote `-a`
     * for a line that is really `a\r\n` does not fit the file it claims to
     * patch.
     */
    const result = report('a\r\nb\r\n', 'a\nb\n', { lineEndings: 'compare' });

    expect(result.equal).toBe(false);
    expect(result.stats.added).toBe(2);
    expect(result.stats.removed).toBe(2);
    expect(result.notes.lineEndings.mode).toBe('compare');
    expect(result.rows.every((row) => row.invisible)).toBe(true);

    const patch = toUnified(result, 3);
    expect(patch).toContain('-a\r');
    expect(patch).toContain('+a');
    // The note is for the setting that HIDES the difference. Here every row
    // shows it, so repeating it would be noise.
    expect(patch).not.toContain('# Line endings');
  });

  it('still finds the real change when the endings are compared as well', () => {
    // The negative control for the option: turning it on must not make the
    // tool blind to what actually changed.
    const result = report('a\r\nb\r\n', 'a\r\nB\r\n', { lineEndings: 'compare' });

    expect(result.stats.added).toBe(1);
    expect(result.stats.removed).toBe(1);
    expect(result.rows.some((row) => row.invisible)).toBe(false);
  });
});

/* ========================================================================== *
 * The tool
 * ========================================================================== */

describe('the tool', () => {
  it('needs both of its inputs', () => {
    expect(diffTool.inputs).toHaveLength(2);
    expect(diffTool.inputs.every((input) => input.required)).toBe(true);
  });

  it('sees the line endings of a dropped file, which a textarea would have eaten', async () => {
    /*
     * WHERE THE LINE-ENDING CASE ACTUALLY ARRIVES. A textarea's value is
     * newline-normalised by the browser, so text pasted into the runner never
     * contains a CR whatever the clipboard held. A dropped file is read as raw
     * bytes and keeps them - so this path, not the typed one, is the one where
     * comparing a Windows checkout against a Unix one happens.
     */
    const encoder = new TextEncoder();
    const bytes = (value: string) =>
      bytesValue(encoder.encode(value), { mediaType: 'text/plain', filename: 'file.txt' });

    const result = await diffTool.run({
      inputs: { original: bytes('a\r\nb\r\n'), changed: bytes('a\nb\n') },
      options: { ignoreWhitespace: 'none', ignoreCase: false, refineWords: true, context: 3 },
      context,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const changes = result.value.changes;
    expect(changes?.type).toBe('json');
    if (changes?.type !== 'json') return;
    expect(changes.data).toMatchObject({
      equal: true,
      notes: { lineEndings: { original: 'crlf', changed: 'lf' } },
    });
  });

  it('produces a patch and a structured view of the same comparison', async () => {
    const result = await diffTool.run({
      inputs: {
        original: { type: 'text', text: 'alpha\nbeta' },
        changed: { type: 'text', text: 'alpha\ngamma' },
      },
      options: { ignoreWhitespace: 'none', ignoreCase: false, refineWords: true, context: 3 },
      context,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const patch = result.value.output;
    expect(patch?.type).toBe('text');
    if (patch?.type === 'text') expect(patch.text).toContain('-beta');

    const changes = result.value.changes;
    expect(changes?.type).toBe('json');
  });

  it('declares the diff presentation on its structured output', () => {
    const changes = diffTool.outputs.find((output) => output.id === 'changes');
    expect(changes?.presentation).toBe('diff');
  });

  it('reads a saved boolean whitespace option as the setting it used to mean', () => {
    /*
     * Options travel in saved canvases and in share links. Renaming the key
     * would have dropped it back to its default, so an old link would quietly
     * start comparing the whitespace it was made to ignore.
     */
    expect(diffOptionsSchema.parse({ ignoreWhitespace: true }).ignoreWhitespace).toBe('trailing');
    expect(diffOptionsSchema.parse({ ignoreWhitespace: false }).ignoreWhitespace).toBe('none');
    expect(diffOptionsSchema.parse({}).ignoreWhitespace).toBe('none');
  });

  it('carries the notes and the context setting into the JSON output', () => {
    // The view cannot state what the comparison ignored, or collapse the runs
    // the patch omits, unless both cross the worker boundary with the rows.
    const json = JSON.parse(
      JSON.stringify(toJson(report('a\r\n', 'a\n', { context: 5 }))),
    ) as Record<string, unknown>;

    expect(json.context).toBe(5);
    expect(json.equal).toBe(true);
    expect(json.identical).toBe(false);
    expect(json.notes).toMatchObject({ lineEndings: { original: 'crlf', changed: 'lf' } });
  });
});

/* ========================================================================== *
 * A byte order mark
 * ========================================================================== */

describe('a byte order mark', () => {
  /*
   * IT IS A CHARACTER, IT IS INVISIBLE, AND IT ARRIVES BY TWO ROUTES.
   *
   * Pasted, it survives and the comparison sees it. Dropped as a FILE, the
   * decoder removes it before this tool is called at all - so two documents
   * that differ only in one compared EQUAL and the patch was empty, while the
   * same two pasted compared as different. The comparison is not changed
   * (see `asText`); the fact is reported.
   */
  it('flags a pasted one as an invisible difference', () => {
    const result = report('\uFEFFname,age\n', 'name,age\n');

    expect(result.equal).toBe(false);
    expect(result.rows.some((row) => row.invisible)).toBe(true);
    expect(result.notes.byteOrderMark).toEqual({ original: true, changed: false });
  });

  it('says so when both sides have one', () => {
    const result = report('\uFEFFa\n', '\uFEFFa\n');
    expect(result.equal).toBe(true);
    expect(result.notes.byteOrderMark).toEqual({ original: true, changed: true });
  });

  it('reports one the decoder removed, which the text can no longer show', () => {
    // What the tool passes in when a dropped file had a BOM. The text here has
    // none - that is the point - and the note still says it did.
    const result = computeDiff('name,age\n', 'name,age\n', settings(), {
      original: true,
      changed: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.notes.byteOrderMark).toEqual({ original: true, changed: false });
    // And the comparison itself is untouched: no character was put back.
    expect(result.value.equal).toBe(true);
  });

  it('says nothing for two documents that never had one', () => {
    // The negative control. This fires on nothing ordinary, which is what makes
    // it worth reading when it does fire.
    expect(report('a\nb\n', 'a\nB\n').notes.byteOrderMark).toEqual({
      original: false,
      changed: false,
    });
  });
});
