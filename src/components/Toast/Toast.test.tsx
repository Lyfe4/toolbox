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

/**
 * A TOAST THAT CARRIES A CONTROL.
 *
 * Added for the canvas's deletion route: a destructive action reachable by
 * finger needs its reversal offered at the moment it happens, not discovered
 * later in an overflow menu. Nothing else about the toast changes, so what is
 * worth asserting is the three things the control brings with it - that it
 * runs, that the notification then closes rather than inviting a second press
 * that would undo something else, and that `altText` reaches the DOM, since
 * it is the only thing a screen-reader user is offered in place of a button
 * inside a live region.
 */
function ActionTrigger({ onUndo }: { readonly onUndo: () => void }) {
  const { notify } = useToast();
  return (
    <button
      type="button"
      onClick={() => {
        notify({
          title: 'Deleted Base64',
          tone: 'warn',
          action: { label: 'Undo', altText: 'Press Ctrl+Z to bring it back', onAction: onUndo },
        });
      }}
    >
      Delete
    </button>
  );
}

describe('Toast with an action', () => {
  it('runs the action when its control is pressed', async () => {
    const user = userEvent.setup();
    let undone = 0;
    render(
      <ToastProvider>
        <ActionTrigger
          onUndo={() => {
            undone += 1;
          }}
        />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));

    expect(undone).toBe(1);
  });

  /*
   * The offer has been taken, so it goes. A toast that stayed up would invite
   * a second press, and a second undo removes something the user never asked
   * about - which is a worse failure than the deletion it was reversing.
   */
  it('closes once the action has been taken', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ActionTrigger onUndo={() => undefined} />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));

    await waitFor(() => {
      expect(screen.queryByText('Deleted Base64')).not.toBeInTheDocument();
    });
  });

  it('carries the alternative for anyone who cannot reach the control', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ActionTrigger onUndo={() => undefined} />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const action = await screen.findByRole('button', { name: 'Undo' });

    expect(action).toHaveAttribute(
      'data-radix-toast-announce-alt',
      'Press Ctrl+Z to bring it back',
    );
  });

  it('has no axe violations with an action on screen', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ToastProvider>
        <ActionTrigger onUndo={() => undefined} />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByRole('button', { name: 'Undo' });

    await expectNoAxeViolations(container);
  });
});
