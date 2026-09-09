import { describe, expect, it } from 'vitest';

import { SHORTCUT_GROUPS, SHORTCUTS, shortcutRowKey, type Shortcut } from './shortcuts';

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
