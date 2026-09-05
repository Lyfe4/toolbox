import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CUSTOM_THEME_STORAGE_KEY } from './customThemes';
import { THEME_STORAGE_KEY } from './storage';

import type { CustomTheme } from './types';

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
    expect(state.selection).toEqual({ kind: 'system' });
    expect(state.skippedThemes).toBe(0);
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
