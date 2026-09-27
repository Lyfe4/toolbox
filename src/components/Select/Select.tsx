import * as RadixSelect from '@radix-ui/react-select';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from '@/components/Icon';
import { cx } from '@/lib/cx';

import styles from './Select.module.css';

import type { PointerEvent, ReactNode, RefObject } from 'react';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly options: readonly SelectOption[];
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly className?: string;
  /*
   * These four mirror FieldControlProps, so `<Select {...control} />` works.
   * They are written as `T | undefined` rather than plain optionals because
   * `exactOptionalPropertyTypes` otherwise refuses an explicitly-undefined value.
   */
  readonly id?: string | undefined;
  readonly 'aria-label'?: string | undefined;
  readonly required?: boolean | undefined;
  readonly 'aria-describedby'?: string | undefined;
  readonly 'aria-invalid'?: true | undefined;
}

/**
 * Listbox built on Radix Select.
 *
 * A native <select> cannot be styled to match the rest of the panel, and a
 * hand-rolled listbox means owning roving focus, typeahead, collision-aware
 * positioning and pointer-vs-keyboard state. Radix ships all of that already
 * audited; we supply only the appearance.
 */
export function Select({
  value,
  onValueChange,
  options,
  placeholder = 'Select',
  disabled = false,
  className,
  id,
  'aria-label': ariaLabel,
  required = false,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
}: SelectProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  /*
   * HOW THE LIST WAS LAST DRIVEN, so focus coming back to the trigger can say
   * whether it came from a pointer.
   *
   * Radix returns focus to the trigger when the list closes, with a plain
   * `focus()`. Both engines decide `:focus-visible` for a scripted focus by
   * their own heuristic, and after an option chosen with the MOUSE both
   * answered yes - so picking "All categories" on /tools, or a tool's format
   * or mode, left the keyboard ring round the trigger: the same complaint as
   * a ring after any click.
   *
   * So the return is ours, both ways, and says which it is: `focusVisible`
   * is false after a pointer and true after a key. Both, rather than only
   * the pointer's, because Gecko carries the first answer into the next
   * scripted focus - a mouse pick followed by a keyboard pick left the
   * keyboard user with no ring on the trigger at all, which is the one
   * outcome worse than the one being fixed.
   */
  const closedByPointer = useRef(false);

  return (
    <RadixSelect.Root
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      required={required}
    >
      <RadixSelect.Trigger
        ref={triggerRef}
        id={id}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        className={cx(styles.trigger, className)}
      >
        <RadixSelect.Value className={styles.value} placeholder={placeholder} />
        <RadixSelect.Icon className={styles.icon}>
          <ChevronDownIcon size={12} />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>

      <RadixSelect.Portal>
        <RadixSelect.Content
          className={styles.content}
          position="popper"
          sideOffset={4}
          onPointerUp={() => {
            closedByPointer.current = true;
          }}
          onPointerDownOutside={() => {
            closedByPointer.current = true;
          }}
          onKeyDown={() => {
            closedByPointer.current = false;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus({
              preventScroll: true,
              focusVisible: !closedByPointer.current,
            });
            closedByPointer.current = false;
          }}
        >
          <ScrollingViewport>
            {options.map((option) => (
              <RadixSelect.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled ?? false}
                className={styles.item}
              >
                {/* The wrapper always renders, so the checkmark column
                    reserves its width and unchecked rows stay aligned. */}
                <span className={styles.indicator}>
                  <RadixSelect.ItemIndicator>
                    <CheckIcon size={12} />
                  </RadixSelect.ItemIndicator>
                </span>
                <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
              </RadixSelect.Item>
            ))}
          </ScrollingViewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}

interface Edges {
  readonly up: boolean;
  readonly down: boolean;
}

