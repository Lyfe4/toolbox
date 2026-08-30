/**
 * Registers the service worker that makes the app work offline.
 *
 * Three deliberate restraints:
 *
 *   - Production only. In dev the worker would sit between Vite and the page
 *     and serve yesterday's module to a hot reload, which is a genuinely
 *     miserable way to lose an afternoon.
 *   - After `load`. Registration competes with the first render for bandwidth
 *     and main-thread time otherwise, and nothing on the first visit needs it.
 *   - Failure is silent to the user and logged for a developer. Offline
 *     support is an enhancement; a browser that refuses to register (private
 *     mode, a policy, an unsupported engine) should still get a working app.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error: unknown) => {
      // console.warn, not console.log: the lint rule allows warn/error, and
      // this is genuinely a degraded state rather than a trace.
      console.warn('Patchbay: offline support unavailable.', error);
    });
  });
}
