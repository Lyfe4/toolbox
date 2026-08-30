import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '@/lib/testing/axe';
import { textConvertDefaultOptions, textConvertOptionFields } from '@/tools/text-convert/options';

import { OptionsPanel } from './OptionsPanel';

/**
 * CONDITIONAL OPTIONS, and the stability property that makes them bearable.
 *
 * A panel whose shape shifts on every toggle feels broken even when it is
 * right. The text-convert tool's answer is that visibility is a function of
 * ONE control - the target format - so there are three layouts and they change
 * only when the user deliberately changes the target.
 *
 * These tests assert that property directly, not just that hiding works.
 */

const fields = textConvertOptionFields as unknown as readonly Parameters<
  typeof OptionsPanel
>[0]['fields'][number][];

function renderPanel(overrides: Record<string, unknown> = {}) {
  const onChange = vi.fn();
  const values = { ...textConvertDefaultOptions, ...overrides };

  const result = render(<OptionsPanel fields={fields} values={values} onChange={onChange} />);

  return { ...result, onChange };
}

/**
 * The panel's SHAPE: which fields are present, in order.
 *
 * Label elements, not control text. A Select renders its current value as its
 * own text content, so reading the controls would make "the panel changed
 * shape" and "the user picked a different bullet" indistinguishable - which is
 * precisely the thing under test.
 */
const shapeOf = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('label')].map((label) => label.textContent.trim());

describe('what shows for each target', () => {
  it('always shows source and target', () => {
    for (const target of ['html', 'markdown', 'text']) {
      const { unmount } = renderPanel({ target });

      expect(screen.getByText('Source format')).toBeInTheDocument();
      expect(screen.getByText('Target format')).toBeInTheDocument();

      unmount();
    }
  });

  it('shows only the HTML options when producing HTML', () => {
    renderPanel({ target: 'html' });

    expect(screen.getByText('Heading ids')).toBeInTheDocument();
    expect(screen.getByText('Link bare URLs')).toBeInTheDocument();
    // Markdown and text settings say nothing about how to write HTML.
    expect(screen.queryByText('Bullet marker')).not.toBeInTheDocument();
    expect(screen.queryByText('Keep link URLs')).not.toBeInTheDocument();
  });

  it('shows only the Markdown options when producing Markdown', () => {
    renderPanel({ target: 'markdown' });

    expect(screen.getByText('Bullet marker')).toBeInTheDocument();
    expect(screen.getByText('Code fence')).toBeInTheDocument();
    expect(screen.getByText('Markup Markdown cannot express')).toBeInTheDocument();
    expect(screen.queryByText('Heading ids')).not.toBeInTheDocument();
    expect(screen.queryByText('Tables')).not.toBeInTheDocument();
  });

  it('shows only the text options when producing plain text', () => {
    renderPanel({ target: 'text' });

    expect(screen.getByText('Keep link URLs')).toBeInTheDocument();
    expect(screen.getByText('List marker')).toBeInTheDocument();
    expect(screen.getByText('Tables')).toBeInTheDocument();
    expect(screen.queryByText('Bullet marker')).not.toBeInTheDocument();
    expect(screen.queryByText('Heading ids')).not.toBeInTheDocument();
  });
});

describe('panel stability', () => {
  it('does not change shape when a non-target option changes', () => {
    /*
     * THE PROPERTY THAT MATTERS. Every conditional field keys off `target` and
     * nothing else, so toggling linkify, picking a different bullet or
     * switching the SOURCE leaves the panel exactly as it was.
     */
    const first = renderPanel({ target: 'markdown' });
    const before = shapeOf(first.container);
    first.unmount();

    for (const change of [
      { bullet: '*' },
      { emphasis: '*' },
      { unsupported: 'drop' },
      { source: 'html' },
      { source: 'markdown' },
      { headingIds: false },
      { keepLinkUrls: false },
    ]) {
      const panel = renderPanel({ target: 'markdown', ...change });
      expect(shapeOf(panel.container), JSON.stringify(change)).toEqual(before);
      panel.unmount();
    }
  });

  it('has exactly three layouts, one per target', () => {
    const shapes = new Set<string>();

    for (const target of ['html', 'markdown', 'text']) {
      const panel = renderPanel({ target });
      shapes.add(shapeOf(panel.container).join('|'));
      panel.unmount();
    }

    expect(shapes.size).toBe(3);
  });

  it('keeps the value of a hidden option, so nothing is lost by looking away', async () => {
    const user = userEvent.setup();
    // Bullet is hidden while the target is HTML, but it is still in the
    // options object - the predicate governs display, not state.
    const { onChange } = renderPanel({ target: 'html', bullet: '+' });

    expect(screen.queryByText('Bullet marker')).not.toBeInTheDocument();

    // Changing something else must not touch it.
    await user.click(screen.getByRole('switch', { name: /Heading ids/ }));

    expect(onChange).toHaveBeenCalledWith('headingIds', false);
    expect(onChange).not.toHaveBeenCalledWith('bullet', expect.anything());
  });
});

describe('accessibility', () => {
  it.each(['html', 'markdown', 'text'])('has no axe violations targeting %s', async (target) => {
    const { container } = renderPanel({ target });

    await expectNoAxeViolations(container);
  });
});
