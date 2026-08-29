import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '@/lib/testing/axe';

import { ToastProvider, useToast } from './Toast';

function Trigger({ tone }: { readonly tone?: 'info' | 'error' }) {
  const { notify } = useToast();
  return (
    <button
      type="button"
      onClick={() => {
        notify({ title: 'Encoded', description: '48 bytes written', ...(tone ? { tone } : {}) });
      }}
    >
      Run
    </button>
  );
}

describe('Toast', () => {
  it('renders the live region before any message exists', () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    expect(screen.getByRole('region', { name: /notifications/i })).toBeInTheDocument();
  });

  it('announces a message when notified', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Run' }));

    /*
     * Radix renders its own empty announce region alongside the toast, so
     * there is more than one role="status" node and their order is a timing
     * detail. Assert against the set rather than against whichever happens to
     * be first.
     */
    await waitFor(() => {
      const regions = screen.getAllByRole('status');
      expect(regions.some((region) => region.textContent.includes('Encoded'))).toBe(true);
    });
    expect(
      screen
        .getAllByRole('status')
        .some((region) => region.textContent.includes('48 bytes written')),
    ).toBe(true);
  });

  it('raises errors assertively', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Trigger tone="error" />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Run' }));

    // Radix keeps role="status" on every toast and varies aria-live instead,
    // so "assertive" is what actually makes an error interrupt.
    await waitFor(() => {
      const regions = screen.getAllByRole('status');
      expect(regions.some((region) => region.getAttribute('aria-live') === 'assertive')).toBe(true);
    });
  });

  it('can be dismissed', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Run' }));
    await screen.findByText('Encoded');
    await user.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    await waitFor(() => {
      expect(screen.queryByText('Encoded')).not.toBeInTheDocument();
    });
  });

  it('has no axe violations with a message on screen', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Run' }));
    await screen.findByText('Encoded');
    await expectNoAxeViolations(container);
  });
});
