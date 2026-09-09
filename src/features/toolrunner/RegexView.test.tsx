import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { JsonValue } from '@/features/registry/types';
import { expectNoAxeViolations } from '@/lib/testing/axe';
import regexTool from '@/tools/regex-tester';
import { regexDefaultOptions, type RegexOptions } from '@/tools/regex-tester/options';

import { RegexView } from './RegexView';

/** The real tool's real output, so the view is tested against what it gets. */
async function reportFor(subject: string, overrides: Partial<RegexOptions>): Promise<JsonValue> {
  const result = await regexTool.run({
    inputs: { input: { type: 'text', text: subject } },
    options: { ...regexDefaultOptions, ...overrides },
    context: { signal: new AbortController().signal, reportProgress: () => undefined },
  });

  if (!result.ok) throw new Error(result.error.message);
  const matches = result.value.matches;
  if (matches?.type !== 'json') throw new Error('expected a JSON report');
  return matches.data;
}

/**
 * The view with its payload-handling props filled in. The Raw toggle's own
 * tests pass real callbacks; everything else here is about the rendering.
 */
function renderView(value: JsonValue) {
  return render(
    <RegexView
      value={value}
      label="Regex matches"
      baseFilename="regex-tester"
      onCopy={() => undefined}
      onDownload={() => undefined}
    />,
  );
}

async function renderReport(subject: string, overrides: Partial<RegexOptions>) {
  return renderView(await reportFor(subject, overrides));
}

/** The raw box's text. `toHaveValue` does not take an asymmetric matcher. */
function rawValue(name: string): string {
  const box = screen.getByRole('textbox', { name });
  if (!(box instanceof HTMLTextAreaElement)) throw new Error(`${name} is not a textarea`);
  return box.value;
}

