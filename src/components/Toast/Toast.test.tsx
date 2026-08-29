import { render, screen } from '@testing-library/react';
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

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Encoded');
    expect(status).toHaveTextContent('48 bytes written');
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
    expect(await screen.findByRole('status')).toHaveAttribute('aria-live', 'assertive');
  });

  it('can be dismissed', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Run' }));
    await screen.findByRole('status');
    await user.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('has no axe violations with a message on screen', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Run' }));
    await screen.findByRole('status');
    await expectNoAxeViolations(container);
  });
});
