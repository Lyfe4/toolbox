/**
 * THE APP'S HALF OF THE COLD OPEN.
 *
 * The panel itself is static markup in index.html, and the inline script there
 * has already decided whether it stays - see that file for why it is markup at
 * all. By the time anything here runs, exactly one of two things is true:
 *
 *   - the panel was removed before the module was fetched, and every function
 *     below is a no-op; or
 *   - the panel is up, `#root` is inert, and this module owns taking it down.
 *
 * WHAT "TAKING IT DOWN" HAS TO DO, all three parts, or the canvas is broken:
 * remove the element, clear the inert flag so the app is operable again, and
 * record that it happened so a reload does not start over. It is written once
 * here rather than at each call site for that reason.
 *
 * It is deliberately NOT a React component holding DOM state. The element
 * outlives the mount that adopts it and predates the chunk that imports this,
 * so the honest model is "a thing in the document that the app removes", and
 * anything more elaborate would be a fiction with the same failure modes.
 */

/** The panel. */
export const COLD_OPEN_ID = 'cold-open';

/** The one control in it that needs JavaScript to mean anything. */
export const COLD_OPEN_START_ID = 'cold-open-start';

/**
 * Remembers that the introduction has been read.
 *
 * Separate from the graph key, because "I have seen this" and "I have work
 * saved" are different facts and the first one has to survive an empty canvas.
 * Dismissing the panel and reloading used to be the one way back to it.
 */
export const COLD_OPEN_STORAGE_KEY = 'patchbay:cold-open:v1';

function panel(): HTMLElement | null {
  return document.getElementById(COLD_OPEN_ID);
}

/**
 * THE DOM IS THE STATE, and these two are the `useSyncExternalStore` pair that
 * lets React read it without pretending otherwise.
 *
 * The alternative - a `useState` initialised from the DOM and then maintained
 * alongside it - is a second copy of a fact that already exists, and the copy
 * goes wrong in a specific way: the panel comes down when the first node
 * arrives, and `nodeOrder.length === 0` is true again the moment somebody
 * selects everything and presses Delete. A derived boolean flips back to "the
 * introduction is up" on a canvas whose panel is long gone - rendering
 * nothing, because the element was removed, while suppressing the canvas's own
 * empty state, which is the one message that screen should have had.
 *
 * Asking the document cannot get that wrong. There is one panel, it is removed
 * exactly once, and removal is the only event there is to publish.
 */
const listeners = new Set<() => void>();

export function subscribeColdOpen(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether the cold open is on screen right now. */
export function isColdOpenShowing(): boolean {
  return panel() !== null;
}

/**
 * Takes the panel down, for good.
 *
 * Safe to call when there is no panel, which is most of the time: every caller
 * would otherwise have to ask first, and the ones that forgot would be the
 * ones that only break for a returning visitor.
 */
export function dismissColdOpen(): void {
  const element = panel();
  if (!element) return;

  element.remove();

  /*
   * The inert flag was set by the inline script in index.html, on the
   * assumption that this would clear it. Nothing else ever sets it, so this is
   * unconditional rather than a toggle.
   */
  const root = document.getElementById('root');
  if (root) root.inert = false;

  try {
    window.localStorage.setItem(COLD_OPEN_STORAGE_KEY, String(Date.now()));
  } catch {
    // A full or disabled store costs a returning visitor one extra click.
    // It is not worth failing the dismissal over.
  }

  // After the DOM has changed, so a subscriber that reads it gets the new
  // answer. The early return above means this fires exactly once.
  for (const listener of listeners) listener();
}

/**
 * Wires the panel's one button to `onStart` and hands back the unsubscribe.
 *
 * The listener is attached rather than the markup carrying an `onclick`,
 * because an inline handler is exactly what `script-src` without
 * `'unsafe-inline'` refuses - the button would be dead in production and fine
 * in every test that never served the real headers.
 */
export function onColdOpenStart(handler: () => void): () => void {
  const button = document.getElementById(COLD_OPEN_START_ID);
  if (!button) return () => undefined;

  button.addEventListener('click', handler);
  return () => {
    button.removeEventListener('click', handler);
  };
}
