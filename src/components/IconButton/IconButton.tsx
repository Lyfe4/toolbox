import { cx } from '@/lib/cx';

import styles from './IconButton.module.css';

import type { ComponentPropsWithRef, ReactNode } from 'react';

/**
 * An icon on its own has no accessible name, so this component makes one
 * mandatory.
 *
 * `Omit<..., 'children' | 'aria-label' | 'aria-labelledby'>` deletes the three
 * escape hatches: you cannot pass text children, and you cannot hand-roll a
 * label that might be missing. The only way to name the control is `label`,
 * which is required - so a nameless icon button will not compile.
 */
export interface IconButtonProps extends Omit<
  ComponentPropsWithRef<'button'>,
  'children' | 'aria-label' | 'aria-labelledby'
> {
  /** Announced to screen readers and shown as the native tooltip. */
  readonly label: string;
  readonly icon: ReactNode;
  readonly size?: 'sm' | 'md';
}

export function IconButton({
  label,
  icon,
  size = 'md',
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cx(styles.button, styles[size], className)}
      {...rest}
    >
      {icon}
    </button>
  );
}
