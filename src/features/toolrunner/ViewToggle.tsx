import { Button } from '@/components/Button';

import styles from './viewChrome.module.css';

/**
 * THE ONE TOGGLE EVERY OUTPUT VIEW USES.
 *
 * A view is a presentation of an output, never a replacement for it, so every
 * view that renders its payload as something other than the payload has to
 * offer the payload as well. That was true of two of the four views: the HTML
 * output had Source and Preview, the conversion report had Report and Raw -
 * with identical markup, identical hidden status line and two byte-identical
 * copies of the same CSS - and the diff and the regex report had no way to
 * reach their JSON at all. Three implementations of one decision, and a fourth
 * that had quietly opted out of it.
 *
 * THE RULE, now that there is one:
 *
 *   A view is `[rendering] [raw]`, in that order, with the rendering pressed
 *   by default - EXCEPT where the raw payload is the thing the person came
 *   for, in which case raw comes first and is the default. HTML source is the
 *   one case of that in the app: it is a developer tool, and a preview you
 *   have to dismiss before you can read the markup would be in the way.
 *
 * Two `aria-pressed` buttons describe the CONTROL - "Raw, pressed". The status
 * line describes the RESULT - "Showing the raw report". Both are needed, and
 * the second is the one a screen reader user is actually asking for, which is
 * why it is a `role="status"` rather than a visible label.
 *
 * Bytes are the deliberate exception, and ImageView explains why: their raw
 * payload is a file rather than text, so it is a Download that is always on
 * screen rather than a state you have to switch to.
 */
export interface ViewOption<T extends string> {
  readonly id: T;
  /** The button's label. */
  readonly label: string;
  /** What is on screen while this option is active, as a sentence. */
  readonly status: string;
}

export interface ViewToggleProps<T extends string> {
  /** The output's name. The group is announced as "<label> view". */
  readonly label: string;
  readonly options: readonly ViewOption<T>[];
  readonly value: T;
  readonly onChange: (id: T) => void;
}

export function ViewToggle<T extends string>({
  label,
  options,
  value,
  onChange,
}: ViewToggleProps<T>) {
  const active = options.find((option) => option.id === value);

  return (
    <div className={styles.toggle} role="group" aria-label={`${label} view`}>
      {options.map((option) => {
        const pressed = option.id === value;
        return (
          <Button
            key={option.id}
            size="sm"
            variant={pressed ? 'primary' : 'ghost'}
            aria-pressed={pressed}
            onClick={() => {
              onChange(option.id);
            }}
          >
            {option.label}
          </Button>
        );
      })}
      <span className={styles.status} role="status">
        {active?.status ?? ''}
      </span>
    </div>
  );
}
