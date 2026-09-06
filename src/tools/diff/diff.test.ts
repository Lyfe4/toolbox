import { applyPatch } from 'diff';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ToolRunContext } from '@/features/registry/types';

import {
  computeDiff,
  lineEndingOf,
  linesOf,
  MAX_EDIT_DISTANCE,
  MAX_REFINE_LINE_LENGTH,
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
  reportProgress: () => undefined,
};

const settings = (overrides: Partial<DiffSettings> = {}): DiffSettings => ({
  whitespace: 'none',
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
    expect(result.notes.lineEndings).toEqual({ original: 'crlf', changed: 'lf' });
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
    // The marker describes both sides at once. Emitting it here would say
    // something false about the side that does have a final newline.
    const patch = toUnified(report('x\na\n', 'y\na'), 3);
    expect(patch).not.toContain('\\ No newline at end of file');
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

  it('finishes quickly on two long, wholly different lines', () => {
    /*
     * THE HANG. Refinement had no bound at all, and it is the same O(ND) Myers
     * search: two dissimilar 34 kB lines - a pair of minified bundles, which
     * is precisely what someone pastes into a diff tool - took 124 seconds, so
     * the 20-second worker timeout fired and the answer was "it took too
     * long". Bounded, the same comparison returns in milliseconds.
     *
     * The bound is generous because the point is to catch an UNBOUNDED
     * regression, which is three orders of magnitude away, not to police
     * milliseconds on a busy machine.
     */
    const left = Array.from({ length: 4_000 }, (_, index) => `f${index.toString()}(a,b);`).join('');
    const right = Array.from({ length: 4_000 }, (_, index) => `g${index.toString()}(x,y,z);`).join(
      '',
    );

    const started = Date.now();
    const result = report(left, right);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.rows).toHaveLength(2);
  });

  it('does not look inside a line too long to read word by word', () => {
    const long = 'x'.repeat(MAX_REFINE_LINE_LENGTH + 1);
    const result = report(long, `${long}y`);
    expect(result.rows.every((row) => row.parts === null)).toBe(true);
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
    expect(text).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
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

    expect(patch).toContain('@@ -6,0 +7,1 @@');
  });

  it('numbers a hunk that only removes lines from the line it comes after', () => {
    const original = 'a\nb\nc';
    const patch = toUnified(report(original, 'a\nc'), 0);

    expect(patch).toContain('@@ -2,1 +1,0 @@');
  });

  it('numbers an insertion at the very start of the file as zero', () => {
    expect(toUnified(report('a\nb', 'X\na\nb'), 0)).toContain('@@ -0,0 +1,1 @@');
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
    expect(result.notes.lineEndings).toEqual({ original: 'crlf', changed: 'lf' });
    expect(toUnified(result, 3)).toBe('');
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
    const bytes = (value: string) => ({
      type: 'bytes' as const,
      bytes: encoder.encode(value),
      mediaType: 'text/plain',
      filename: 'file.txt',
    });

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
