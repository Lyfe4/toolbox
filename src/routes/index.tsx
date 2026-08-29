import { createFileRoute } from '@tanstack/react-router';

import styles from './index.module.css';

/**
 * Exported separately from `Route` so tests can render the page on its own,
 * without standing up a router.
 */
export function HomePage() {
  return (
    <main className={styles.main}>
      <h1 className={styles.title}>Patchbay</h1>
    </main>
  );
}

export const Route = createFileRoute('/')({ component: HomePage });
