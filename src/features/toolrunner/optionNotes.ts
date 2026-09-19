import { useSyncExternalStore } from 'react';

/**
 * WHETHER AN OPTION'S EXPLANATION IS DRAWN, REMEMBERED.
 *
 * Every option field may declare a `description`, and until now every one of
 * them was painted under its label on every visit. Measured in the production
 * build: on `/tools/regex-tester` at 1280 the two descriptions in the Options
 * panel are 32px and 64px of a 490px panel - a fifth of it - and in the canvas
 * inspector, where the rail is 320px at its narrowest, the same sentences wrap
 * to three and four lines and push the Output section that far further down.
 *
 * THE PROBLEM IS NOT THAT THEY ARE USELESS, IT IS THAT THEY ARE PERMANENT. A
 * sentence explaining what the `v` flag does is worth reading once and is noise
 * on every visit after that. So it is a preference, remembered, with one
 * control for the whole panel rather than a disclosure per field: forty fields
 * would otherwise be forty extra tab stops for a density setting.
 *
 * NOTHING IS HIDDEN FROM A SCREEN READER IN EITHER STATE, and that is what
 * makes hiding them acceptable at all. The `<p>` stays in the DOM and stays the
 * target of the control's `aria-describedby`, clipped by the same recipe
 * `VisuallyHidden` uses - so the description is announced when the control takes
 * focus whether this is on or off, which is both the right moment and better
 * than reading it off the page. What the preference decides is whether it is
 * PAINTED. `Field.test.tsx` asserts the element survives, and
 * `cross-browser-check.mjs` asserts the announced text survives in two engines.
 *
 * IT DEFAULTS TO OFF, which is the opposite of the old behaviour and is the
 * point. On is one press away and is then remembered forever; the dense panel
 * is what the instrument layout is for, and a page that starts by explaining
 * every control is a page that has decided every visit is a first visit.
 *
 * WHY NO SCHEMA AND NO MIGRATION, the same argument `inspectorPreference` makes:
 * it is one boolean, the only thing an unreadable value can mean is `false`, and
 * `false` is also the first-load default. A value from a future build, a
 * hand-edited one, a blocked `localStorage` and a first visit all land on the
 * same answer.
 */

export const OPTION_NOTES_STORAGE_KEY = 'patchbay:option-notes:v1';

const SHOWN = 'shown';

/** Read on first use rather than at import, so a module load touches nothing. */
let current: boolean | null = null;
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return window.localStorage.getItem(OPTION_NOTES_STORAGE_KEY) === SHOWN;
  } catch {
    /*
     * Storage throws outright in private modes and under some enterprise
     * policies. A tool page that cannot remember a density preference is not a
     * tool page that should fail to render, and the fallback is the default.
     */
    return false;
  }
}

export function optionNotesShown(): boolean {
  current ??= read();
  return current;
}

export function setOptionNotesShown(shown: boolean): void {
  current = shown;
  try {
    window.localStorage.setItem(OPTION_NOTES_STORAGE_KEY, shown ? SHOWN : 'hidden');
  } catch {
    // As above. Not being able to remember is not worth breaking anything over.
  }
  for (const listener of listeners) listener();
}

/**
 * Reset, for tests only.
 *
 * The cache above is module state, so a test that writes the key and then reads
 * through the hook would otherwise get the answer from before it wrote.
 */
export function forgetOptionNotes(): void {
  current = null;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The preference, live.
 *
 * `useSyncExternalStore` rather than lifting the flag into each host: the
 * toggle sits in one component (a panel's title bar) and the descriptions in
 * another (the fields inside it), and those two are rendered by two different
 * routes - the tool page and the canvas inspector. Threading a boolean and a
 * setter through both would be two copies of the same wiring, and the first one
 * to be forgotten is a toggle that moves nothing.
 */
export function useOptionNotes(): boolean {
  return useSyncExternalStore(subscribe, optionNotesShown, () => false);
}
