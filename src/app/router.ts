import { createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';

import { ROUTE_PENDING_MIN_MS, ROUTE_PENDING_MS, ROUTE_PRELOAD_DELAY_MS } from './navigation';

/**
 * Router configuration, tuned to the wait it actually has.
 *
 * The two pending thresholds and the reasoning behind them live in
 * navigation.ts, because RouteProgress applies the same numbers to the global
 * bar - `defaultPendingMs` gates a ROUTE's pendingComponent, not the router's
 * status, so a bar wired to the status alone flashes on every click.
 *
 * `defaultPreload: 'intent'` is the half that removes the delay rather than
 * decorating it: hovering or focusing a nav link starts the import, so by the
 * time the click lands the chunk is usually already there. Measured, that
 * takes a cold /tools from 205ms to 47ms and /styleguide from 269ms to 92ms
 * on a connection with 150ms of per-chunk latency.
 *
 * Preloading is a runtime dynamic import and does NOT move a chunk into the
 * initial bundle; the budget check holds it to that.
 */
export const router = createRouter({
  routeTree,
  defaultPendingMs: ROUTE_PENDING_MS,
  defaultPendingMinMs: ROUTE_PENDING_MIN_MS,
  defaultPreload: 'intent',
  defaultPreloadDelay: ROUTE_PRELOAD_DELAY_MS,
});

// Declaration merging: this tells TanStack Router's own types about *our*
// router instance. Because of it, `<Link to="/nope" />` is a compile error
// rather than a broken link discovered at runtime.
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
