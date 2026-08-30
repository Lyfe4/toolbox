/**
 * How long a navigation may take before it is worth saying so.
 *
 * These live in their own module because both ends need them and importing
 * one from the other would close a cycle: RouteProgress is rendered by the
 * root route, the root route is part of the route tree, and the route tree is
 * what the router is built from. Reaching back from the component to the
 * router instance made that a real circular import, and the app rendered
 * nothing at all.
 *
 * MEASURED, on the production build in Firefox, before any of this existed:
 *
 *   route          cold (localhost)   cold (+150ms/chunk)   warm
 *   /tools               126 ms             205 ms         22-34 ms
 *   /styleguide          132 ms             269 ms         54-71 ms
 *   /                      7 ms               5 ms          0-3 ms
 *
 * The wait is bimodal - a warm navigation is imperceptible and a cold one
 * over a real connection is a beat - so feedback on every navigation would
 * flicker on most of them.
 *
 * AFTER, with preloading on intent, same build and browser:
 *
 *   route          no prefetch   after a hover   change
 *   /tools           206 ms          36 ms        -83%
 *   /styleguide      243 ms          95 ms        -61%
 *
 * (both at +150ms/chunk, which is the case the thresholds were chosen for.)
 * The wait does not vanish - hovering only buys as long as the pointer
 * rested - so the indicator still earns its place on a cold click.
 */

/**
 * Nothing appears until a navigation has taken this long.
 *
 * Above every warm figure above, and above both cold ones on localhost, so
 * the indicator stays silent unless the wait is genuinely perceptible.
 */
export const ROUTE_PENDING_MS = 150;

/**
 * Once it appears, it stays at least this long.
 *
 * Without it a wait that ends at 210ms would show a bar for 60ms, which is a
 * flash rather than feedback - and reads as a glitch, not as an explanation.
 */
export const ROUTE_PENDING_MIN_MS = 400;

/**
 * How long the pointer must rest on a link before its chunk is fetched.
 *
 * Enough that sweeping the pointer across the header does not fire three
 * imports, short enough that a deliberate hover is well ahead of the click.
 */
export const ROUTE_PRELOAD_DELAY_MS = 80;
