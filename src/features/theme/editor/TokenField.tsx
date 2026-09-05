import { useState } from 'react';

import { Button, Field, TextInput, VisuallyHidden } from '@/components';
import { cx } from '@/lib/cx';
import { formatColor, parseColor } from '@/tools/color-convert/color';

import styles from './themeEditor.module.css';

import type { TokenDescriptor } from '../tokenGroups';

/**
 * Canonical form for a colour the user typed, or null if it is not one.
 *
 * The colour tool's parser decides what counts, so this field accepts exactly
 * the notations that tool converts between - hex, rgb(), hsl() and oklch() -
 * and nothing has to be taught about colour syntax twice.
 */
export function canonicalColour(input: string): string | null {
  const parsed = parseColor(input);
  return parsed.ok ? formatColor(parsed.value, 'hex', 3) : null;
}

/**
 * The value a native colour input can hold: six hex digits, no alpha.
 *
 * `<input type="color">` has no way to express transparency, so a token with
 * an alpha channel shows the picker its opaque twin. The text field remains
 * the complete control - which is the point of it.
 */
function pickerValue(colour: string | null): string {
  if (colour === null) return '#000000';
  const parsed = parseColor(colour);
  if (!parsed.ok) return '#000000';
  return formatColor({ ...parsed.value, a: 1 }, 'hex', 3);
}

export interface TokenFieldProps {
  readonly descriptor: TokenDescriptor;
  /** The colour in force: the override if there is one, otherwise inherited. */
  readonly value: string;
  /** What the base preset says, shown when the token has been overridden. */
  readonly inherited: string;
  readonly overridden: boolean;
  readonly onChange: (canonical: string) => void;
  readonly onReset: () => void;
}

export function TokenField({
  descriptor,
  value,
  inherited,
  overridden,
  onChange,
  onReset,
}: TokenFieldProps) {
  /*
   * TWO PIECES OF STATE FOR ONE VALUE, and the second one is why.
   *
   * `typed` is the literal text in the box, which is not the same thing as the
   * token's value: "oklch(0.6 0.2 40)" and "#c2683a" can be the same colour,
   * and re-writing what somebody typed while they are still typing it is the
   * single most irritating thing a colour field can do.
   *
   * `seen` is the last value this field pushed or accepted from outside. When
   * `value` differs from it, something else changed the token - an undo, a
   * reset, a whole-theme change - and the box has to follow. When they agree,
   * the change came from this box and the text is left alone.
   *
   * Assigning state during render is React's documented way to adjust state
   * when a prop changes; it is handled before the browser sees anything, with
   * no extra paint.
   */
  const [typed, setTyped] = useState(value);
  const [seen, setSeen] = useState(value);
  const [invalid, setInvalid] = useState(false);

  if (value !== seen) {
    setSeen(value);
    // Only overwrite the text when it no longer MEANS the current value, so
    // typing a valid `hsl(...)` does not have the box rewritten to hex.
    if (canonicalColour(typed) !== value) {
      setTyped(value);
      setInvalid(false);
    }
  }

  const commit = (next: string): void => {
    setTyped(next);
    const canonical = canonicalColour(next);
    if (canonical === null) {
      // Rejected, and the draft is untouched: an unparseable colour can never
      // become part of the theme, so the page cannot be corrupted by typing.
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setSeen(canonical);
    onChange(canonical);
  };

  const canonical = canonicalColour(typed);
  const error = invalid
    ? 'Not a colour. Try #3b82f6, rgb(59 130 246), hsl(217 91% 60%) or oklch(0.62 0.19 259).'
    : undefined;

  return (
    <Field
      label={descriptor.token}
      description={descriptor.hint}
      {...(error === undefined ? {} : { error })}
      className={cx(styles.tokenField)}
    >
      {(control) => (
        <div className={styles.tokenControls}>
          {/*
            The native picker. No library: it is keyboard-operable, respects
            the platform's own colour tools, weighs nothing, and the text field
            beside it is a complete alternative for anyone it does not suit.
          */}
          <input
            type="color"
            className={styles.picker}
            value={pickerValue(canonical ?? value)}
            aria-label={`${descriptor.token}, colour picker`}
            onChange={(event) => {
              commit(event.target.value);
            }}
          />

          <TextInput
            {...control}
            className={styles.tokenInput}
            value={typed}
            invalid={invalid}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              commit(event.target.value);
            }}
          />

          <Button
            size="sm"
            variant="ghost"
            disabled={!overridden}
            onClick={onReset}
            className={styles.resetButton}
          >
            {/*
              THE WHOLE NAME IS IN ONE NODE, and the visible word is a copy.
              The obvious spelling - "Reset" then a hidden " surface-base" -
              produces "Resetsurface-base": the accessible-name algorithm trims
              each child's text before joining, so a leading space inside the
              hidden half does not survive. Measured, not assumed.

              The visible word is still contained in the accessible name, so
              speech control works on what is written on the button.
            */}
            <VisuallyHidden>Reset {descriptor.token}</VisuallyHidden>
            <span aria-hidden="true">Reset</span>
          </Button>

          <p className={styles.tokenReadout}>
            {/*
              The resolved value, always, alongside whatever was typed. When
              they are the same string this is a repetition; when they are not,
              it is the answer to "what did that actually become".
            */}
            <span className={styles.tokenCanonical}>{canonical ?? '—'}</span>
            <span className={styles.tokenOrigin}>
              {overridden ? `overrides ${inherited}` : 'inherited'}
            </span>
          </p>
        </div>
      )}
    </Field>
  );
}
