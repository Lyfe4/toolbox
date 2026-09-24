import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '@/lib/testing/axe';
import { renderRoute } from '@/lib/testing/renderRoute';

/**
 * EVERY ROUTE, UNDER AXE, IN THE UNIT SUITE.
 *
 * README and CONTRIBUTING both said "axe runs against every component and
 * route in the unit suite". Every `/tools` route was scanned; `/styleguide`
 * and the not-found page never were, in any commit. The two engines in
 * `check:browsers` scan every route with `color-contrast` on, which jsdom
 * cannot do - this is the half that runs on every push.
 */
describe('every route has no axe violations', () => {
  it('/styleguide', async () => {
    const { container } = await renderRoute('/styleguide');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Styleguide' }),
    ).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('a path that matches no route', async () => {
    const { container } = await renderRoute('/nothing-here');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'No patch here' }),
    ).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});
