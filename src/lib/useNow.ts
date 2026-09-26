import { useSyncExternalStore } from 'react';

/**
 * The reader's clock, for the few things on screen that are statements about
 * NOW rather than about a result.
 *
 * A tool's output is cached on its inputs and reproduced by a share link, so
 * nothing on a port may depend on when it was computed - jwt-decode's
 * `expired` did, and a canvas node kept calling an expired token live for as
 * long as the cache held the run. What does depend on the moment ("has this
 * expired?", "in 5 minutes") is computed as it is drawn, from this, and says
 * whose clock it is.
 *
 * ONE INTERVAL FOR EVERY SUBSCRIBER, running only while something is
 * subscribed. A second is the finest unit anything here prints, and the
 * components that subscribe are deliberately the small ones - a strip, a
 * parenthesis - so a tick re-renders a phrase, not a token's payload.
 *
 * LATE TIMERS ARE THE CASE THAT MATTERS. A hidden tab's interval is throttled
 * to once a minute or worse, and a laptop lid stops it outright; the first
 * thing somebody does on coming back is read the screen. So becoming visible,
 * and being restored from the back-forward cache, both read the clock at once
 * rather than waiting for the next tick.
 */

const TICK_MS = 1000;

const listeners = new Set<() => void>();
let current = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  current = Date.now();
  for (const listener of listeners) listener();
}

function onVisibility(): void {
  if (document.visibilityState !== 'hidden') tick();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    timer = setInterval(tick, TICK_MS);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', tick);
  }
  // The snapshot a render read before this subscription may already be old.
  tick();

  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    if (timer !== null) clearInterval(timer);
    timer = null;
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pageshow', tick);
  };
}

/*
 * Stable between two reads in one render, which React checks: with nobody
 * subscribed the clock is refreshed only once it is a tick away - either way,
 * because a clock can be set back - so two calls a millisecond apart return the
 * same value. Subscribing reads it exactly.
 */
function snapshot(): number {
  if (listeners.size === 0 && Math.abs(Date.now() - current) >= TICK_MS) current = Date.now();
  return current;
}

function noSubscription(): () => void {
  return () => undefined;
}

/**
 * Epoch milliseconds by this device's clock, re-rendering as it moves.
 *
 * `pinned` replaces it, for a test that wants one frozen moment; nothing is
 * subscribed then.
 */
export function useNow(pinned: number | null = null): number {
  const live = useSyncExternalStore(
    pinned === null ? subscribe : noSubscription,
    snapshot,
    () => 0,
  );
  return pinned ?? live;
}
