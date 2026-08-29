import styles from './VisuallyHidden.module.css';

import type { ReactNode } from 'react';

export interface VisuallyHiddenProps {
  readonly children: ReactNode;
  /** Render as a <span> (default) or a <div>, depending on the surrounding flow. */
  readonly as?: 'span' | 'div';
}

/** Text that is available to screen readers but not painted on screen. */
export function VisuallyHidden({ children, as: Tag = 'span' }: VisuallyHiddenProps) {
  return <Tag className={styles.root}>{children}</Tag>;
}
