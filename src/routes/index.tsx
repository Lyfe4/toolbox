import { createFileRoute } from '@tanstack/react-router';

import styles from './index.module.css';

/**
 * Exported separately from `Route` so tests can render the page on its own,
 * without standing up a router.
 */
export function HomePage() {
  return (
    <div className={styles.main}>
      <p className={styles.eyebrow}>Client-side developer toolbox</p>
      <h1 className={styles.title}>Patchbay</h1>
      <hr className={styles.rule} />
      <p className={styles.lede}>
        Small utilities laid out as modules on an infinite canvas, wired together so one
        tool&rsquo;s output becomes the next tool&rsquo;s input. Everything runs in this tab.
        Nothing you paste ever leaves your machine.
      </p>
      <p className={styles.status}>
        <span className={styles.statusDot} aria-hidden="true" />
        Design system online
      </p>
    </div>
  );
}

export const Route = createFileRoute('/')({ component: HomePage });
