import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '@/lib/testing/axe';

import * as Icons from './Icon';

/** Every exported component whose name ends in "Icon". */
const ICON_ENTRIES = Object.entries(Icons).filter(([name]) => name.endsWith('Icon'));

describe('Icon set', () => {
  it('exports icons', () => {
    expect(ICON_ENTRIES.length).toBeGreaterThan(8);
  });

  it.each(ICON_ENTRIES)('%s is decorative and drawn on the 24px grid', (_name, Component) => {
    const { container } = render(<Component size={24} />);
    const svg = container.querySelector('svg');

    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('focusable', 'false');
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
    expect(svg).toHaveAttribute('stroke-width', '1.5');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <>
        {ICON_ENTRIES.map(([name, Component]) => (
          <Component key={name} />
        ))}
      </>,
    );
    await expectNoAxeViolations(container);
  });
});
