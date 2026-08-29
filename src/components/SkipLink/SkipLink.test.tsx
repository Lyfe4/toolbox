import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '@/lib/testing/axe';

import { SkipLink } from './SkipLink';

describe('SkipLink', () => {
  it('points at the content target', () => {
    render(<SkipLink targetId="main" />);
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main');
  });

  it('is the first thing reachable by keyboard', async () => {
    const user = userEvent.setup();
    render(
      <>
        <SkipLink targetId="main" />
        <button type="button">Somewhere else</button>
      </>,
    );

    await user.tab();
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveFocus();
  });

  it('has no axe violations', async () => {
    const { container } = render(<SkipLink targetId="main" />);
    await expectNoAxeViolations(container);
  });
});
