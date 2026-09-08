/**
 * WHETHER THE INSPECTOR IS SHOWING, REMEMBERED.
 *
 * The panel used to default to open above the breakpoint, which meant a
 * first-time visitor with an empty canvas was shown an empty panel whose only
 * message was that there was nothing to inspect. It starts closed now - and
 * "closed on first load" is exactly what that says, because this remembers the
 * user's own answer for every load after it.
 *
 * WHY THIS PERSISTS WHEN THE RAIL'S WIDTH DOES NOT. The width is a preference
 * inside an open panel and one drag restores it, which is the reasoning for
 * leaving it in session state. Open against closed is not comparable: since the
 * inspector became the only place a node's input is entered and its output
 * read, closing it on every reload would hide the thing the user was working on
 * from exactly the people who use the canvas most, and it would do so on a page
 * load they did not ask for.
 *
 * WHY IT NEEDS NO SCHEMA AND NO MIGRATION. It is one boolean, and the only
 * thing an unreadable value can mean is `false` - which is also the first-load
 * default. There is no state this reader can be in where a migration would have
 * anything to do: a value from a future build, a hand-edited one, a blocked
 * `localStorage`, and a first visit all land on the same answer, and that answer
 * is the conservative one. That is what makes a second storage key affordable
 * here where `graphStore`'s needed Zod and five versions of migration.
 *
 * Hand-written rather than Zod for the same reason `themeStore`'s reader is:
 * this is read during the first render, so it is in the initial payload, and
 * `z.boolean()` is not worth a byte of it.
 */

export const INSPECTOR_STORAGE_KEY = 'patchbay:inspector:v1';

/** The stored answer, or `false` for anything this build cannot read. */
export function loadInspectorOpen(): boolean {
  try {
    return window.localStorage.getItem(INSPECTOR_STORAGE_KEY) === 'open';
  } catch {
    /*
     * Storage throws outright in private modes and under some enterprise
     * policies. A canvas that cannot remember the panel is not a canvas that
     * should fail to load, and the fallback is the default anyway.
     */
    return false;
  }
}

export function saveInspectorOpen(open: boolean): void {
  try {
    window.localStorage.setItem(INSPECTOR_STORAGE_KEY, open ? 'open' : 'closed');
  } catch {
    // As above. Not being able to remember is not worth breaking anything over.
  }
}
