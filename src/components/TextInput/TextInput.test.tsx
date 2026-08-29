import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '@/lib/testing/axe';

import { TextInput } from './TextInput';

describe('TextInput', () => {
  it('accepts typed text', async () => {
    const user = userEvent.setup();
    render(<TextInput aria-label="Payload" />);

    await user.type(screen.getByRole('textbox', { name: 'Payload' }), 'patch');
    expect(screen.getByRole('textbox', { name: 'Payload' })).toHaveValue('patch');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <>
        <TextInput aria-label="Payload" placeholder="Paste here" />
        <TextInput aria-label="Broken" invalid />
        <TextInput aria-label="Off" disabled />
      </>,
    );
    await expectNoAxeViolations(container);
  });
});
