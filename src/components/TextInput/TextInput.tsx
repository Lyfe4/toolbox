import { cx } from '@/lib/cx';

import styles from './TextInput.module.css';

import type { ComponentPropsWithRef } from 'react';

export interface TextInputProps extends ComponentPropsWithRef<'input'> {
  /** Paints the error treatment. Field sets aria-invalid for you as well. */
  readonly invalid?: boolean;
}

export function TextInput({ invalid = false, className, type = 'text', ...rest }: TextInputProps) {
  return (
    <input
      type={type}
      className={cx(styles.input, invalid && styles.invalid, className)}
      {...rest}
    />
  );
}
