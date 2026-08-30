import { useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import styles from './RouteProgress.module.css';
import { useDelayedPending } from './useDelayedPending';

/** Human names for the routes, for what gets announced. */
const ROUTE_NAMES: Record<string, string> = {
  '/': 'Canvas',
  '/tools': 'Tools',
  '/styleguide': 'Styleguide',
};

function nameFor(pathname: string): string {
  const known = ROUTE_NAMES[pathname];
  if (known !== undefined) return known;
  // /tools/base64 and the like: the last segment is the tool.
  return pathname.split('/').filter(Boolean).at(-1) ?? 'Page';
}

/**
 * Feedback for a navigation that is taking long enough to notice.
 *
 * WHY IT LOOKS LIKE THIS
 *
 * A route change here is a dynamic import, so the wait is bimodal: a warm
 * navigation is 0-70ms and a cold one over a real connection is 200-270ms.
 * Anything that renders on every navigation would flicker on most of them, so
 * the router is configured with `defaultPendingMs` to stay silent below the
 * threshold and `defaultPendingMinMs` to hold long enough to read once it does
 * appear. This component only draws what the router has already decided is
 * worth showing.
 *
 * A bar rather than a spinner: a spinner says "something is happening
 * forever", where a bar that fills says "this is finite and it is moving". It
 * is indeterminate underneath - the import gives no progress events, and a
 * fake percentage would be a lie - but it reads as determinate because it
 * sweeps in one direction at a steady rate.
 *
 * The announcement is separate from the bar and outlives it: someone using a
 * screen reader gets nothing at all from a route change otherwise, because
 * the document does not reload and focus does not move.
 */
export function RouteProgress() {
  const pending = useRouterState({ select: (state) => state.status === 'pending' });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isPending = useDelayedPending(pending);

  const [announcement, setAnnouncement] = useState('');
  const previous = useRef(pathname);

  /*
   * Announced on ARRIVAL, not on departure. "Loading Tools" that never
   * resolves into "Tools" is worse than a single message once the page is
   * actually there, and the arrival is the moment the content changed.
   */
  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    setAnnouncement(`${nameFor(pathname)} loaded.`);
  }, [pathname]);

  /*
   * ONE element, not a fragment.
   *
   * The shell is a grid, and a fragment's children become grid items in their
   * own right - two extra rows in a two-row template, which pushed <main> into
   * an implicit auto row and collapsed the canvas to nothing. Anything
   * rendered into a layout has to be one box unless the layout says otherwise.
   */
  return (
    <div className={styles.root}>
      {/*
        aria-hidden: the bar is decorative, and the live region below carries
        the same information to assistive technology. Announcing both would
        mean saying it twice.
      */}
      <div
        className={styles.track}
        data-pending={isPending ? '' : undefined}
        data-testid="route-progress"
        aria-hidden="true"
      >
        <span className={styles.bar} />
      </div>

      <p className={styles.status} role="status" aria-live="polite" data-testid="route-announcer">
        {announcement}
      </p>
    </div>
  );
}
