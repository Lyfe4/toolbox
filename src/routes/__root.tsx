import { createRootRoute, Link, Outlet } from '@tanstack/react-router';

import { RouteProgress } from '@/app/RouteProgress';
import { PortIcon } from '@/components/Icon';
import { SkipLink } from '@/components/SkipLink';
import { ToastProvider } from '@/components/Toast';
import { useThemeSync } from '@/features/theme';

import styles from './__root.module.css';

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

export const Route = createRootRoute({ component: RootLayout });
