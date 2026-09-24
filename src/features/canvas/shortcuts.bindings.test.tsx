import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import { usePipelineStore } from '@/features/execution/pipelineStore';
import { EMPTY_ANNOUNCEMENTS } from '@/lib/announce';

import { Canvas } from './Canvas';
import { useCanvasStore } from './graphStore';
import { SHORTCUTS, type Shortcut } from './shortcuts';
import { DEFAULT_VIEWPORT, useViewportStore } from './viewportStore';

import type { CanvasNode } from './types';

/**
 * THE MAP AGAINST THE KEYS THE CANVAS REALLY TAKES.
 *
 * `shortcuts.ts` said "if a binding is not listed here it does not exist", and
 * the README said the `?` overlay "is generated from the same array the canvas
 * binds, so it cannot drift". Neither was true: the canvas binds keys in a
 * hand-written switch, and `SHORTCUTS` only feeds the overlay. The audit of
 * round seventeen found `Ctrl+Y` redoing and `Backspace` deleting, neither of
 * them in the map a person reads to find out what the keys do.
 *
 * So the claim is asserted instead of described. Every branch of the handler
 * that acts calls `preventDefault` and every branch that declines does not,
 * which makes "did the canvas take this key" observable from outside: press
 * every candidate, on a canvas where every branch has something to act on,
 * and compare what was taken with what is listed - both ways.
 */

function node(id: string, x: number): CanvasNode {
  return { id, toolId: 'base64', position: { x, y: 96 }, options: {}, inputs: {}, fileInputs: {} };
}

function seed(): void {
  usePipelineStore.getState().reset();
  const nodes = [node('a', 96), node('b', 496)];
  useCanvasStore.setState({
    graph: {
      nodes: Object.fromEntries(nodes.map((one) => [one.id, one])),
      nodeOrder: nodes.map((one) => one.id),
      edges: {},
      edgeOrder: [],
      nextId: 3,
    },
    selection: { nodes: ['a'], edges: [] },
    past: [],
    future: [],
    pendingMove: null,
    ...EMPTY_ANNOUNCEMENTS,
  });
  useViewportStore.setState({ viewport: DEFAULT_VIEWPORT });
}

interface Press {
  readonly key: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
}

/** Whether the canvas took one press: a fresh canvas each time, so no press sees another's overlay. */
function taken(press: Press): boolean {
  // Per press, not per test: a Delete that lands is saved, and the next mount
  // would restore that graph instead of the seeded one.
  window.localStorage.clear();
  seed();
  const { unmount } = render(
    <ToastProvider>
      <Canvas />
    </ToastProvider>,
  );
  const target = screen.getByTestId('node-a');
  act(() => {
    target.focus();
    // After the focus, which is allowed to move the selection: Delete needs one.
    useCanvasStore.getState().select({ nodes: ['a'], edges: [] });
  });
  const event = new KeyboardEvent('keydown', {
    key: press.key,
    ctrlKey: press.ctrl,
    shiftKey: press.shift,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  unmount();
  return event.defaultPrevented;
}

// ASCII only, so a split by character is a split by key.
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const KEYS = [
  ...LETTERS,
  ...'0123456789'.split(''),
  ...'+=-_?/.,[]'.split(''),
  ' ',
  'Enter',
  'Escape',
  'Delete',
  'Backspace',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'F8',
];

/**
 * The same physical key under two names. `=` is the unshifted `+` key and `_`
 * the shifted `-` on the layouts the map is written for, and the canvas takes
 * both so that a person pressing the key labelled `+` is not told to hold Shift.
 */
const ALIASES: Readonly<Record<string, string>> = { '=': '+', _: '-' };

/**
 * Listed, and taken by something other than the canvas root's keydown - the
 * browser's own focus order, a pointer or a wheel, the inspector, or Radix's
 * toast viewport. Named so the comparison below can say what it is NOT
 * checking.
 */
const HANDLED_ELSEWHERE = (shortcut: Shortcut): boolean =>
  shortcut.keys.some((key) => ['Tab', 'Middle-drag', 'Scroll', 'F8'].includes(key)) ||
  shortcut.action === 'Leave the inspector and return to the node';

/** A press, as the map would spell its non-modifier key. */
function spelled(key: string): string {
  if (key === ' ') return 'Space';
  if (key.startsWith('Arrow')) return 'Arrows';
  if (key.length === 1 && /[a-z]/i.test(key)) return key.toUpperCase();
  return ALIASES[key] ?? key;
}

const mainKey = (shortcut: Shortcut): string | undefined =>
  shortcut.keys.find((key) => !['Ctrl', 'Shift', 'drag'].includes(key));

/**
 * Whether the map lists a press. A listed binding without Shift also covers
 * the shifted press - a capital K is still K, and `?` is typed with Shift -
 * unless the map lists the shifted form as a binding of its own, the way it
 * does `Ctrl+Shift+Z` and `Shift+Enter`.
 */
function listed(press: Press): boolean {
  const key = spelled(press.key);
  const candidates = SHORTCUTS.filter(
    (shortcut) => mainKey(shortcut) === key && shortcut.keys.includes('Ctrl') === press.ctrl,
  );
  if (candidates.some((shortcut) => shortcut.keys.includes('Shift') === press.shift)) return true;
  return (
    press.shift &&
    candidates.length > 0 &&
    candidates.every((shortcut) => !shortcut.keys.includes('Shift'))
  );
}

const describePress = (press: Press): string =>
  `${press.ctrl ? 'Ctrl+' : ''}${press.shift ? 'Shift+' : ''}${press.key === ' ' ? 'Space' : press.key}`;

const PRESSES: readonly Press[] = KEYS.flatMap((key) =>
  [
    { ctrl: false, shift: false },
    { ctrl: false, shift: true },
    { ctrl: true, shift: false },
    { ctrl: true, shift: true },
  ].map((modifiers) => ({
    key: modifiers.shift && key.length === 1 && /[a-z]/.test(key) ? key.toUpperCase() : key,
    ...modifiers,
  })),
);

describe('the keyboard map against the keys the canvas takes', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  const results = (): readonly (Press & { readonly taken: boolean })[] =>
    PRESSES.map((press) => ({ ...press, taken: taken(press) }));
  let cache: readonly (Press & { readonly taken: boolean })[] | null = null;
  const all = (): readonly (Press & { readonly taken: boolean })[] => (cache ??= results());

  it('takes something at all, so the comparison below has a subject', () => {
    const count = all().filter((press) => press.taken).length;
    expect(count).toBeGreaterThan(15);
  });

  it('lists every key the canvas takes', () => {
    const unlisted = all()
      .filter((press) => press.taken && !listed(press))
      .map(describePress);
    expect(unlisted).toEqual([]);
  });

  it('takes every key it lists, apart from the ones something else handles', () => {
    const ignored = SHORTCUTS.filter((shortcut) => !HANDLED_ELSEWHERE(shortcut))
      .filter((shortcut) => {
        const key = mainKey(shortcut);
        const ctrl = shortcut.keys.includes('Ctrl');
        const shift = shortcut.keys.includes('Shift');
        return !all().some(
          (press) =>
            press.taken &&
            spelled(press.key) === key &&
            press.ctrl === ctrl &&
            press.shift === shift,
        );
      })
      .map((shortcut) => shortcut.keys.join('+'));
    expect(ignored).toEqual([]);
  });
});