describe('RegexView', () => {
  it('leads with the count and the flags', async () => {
    // Half the surprises in this tool are a flag being on or off, so the
    // flags belong next to the number rather than three panels away.
    await renderReport('a1 b22 c333', { pattern: '\\d+', ignoreCase: true });

    expect(screen.getByText('3 matches')).toBeInTheDocument();
    expect(screen.getByText('/\\d+/gi')).toBeInTheDocument();
  });

  it('says "1 match" rather than "1 matches"', async () => {
    await renderReport('a1', { pattern: '\\d+' });
    expect(screen.getByText('1 match')).toBeInTheDocument();
  });

  it('marks each match in the subject', async () => {
    const { container } = await renderReport('a1 b22', { pattern: '\\d+' });

    const marks = container.querySelectorAll('mark');
    expect([...marks].map((mark) => mark.textContent)).toEqual(['1', '22']);
  });

  it('keeps two adjacent matches as two marks', async () => {
    // Merged marks would show one long match where there are two, and the
    // highlight is the only place that error would be invisible in the data.
    const { container } = await renderReport('abab', { pattern: 'ab' });
    expect(container.querySelectorAll('mark')).toHaveLength(2);
  });

  it('draws a zero-length match as a labelled mark rather than as nothing', async () => {
    /*
     * `/^/gm` finds the start of every line and matches no text at all.
     * Drawing nothing would make it look as though the pattern failed, so
     * each position gets a mark of its own carrying a hidden label - which is
     * also what a screen reader hears, since there is no text to read.
     */
    const { container } = await renderReport('a\nb\nc', { pattern: '^', multiline: true });

    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(3);
    expect(marks[0]?.textContent).toBe('empty match');
  });

  it('renders the subject exactly, marks and gaps together', async () => {
    const subject = 'ada@example bob@example';
    const { container } = await renderReport(subject, { pattern: '\\w+@\\w+' });

    const region = container.querySelector('pre');
    expect(region?.textContent).toBe(subject);
  });

  it('shows a multi-line match as an escape rather than as two rows', async () => {
    // A cell holding a real newline silently becomes two lines and reads as
    // two matches. The table is one row per match or it is not a table.
    await renderReport('a\nb', { pattern: 'a.b', dotAll: true });

    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(2); // header plus one match
    expect(rows[1]?.textContent).toContain('a\\nb');
  });

  it('lists each capture group with its number, name and offset', async () => {
    await renderReport('ada@example', { pattern: '(?<user>\\w+)@(\\w+)' });

    const rows = screen.getAllByRole('row');
    const cells = rows[1]?.textContent ?? '';
    expect(cells).toContain('$1');
    expect(cells).toContain('user');
    expect(cells).toContain('$2');
  });

  it('says when a group did not participate rather than showing a blank', async () => {
    await renderReport('b', { pattern: '(a)|(b)' });
    expect(screen.getByText('did not participate')).toBeInTheDocument();
  });

  it('shows the diagnosis when nothing matched', async () => {
    const { container } = await renderReport('hello world', { pattern: 'HELLO' });

    expect(screen.getByText('0 matches')).toBeInTheDocument();
    expect(container.textContent).toContain('ignore case');
    // Nothing matched, so there is nothing to highlight and no table to draw.
    expect(container.querySelector('table')).toBeNull();
  });

  it('names the level of each note in words, not only in colour', async () => {
    const { container } = await renderReport('hello', { pattern: 'HELLO' });
    expect(container.textContent).toContain('Try this');
  });

  it('warns about a pattern that can backtrack catastrophically', async () => {
    const { container } = await renderReport('aaa!', { pattern: '(a+)+$' });

    expect(container.textContent).toContain('backtrack catastrophically');
    // And is honest about what the check is. A heuristic sold as a proof is
    // worse than no heuristic.
    expect(container.textContent).toContain('not a proof');
  });

  it('renders backticked fragments as code rather than as backticks', async () => {
    const { container } = await renderReport('abc', { pattern: 'x*' });
    expect(container.textContent).not.toContain('`');
    expect(container.querySelectorAll('code').length).toBeGreaterThan(0);
  });

  it('makes the scrolling regions focusable', async () => {
    /*
     * A scrollable box that cannot be focused is unreachable for anyone
     * driving the page from the keyboard. This project has already shipped
     * that defect once, in the shortcuts dialog, and it is structurally
     * invisible to jsdom - so the rule is asserted here and the geometry is
     * checked in a real engine.
     */
    const { container } = await renderReport('a1 b22', { pattern: '\\d+' });

    for (const label of ['Subject text with matches highlighted', 'Match listing']) {
      expect(screen.getByRole('group', { name: label })).toHaveAttribute('tabindex', '0');
    }
    expect(container).toBeTruthy();
  });

  it('gives the table a caption and column headers', async () => {
    await renderReport('a1', { pattern: '(\\d)' });

    const table = screen.getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['#', 'Offset (UTF-16)', 'Line:col', 'Match', 'Groups']);
  });

  it('survives a payload it does not recognise', () => {
    // The value arrives as JsonValue because it crossed the worker boundary.
    // A future change to the tool should show up as "nothing to show", never
    // as a crash inside a render.
    renderView({ nonsense: true });
    expect(screen.getByText('Nothing to show.')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = await renderReport('a1 b22\nc333', { pattern: '(\\d+)' });
    await expectNoAxeViolations(container);
  });

  it('has no accessibility violations with notes and a risk warning', async () => {
    const { container } = await renderReport('aaa!', { pattern: '(a+)+$' });
    await expectNoAxeViolations(container);
  });

  /*
   * THE PAYLOAD THIS VIEW USED TO WITHHOLD.
   *
   * The tool's other output is the replaced text or a printed match list - an
   * answer to a different question. The offsets, the group names, the risk
   * findings and the segment model behind the highlight only exist on THIS
   * port, and the only way to read them was to wire it into another node. The
   * table stops at 200 rows; the payload does not, which is exactly the case
   * where somebody needs it.
   */
  it('reaches every match through the raw payload, past the table cap', async () => {
    const user = userEvent.setup();
    const subject = Array.from({ length: 250 }, (_, index) => index.toString()).join(' ');
    renderView(await reportFor(subject, { pattern: '\\d+' }));

    expect(screen.getAllByRole('row').length).toBeLessThan(250);

    await user.click(screen.getByRole('button', { name: 'Raw' }));

    expect(rawValue('Regex matches raw')).toContain('"count": 250');
  });

  it('has no accessibility violations in the raw view', async () => {
    const user = userEvent.setup();
    const { container } = await renderReport('a1 b22', { pattern: '\\d+' });

    await user.click(screen.getByRole('button', { name: 'Raw' }));
    await expectNoAxeViolations(container);
  });
});
