import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '@/lib/testing/axe';

import { LiveRegion } from './LiveRegion';

/*
 * The one component in this directory with no test of its own until round
 * seventeen, under a README and a CONTRIBUTING that both said axe ran against
 * every component. Its draining behaviour is covered where it is used (the
 * canvas and the tool page announce through it); this is the component alone.
 */
describe('LiveRegion', () => {
  it('speaks the latest message as a polite status', async () => {
    render(<LiveRegion log={[{ text: 'Pipeline finished', seq: 1 }]} testId="region" />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(await screen.findByText('Pipeline finished')).toBeInTheDocument();
  });

  it('has no axe violations, empty or speaking', async () => {
    const empty = render(<LiveRegion log={[]} />);
    await expectNoAxeViolations(empty.container);
    empty.unmount();

    const speaking = render(<LiveRegion log={[{ text: 'Zoom 100 percent.', seq: 1 }]} />);
    await screen.findByText('Zoom 100 percent.');
    await expectNoAxeViolations(speaking.container);
  });
});
