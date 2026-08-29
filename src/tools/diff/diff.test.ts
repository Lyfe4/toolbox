import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ToolRunContext } from '@/features/registry/types';

import {
  computeDiff,
  linesOf,
  MAX_EDIT_DISTANCE,
  MAX_ROWS,
  toUnified,
  type DiffSettings,
} from './compute';
import diffTool from './index';

const context: ToolRunContext = {
  signal: new AbortController().signal,
  reportProgress: () => undefined,
};

const settings = (overrides: Partial<DiffSettings> = {}): DiffSettings => ({
  ignoreWhitespace: false,
  ignoreCase: false,
  refineWords: true,
  context: 3,
  ...overrides,
});

function report(original: string, changed: string, overrides: Partial<DiffSettings> = {}) {
  const result = computeDiff(original, changed, settings(overrides));
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('line diffing', () => {
  it('reports identical inputs as identical', () => {
    const result = report('a\nb\nc', 'a\nb\nc');
    expect(result.identical).toBe(true);
    expect(result.stats).toEqual({ added: 0, removed: 0, unchanged: 3 });
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
    // does. Without `ignoreNewlineAtEof` jsdiff calls them different tokens,
    // and the diff claims an untouched line was rewritten.
    const result = report('alpha\nbeta', 'alpha\nbeta\ngamma');

    expect(result.stats).toEqual({ added: 1, removed: 0, unchanged: 2 });
    expect(result.rows.filter((row) => row.kind === 'add').map((row) => row.text)).toEqual([
      'gamma',
    ]);
  });

  it('counts a pure insertion', () => {
    const result = report('a\nc', 'a\nb\nc');
    expect(result.stats.added).toBe(1);
    expect(result.stats.removed).toBe(0);
  });

  it('ignores whitespace when asked', () => {
    expect(report('a\n  b  \nc', 'a\nb\nc').identical).toBe(false);
    expect(report('a\n  b  \nc', 'a\nb\nc', { ignoreWhitespace: true }).identical).toBe(true);
  });

  it('ignores case when asked, without lowercasing the output', () => {
    const result = report('Hello\nWorld', 'HELLO\nWorld', { ignoreCase: true });

    expect(result.identical).toBe(true);
    // The comparison folded case; what the user sees must not be folded.
    expect(result.rows[0]?.text).toBe('HELLO');
  });

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
  });

  it('treats a trailing newline as a terminator, not as an empty last line', () => {
    expect(linesOf('a\nb')).toEqual(['a', 'b']);
    expect(linesOf('a\n')).toEqual(['a']);
    expect(linesOf('')).toEqual([]);
  });

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

/*
 * The invariant that makes the row model trustworthy: a diff is a description
 * of how to get from one text to the other, so reading only the old-side rows
 * must reconstruct the original exactly, and reading only the new-side rows
 * must reconstruct the changed text exactly. If line numbering, run pairing or
 * the case-folding indirection is wrong anywhere, this fails.
 */
describe('reconstruction', () => {
  /*
   * Non-empty, newline-free lines. Empty lines are excluded deliberately: a
   * trailing empty line and a trailing newline are the same three characters
   * of JSON and different texts, and that ambiguity is pinned by its own test
   * above rather than smuggled into this property.
   */
  const lines = fc.array(
    fc.string({ minLength: 1, maxLength: 12 }).map((line) => line.replaceAll('\n', 'x')),
    { maxLength: 30 },
  );

  it('rebuilds both sides from the rows', () => {
    fc.assert(
      fc.property(lines, lines, fc.boolean(), (left, right, refineWords) => {
        const original = left.join('\n');
        const changed = right.join('\n');
        const result = report(original, changed, { refineWords });

        const oldSide = result.rows
          .filter((row) => row.kind !== 'add')
          .map((row) => row.text)
          .join('\n');
        const newSide = result.rows
          .filter((row) => row.kind !== 'remove')
          .map((row) => row.text)
          .join('\n');

        expect(oldSide).toBe(original);
        expect(newSide).toBe(changed);
      }),
      { numRuns: 200 },
    );
  });

  it('numbers every row consecutively on the side it belongs to', () => {
    fc.assert(
      fc.property(lines, lines, (left, right) => {
        const result = report(left.join('\n'), right.join('\n'));

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
      { numRuns: 200 },
    );
  });

  it('keeps the parts of a refined row equal to its text', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (left, right) => {
        const result = report(left, right);
        for (const row of result.rows) {
          if (row.parts === null) continue;
          expect(row.parts.map((part) => part.text).join('')).toBe(row.text);
        }
      }),
      { numRuns: 200 },
    );
  });
});

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
});

describe('the tool', () => {
  it('needs both of its inputs', () => {
    expect(diffTool.inputs).toHaveLength(2);
    expect(diffTool.inputs.every((input) => input.required)).toBe(true);
  });

  it('produces a patch and a structured view of the same comparison', async () => {
    const result = await diffTool.run({
      inputs: {
        original: { type: 'text', text: 'alpha\nbeta' },
        changed: { type: 'text', text: 'alpha\ngamma' },
      },
      options: { ignoreWhitespace: false, ignoreCase: false, refineWords: true, context: 3 },
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
});
