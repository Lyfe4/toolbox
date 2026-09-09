import { useEffect, useId, useLayoutEffect, useRef } from 'react';

import { CloseIcon } from '@/components/Icon';
import { IconButton } from '@/components/IconButton';
import { DATA_TYPES } from '@/features/registry';

import styles from './canvas.module.css';
import { PortGlyph } from './PortGlyph';
import { SHORTCUT_GROUPS, SHORTCUTS, shortcutRowKey, TOUCH_ROUTES } from './shortcuts';

/** What each data type actually carries, in a few words. */
const TYPE_MEANING: Record<(typeof DATA_TYPES)[number], string> = {
  text: 'plain text',
  json: 'structured data',
  bytes: 'raw bytes or a file',
  color: 'a colour',
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

  /*
   * Move focus into the dialog so Escape and Tab behave as expected.
   *
   * A LAYOUT EFFECT, for the reason CommandDialog's carries at length. A
   * passive effect defers the move past the paint and therefore past the task
   * the `?` keystroke started, which leaves a window in which the canvas root
   * still has focus - and this region is opened from a canvas that claims
   * every single letter, so a key struck in that window is swallowed rather
   * than reaching the dialog. The exposure here is smaller than the palette's,
   * because nothing is typed into this panel; it is corrected anyway, because
   * "small window" is how every one of the deferred-focus bugs already written
   * up in this feature was described before it was found.
   */
  useLayoutEffect(() => {
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

        {/*
          tabIndex={0} and a name, because this region SCROLLS.
          A scrollable box that nothing can focus is unreachable from the
          keyboard: there is no listbox here to arrow through, so the only way
          to see the shortcuts below the fold is to focus the region itself and
          use the arrow keys. Caught by axe's scrollable-region-focusable in a
          real browser - jsdom cannot see it, because whether a box scrolls is
          a question about layout.
        */}
        <div
          className={styles.dialogScroll}
          data-scroll-region=""
          tabIndex={0}
          role="group"
          aria-label="Shortcut reference"
        >
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
                {/*
                  KEYED ON THE BINDING, NOT ON WHAT IT DOES.

                  Two entries here read "Pan the canvas" - Space-drag and
                  middle-drag - so a key built from the action alone collided,
                  and React logged "two children with the same key" out of
                  every test that opens this dialog. Both rows still rendered,
                  because the list never changes after mount; the moment it
                  did, one of them would have been dropped or duplicated. What
                  makes a row unique is the KEYS it lists, which is also what
                  makes it a different shortcut. `shortcuts.test.ts` asserts
                  the whole array is unique under exactly this identity.
                */}
                {SHORTCUTS.filter((shortcut) => shortcut.group === group).map((shortcut) => (
                  <tr key={shortcutRowKey(shortcut)}>
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
            WITHOUT A KEYBOARD
            ──────────────────
            A table of its own rather than rows in the three above, because
            none of these has a key to print in the Keys column - they are
            gestures and visible controls, and inventing a keystroke for them
            would be worse than leaving them out.

            It is here at all because the honest answer used to be
            embarrassing: Delete, Duplicate and Select-all were keyboard-only,
            so on a phone you could add nodes to a canvas and never remove
            one. Read from `TOUCH_ROUTES`, in the same file the shortcut table
            reads, so a route that stops existing stops being listed.
          */}
          <table className={styles.shortcutTable}>
            <caption className={styles.groupLabel}>Without a keyboard</caption>
            <thead>
              <tr>
                <th scope="col" className={styles.shortcutKeys}>
                  Gesture
                </th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {TOUCH_ROUTES.map((route) => (
                <tr key={route.gesture}>
                  <td className={styles.shortcutKeys}>{route.gesture}</td>
                  <td>{route.action}</td>
                </tr>
              ))}
            </tbody>
          </table>

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

            {/*
              THE THREE WAYS IN, SAID ONCE.

              The table above can only list a key, and two of the three routes
              have no key: dragging a port, and the Connect button a selected
              node carries. That button exists because `C` is also the
              documented way to read a port label the node has truncated, and a
              phone has no `C` - so on the device where labels truncate most
              the fallback was unreachable. All three end in the same chooser,
              which is where a full port label can be read.
            */}
            <p className={styles.legendFlow}>
              To connect: <strong>drag</strong> from a port, press{' '}
              <kbd className={styles.kbd}>C</kbd> on a focused node, or select a node and press its{' '}
              <strong>Connect</strong> button. All three open the same chooser, which lists every
              port by its <strong>full name</strong> &mdash; which is how to read a label the node
              has had to cut short.
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
