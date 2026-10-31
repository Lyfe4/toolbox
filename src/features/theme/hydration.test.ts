import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CUSTOM_THEME_STORAGE_KEY } from './customThemes';
import { THEME_STORAGE_KEY } from './storage';
import indexHtml from '../../../index.html?raw';

import type { CustomTheme, ThemeAppearance } from './types';

/**
 * WHAT HAPPENS ON A RELOAD.
 *
 * The theme store reads localStorage at MODULE LOAD - it has to, because the
 * first paint must already be wearing the right theme, and an effect that ran
 * afterwards would show one frame of the wrong one. That makes it untestable
 * by ordinary means: importing the module once per file would fix its state
 * before any test could arrange storage.
 *
 * `vi.resetModules()` plus a dynamic import gives each case its own fresh
 * evaluation, which is as close to a reload as a test can get.
 */
async function reload() {
  vi.resetModules();
  const module = await import('./store');
  return module.useThemeStore.getState();
}

const THEME: CustomTheme = {
  id: 'theme-1',
  label: 'Midnight',
  base: 'blueprint',
  overrides: { accent: '#ff0000' },
};

beforeEach(() => {
  window.localStorage.clear();
});

describe('startup', () => {
  it('starts with nothing when storage is empty', async () => {
    const state = await reload();
    expect(state.customThemes).toEqual([]);
    expect(state.selection).toEqual({ kind: 'preset', name: 'blueprint' });
    expect(state.skippedThemes).toBe(0);
    // Starting on the default is not choosing it: a visitor who never picks
    // keeps getting whatever the default is, including after it changes.
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('restores a saved library and the theme that was selected', async () => {
    window.localStorage.setItem(
      CUSTOM_THEME_STORAGE_KEY,
      JSON.stringify({ version: 1, themes: [THEME] }),
    );
    window.localStorage.setItem(
      THEME_STORAGE_KEY,
      JSON.stringify({ version: 1, selection: { kind: 'custom', id: 'theme-1' } }),
    );

    const state = await reload();
    expect(state.customThemes).toEqual([THEME]);
    expect(state.selection).toEqual({ kind: 'custom', id: 'theme-1' });
  });

  it('starts rather than crashing when the library is corrupt', async () => {
    window.localStorage.setItem(CUSTOM_THEME_STORAGE_KEY, '}{ not json');

    const state = await reload();
    expect(state.customThemes).toEqual([]);
  });

  it('keeps the readable themes and counts the ones it skipped', async () => {
    window.localStorage.setItem(
      CUSTOM_THEME_STORAGE_KEY,
      JSON.stringify({ version: 1, themes: [THEME, { id: 'broken' }] }),
    );

    const state = await reload();
    expect(state.customThemes).toEqual([THEME]);
    expect(state.skippedThemes).toBe(1);
  });

  it('adopts themes left under the old selection key', async () => {
    window.localStorage.setItem(
      THEME_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        selection: { kind: 'system' },
        customThemes: [{ ...THEME, id: 'legacy-1' }],
      }),
    );

    const state = await reload();
    expect(state.customThemes.map((theme) => theme.id)).toEqual(['legacy-1']);
  });

  it('prefers the new library when a theme exists in both places', async () => {
    window.localStorage.setItem(
      CUSTOM_THEME_STORAGE_KEY,
      JSON.stringify({ version: 1, themes: [{ ...THEME, label: 'New' }] }),
    );
    window.localStorage.setItem(
      THEME_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        selection: { kind: 'system' },
        customThemes: [{ ...THEME, label: 'Old' }],
      }),
    );

    const state = await reload();
    expect(state.customThemes).toHaveLength(1);
    expect(state.customThemes[0]?.label).toBe('New');
  });

  it('falls back to a preset when the selected theme has been deleted', async () => {
    window.localStorage.setItem(
      THEME_STORAGE_KEY,
      JSON.stringify({ version: 1, selection: { kind: 'custom', id: 'gone' } }),
    );

    const { resolveActive } = await import('./store');
    const state = await reload();
    expect(resolveActive(state).custom).toBeNull();
  });

  it('never persists a draft, however the page is left', async () => {
    const state = await reload();
    state.setDraftTheme(THEME);

    const { useThemeStore } = await import('./store');
    expect(useThemeStore.getState().draftTheme).toEqual(THEME);
    // Nothing written anywhere: a draft is what the screen shows, not what the
    // user has chosen, and reloading mid-edit must not resurrect it.
    expect(window.localStorage.getItem(CUSTOM_THEME_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });
});

