import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { CloseIcon } from '@/components/Icon';
import { IconButton } from '@/components/IconButton';
import { TextInput } from '@/components/TextInput';
import { VisuallyHidden } from '@/components/VisuallyHidden';
import { counted } from '@/lib/plural';

import styles from './canvas.module.css';

export interface DialogOption {
  readonly id: string;
  readonly name: string;
  /** One line. Truncated with an ellipsis rather than wrapped. */
  readonly detail: string;
  /** The id of the group this belongs under. See `DialogGroup`. */
  readonly group: string;
}

/**
 * A section of the list.
 *
 * Groups are passed in as an ORDERED array rather than derived from the
 * options, because deriving them means the order comes from whatever sequence
 * the options happened to arrive in - which is how "encoding" ended up
 * appearing three times.
 */
export interface DialogGroup {
  readonly id: string;
  readonly label: string;
  /** A few words on what the group is. Only worth it when that is not obvious. */
  readonly note?: string;
  /**
   * Marks a group as a different KIND of thing rather than another category.
   * A pipeline places a whole prewired graph; a tool places one module.
   */
  readonly distinct?: boolean;
}

export interface CommandDialogProps {
  readonly title: string;
  readonly searchLabel: string;
  readonly placeholder: string;
  readonly options: readonly DialogOption[];
  readonly groups: readonly DialogGroup[];
  /** Shown when there is nothing to choose from at all, before any typing. */
  readonly emptyMessage: string;
  readonly onChoose: (id: string) => void;
  readonly onClose: () => void;
  readonly footer?: ReactNode;
}

interface Section {
  readonly group: DialogGroup;
  readonly options: readonly DialogOption[];
}

/**
 * Buckets options into their groups.
 *
 * WHICH ORDER, AND WHY IT DEPENDS ON THE QUERY
 *
 * With no query the list is a catalogue, and the declared group order is the
 * right one: pipelines, then the tool categories, the same every time.
 *
 * With a query it is a ranked result set, and the declared order is wrong.
 * Typing "base64" and pressing Enter has to give you Base64 - but grouping
 * alone would put the Pipelines section first regardless of score, because
 * two presets happen to mention base64 in their summaries. So when searching,
 * the groups are ordered by their best-scoring member. `options` arrives
 * already sorted best-first, so a bucket's first entry is its best.
 *
 * An option whose group was never declared still gets rendered, in a section
 * of its own at the end. Silently dropping it would be the worse failure: a
 * tool that exists but cannot be found is indistinguishable from a broken app.
 */
