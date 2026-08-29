import styles from '@/components/TextInput/TextInput.module.css';
import { cx } from '@/lib/cx';

import type { ComponentPropsWithRef } from 'react';

// Shares the TextInput stylesheet on purpose: a textarea is the same control
// with a different box, and duplicating the rules would let them drift.

export interface TextAreaProps extends ComponentPropsWithRef<'textarea'> {
  readonly invalid?: boolean;
}

export function TextArea({ invalid = false, className, rows = 4, ...rest }: TextAreaProps) {
  return (
    <textarea
      rows={rows}
      className={cx(styles.input, styles.textarea, invalid && styles.invalid, className)}
      {...rest}
    />
  );
}
