import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Button } from '@/components/Button';
import { expectNoAxeViolations } from '@/lib/testing/axe';

import { Tooltip, TooltipProvider } from './Tooltip';

describe('Tooltip', () => {
  it('opens on keyboard focus, not hover alone', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <Tooltip content="Copies the output to the clipboard">
          <Button>Copy</Button>
        </Tooltip>
      </TooltipProvider>,
    );

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    await user.tab();
    expect(screen.getByRole('button', { name: 'Copy' })).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Copies the output to the clipboard',
    );
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <Tooltip content="Tooltip body">
          <Button>Copy</Button>
        </Tooltip>
      </TooltipProvider>,
    );

    await user.tab();
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <TooltipProvider>
        <Tooltip content="Tooltip body">
          <Button>Copy</Button>
        </Tooltip>
      </TooltipProvider>,
    );
    await expectNoAxeViolations(container);
  });
});
