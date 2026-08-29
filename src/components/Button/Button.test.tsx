import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '@/lib/testing/axe';

import { Button } from './Button';

describe('Button', () => {
  it('renders a real button that defaults to type="button"', () => {
    render(<Button>Patch</Button>);
    const button = screen.getByRole('button', { name: 'Patch' });
    expect(button).toHaveAttribute('type', 'button');
  });

  it('is operable with the keyboard', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Button onClick={onClick}>Patch</Button>);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Patch' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('does not fire when disabled', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <Button disabled onClick={onClick}>
        Patch
      </Button>,
    );

    await user.click(screen.getByRole('button', { name: 'Patch' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('has no axe violations in any variant', async () => {
    const { container } = render(
      <>
        <Button variant="primary">Primary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Danger</Button>
        <Button variant="ghost" size="sm" disabled>
          Disabled
        </Button>
      </>,
    );
    await expectNoAxeViolations(container);
  });
});
