import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '@/lib/testing/axe';

import { Panel } from './Panel';

describe('Panel', () => {
  it('names its region from the title', () => {
    render(<Panel title="Encoder">Body</Panel>);
    expect(screen.getByRole('region', { name: 'Encoder' })).toBeInTheDocument();
  });

  it('does not claim an unnamed landmark when there is no title', () => {
    render(<Panel>Body</Panel>);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('renders the footer when given one', () => {
    render(
      <Panel title="Encoder" footer="12 bytes">
        Body
      </Panel>,
    );
    expect(screen.getByText('12 bytes')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <Panel title="Encoder" footer="Ready">
        <p>Panel body copy.</p>
      </Panel>,
    );
    await expectNoAxeViolations(container);
  });
});
