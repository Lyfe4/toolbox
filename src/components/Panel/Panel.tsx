import { type ComponentPropsWithRef, type ReactNode, useId } from 'react';

import { cx } from '@/lib/cx';

import styles from './Panel.module.css';

/**
 * `Omit<..., 'title'>` is load-bearing: a <section> already has an HTML `title`
 * attribute typed as `string`, and ours takes a ReactNode. Removing the native
 * one lets our richer version take the name.
 */
export interface PanelProps extends Omit<ComponentPropsWithRef<'section'>, 'title'> {
  /** Rendered in the title bar as a tight uppercase mono label. */
  readonly title?: ReactNode;
  /** Controls pinned to the right of the title bar. */
  readonly actions?: ReactNode;
  readonly footer?: ReactNode;
  /** Drop the body padding, for panels that host their own edge-to-edge content. */
  readonly flush?: boolean;
  readonly children: ReactNode;
}

export function Panel({
  title,
  actions,
  footer,
  flush = false,
  className,
  children,
  ...rest
}: PanelProps) {
  // useId gives a stable, collision-free id on both server and client. It is
  // what lets the <section> point at its own heading for its accessible name.
  const titleId = useId();
  const hasTitleBar = title !== undefined || actions !== undefined;

  return (
    <section
      className={cx(styles.panel, className)}
      // A landmark with no name is noise in a screen reader's landmark list,
      // so only claim one when there is actually a title to name it with.
      {...(title !== undefined ? { 'aria-labelledby': titleId } : {})}
      {...rest}
    >
      {hasTitleBar ? (
        <div className={styles.titleBar}>
          {title !== undefined ? (
            <h2 className={styles.title} id={titleId}>
              {title}
            </h2>
          ) : (
            <span />
          )}
          {actions !== undefined ? <div className={styles.actions}>{actions}</div> : null}
        </div>
      ) : null}

      <div className={cx(styles.body, flush && styles.bodyFlush)}>{children}</div>

      {footer !== undefined ? <div className={styles.footer}>{footer}</div> : null}
    </section>
  );
}
