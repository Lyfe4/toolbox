import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '@/lib/testing/axe';

import { VisuallyHidden } from './VisuallyHidden';

describe('VisuallyHidden', () => {
  it('keeps its text in the accessibility tree', () => {
    render(
      <button type="button">
        <VisuallyHidden>Mute channel</VisuallyHidden>
      </button>,
    );
    expect(screen.getByRole('button', { name: 'Mute channel' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<VisuallyHidden as="div">Status: idle</VisuallyHidden>);
    await expectNoAxeViolations(container);
  });
});
