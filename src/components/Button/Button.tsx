import { cx } from '@/lib/cx';

import styles from './Button.module.css';

import type { ComponentPropsWithRef } from 'react';

export type ButtonVariant = 'primary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

/**
 * `ComponentPropsWithRef<'button'>` is every prop a real <button> accepts,
 * including `ref`, `onClick` and `disabled`. Extending it means this component
 * is a drop-in replacement rather than a walled garden.
 */
export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  // Default to "button". A bare <button> inside a form submits it, which is
  // almost never what is wanted and is a classic source of surprise.
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(styles.button, styles[variant], styles[size], className)}
      {...rest}
    />
  );
}