/**
 * THE FIRST PAINT AND THE APP AGREE.
 *
 * index.html sets data-theme before any module runs, and the store decides it
 * again a moment later. Two answers to one question, in two languages: where
 * they differ, the page flashes from one theme to the other on load. So this
 * runs the theme bootstrap itself, out of the real document, against the same
 * storage the store is about to read, and holds the two to the same theme.
 */
const bootstrap =
  [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1] ?? '')
    .find((script) => script.includes(THEME_STORAGE_KEY)) ?? '';

function stubAppearance(appearance: ThemeAppearance): void {
  const stub = (target: Window) =>
    vi.spyOn(target, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query === '(prefers-color-scheme: light)' && appearance === 'light',
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
  // The store reads the test's `window`. A <script> reads jsdom's inner
  // global instead, a different object, and the only way to reach it is from
  // a script. Both have to answer, or the two sides are not asked the same.
  stub(window);
  stub(scriptWindow());
}

function scriptWindow(): Window {
  const probe = document.createElement('script') as HTMLScriptElement & { realm?: Window };
  probe.textContent = 'document.currentScript.realm = window;';
  document.head.append(probe);
  probe.remove();
  if (!probe.realm) throw new Error('jsdom did not run the probe script');
  return probe.realm;
}

describe('the bootstrap paints what the store will', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('style');
  });

  const selection = (value: unknown) => JSON.stringify({ version: 1, selection: value });

  it.each<[string, string | null, string | null, ThemeAppearance, string]>([
    ['nothing stored, dark OS', null, null, 'dark', 'blueprint'],
    ['nothing stored, light OS', null, null, 'light', 'blueprint'],
    ['unreadable selection', '}{', null, 'light', 'blueprint'],
    ['System chosen, dark OS', selection({ kind: 'system' }), null, 'dark', 'graphite'],
    ['System chosen, light OS', selection({ kind: 'system' }), null, 'light', 'vellum'],
    ['graphite chosen', selection({ kind: 'preset', name: 'graphite' }), null, 'light', 'graphite'],
    [
      'a custom theme',
      selection({ kind: 'custom', id: THEME.id }),
      JSON.stringify({ version: 1, themes: [THEME] }),
      'light',
      'blueprint',
    ],
    ['a deleted custom theme', selection({ kind: 'custom', id: 'gone' }), null, 'light', 'vellum'],
  ])('%s', async (_name, stored, library, appearance, expected) => {
    if (stored !== null) window.localStorage.setItem(THEME_STORAGE_KEY, stored);
    if (library !== null) window.localStorage.setItem(CUSTOM_THEME_STORAGE_KEY, library);
    stubAppearance(appearance);

    expect(bootstrap).not.toBe('');
    // Run the way a page runs it: a <script> element, executed by the
    // document, seeing jsdom's storage and the stubbed media query.
    const script = document.createElement('script');
    script.textContent = bootstrap;
    document.head.append(script);
    script.remove();
    const painted = document.documentElement.getAttribute('data-theme');

    const state = await reload();
    const { resolveActive } = await import('./store');

    expect(painted).toBe(expected);
    expect(resolveActive(state).theme).toBe(expected);
  });
});

describe('the draft outranks the selection on screen', () => {
  it('shows the draft while one is open, and the selection once it is not', async () => {
    const { resolveActive, useThemeStore } = await import('./store');
    useThemeStore.setState({
      selection: { kind: 'preset', name: 'vellum' },
      customThemes: [],
      draftTheme: THEME,
    });

    expect(resolveActive(useThemeStore.getState())).toEqual({
      theme: 'blueprint',
      custom: THEME,
    });

    useThemeStore.setState({ draftTheme: null });
    expect(resolveActive(useThemeStore.getState())).toEqual({ theme: 'vellum', custom: null });
  });
});
