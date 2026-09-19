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
  /**
   * Whether the description is PAINTED. It is announced either way.
   *
   * The element is never removed and never leaves `aria-describedby`, so a
   * screen reader hears the same sentence at the same moment - when the control
   * takes focus - in both states. What this decides is whether the sentence
   * also occupies two lines of a 300px rail forever. Only the tool options
   * panel sets it; see `features/toolrunner/optionNotes.ts` for why that is a
   * preference and why it defaults to off.
   */
  readonly descriptionVisible?: boolean;
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
  descriptionVisible = true,
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
        <p
          className={cx(styles.description, !descriptionVisible && styles.descriptionQuiet)}
          id={descriptionId}
        >
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
