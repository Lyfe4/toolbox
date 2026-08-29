import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { CloseIcon } from '@/components/Icon';
import { IconButton } from '@/components/IconButton';
import { TextInput } from '@/components/TextInput';
import { VisuallyHidden } from '@/components/VisuallyHidden';

import styles from './canvas.module.css';

export interface DialogOption {
  readonly id: string;
  readonly name: string;
  readonly meta: string;
  readonly detail: string;
  /** Options sharing a group are rendered under one heading. */
  readonly group: string;
}

export interface CommandDialogProps {
  readonly title: string;
  readonly searchLabel: string;
  readonly placeholder: string;
  readonly options: readonly DialogOption[];
  readonly emptyMessage: string;
  readonly onChoose: (id: string) => void;
  readonly onClose: () => void;
  readonly footer?: ReactNode;
}

/**
 * A searchable, keyboard-driven chooser.
 *
 * Shared by the tool palette and the keyboard connection flow, because both
 * are the same interaction: filter a list, move through it, commit one.
 *
 * The pattern is the ARIA combobox-with-listbox one. The text input keeps
 * focus throughout and `aria-activedescendant` points at the highlighted row,
 * so arrow keys move the selection without moving focus - which is what lets
 * the user keep typing to narrow the list.
 */
export function CommandDialog({
  title,
  searchLabel,
  placeholder,
  options,
  emptyMessage,
  onChoose,
  onClose,
  footer,
}: CommandDialogProps) {
  const listId = useId();
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const filtered = fuzzyFilter(options, query);
  const clampedActive = Math.min(active, Math.max(0, filtered.length - 1));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const commit = useCallback((): void => {
    const option = filtered[clampedActive];
    if (option) onChoose(option.id);
  }, [filtered, clampedActive, onChoose]);

  /*
   * Keys are bound imperatively rather than through onKeyDown. A role="dialog"
   * counts as a non-interactive element to the linter, and rather than switch
   * that rule off - it catches genuine div-pretending-to-be-a-button bugs -
   * the listener goes straight onto the element.
   */
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setActive((current) => Math.min(current + 1, filtered.length - 1));
          return;
        case 'ArrowUp':
          event.preventDefault();
          setActive((current) => Math.max(current - 1, 0));
          return;
        case 'Home':
          event.preventDefault();
          setActive(0);
          return;
        case 'End':
          event.preventDefault();
          setActive(Math.max(0, filtered.length - 1));
          return;
        case 'Enter':
          event.preventDefault();
          commit();
          return;
        case 'Escape':
          event.preventDefault();
          onClose();
          return;
        default:
          return;
      }
    };

    dialog.addEventListener('keydown', onKeyDown);
    return () => {
      dialog.removeEventListener('keydown', onKeyDown);
    };
  }, [commit, filtered.length, onClose]);

  const activeOption = filtered[clampedActive];

  return (
    <div className={styles.scrim} data-testid="canvas-dialog-scrim">
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className={styles.dialogHead}>
          <h2 className={styles.dialogTitle} id={titleId}>
            {title}
          </h2>
          <IconButton label="Close" size="sm" icon={<CloseIcon size={12} />} onClick={onClose} />
        </div>

        <div className={styles.dialogBody}>
          <TextInput
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label={searchLabel}
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeOption ? `${listId}-${activeOption.id}` : undefined}
            placeholder={placeholder}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
          />

          {/* Announces how many options survived the filter. */}
          <VisuallyHidden as="div">
            <span role="status" aria-live="polite">
              {filtered.length} {filtered.length === 1 ? 'result' : 'results'}
            </span>
          </VisuallyHidden>

          {filtered.length === 0 ? (
            <p className={styles.groupLabel}>{emptyMessage}</p>
          ) : (
            <div className={styles.optionList} id={listId} role="listbox" aria-label={title}>
              {filtered.map((option, index) => {
                /*
                 * Derived from the previous item rather than from a variable
                 * mutated during render, which would be unsound the moment
                 * React re-orders or replays the render.
                 */
                const heading = filtered[index - 1]?.group === option.group ? null : option.group;

                return (
                  <div key={option.id}>
                    {heading === null ? null : (
                      <div className={styles.groupLabel} role="presentation">
                        {heading}
                      </div>
                    )}
                    <div
                      id={`${listId}-${option.id}`}
                      role="option"
                      aria-selected={index === clampedActive}
                      className={styles.option}
                      data-testid={`dialog-option-${option.id}`}
                    >
                      <span className={styles.optionMeta}>{option.meta}</span>
                      <span className={styles.optionName}>{option.name}</span>
                      <span className={styles.optionMeta}>{option.detail}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {footer}
        </div>
      </div>
    </div>
  );
}

/**
 * Small subsequence match, scored so that earlier and tighter matches win.
 *
 * Deliberately hand-written: this filters eight tools, and pulling in a search
 * library for that would cost more bytes than the whole canvas chunk.
 */
export function fuzzyFilter(
  options: readonly DialogOption[],
  query: string,
): readonly DialogOption[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return options;

  return options
    .map((option) => ({
      option,
      score: fuzzyScore(`${option.name} ${option.detail} ${option.group}`.toLowerCase(), needle),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.option);
}

/** 0 means "no match". Higher is better. */
export function fuzzyScore(haystack: string, needle: string): number {
  // An exact substring is always the strongest signal.
  const direct = haystack.indexOf(needle);
  if (direct !== -1) return 1000 - direct;

  let score = 0;
  let cursor = 0;
  let streak = 0;

  for (const char of needle) {
    const found = haystack.indexOf(char, cursor);
    if (found === -1) return 0;
    // Consecutive characters are worth more than scattered ones.
    streak = found === cursor ? streak + 1 : 0;
    score += 10 + streak * 5;
    cursor = found + 1;
  }

  return score;
}
