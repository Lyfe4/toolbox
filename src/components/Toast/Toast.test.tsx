import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

/**
 * HOW LONG A TOAST LIVES, AND WHAT STOPS THE CLOCK.
 *
 * Every test above this line was written against a toast that was already on
 * screen, and not one of them would have noticed that toasts had stopped
 * leaving on their own - which is what was reported, and what these are here
 * to keep from happening twice.
 *
 * The cause was Radix's single provider-wide pause flag. It goes up on the
 * first `pointermove` over the viewport and comes down on the matching
 * `pointerleave`, but the listeners that would lower it are attached only
 * while a toast exists. Press the dismiss button - with, necessarily, the
 * pointer over the toast - and the flag is raised, the last toast leaves and
 * the listeners come down in the same commit, so the `pointerleave` that would
 * have lowered it arrives at nothing. Every toast after that mounted into a
 * provider that believed it was paused and started no timer at all, so the
 * only way to clear one was by hand, which is precisely what re-armed it.
 *
 * So: the three lifetimes, the three things that legitimately stop the clock,
 * and - the one that matters - that none of them can stick.
 */

/** What the tone table promises, named so a failure says which rule broke. */
const RECEIPT = 6_000;
const REFUSAL = 12_000;
const OFFER = 20_000;

function Bench() {
  const { notify } = useToast();
  const count = useRef(0);
  const next = () => {
    count.current += 1;
    return count.current.toString();
  };
  return (
    <>
      <button
        type="button"
        onClick={() => {
          notify({ title: `Copied ${next()}`, tone: 'ok' });
        }}
      >
        Copy
      </button>
      <button
        type="button"
        onClick={() => {
          notify({ title: `File rejected ${next()}`, tone: 'error' });
        }}
      >
        Reject
      </button>
      <button
        type="button"
        onClick={() => {
          notify({ title: `Nothing to drop that on ${next()}`, tone: 'warn' });
        }}
      >
        Refuse
      </button>
      <button
        type="button"
        onClick={() => {
          notify({
            title: `Deleted node ${next()}`,
            tone: 'warn',
            action: { label: 'Undo', altText: 'Press Ctrl+Z', onAction: () => undefined },
          });
        }}
      >
        Delete
      </button>
    </>
  );
}

function mountBench() {
  render(
    <ToastProvider>
      <Bench />
    </ToastProvider>,
  );
}

function press(name: string) {
  fireEvent.click(screen.getByRole('button', { name }));
}

/** The Radix viewport itself - the element the pause listeners sit on. */
function viewport() {
  return screen.getByRole('list');
}

