import { describe, expect, it } from 'vitest';

import {
  SHORTCUT_GROUPS,
  SHORTCUTS,
  shortcutRowKey,
  TOUCH_ROUTES,
  type Shortcut,
} from './shortcuts';

/**
 * THE REFERENCE IS GENERATED, SO A DUPLICATE IN THE ARRAY IS A DUPLICATE ROW.
 *
 * `Space + drag` and `Middle-drag` both read "Pan the canvas", and the overlay
 * used to key its rows on the action - so React logged "Encountered two
 * children with the same key, `Moving around-Pan the canvas`" out of every
 * test file that opens the dialog. Both rows happened to survive, because this
 * list is fixed at mount; a duplicate key only drops or duplicates a child
 * once the list changes. Asserting it here rather than only through the render
 * catches it in the one place a new shortcut is written.
 */
describe('the shortcut list', () => {
  it('gives every entry a row identity of its own', () => {
    const keys = SHORTCUTS.map(shortcutRowKey);
    expect(new Set(keys).size).toBe(SHORTCUTS.length);
  });

  it('never lists the same binding twice in a group', () => {
    const seen = new Map<string, Shortcut>();

    for (const shortcut of SHORTCUTS) {
      const binding = `${shortcut.group}|${shortcut.keys.join('+')}`;
      const first = seen.get(binding);
      // Two actions on one binding in one group is a contradiction in the map
      // rather than a rendering problem: only one of them can be what happens.
      expect(first, `${binding} is listed twice`).toBeUndefined();
      seen.set(binding, shortcut);
    }
  });

  it('puts every entry in a declared group, so none is unreachable', () => {
    for (const shortcut of SHORTCUTS) {
      expect(SHORTCUT_GROUPS).toContain(shortcut.group);
    }
  });
});

/**
 * THE ROUTES WITH NO KEY.
 *
 * A separate list because a gesture has no keystroke to print, and the same
 * identity rules apply for the same reason: the overlay renders one row per
 * entry keyed on the gesture, so two entries sharing a gesture is a dropped
 * row, and an empty action is a row that says nothing.
 */
describe('the routes that need no keyboard', () => {
  it('names each gesture once', () => {
    const gestures = TOUCH_ROUTES.map((route) => route.gesture);
    expect(new Set(gestures).size).toBe(TOUCH_ROUTES.length);
  });

  it('says what each one does', () => {
    for (const route of TOUCH_ROUTES) {
      expect(route.gesture.trim()).not.toBe('');
      expect(route.action.trim()).not.toBe('');
    }
  });

  /*
   * The three gaps this list was written for. Named individually rather than
   * counted: a list that lost the Delete row would still be "eight routes".
   */
  it('covers deleting a node, deleting a wire and selecting everything', () => {
    const actions = TOUCH_ROUTES.map((route) => route.action).join(' | ');
    expect(actions).toContain('Delete');
    expect(actions).toContain('Select all');
    expect(actions).toContain('Remove the wire');
  });
});
