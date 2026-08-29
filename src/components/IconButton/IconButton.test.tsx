import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CloseIcon } from '@/components/Icon';
import { expectNoAxeViolations } from '@/lib/testing/axe';

import { IconButton } from './IconButton';

describe('IconButton', () => {
  it('takes its accessible name from the required label', () => {
    render(<IconButton label="Close panel" icon={<CloseIcon />} />);
    expect(screen.getByRole('button', { name: 'Close panel' })).toBeInTheDocument();
  });

  it('hides the icon from assistive technology', () => {
    const { container } = render(<IconButton label="Close panel" icon={<CloseIcon />} />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <>
        <IconButton label="Close panel" icon={<CloseIcon />} />
        <IconButton label="Disabled action" icon={<CloseIcon />} size="sm" disabled />
      </>,
    );
    await expectNoAxeViolations(container);
  });
});
