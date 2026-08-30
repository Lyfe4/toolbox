import { createRootRoute, HeadContent, Link, Outlet, useRouterState } from '@tanstack/react-router';

import { pageMeta, SITE_META } from '@/app/head';
import { RouteProgress } from '@/app/RouteProgress';
import { PortIcon } from '@/components/Icon';
import { SkipLink } from '@/components/SkipLink';
import { ToastProvider } from '@/components/Toast';
import { useThemeSync } from '@/features/theme';

import styles from './__root.module.css';
import { NotFound } from './NotFound';

const MAIN_ID = 'main-content';

function RootLayout() {
  // Mounted once: keeps <html data-theme> in step with the store and follows
  // the OS setting while the selection is "system".
  useThemeSync();

  return (
    /*
     * ToastProvider is global: results and errors have to be announceable from
     * anywhere. TooltipProvider deliberately is NOT - it drags Radix's Popper
     * and floating-ui into the initial payload (measured: 34.9 kB raw / 12.0 kB
     * gzipped) for every visitor, including ones who only ever open /tools.
     * It is mounted per-route instead, by the routes that actually show
     * tooltips, so the cost is lazy and nobody loses a tooltip.
     */
    <ToastProvider>
      {/*
        Renders the title and meta tags for whichever route is matched. React
        hoists <title> and <meta> into <head> wherever they are rendered, so
        this does not have to sit in the document head itself.
      */}
      <HeadContent />

      <div className={styles.shell}>
        {/* First tab stop on every page. */}
        <SkipLink targetId={MAIN_ID} />

        <header className={styles.header}>
          <Link to="/" className={styles.wordmark}>
            <span className={styles.wordmarkGlyph} aria-hidden="true">
              <PortIcon size={16} />
            </span>
            Patchbay
          </Link>

          <nav className={styles.nav} aria-label="Views">
            <Link to="/" className={styles.navLink}>
              Home
            </Link>
            <Link to="/tools" className={styles.navLink}>
              Tools
            </Link>
            <Link to="/styleguide" className={styles.navLink}>
              Styleguide
            </Link>
          </nav>
        </header>

        {/*
          Directly under the header, so the feedback for "the page is
          changing" sits at the boundary between the thing that stayed and the
          thing that is being replaced.
        */}
        <RouteProgress />

        {/*
            tabIndex={-1} makes this focusable by script only, so the skip link
            can move focus here without adding a stop to the tab order.
          */}
        <main id={MAIN_ID} className={styles.main} tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </ToastProvider>
  );
}

/**
 * The 404 view, wrapped so it can name the path that missed.
 *
 * `notFoundComponent` is rendered in place of the outlet, so the header, the
 * theme and the skip link are all still there - a 404 is a state of the app,
 * not a different site.
 */
function RootNotFound() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return <NotFound pathname={pathname} />;
}

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: RootNotFound,
  // Site-wide defaults. A child route's `head` overrides only the tags it
  // names, so a route that forgets still gets a real title and description.
  head: () => ({ meta: [...pageMeta(), ...SITE_META] }),
});