async function elapse(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function onScreen(text: string) {
  return screen.queryByText(text) !== null;
}

describe('How long a toast lives', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('takes a receipt down after six seconds, without being asked', async () => {
    mountBench();
    press('Copy');

    await elapse(RECEIPT - 1_000);
    expect(onScreen('Copied 1')).toBe(true);
    await elapse(1_000);
    expect(onScreen('Copied 1')).toBe(false);
  });

  /*
   * A refusal is the durable copy of something the shared live region may
   * already have overwritten, and it has to be read rather than noticed.
   */
  it('gives a refusal twice as long, worded as an error or as a warning alike', async () => {
    mountBench();
    press('Reject');
    press('Refuse');

    await elapse(RECEIPT + 1_000);
    expect(onScreen('File rejected 1')).toBe(true);
    expect(onScreen('Nothing to drop that on 2')).toBe(true);

    await elapse(REFUSAL - RECEIPT - 1_000);
    expect(onScreen('File rejected 1')).toBe(false);
    expect(onScreen('Nothing to drop that on 2')).toBe(false);
  });

  it('gives an offer twenty seconds, because it has to be reached and not just read', async () => {
    mountBench();
    press('Delete');

    await elapse(REFUSAL + 1_000);
    expect(onScreen('Deleted node 1')).toBe(true);
    await elapse(OFFER - REFUSAL - 1_000);
    expect(onScreen('Deleted node 1')).toBe(false);
  });

  /*
   * THE BUG, AS THE USER MET IT.
   *
   * Dismissing one by hand means the pointer was over the viewport when its
   * contents were removed. Nothing about that should have any bearing on the
   * next notification, and it used to decide the fate of every one.
   */
  it('still expires the next one after a toast was dismissed by hand under the pointer', async () => {
    mountBench();
    press('Copy');
    fireEvent.pointerMove(viewport());
    press('Dismiss notification');
    await elapse(0);
    expect(onScreen('Copied 1')).toBe(false);

    press('Copy');
    await elapse(RECEIPT);
    expect(onScreen('Copied 2')).toBe(false);
  });

  it('still expires the next one after an Undo was taken under the pointer', async () => {
    mountBench();
    press('Delete');
    fireEvent.pointerMove(viewport());
    press('Undo');
    await elapse(0);
    expect(onScreen('Deleted node 1')).toBe(false);

    press('Copy');
    await elapse(RECEIPT);
    expect(onScreen('Copied 2')).toBe(false);
  });

  /*
   * Pointer and focus both stop the clock, and the focus half is what makes
   * twenty seconds defensible rather than a guess: the window only has to
   * cover ARRIVING at the offer. Once F8 has put somebody inside the viewport,
   * reading it and pressing Undo happen with the countdown stopped.
   */
  it('stops the countdown under the pointer, and starts it again on the way out', async () => {
    mountBench();
    press('Copy');

    fireEvent.pointerMove(viewport());
    await elapse(RECEIPT * 5);
    expect(onScreen('Copied 1')).toBe(true);

    fireEvent.pointerLeave(viewport());
    await elapse(RECEIPT - 1_000);
    expect(onScreen('Copied 1')).toBe(true);
    await elapse(1_000);
    expect(onScreen('Copied 1')).toBe(false);
  });

  it('stops the countdown while focus is inside it, so reaching an offer is not a race', async () => {
    mountBench();
    press('Delete');

    act(() => {
      screen.getByRole('button', { name: 'Undo' }).focus();
    });
    await elapse(OFFER * 3);
    expect(onScreen('Deleted node 1')).toBe(true);

    act(() => {
      screen.getByRole('button', { name: 'Copy' }).focus();
    });
    await elapse(OFFER);
    expect(onScreen('Deleted node 1')).toBe(false);
  });

  /*
   * A hidden tab throttles its timers rather than stopping them, so without
   * this a message spends its whole life on a screen nobody is looking at and
   * the user comes back to nothing. The mechanism can be produced on its own -
   * see CONTRIBUTING - so it is a unit test rather than a manual check.
   */
  it('does not spend a toast on a tab nobody is looking at', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    mountBench();
    press('Reject');
    fireEvent(document, new Event('visibilitychange'));

    await elapse(REFUSAL * 3);
    expect(onScreen('File rejected 1')).toBe(true);

    hidden.mockReturnValue(false);
    fireEvent(document, new Event('visibilitychange'));
    await elapse(REFUSAL);
    expect(onScreen('File rejected 1')).toBe(false);
    hidden.mockRestore();
  });
});

/**
 * SEVERAL AT ONCE.
 *
 * The second half of the report: after a few deletions the user was closing
 * notifications by hand. Timing out again fixes the waiting; it does not fix
 * the pile, because five deletions inside twenty seconds is still five
 * notifications stacked over the canvas they are about.
 */
describe('When several arrive at once', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the three most recent and drops what has been overtaken', async () => {
    mountBench();
    press('Delete');
    press('Delete');
    press('Delete');
    press('Delete');
    press('Delete');
    await elapse(0);

    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(3);
    expect(onScreen('Deleted node 1')).toBe(false);
    expect(onScreen('Deleted node 2')).toBe(false);
    expect(onScreen('Deleted node 5')).toBe(true);
  });

  /*
   * Each carries its own countdown rather than sharing one, so a burst cannot
   * leave the last arrival holding the first one's remaining time.
   */
  it('leaves none of them behind', async () => {
    mountBench();
    press('Copy');
    await elapse(RECEIPT / 2);
    press('Reject');
    press('Delete');

    await elapse(RECEIPT / 2);
    expect(onScreen('Copied 1')).toBe(false);
    expect(onScreen('File rejected 2')).toBe(true);

    await elapse(REFUSAL);
    expect(onScreen('File rejected 2')).toBe(false);
    expect(onScreen('Deleted node 3')).toBe(true);

    await elapse(OFFER);
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });
});
