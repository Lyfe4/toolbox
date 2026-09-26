import { describe, expect, it } from 'vitest';

import {
  SHORTCUT_GROUPS,
  SHORTCUTS,
  shortcutRowKey,
  TOUCH_ROUTES,
  type Shortcut,
} from './shortcuts';
import harness from '../../../scripts/cross-browser-check.mjs?raw';

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
/** The unit tests beside this file, as text, for `HELD_BY` to resolve against. */
const UNIT_TESTS = import.meta.glob<string>('./*.test.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

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
  /*
   * HELD TO THE CONTROLS, NOT ONLY TO THE OVERLAY. `overlays.test.tsx` holds
   * this list to what the reference draws; nothing held it to what the canvas
   * DOES, so a route removed from the application stayed promised until
   * somebody edited the list - and one promise was already half true: "Add
   * tool, Fit, Inspector - on the toolbar at every width" was checked for Fit
   * alone (round twenty-six).
   *
   * So every route names the tests that exercise it, and each one must exist:
   * a harness label in `cross-browser-check.mjs` - the routes are gestures and
   * geometry, which jsdom cannot perform - or a unit test in this directory. A
   * route added without an entry fails, which is the moment to find its test.
   */
  const HELD_BY: Readonly<Record<string, readonly string[]>> = {
    'Drag empty canvas': ['cross-browser-check.mjs › one finger drags the canvas'],
    Pinch: ['cross-browser-check.mjs › two fingers pinch to zoom'],
    'Tap a node': [
      'cross-browser-check.mjs › selecting a node with a finger reveals its Connect button',
    ],
    'Tap a wire': [
      'cross-browser-check.mjs › at 390px a finger still selects a wire, and the wire still draws its selection',
      'cross-browser-check.mjs › a wire is finger-sized to press when the canvas is zoomed out',
    ],
    'Selection bar': [
      'deletion.test.tsx › leaves the identical document whichever removes a node',
      'deletion.test.tsx › duplicates identically from the button and from Ctrl+D',
      'deletion.test.tsx › selects everything identically from the button and from Ctrl+A',
    ],
    'Undo, in the notification': [
      'deletion.test.tsx › restores the node when that Undo is pressed',
    ],
    'Disconnect, in the inspector': [
      'deletion.test.tsx › removes that wire and offers to put it back',
    ],
    'Add tool, Fit, Inspector': [
      'cross-browser-check.mjs › Add tool, Fit and Inspector are on the bar at ${width.toString()}px, not behind the overflow menu',
    ],
  };

  it('names the tests that exercise every route, and each of them exists', () => {
    expect(Object.keys(HELD_BY).toSorted()).toEqual(
      TOUCH_ROUTES.map((route) => route.gesture).toSorted(),
    );
    const unresolved = Object.values(HELD_BY)
      .flat()
      .filter((held) => {
        const [file = '', title = ''] = held.split(' › ');
        const source =
          file === 'cross-browser-check.mjs' ? harness : (UNIT_TESTS[`./${file}`] ?? '');
        return !source.includes(`'${title}'`) && !source.includes(`\`${title}\``);
      });
    expect(unresolved).toEqual([]);
  });

  it('covers deleting a node, deleting a wire and selecting everything', () => {
    const actions = TOUCH_ROUTES.map((route) => route.action).join(' | ');
    expect(actions).toContain('Delete');
    expect(actions).toContain('Select all');
    expect(actions).toContain('Remove the wire');
  });
});
