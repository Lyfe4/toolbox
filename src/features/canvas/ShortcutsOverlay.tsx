import { useEffect, useId, useRef } from 'react';

import { CloseIcon } from '@/components/Icon';
import { IconButton } from '@/components/IconButton';
import { DATA_TYPES } from '@/features/registry';

import styles from './canvas.module.css';
import { PortGlyph } from './PortGlyph';
import { SHORTCUT_GROUPS, SHORTCUTS } from './shortcuts';

/** What each data type actually carries, in a few words. */
const TYPE_MEANING: Record<(typeof DATA_TYPES)[number], string> = {
  text: 'plain text',
  json: 'structured data',
  bytes: 'raw bytes or a file',
  image: 'an image',
  color: 'a colour',
  datetime: 'a moment in time',
};

export interface ShortcutsOverlayProps {
  readonly onClose: () => void;
}

/** The `?` reference. Reads the same array the canvas actually binds. */
export function ShortcutsOverlay({ onClose }: ShortcutsOverlayProps) {
  const titleId = useId();
  const legendId = useId();
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

        <div className={styles.dialogScroll} data-scroll-region="">
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

          {/*
            THE KEY
            ───────
            Nothing else on the canvas says which way data flows or what the
            connector shapes mean, and a node editor is close to unusable until
            you know both. It lives here rather than on the canvas itself
            because it is reference material, not a tour: opened when wanted,
            gone the rest of the time.
          */}
          <section className={styles.legend} aria-labelledby={legendId}>
            <h3 className={styles.groupLabel} id={legendId}>
              Ports and wires
            </h3>

            <p className={styles.legendFlow}>
              Data flows <strong>left to right</strong>. Every wire leaves an{' '}
              <strong>output</strong> on a node&rsquo;s right edge and enters an{' '}
              <strong>input</strong> on another node&rsquo;s left edge. Inputs are listed first,
              then outputs. Drag from either end.
            </p>

            <ul className={styles.legendList}>
              <li className={styles.legendItem}>
                <PortGlyph types={['text']} connected={false} className={styles.legendGlyph} />
                <span>Hollow &mdash; nothing connected here yet</span>
              </li>
              <li className={styles.legendItem}>
                <PortGlyph types={['text']} connected className={styles.legendGlyph} />
                <span>Filled &mdash; a wire is attached</span>
              </li>
              <li className={styles.legendItem}>
                <PortGlyph
                  types={['text', 'bytes']}
                  connected={false}
                  className={styles.legendGlyph}
                />
                <span>Two squares &mdash; accepts more than one type</span>
              </li>
            </ul>

            {/*
              Shape, not colour: the same reason PortGlyph draws silhouettes.
              The list reads correctly in greyscale and in forced-colors.
            */}
            <ul className={styles.legendList}>
              {DATA_TYPES.map((type) => (
                <li className={styles.legendItem} key={type}>
                  <PortGlyph types={[type]} connected={false} className={styles.legendGlyph} />
                  <span>
                    <span className={styles.legendType}>{type}</span> &mdash; {TYPE_MEANING[type]}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
