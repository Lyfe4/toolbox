import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { JsonValue } from '@/features/registry/types';
import { expectNoAxeViolations } from '@/lib/testing/axe';
import { computeDiff, toJson } from '@/tools/diff/compute';

import { DiffView } from './DiffView';

function diffOf(original: string, changed: string): JsonValue {
  const result = computeDiff(original, changed, {
    ignoreWhitespace: false,
    ignoreCase: false,
    refineWords: true,
    context: 3,
  });
  if (!result.ok) throw new Error(result.error.message);
  return toJson(result.value);
}

describe('DiffView', () => {
  it('renders the rows as a list, not as a wall of text', () => {
    render(<DiffView value={diffOf('a\nb\nc', 'a\nB\nc')} label="Diff changes" />);

    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem').length).toBeGreaterThan(0);
  });

  it('names the change and the line number for a screen reader', () => {
    render(<DiffView value={diffOf('one\ntwo', 'one\nTWO')} label="Diff changes" />);

    const items = screen.getAllByRole('listitem');
    const removed = items.find((item) => item.textContent.includes('removed, line'));
    const added = items.find((item) => item.textContent.includes('added, line'));

    expect(removed).toBeDefined();
    expect(added).toBeDefined();
  });

  /*
   * The requirement is that a diff is legible without colour. The sign column
   * carries it: every row is prefixed with +, - or a space, so this survives
   * greyscale, colour-vision deficiency and forced-colors mode.
   */
  it('distinguishes additions from removals without using colour', () => {
    const { container } = render(
      <DiffView value={diffOf('keep\ngone', 'keep\nnew')} label="Diff changes" />,
    );

    const text = container.textContent;
    expect(text).toContain('-');
    expect(text).toContain('+');
  });

  it('marks changed words with ins and del, which carry their own meaning', () => {
    const { container } = render(
      <DiffView value={diffOf('the quick brown fox', 'the quick red fox')} label="Diff changes" />,
    );

    expect(container.querySelector('ins')?.textContent).toContain('red');
    expect(container.querySelector('del')?.textContent).toContain('brown');
  });

  it('summarises the change before the detail', () => {
    render(<DiffView value={diffOf('a\nb', 'a\nc')} label="Diff changes" />);
    expect(screen.getByText('1 added, 1 removed, 1 unchanged')).toBeInTheDocument();
  });

  it('says so plainly when the two inputs match', () => {
    render(<DiffView value={diffOf('same', 'same')} label="Diff changes" />);
    expect(screen.getByText('The two inputs are identical.')).toBeInTheDocument();
  });

  it('degrades to a message rather than crashing on an unexpected shape', () => {
    render(<DiffView value={{ nonsense: true }} label="Diff changes" />);
    expect(screen.getByText(/not a diff this view can render/)).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <DiffView value={diffOf('a\nb\nc', 'a\nB\nc')} label="Diff changes" />,
    );
    await expectNoAxeViolations(container);
  });
});
