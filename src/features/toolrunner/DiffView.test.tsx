import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { JsonValue } from '@/features/registry/types';
import { expectNoAxeViolations } from '@/lib/testing/axe';
import { computeDiff, toJson, type DiffSettings } from '@/tools/diff/compute';

import { DiffView } from './DiffView';

const NBSP = '\u00A0';
/** Right-to-left override, and the pop that ends it. */
const RLO = '\u202E';
const PDF = '\u202C';

function diffOf(
  original: string,
  changed: string,
  overrides: Partial<DiffSettings> = {},
): JsonValue {
  const result = computeDiff(original, changed, {
    whitespace: 'none',
    ignoreCase: false,
    refineWords: true,
    context: 3,
    ...overrides,
  });
  if (!result.ok) throw new Error(result.error.message);
  return toJson(result.value);
}

/** A file long enough that its unchanged middle is worth folding away. */
function longFile(marker: string): string {
  return Array.from({ length: 40 }, (_, index) =>
    index === 0 ? marker : `line ${index.toString()}`,
  ).join('\n');
}

/**
 * The view with the three payload-handling props filled in.
 *
 * Every test below this line is about the RENDERED diff, and repeating a
 * filename and two callbacks twenty-odd times would bury what each one is
 * actually asserting. The Raw toggle has its own tests at the bottom of the
 * file and they use `DiffView` directly, because for those the callbacks are
 * the point.
 */
function DiffUnderTest(props: { readonly value: JsonValue; readonly label: string }) {
  return (
    <DiffView
      {...props}
      baseFilename="diff"
      onCopy={() => undefined}
      onDownload={() => undefined}
    />
  );
}

/** The raw box's text. `toHaveValue` does not take an asymmetric matcher. */
function rawValue(name: string): string {
  const box = screen.getByRole('textbox', { name });
  if (!(box instanceof HTMLTextAreaElement)) throw new Error(`${name} is not a textarea`);
  return box.value;
}

