import { createRootRoute, Link, Outlet } from '@tanstack/react-router';

import { PortIcon } from '@/components/Icon';
import { SkipLink } from '@/components/SkipLink';
import { ToastProvider } from '@/components/Toast';
import { TooltipProvider } from '@/components/Tooltip';
import { useThemeSync } from '@/features/theme';

import styles from './__root.module.css';

const MAIN_ID = 'main-content';

function RootLayout() {
  // Mounted once: keeps <html data-theme> in step with the store and follows
  // the OS setting while the selection is "system".
  useThemeSync();

  return (
    <TooltipProvider>
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

            <nav className={styles.nav} aria-label="Main">
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
            tabIndex={-1} makes this focusable by script only, so the skip link
            can move focus here without adding a stop to the tab order.
          */}
          <main id={MAIN_ID} className={styles.main} tabIndex={-1}>
            <Outlet />
          </main>
        </div>
      </ToastProvider>
    </TooltipProvider>
  );
}

export const Route = createRootRoute({ component: RootLayout });
