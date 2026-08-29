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

  it('labels the table so its purpose is clear out of context', () => {
    render(<ColorView color={MID_GREY} label="Colour" />);
    expect(screen.getByRole('table', { name: 'Contrast, WCAG 2.1' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<ColorView color={MID_GREY} label="Colour" />);
    await expectNoAxeViolations(container);
  });
});
