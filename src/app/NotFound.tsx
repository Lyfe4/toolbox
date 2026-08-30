import { Link } from '@tanstack/react-router';

import { PortIcon } from '@/components/Icon';

import styles from './NotFound.module.css';

/**
 * The 404 view.
 *
 * Rendered by the router, not served as a separate document: `_redirects`
 * hands every unmatched path to index.html so the SPA boots and decides for
 * itself. That means an unknown URL is a 200 with this component inside, which
 * is the normal and correct arrangement for a client-routed site - the
 * alternative is a static 404.html that cannot know the route table.
 *
 * It states the path it could not find, because "not found" without saying
 * what was not found is a dead end. The path is rendered as text into a
 * `<code>`; it is never inserted as markup, and CSP would refuse to execute
 * anything in it regardless.
 */
export function NotFound({ pathname }: { readonly pathname?: string }) {
  return (
    <div className={styles.root}>
      <div className={styles.panel}>
        <span className={styles.glyph} aria-hidden="true">
          <PortIcon size={24} />
        </span>

        <p className={styles.code}>404</p>
        <h1 className={styles.title}>No patch here</h1>

        <p className={styles.body}>Nothing is wired to this path.</p>

        {/*
          The path on its own line rather than inline in the sentence. Inline,
          the chip's own padding put a visible gap before the full stop, and a
          long path would have had to wrap mid-sentence.
        */}
        {pathname === undefined ? null : <code className={styles.path}>{pathname}</code>}

        <nav className={styles.links} aria-label="Go to">
          <Link to="/" className={styles.link}>
            Canvas
          </Link>
          <Link to="/tools" className={styles.link}>
            Tools
          </Link>
        </nav>
      </div>
    </div>
  );
}
