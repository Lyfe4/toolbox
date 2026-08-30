import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ROUTE_PENDING_MIN_MS, ROUTE_PENDING_MS } from './navigation';
import { useDelayedPending } from './useDelayedPending';

/**
 * The two thresholds, tested where they can be tested deterministically.
 *
 * A clock is injected so `Date.now` and the fake timers advance together;
 * without that the hook reads a real wall clock while the timers are
 * simulated, and the minimum-visible calculation comes out nonsense.
 */
function clock() {
  let now = 0;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
      act(() => {
        vi.advanceTimersByTime(ms);
      });
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a wait shorter than the threshold', () => {
  it('never shows anything', () => {
    const time = clock();
    const { result, rerender } = renderHook(({ pending }) => useDelayedPending(pending, time.now), {
      initialProps: { pending: true },
    });

    time.advance(ROUTE_PENDING_MS - 10);
    expect(result.current).toBe(false);

    rerender({ pending: false });
    time.advance(1000);

    // The whole navigation came and went below the threshold, which is what
    // most of them do. Showing anything here is the flicker.
    expect(result.current).toBe(false);
  });

  it.each([0, 1, 40, 70, ROUTE_PENDING_MS - 1])(
    'stays silent for a %ims navigation',
    (duration) => {
      const time = clock();
      const { result, rerender } = renderHook(
        ({ pending }) => useDelayedPending(pending, time.now),
        { initialProps: { pending: true } },
      );

      time.advance(duration);
      rerender({ pending: false });
      time.advance(1000);

      expect(result.current).toBe(false);
    },
  );
});

describe('a wait longer than the threshold', () => {
  it('shows once the threshold passes', () => {
    const time = clock();
    const { result } = renderHook(({ pending }) => useDelayedPending(pending, time.now), {
      initialProps: { pending: true },
    });

    time.advance(ROUTE_PENDING_MS - 1);
    expect(result.current).toBe(false);

    time.advance(2);
    expect(result.current).toBe(true);
  });

  it('holds for the minimum even when the wait ends immediately after', () => {
    const time = clock();
    const { result, rerender } = renderHook(({ pending }) => useDelayedPending(pending, time.now), {
      initialProps: { pending: true },
    });

    time.advance(ROUTE_PENDING_MS + 1);
    expect(result.current).toBe(true);

    // Navigation finishes 5ms later. Without the minimum this would be a
    // 5ms flash - which reads as a glitch, not as an explanation.
    time.advance(5);
    rerender({ pending: false });
    expect(result.current).toBe(true);

    time.advance(ROUTE_PENDING_MIN_MS - 10);
    expect(result.current).toBe(true);

    time.advance(20);
    expect(result.current).toBe(false);
  });

  it('hides straight away when it has already been up long enough', () => {
    const time = clock();
    const { result, rerender } = renderHook(({ pending }) => useDelayedPending(pending, time.now), {
      initialProps: { pending: true },
    });

    /*
     * In two steps, not one. The clock is read when the show-timer FIRES, so
     * jumping past the threshold in a single advance would stamp the moment
     * as the end of the jump and make the hold look like it had just started.
     * Real time does not arrive in one lump either.
     */
    time.advance(ROUTE_PENDING_MS + 1);
    expect(result.current).toBe(true);

    time.advance(ROUTE_PENDING_MIN_MS + 100);
    rerender({ pending: false });

    // No extra hold: it has been readable for well over the minimum already.
    expect(result.current).toBe(false);
  });
});

describe('navigations in quick succession', () => {
  it('does not show for a burst of fast ones', () => {
    const time = clock();
    const { result, rerender } = renderHook(({ pending }) => useDelayedPending(pending, time.now), {
      initialProps: { pending: false },
    });

    for (let i = 0; i < 5; i += 1) {
      rerender({ pending: true });
      time.advance(30);
      rerender({ pending: false });
      time.advance(30);
      expect(result.current).toBe(false);
    }
  });

  it('cancels a pending show when the navigation finishes first', () => {
    const time = clock();
    const { result, rerender } = renderHook(({ pending }) => useDelayedPending(pending, time.now), {
      initialProps: { pending: true },
    });

    time.advance(ROUTE_PENDING_MS - 20);
    rerender({ pending: false });

    // The timer that would have shown it must be cleared, not merely ignored.
    time.advance(500);
    expect(result.current).toBe(false);
  });
});
