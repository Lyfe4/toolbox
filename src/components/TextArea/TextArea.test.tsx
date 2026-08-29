import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '@/lib/testing/axe';

import { TextArea } from './TextArea';

describe('TextArea', () => {
  it('accepts multi-line input', async () => {
    const user = userEvent.setup();
    render(<TextArea aria-label="Payload" />);

    await user.type(screen.getByRole('textbox', { name: 'Payload' }), 'one{Enter}two');
    expect(screen.getByRole('textbox', { name: 'Payload' })).toHaveValue('one\ntwo');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <>
        <TextArea aria-label="Payload" />
        <TextArea aria-label="Broken" invalid />
      </>,
    );
    await expectNoAxeViolations(container);
  });
});