/**
 * The list's viewport, with a hint drawn over each end that has more beyond it.
 *
 * THE HINTS ARE THE LIST'S ONLY SCROLLBAR. Radix's viewport hides the native
 * one with a stylesheet of its own - allowed by its hash in public/_headers -
 * so without them a list that does not fit, which is every list on a phone
 * held sideways, ends at its last visible row with nothing to say that it
 * continues.
 *
 * THEY ARE OURS, NOT RADIX'S SCROLL BUTTONS, because those moved the rows under
 * the reader twice. Radix mounts its up button the moment the list leaves the
 * top, in the list's flex column, which pushes every row down by its height;
 * and a scroll button scrolls the FOCUSED row into view as it mounts - on open
 * that is the chosen row, so the first scroll a finger or a wheel made was
 * undone, and scrolling back up from the end jumped the list to the top.
 * Measured in both engines: 30px down came back as 2, and 20px up from the
 * end of the Category list as 2. So these never mount or unmount: both are
 * always in the viewport, sticky at its ends and overlapping the rows by
 * their own height, and whether one shows is a data attribute, which moves
 * nothing. `checkPopovers` holds that a row moves by exactly what the list is
 * scrolled and by nothing else.
 */
function ScrollingViewport({ children }: { readonly children: ReactNode }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Edges>({ up: false, down: false });

  const measure = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const up = viewport.scrollTop > 0;
    const down = Math.ceil(viewport.scrollTop) < viewport.scrollHeight - viewport.clientHeight;
    setEdges((was) => (was.up === up && was.down === down ? was : { up, down }));
  }, []);

  // The viewport's size is only known once the popper has placed the list and
  // capped its height, which is after mount - hence an observer, not one read.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => {
      observer.disconnect();
    };
  }, [measure]);

  return (
    <RadixSelect.Viewport ref={viewportRef} className={styles.viewport} onScroll={measure}>
      <ScrollHint direction="up" shown={edges.up} viewportRef={viewportRef} />
      {children}
      <ScrollHint direction="down" shown={edges.down} viewportRef={viewportRef} />
    </RadixSelect.Viewport>
  );
}

/**
 * An indicator first and a control second, as Radix's was: a mouse resting on
 * one scrolls the list a row at a time, and a finger scrolls the list itself -
 * the hint is inside the scroller, so a drag that starts on it still scrolls.
 * Nothing happens on a click. `data-select-scroll` is the handle
 * check:browsers measures it by.
 */
function ScrollHint({
  direction,
  shown,
  viewportRef,
}: {
  readonly direction: 'up' | 'down';
  readonly shown: boolean;
  readonly viewportRef: RefObject<HTMLDivElement | null>;
}) {
  const timer = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (timer.current !== null) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  // A hint that stops showing has reached its end; so has an unmounted one.
  useEffect(() => {
    if (!shown) stop();
  }, [shown, stop]);
  useEffect(() => stop, [stop]);

  /*
   * ONLY A POINTER THAT MOVED. A hint appears under a mouse that is resting on
   * the list as soon as the wheel takes it off the top, and WebKit answers the
   * change with a pointermove of its own, at the same place - which, if it
   * started this, scrolled the list straight back up: the wheel's first notch,
   * undone, the fault this component exists to remove. So a scroll starts on
   * the second move over the hint at a different place from the first.
   * `movementX` would say it in one event, and WebKit reports it as 0 for
   * every move.
   */
  const lastMove = useRef<{ readonly x: number; readonly y: number } | null>(null);
  const move = (event: PointerEvent) => {
    const was = lastMove.current;
    lastMove.current = { x: event.clientX, y: event.clientY };
    if (!shown || event.pointerType !== 'mouse' || timer.current !== null) return;
    if (was === null || (was.x === event.clientX && was.y === event.clientY)) return;
    timer.current = window.setInterval(() => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const row = viewport.querySelector<HTMLElement>('[role="option"]');
      const step = row?.offsetHeight ?? 24;
      viewport.scrollTop += direction === 'up' ? -step : step;
    }, 50);
  };
  const leave = () => {
    lastMove.current = null;
    stop();
  };

  return (
    <div
      aria-hidden
      className={styles.scroll}
      data-select-scroll={direction}
      data-shown={shown ? '' : undefined}
      onPointerMove={move}
      onPointerLeave={leave}
    >
      {direction === 'up' ? <ChevronUpIcon size={12} /> : <ChevronDownIcon size={12} />}
    </div>
  );
}
