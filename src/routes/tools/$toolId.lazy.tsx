import { createLazyFileRoute, Link } from '@tanstack/react-router';

import { Panel } from '@/components/Panel';
import { getManifestEntry, isToolId } from '@/features/registry';
import { ToolRunner } from '@/features/toolrunner';

import styles from './tools.module.css';

export function ToolPage() {
  const { toolId } = Route.useParams();

  // The id comes from the URL, so it is untrusted until narrowed. `isToolId` is
  // a type guard: after this check TypeScript knows `toolId` is a real ToolId.
  if (!isToolId(toolId)) {
    return (
      <div className={styles.page}>
        <header className={styles.head}>
          <p className={styles.eyebrow}>Not found</p>
          <h1 className={styles.title}>No such tool</h1>
          <p className={styles.lede}>
            There is no tool with the id &ldquo;{toolId}&rdquo;.{' '}
            <Link to="/tools" className={styles.breadcrumbLink}>
              Browse every tool
            </Link>
            .
          </p>
        </header>
      </div>
    );
  }

  const entry = getManifestEntry(toolId);

  return (
    <div className={styles.page}>
      <header className={styles.toolHead}>
        <p className={styles.breadcrumb}>
          <Link to="/tools" className={styles.breadcrumbLink}>
            Tools
          </Link>
          {' / '}
          {entry.category}
        </p>
        <h1 className={styles.title}>{entry.name}</h1>
        <p className={styles.lede}>{entry.summary}</p>
      </header>

      <ToolRunner entry={entry} />

      <Panel title="Privacy" footer="No network access is possible from this page">
        <p className={styles.lede}>
          This tool runs entirely in your browser. The page&rsquo;s Content-Security-Policy sets{' '}
          <code>connect-src &apos;none&apos;</code>, so the browser itself refuses any attempt to
          send your input anywhere &mdash; it is enforced, not merely promised.
        </p>
      </Panel>
    </div>
  );
}

export const Route = createLazyFileRoute('/tools/$toolId')({ component: ToolPage });
