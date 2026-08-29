import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '@/lib/testing/axe';

import { Toggle } from './Toggle';

describe('Toggle', () => {
  it('exposes the switch role and its checked state', () => {
    render(<Toggle checked label="Monitor" onCheckedChange={vi.fn()} />);
    expect(screen.getByRole('switch', { name: 'Monitor' })).toBeChecked();
  });

  it('toggles with the keyboard', async () => {
    const onCheckedChange = vi.fn();
    const user = userEvent.setup();
    render(<Toggle checked={false} label="Monitor" onCheckedChange={onCheckedChange} />);

    await user.tab();
    expect(screen.getByRole('switch', { name: 'Monitor' })).toHaveFocus();
    await user.keyboard(' ');
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('keeps its name when the label is visually hidden', () => {
    render(<Toggle checked={false} label="Monitor" labelHidden onCheckedChange={vi.fn()} />);
    expect(screen.getByRole('switch', { name: 'Monitor' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <>
        <Toggle checked label="On" onCheckedChange={vi.fn()} />
        <Toggle checked={false} label="Off" onCheckedChange={vi.fn()} />
        <Toggle checked={false} label="Locked" disabled onCheckedChange={vi.fn()} />
      </>,
    );
    await expectNoAxeViolations(container);
  });
});
