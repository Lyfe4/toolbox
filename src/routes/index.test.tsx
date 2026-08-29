import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '@/lib/testing/axe';

import { HomePage } from './index';

describe('HomePage', () => {
  it('renders the product name as the page heading', () => {
    render(<HomePage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Patchbay' })).toBeInTheDocument();
  });

  it('has no axe-core accessibility violations', async () => {
    const { container } = render(<HomePage />);

    await expectNoAxeViolations(container);
  });
});
