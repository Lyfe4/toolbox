import { type ReactNode, useId } from 'react';

import { ErrorIcon } from '@/components/Icon';
import { cx } from '@/lib/cx';

import styles from './Field.module.css';

/**
 * The wiring a control needs in order to be correctly described. Field builds
 * this and hands it to you; you spread it onto whatever control you render.
 *
 * Every property is present but may be `undefined`, rather than optional. That
 * matters under `exactOptionalPropertyTypes`: it makes the object safe to
 * spread onto an element even when there is no description or error.
 */
export interface FieldControlProps {
  readonly id: string;
  readonly 'aria-describedby': string | undefined;
  readonly 'aria-invalid': true | undefined;
  readonly required: boolean | undefined;
}

export interface FieldProps {
  readonly label: string;
  readonly description?: string;
  /** When present the field is in an error state and this text is announced. */
  readonly error?: string;
  readonly required?: boolean;
  readonly className?: string;
  /**
   * A RENDER PROP: instead of children being elements, they are a function
   * that receives the generated ids and returns the control. That is what lets
   * Field guarantee label/description/error are actually wired to the input,
   * without having to guess at or clone its children.
   */
  readonly children: (control: FieldControlProps) => ReactNode;
}

export function Field({
  label,
  description,
  error,
  required = false,
  className,
  children,
}: FieldProps) {
  const id = useId();
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;

  // The error is listed last so screen readers read the hint before the fault.
  const describedBy = cx(
    description !== undefined && descriptionId,
    error !== undefined && errorId,
  );

  const control: FieldControlProps = {
    id,
    'aria-describedby': describedBy === '' ? undefined : describedBy,
    'aria-invalid': error !== undefined ? true : undefined,
    required: required ? true : undefined,
  };

  return (
    <div className={cx(styles.field, className)}>
      <div className={styles.labelRow}>
        <label className={styles.label} htmlFor={id}>
          {label}
        </label>
        {required ? (
          <span className={styles.required} aria-hidden="true">
            *
          </span>
        ) : null}
      </div>

      {description !== undefined ? (
        <p className={styles.description} id={descriptionId}>
          {description}
        </p>
      ) : null}

      {children(control)}

      {/*
        role="alert" so a validation failure appearing after submit is
        announced immediately, rather than only when focus reaches the field.
      */}
      {error !== undefined ? (
        <p className={styles.error} id={errorId} role="alert">
          <ErrorIcon size={12} />
          {error}
        </p>
      ) : null}
    </div>
  );
}
