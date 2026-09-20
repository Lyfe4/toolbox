import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '@/lib/testing/axe';

import { ColorView } from './ColorView';

const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const WHITE = { r: 1, g: 1, b: 1, a: 1 };
const MID_GREY = { r: 0.5, g: 0.5, b: 0.5, a: 1 };

describe('ColorView', () => {
  it('gives the swatch an accessible name rather than leaving it decorative', () => {
    render(<ColorView color={BLACK} label="Colour" />);
    expect(screen.getByRole('img', { name: 'Colour preview' })).toBeInTheDocument();
  });

  it('reports contrast against both black and white', () => {
    render(<ColorView color={MID_GREY} label="Colour" />);

    expect(screen.getByRole('rowheader', { name: /On black/ })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: /On white/ })).toBeInTheDocument();
  });

  it('gives black the maximum ratio against white', () => {
    render(<ColorView color={BLACK} label="Colour" />);
    expect(screen.getByText('21.00:1')).toBeInTheDocument();
  });

  /*
   * A contrast checker that reported pass and fail by colour alone would be an
   * unusually pointed failure. The verdict is words.
   */
  it('states pass and fail in words', () => {
    render(<ColorView color={WHITE} label="Colour" />);

    expect(screen.getByText('passes AAA')).toBeInTheDocument();
    expect(screen.getByText('fails AA')).toBeInTheDocument();
  });

  /*
   * THE CHEQUERBOARD, WHICH WAS DRAWN BEHIND EVERY COLOUR.
   *
   * `background-image` paints above `background-color`, so the four gradients
   * that make the chequerboard were drawn ON TOP of an opaque swatch: a solid
   * `#aabbcc` was shown as `#aabbcc` in 16px squares of `--pb-surface-raised`,
   * which is a picture of a colour nobody asked for. And because every swatch
   * had it, the pattern could not signal the one thing it exists to signal.
   *
   * jsdom has no layout engine and resolves nothing about how those gradients
   * PAINT, so this is asserted on the class and the flag rather than on pixels;
   * the geometric half belongs to `check:browsers`. The flag is the stable
   * half - it is what a check in either place can name - and it is asserted in
   * both directions, because a rule that fires on everything and a rule that
   * fires on nothing are equally useless here.
   */
  it.each([
    ['an opaque colour', { r: 0.6, g: 0.7, b: 0.8, a: 1 }, 'false'],
    ['a fully transparent colour', { r: 0.6, g: 0.7, b: 0.8, a: 0 }, 'true'],
    ['87% opaque, which is #aabbccdd', { r: 0.6, g: 0.7, b: 0.8, a: 0.8666 }, 'true'],
    // The boundary itself: one step below 1 is translucent, and 1 is not.
    ['a hair under opaque', { r: 0.6, g: 0.7, b: 0.8, a: 0.999 }, 'true'],
  ])('marks %s as translucent: %s', (_name, color, expected) => {
    render(<ColorView color={color} label="Colour" />);
    const swatch = screen.getByRole('img', { name: 'Colour preview' });

    expect(swatch).toHaveAttribute('data-translucent', expected);
    // And the class follows the flag, which is what actually decides the paint.
    expect(swatch.className.includes('translucent')).toBe(expected === 'true');
  });

  it('labels the table so its purpose is clear out of context', () => {
    render(<ColorView color={MID_GREY} label="Colour" />);
    expect(screen.getByRole('table', { name: 'Contrast, WCAG 2.1' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<ColorView color={MID_GREY} label="Colour" />);
    await expectNoAxeViolations(container);
  });
});
