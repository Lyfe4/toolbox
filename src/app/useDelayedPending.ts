import { useEffect, useRef, useState } from 'react';

import { ROUTE_PENDING_MIN_MS, ROUTE_PENDING_MS } from './navigation';

/**
 * Turns "is pending" into "should be shown".
 *
 * TanStack Router's `state.status` flips to 'pending' the instant a
 * navigation starts - on every navigation, including the 0-3ms ones.
 * `defaultPendingMs` gates a ROUTE's pendingComponent, not the router status,
 * so an indicator wired straight to the status flashes on every click. This
 * applies the same two rules the router uses:
 *
 *   - nothing appears until the wait passes ROUTE_PENDING_MS
 *   - once it appears it stays at least ROUTE_PENDING_MIN_MS, so a wait that
 *     ends just past the threshold is readable rather than a blink
 *
 * Its own module because it is the only part with logic worth testing on its
 * own: in jsdom a route's dynamic import takes over a second to transform, so
 * an end-to-end "was this navigation fast" test would be measuring the test
 * runner. The real fast-versus-slow distinction is asserted in
 * scripts/cross-browser-check.mjs, against a real browser.
 */
export function useDelayedPending(pending: boolean, now: () => number = Date.now): boolean {
  const [shown, setShown] = useState(false);
  const shownAt = useRef(0);

  useEffect(() => {
    if (pending) {
      /*
       * Already up: do nothing. The effect re-runs when `shown` flips, and
       * arming a second show-timer here would re-stamp `shownAt` a further
       * ROUTE_PENDING_MS later - so the minimum-visible hold would be measured
       * from the wrong moment and the bar would linger past its welcome.
       */
      if (shown) return undefined;

      const timer = window.setTimeout(() => {
        shownAt.current = now();
        setShown(true);
      }, ROUTE_PENDING_MS);

      return () => {
        window.clearTimeout(timer);
      };
    }

    if (!shown) return undefined;

    const remaining = ROUTE_PENDING_MIN_MS - (now() - shownAt.current);
    if (remaining <= 0) {
      setShown(false);
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setShown(false);
    }, remaining);

    return () => {
      window.clearTimeout(timer);
    };
  }, [pending, shown, now]);

  return shown;
}
