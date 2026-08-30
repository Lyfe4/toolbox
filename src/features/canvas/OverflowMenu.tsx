import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/Button';

import styles from './canvas.module.css';

export interface OverflowItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly onSelect: () => void;
  /** Extra context, read after the label. Used for the share privacy note. */
  readonly description?: string;
}

export interface OverflowMenuProps {
  readonly label: string;
  readonly items: readonly OverflowItem[];
}

/**
 * The toolbar's overflow, for viewports too narrow to show every control.
 *
 * Collapsing beats shrinking. A row of flex children that shrink past their
 * text ends up as "FI" and "NDO"; a row that simply overflows puts Share and
 * Shortcuts off the side of the screen where nothing can reach them. Neither
 * is a layout - this is.
 *
 * Built here rather than pulled from Radix: it is one button and a list, and
 * the menu primitive would cost more than the whole canvas chunk. What it does
 * NOT skimp on is the keyboard contract - the part a hand-rolled menu usually
 * gets wrong:
 *
 *   - The trigger says whether it is open (`aria-expanded`) and what it owns.
 *   - Opening moves focus to the first item; Escape closes and gives focus
 *     back to the trigger, so the user is never dropped somewhere unexpected.
 *   - Up/Down wrap around the items, Home/End jump to the ends.
 *   - Tabbing away or clicking outside closes it.
 */
export function OverflowMenu({ label, items }: OverflowMenuProps) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  /* Focus the first item when the menu opens, so the keyboard has somewhere
     to be. Nothing to restore on close: `close` handles that itself. */
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  /* Clicking anywhere else closes, without stealing focus back - the user has
     already decided where they are going. */
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const focusables = [
      ...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
    ];
    if (focusables.length === 0) return;
    const index = focusables.indexOf(document.activeElement as HTMLElement);

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        close(true);
        return;
      case 'ArrowDown':
        event.preventDefault();
        focusables[(index + 1) % focusables.length]?.focus();
        return;
      case 'ArrowUp':
        event.preventDefault();
        focusables[(index - 1 + focusables.length) % focusables.length]?.focus();
        return;
      case 'Home':
        event.preventDefault();
        focusables[0]?.focus();
        return;
      case 'End':
        event.preventDefault();
        focusables[focusables.length - 1]?.focus();
        return;
      case 'Tab':
        // Tab leaves the menu entirely rather than cycling inside it.
        setOpen(false);
        return;
      default:
        return;
    }
  };

  return (
    <div className={styles.overflow}>
      <Button
        ref={triggerRef}
        size="sm"
        variant="ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        {label}
      </Button>

      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          /*
           * Programmatically focusable but not a tab stop. Focus lives on the
           * items in this pattern, and the container only ever receives it if
           * something moves it there deliberately - which is also what the
           * a11y linter asks for on an interactive role.
           */
          tabIndex={-1}
          aria-label={label}
          className={styles.overflowMenu}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={styles.overflowItem}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
            >
              <span className={styles.overflowItemLabel}>
                {item.icon}
                {item.label}
              </span>
              {item.description === undefined ? null : (
                <span className={styles.overflowItemNote}>{item.description}</span>
              )}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