describe('DiffView', () => {
  it('renders the rows as a list, not as a wall of text', () => {
    render(<DiffUnderTest value={diffOf('a\nb\nc', 'a\nB\nc')} label="Diff changes" />);

    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem').length).toBeGreaterThan(0);
  });

  it('names the change, the side and the line number for a screen reader', () => {
    /*
     * The prefix used to say "removed, line 12" without saying WHICH line 12.
     * A removal is numbered in the original and an addition in the changed
     * text, so the two are different lines with the same number, and the two
     * gutters that make that obvious on screen are aria-hidden.
     */
    render(<DiffUnderTest value={diffOf('one\ntwo', 'one\nTWO')} label="Diff changes" />);

    const items = screen.getAllByRole('listitem');
    const removed = items.find((item) => item.textContent.includes('removed, original line 2'));
    const added = items.find((item) => item.textContent.includes('added, changed line 2'));

    expect(removed).toBeDefined();
    expect(added).toBeDefined();
  });

  /*
   * The requirement is that a diff is legible without colour. The sign column
   * carries it: every row is prefixed with +, -, ~ or a space, so this survives
   * greyscale, colour-vision deficiency and forced-colors mode.
   */
  it('distinguishes additions from removals without using colour', () => {
    const { container } = render(
      <DiffUnderTest value={diffOf('keep\ngone', 'keep\nnew')} label="Diff changes" />,
    );

    const text = container.textContent;
    expect(text).toContain('-');
    expect(text).toContain('+');
  });

  it('marks changed words with ins and del, which carry their own meaning', () => {
    const { container } = render(
      <DiffUnderTest
        value={diffOf('the quick brown fox', 'the quick red fox')}
        label="Diff changes"
      />,
    );

    expect(container.querySelector('ins')?.textContent).toContain('red');
    expect(container.querySelector('del')?.textContent).toContain('brown');
  });

  it('summarises the change before the detail', () => {
    render(<DiffUnderTest value={diffOf('a\nb', 'a\nc')} label="Diff changes" />);
    expect(screen.getByText('1 added, 1 removed, 1 unchanged')).toBeInTheDocument();
  });

  it('says so plainly when the two inputs match', () => {
    render(<DiffUnderTest value={diffOf('same', 'same')} label="Diff changes" />);
    expect(screen.getByText('The two inputs are identical.')).toBeInTheDocument();
  });

  it('degrades to a message rather than crashing on an unexpected shape', () => {
    render(<DiffUnderTest value={{ nonsense: true }} label="Diff changes" />);
    expect(screen.getByText(/not a diff this view can render/)).toBeInTheDocument();
  });

  it('renders a payload from before the notes existed', () => {
    // The worker and the page are separately cached, so a running tab can be
    // handed either shape. Missing notes must read as "nothing to report".
    render(
      <DiffUnderTest
        value={{
          stats: { added: 1, removed: 1, unchanged: 0 },
          identical: false,
          rows: [
            { kind: 'remove', oldLine: 1, newLine: null, text: 'a', parts: null },
            { kind: 'add', oldLine: null, newLine: 1, text: 'b', parts: null },
          ],
        }}
        label="Diff changes"
      />,
    );

    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});

/*
 * The notes are the half of the view that keeps it honest. A row can only
 * describe its own line; a difference the comparison deliberately normalised
 * away has nowhere else to be stated, and staying silent is how a diff misleads
 * without ever being wrong.
 */
describe('DiffView notes', () => {
  it('does not claim two texts are identical when only the comparison says so', () => {
    render(<DiffUnderTest value={diffOf('Hello', 'HELLO', { ignoreCase: true })} label="Diff" />);

    expect(screen.queryByText('The two inputs are identical.')).not.toBeInTheDocument();
    expect(screen.getByText(/No lines were added or removed/)).toBeInTheDocument();
  });

  it('says which line endings each side uses when they differ', () => {
    render(<DiffUnderTest value={diffOf('a\r\nb\r\n', 'a\nb\n')} label="Diff" />);
    expect(screen.getByText(/uses CRLF, the changed text uses LF/)).toBeInTheDocument();
  });

  it('says when a final newline was added or removed', () => {
    render(<DiffUnderTest value={diffOf('a\nb\n', 'a\nb')} label="Diff" />);
    expect(screen.getByText(/has a final newline; the changed text has none/)).toBeInTheDocument();
  });

  it('counts the rows whose difference the options ignored', () => {
    render(
      <DiffUnderTest
        value={diffOf('a\n   b\nc\nd', 'a\nb\nc\nD', { whitespace: 'trailing' })}
        label="Diff"
      />,
    );
    expect(screen.getByText(/1 line differs only in whitespace or case/)).toBeInTheDocument();
  });

  it('warns that bidirectional controls can reorder what is drawn', () => {
    render(<DiffUnderTest value={diffOf('x = 1;', `x = 1; ${RLO}evil${PDF}`)} label="Diff" />);
    expect(screen.getByText(/bidirectional formatting characters/)).toBeInTheDocument();
  });
});

describe('DiffView rows the reader could not otherwise explain', () => {
  it('gives an unchanged-but-not-identical row its own sign', () => {
    // Not a space, because it is not the same on both sides; not a + or -,
    // because the comparison was told to look past it.
    const { container } = render(
      <DiffUnderTest value={diffOf('   a', 'a', { whitespace: 'trailing' })} label="Diff" />,
    );
    expect(container.textContent).toContain('~');
  });

  it('says in words when a changed pair differs only in invisible characters', () => {
    /*
     * `-a b` above `+a b`, where one of those spaces is a non-breaking space.
     * There is nothing to see, so the only honest rendering is a sentence.
     */
    render(<DiffUnderTest value={diffOf(`a${NBSP}b`, 'a b')} label="Diff" />);
    expect(screen.getByText(/differs only in invisible characters/)).toBeInTheDocument();
  });

  it('does not repeat the invisible note on both halves of a pair', () => {
    render(<DiffUnderTest value={diffOf(`a${NBSP}b`, 'a b')} label="Diff" />);
    expect(screen.getAllByText(/differs only in invisible characters/)).toHaveLength(1);
  });
});

/*
 * Scannability. A forty-line file with one changed line used to be forty rows
 * to scroll past; the answer to "what changed" was in there somewhere.
 */
describe('DiffView folding', () => {
  it('folds a long run of unchanged lines behind a button that counts them', () => {
    render(<DiffUnderTest value={diffOf(longFile('before'), longFile('after'))} label="Diff" />);

    const button = screen.getByRole('button', { name: /unchanged lines/ });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    // 40 lines, one changed at the top, three kept as context: 36 folded.
    expect(button).toHaveTextContent('Show 36 unchanged lines');
  });

  it('shows the folded lines when the button is pressed', async () => {
    const user = userEvent.setup();
    render(<DiffUnderTest value={diffOf(longFile('before'), longFile('after'))} label="Diff" />);

    const before = screen.getAllByRole('listitem').length;
    await user.click(screen.getByRole('button', { name: /unchanged lines/ }));

    expect(screen.getByRole('button', { name: /unchanged lines/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(before);
  });

  it('keeps context lines either side of a change', () => {
    render(<DiffUnderTest value={diffOf(longFile('before'), longFile('after'))} label="Diff" />);
    // The three lines after the change are context and must not be folded.
    expect(screen.getByText('line 1')).toBeInTheDocument();
    expect(screen.getByText('line 3')).toBeInTheDocument();
    expect(screen.queryByText('line 20')).not.toBeInTheDocument();
  });

  it('folds nothing when the file is short enough to read', () => {
    render(<DiffUnderTest value={diffOf('a\nb\nc', 'a\nB\nc')} label="Diff" />);
    expect(screen.queryByRole('button', { name: /unchanged lines/ })).not.toBeInTheDocument();
  });

  it('folds every unchanged line at zero context, matching the patch', () => {
    render(
      <DiffUnderTest
        value={diffOf(longFile('before'), longFile('after'), { context: 0 })}
        label="Diff"
      />,
    );
    expect(screen.getByRole('button', { name: 'Show 39 unchanged lines' })).toBeInTheDocument();
  });
});

describe('DiffView accessibility', () => {
  it('has no axe violations', async () => {
    const { container } = render(
      <DiffUnderTest value={diffOf('a\nb\nc', 'a\nB\nc')} label="Diff changes" />,
    );
    await expectNoAxeViolations(container);
  });

  /*
   * THE PAYLOAD THIS VIEW USED TO WITHHOLD.
   *
   * It was tempting to call the tool's other output - the unified patch - the
   * raw form and stop there. It is not the same thing: the patch is a
   * different serialisation with its own losses. The `~` rows, the `oldText`
   * an ignore-case comparison keeps, and the per-row `parts` the word-level
   * highlight is built from exist only here, and until now the only way to
   * read any of them was to wire the port into another node.
   */
  it('reaches the row structure the unified patch cannot express', async () => {
    const user = userEvent.setup();
    render(
      <DiffView
        value={diffOf('hello world', 'hello there')}
        label="Diff changes"
        baseFilename="diff"
        onCopy={() => undefined}
        onDownload={() => undefined}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Raw' }));

    // The word-level parts: what a unified patch has no way to say.
    expect(rawValue('Diff changes raw')).toContain('"changed": true');
    // And the rendering is gone rather than doubled up beneath it.
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('has no axe violations in the raw view', async () => {
    const user = userEvent.setup();
    const { container } = render(<DiffUnderTest value={diffOf('a', 'b')} label="Diff changes" />);

    await user.click(screen.getByRole('button', { name: 'Raw' }));
    await expectNoAxeViolations(container);
  });

  it('has no axe violations with notes and a fold', async () => {
    const { container } = render(
      <DiffUnderTest
        value={diffOf(`${longFile('before')}\r\n`, longFile('after'))}
        label="Diff changes"
      />,
    );
    await expectNoAxeViolations(container);
  });
});
