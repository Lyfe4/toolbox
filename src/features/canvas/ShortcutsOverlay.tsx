import { useEffect, useId, useRef } from 'react';

import { CloseIcon } from '@/components/Icon';
import { IconButton } from '@/components/IconButton';

import styles from './canvas.module.css';
import { SHORTCUT_GROUPS, SHORTCUTS } from './shortcuts';

export interface ShortcutsOverlayProps {
  readonly onClose: () => void;
}

/** The `?` reference. Reads the same array the canvas actually binds. */
export function ShortcutsOverlay({ onClose }: ShortcutsOverlayProps) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Move focus into the dialog so Escape and Tab behave as expected.
    closeRef.current?.focus();
  }, []);

  // Bound imperatively; see the note in CommandDialog.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };

    dialog.addEventListener('keydown', onKeyDown);
    return () => {
      dialog.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <div className={styles.scrim} data-testid="shortcuts-overlay">
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className={styles.dialogHead}>
          <h2 className={styles.dialogTitle} id={titleId}>
            Keyboard shortcuts
          </h2>
          <IconButton
            ref={closeRef}
            label="Close shortcuts"
            size="sm"
            icon={<CloseIcon size={12} />}
            onClick={onClose}
          />
        </div>

        <div className={styles.dialogBody}>
          {SHORTCUT_GROUPS.map((group) => (
            <table className={styles.shortcutTable} key={group}>
              <caption className={styles.groupLabel}>{group}</caption>
              <thead>
                <tr>
                  <th scope="col" className={styles.shortcutKeys}>
                    Keys
                  </th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {SHORTCUTS.filter((shortcut) => shortcut.group === group).map((shortcut) => (
                  <tr key={`${group}-${shortcut.action}`}>
                    <td className={styles.shortcutKeys}>
                      {shortcut.keys.map((key, index) => (
                        <span key={key}>
                          {index > 0 ? ' + ' : null}
                          <kbd className={styles.kbd}>{key}</kbd>
                        </span>
                      ))}
                    </td>
                    <td>{shortcut.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </div>
      </div>
    </div>
  );
}
