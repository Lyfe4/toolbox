import { useEffect } from 'react';

import { THEME_PRESETS, THEME_PRESET_LIST } from './presets';
import { resolveSelection, syncDocumentTheme, useThemeStore } from './store';

import type { CustomTheme, ThemePreset, ThemeSelection } from './types';

export interface UseThemeResult {
  /** What the user picked, including the `system` option. */
  readonly selection: ThemeSelection;
  /** The preset actually in force right now. */
  readonly activePreset: ThemePreset;
  /** The custom theme in force, or null when a plain preset is selected. */
  readonly activeCustom: CustomTheme | null;
  readonly presets: readonly ThemePreset[];
  readonly customThemes: readonly CustomTheme[];
  readonly setSelection: (selection: ThemeSelection) => void;
}

/** Typed read/write access to the current theme. */
export function useTheme(): UseThemeResult {
  const selection = useThemeStore((state) => state.selection);
  const customThemes = useThemeStore((state) => state.customThemes);
  const systemAppearance = useThemeStore((state) => state.systemAppearance);
  const setSelection = useThemeStore((state) => state.setSelection);

  const resolved = resolveSelection(selection, customThemes, systemAppearance);

  return {
    selection,
    activePreset: THEME_PRESETS[resolved.theme],
    activeCustom: resolved.custom,
    presets: THEME_PRESET_LIST,
    customThemes,
    setSelection,
  };
}

/**
 * Side-effect half of the engine. Mount once, at the root.
 *
 * Keeps <html data-theme> in step with the store, and follows the OS setting
 * while the selection is `system`.
 */
export function useThemeSync(): void {
  useEffect(() => {
    syncDocumentTheme(useThemeStore.getState());
    return useThemeStore.subscribe(syncDocumentTheme);
  }, []);

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (event: MediaQueryListEvent): void => {
      useThemeStore.getState().setSystemAppearance(event.matches ? 'light' : 'dark');
    };
    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, []);
}
