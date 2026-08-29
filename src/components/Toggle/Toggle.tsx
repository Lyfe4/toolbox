import { type ComponentPropsWithRef, useId } from 'react';

import { VisuallyHidden } from '@/components/VisuallyHidden';
import { cx } from '@/lib/cx';

import styles from './Toggle.module.css';

/**
 * The omitted props are the ones this component owns. `role` and `aria-checked`
 * are what make it a switch, and `onChange` is not how a <button> reports
 * changes - so none of them may be overridden from outside.
 */
export interface ToggleProps extends Omit<
  ComponentPropsWithRef<'button'>,
  'onChange' | 'children' | 'role' | 'aria-checked' | 'type' | 'value'
> {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  /** Required: a switch with no name is unusable with a screen reader. */
  readonly label: string;
  /** Hide the label visually while keeping it announced. */
  readonly labelHidden?: boolean;
}

/**
 * A two-state switch built on a real <button>.
 *
 * role="switch" + aria-checked is the WAI-ARIA pattern, and because the
 * element is a button it is keyboard-operable (Space/Enter) for free - no
 * div-with-onClick, no manual key handling.
 */
export function Toggle({
  checked,
  onCheckedChange,
  label,
  labelHidden = false,
  disabled,
  className,
  ...rest
}: ToggleProps) {
  const labelId = useId();

  return (
    <span className={cx(styles.root, className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        disabled={disabled}
        className={styles.track}
        onClick={() => {
          onCheckedChange(!checked);
        }}
        {...rest}
      >
        <span className={styles.thumb} />
      </button>
      {labelHidden ? (
        <VisuallyHidden>
          <span id={labelId}>{label}</span>
        </VisuallyHidden>
      ) : (
        <span className={styles.label} id={labelId}>
          {label}
        </span>
      )}
    </span>
  );
}