function toSections(
  options: readonly DialogOption[],
  groups: readonly DialogGroup[],
  rankByScore: boolean,
): readonly Section[] {
  const buckets = new Map<string, DialogOption[]>();
  /** Where each group's best-scoring member sits in `options`. */
  const bestRank = new Map<string, number>();

  options.forEach((option, index) => {
    const bucket = buckets.get(option.group);
    if (bucket) {
      bucket.push(option);
    } else {
      buckets.set(option.group, [option]);
      bestRank.set(option.group, index);
    }
  });

  const sections: Section[] = [];

  for (const group of groups) {
    const bucket = buckets.get(group.id);
    if (bucket && bucket.length > 0) sections.push({ group, options: bucket });
    buckets.delete(group.id);
  }

  // Whatever is left was not declared; keep it visible rather than lose it.
  for (const [id, bucket] of buckets) {
    sections.push({ group: { id, label: id }, options: bucket });
  }

  if (!rankByScore) return sections;

  return sections.toSorted(
    (a, b) => (bestRank.get(a.group.id) ?? 0) - (bestRank.get(b.group.id) ?? 0),
  );
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
 * the user keep typing to narrow the list. A pointer drives the same single
 * highlight rather than a second, competing one.
 */
export function CommandDialog({
  title,
  searchLabel,
  placeholder,
  options,
  groups,
  emptyMessage,
  onChoose,
  onClose,
  footer,
}: CommandDialogProps) {
  const listId = useId();
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const searching = query.trim() !== '';
  const filtered = useMemo(() => fuzzyFilter(options, query), [options, query]);
  const sections = useMemo(
    () => toSections(filtered, groups, searching),
    [filtered, groups, searching],
  );

  /*
   * The flat order is what the keyboard walks and what `active` indexes into.
   * It is rebuilt from the sections, not from `filtered`, so what the arrow
   * keys traverse is exactly what is on screen and in the same order.
   */
  const flat = useMemo(() => sections.flatMap((section) => section.options), [sections]);
  const clampedActive = Math.min(active, Math.max(0, flat.length - 1));
  const activeOption = flat[clampedActive];
  const activeId = activeOption ? `${listId}-${activeOption.id}` : undefined;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  /*
   * Keep the highlighted row visible.
   *
   * This is the one that made the palette look inert: the highlight moved
   * correctly on every arrow press, but the list never scrolled, so from the
   * fourth row down the selection was somewhere below the fold and the screen
   * did not change at all. `block: 'nearest'` scrolls the minimum needed and
   * does nothing when the row is already visible.
   */
  useEffect(() => {
    if (activeId === undefined) return;
    document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const commit = useCallback(
    (id?: string): void => {
      const chosen = id ?? activeOption?.id;
      if (chosen !== undefined) onChoose(chosen);
    },
    [activeOption, onChoose],
  );

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
          setActive((current) => Math.min(current + 1, flat.length - 1));
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
          setActive(Math.max(0, flat.length - 1));
          return;
        /*
         * A page is however many rows are actually on screen, read from the
         * list rather than assumed - the dialog is 70vh, so "a page" is a
         * different number of rows on a laptop and on a monitor.
         *
         * Focus stays in the input, so the browser's own PageUp/PageDown
         * scrolling never applies here; without these the keys did nothing at
         * all, which is the same defect as a control that looks pressable.
         */
        case 'PageDown':
          event.preventDefault();
          setActive((current) => Math.min(current + pageSize(listRef.current), flat.length - 1));
          return;
        case 'PageUp':
          event.preventDefault();
          setActive((current) => Math.max(current - pageSize(listRef.current), 0));
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
  }, [commit, flat.length, onClose]);

  /*
   * Pointer handling, delegated to the list.
   *
   * One listener rather than one per row, and it resolves the row from
   * `event.target.closest(...)` so a click that lands on the name or the
   * summary still counts - which is most clicks. Delegating also keeps the
   * handlers off elements the a11y linter would rightly question, the same
   * approach the canvas root already takes.
   *
   * `pointerdown` is cancelled so the press never moves focus out of the
   * input: this is a combobox, and focus staying put is the whole pattern.
   *
   * The hover uses pointermove, not pointerenter. Enter also fires when the
   * list scrolls under a stationary cursor, which would yank the highlight
   * away from someone using the keyboard. Move only fires when the pointer
   * actually moves.
   */
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    const optionIdFrom = (target: EventTarget | null): string | null => {
      if (!(target instanceof Element)) return null;
      return target.closest<HTMLElement>('[data-option-id]')?.dataset.optionId ?? null;
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (optionIdFrom(event.target) !== null) event.preventDefault();
    };

    const onClick = (event: MouseEvent): void => {
      const id = optionIdFrom(event.target);
      if (id !== null) commit(id);
    };

    const onPointerMove = (event: PointerEvent): void => {
      const id = optionIdFrom(event.target);
      if (id === null) return;
      const index = flat.findIndex((option) => option.id === id);
      if (index !== -1) setActive(index);
    };

    list.addEventListener('pointerdown', onPointerDown);
    list.addEventListener('click', onClick);
    list.addEventListener('pointermove', onPointerMove);

    return () => {
      list.removeEventListener('pointerdown', onPointerDown);
      list.removeEventListener('click', onClick);
      list.removeEventListener('pointermove', onPointerMove);
    };
  }, [commit, flat]);

  /*
   * The popup only exists while there is something in it.
   *
   * `aria-controls` pointing at a listbox that has been unmounted is a
   * dangling reference - axe rates it critical, and a screen reader following
   * it finds nothing. Saying "not expanded" instead is also simply true: with
   * no matches there is no popup.
   */
  const hasList = flat.length > 0;

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
            aria-expanded={hasList}
            {...(hasList ? { 'aria-controls': listId } : {})}
            aria-autocomplete="list"
            aria-activedescendant={activeId}
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
              {counted(flat.length, 'result')}
            </span>
          </VisuallyHidden>

          {!hasList ? (
            <p className={styles.emptyResult} data-testid="dialog-empty">
              {searching ? `No matches for “${query.trim()}”.` : emptyMessage}
            </p>
          ) : (
            <div
              ref={listRef}
              className={styles.optionList}
              id={listId}
              role="listbox"
              aria-label={title}
              /* The one element in this dialog that scrolls. Marked so the
                 overlay smoke test can find it without guessing at classes. */
              data-scroll-region=""
            >
              {sections.map((section) => (
                <div
                  key={section.group.id}
                  role="group"
                  aria-label={section.group.label}
                  className={section.group.distinct ? styles.groupDistinct : styles.group}
                >
                  {/*
                    aria-hidden because role="group" already carries the same
                    text as its accessible name; without this a screen reader
                    reads every heading twice.
                  */}
                  <div className={styles.groupLabel} aria-hidden="true">
                    <span>{section.group.label}</span>
                    {section.group.note === undefined ? null : (
                      <span className={styles.groupNote}>{section.group.note}</span>
                    )}
                  </div>

                  {section.options.map((option) => (
                    <div
                      key={option.id}
                      id={`${listId}-${option.id}`}
                      data-option-id={option.id}
                      role="option"
                      aria-selected={option.id === activeOption?.id}
                      className={styles.option}
                      data-testid={`dialog-option-${option.id}`}
                    >
                      {/*
                        The selected marker is a real element rather than a
                        border, so it holds its space when unselected and the
                        row never shifts. It is what carries selection
                        structurally, without relying on colour.
                      */}
                      <span className={styles.optionBar} aria-hidden="true" />
                      <span className={styles.optionName}>{option.name}</span>
                      <span className={styles.optionDetail}>{option.detail}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {footer}
        </div>
      </div>
    </div>
  );
}

/**
 * How many option rows fit in the visible list.
 *
 * Measured, with a sane fallback for the frame before layout exists. One row
 * is kept as overlap so a page turn leaves something recognisable on screen,
 * which is how every other paged list behaves.
 */
function pageSize(list: HTMLElement | null): number {
  const row = list?.querySelector<HTMLElement>('[role="option"]')?.offsetHeight ?? 0;
  if (!list || row <= 0) return 8;
  return Math.max(1, Math.floor(list.clientHeight / row) - 1);
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
