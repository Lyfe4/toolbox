import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '@/lib/testing/axe';

import { Select } from './Select';

const OPTIONS = [
  { value: 'hex', label: 'Hex' },
  { value: 'base64', label: 'Base64' },
  { value: 'binary', label: 'Binary' },
];

describe('Select', () => {
  it('renders a labelled combobox showing the current value', () => {
    render(<Select aria-label="Encoding" value="hex" options={OPTIONS} onValueChange={vi.fn()} />);
    const trigger = screen.getByRole('combobox', { name: 'Encoding' });
    expect(trigger).toHaveTextContent('Hex');
  });

  it('opens its listbox from the keyboard', async () => {
    const user = userEvent.setup();
    render(<Select aria-label="Encoding" value="hex" options={OPTIONS} onValueChange={vi.fn()} />);

    await user.tab();
    expect(screen.getByRole('combobox', { name: 'Encoding' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <>
        <Select aria-label="Encoding" value="hex" options={OPTIONS} onValueChange={vi.fn()} />
        <Select
          aria-label="Locked"
          value="hex"
          options={OPTIONS}
          disabled
          onValueChange={vi.fn()}
        />
      </>,
    );
    await expectNoAxeViolations(container);
  });
});
