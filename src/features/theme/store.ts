import { create } from 'zustand';

import { applyTheme } from './applyTheme';
import { SYSTEM_THEME } from './presets';
import { readThemeState, writeThemeState } from './storage';

import type { CustomTheme, ThemeAppearance, ThemeName, ThemeSelection } from './types';

/** What a selection actually resolves to once system preference and custom themes are considered. */
export interface ResolvedTheme {
  readonly theme: ThemeName;
  readonly custom: CustomTheme | null;
}

export interface ThemeStore {
  readonly selection: ThemeSelection;
  readonly customThemes: readonly CustomTheme[];
  readonly systemAppearance: ThemeAppearance;
  readonly setSelection: (selection: ThemeSelection) => void;
  readonly setSystemAppearance: (appearance: ThemeAppearance) => void;
  readonly upsertCustomTheme: (theme: CustomTheme) => void;
  readonly removeCustomTheme: (id: string) => void;
}

/** Reads the OS preference. Defaults to dark when the query is unsupported. */
export function detectSystemAppearance(): ThemeAppearance {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * Pure resolution: selection plus context in, concrete theme out.
 * Kept separate from the store so it can be tested without React or zustand.
 */
export function resolveSelection(
  selection: ThemeSelection,
  customThemes: readonly CustomTheme[],
  systemAppearance: ThemeAppearance,
): ResolvedTheme {
  switch (selection.kind) {
    case 'system':
      return { theme: SYSTEM_THEME[systemAppearance], custom: null };
    case 'preset':
      return { theme: selection.name, custom: null };
    case 'custom': {
      const custom = customThemes.find((theme) => theme.id === selection.id);
      // A custom theme can be deleted while still selected; fall back rather than break.
      if (!custom) return { theme: SYSTEM_THEME[systemAppearance], custom: null };
      return { theme: custom.base, custom };
    }
  }
}

const persisted = typeof window === 'undefined' ? null : readThemeState();

export const useThemeStore = create<ThemeStore>()((set, get) => {
  /** Writes the whole blob back to localStorage after any mutation. */
  const persist = (): void => {
    const { selection, customThemes } = get();
    writeThemeState({ version: 1, selection, customThemes });
  };

  return {
    selection: persisted?.selection ?? { kind: 'system' },
    customThemes: persisted?.customThemes ?? [],
    systemAppearance: detectSystemAppearance(),

    setSelection: (selection) => {
      set({ selection });
      persist();
    },

    setSystemAppearance: (systemAppearance) => {
      set({ systemAppearance });
    },

    upsertCustomTheme: (theme) => {
      const existing = get().customThemes;
      const index = existing.findIndex((candidate) => candidate.id === theme.id);
      const customThemes =
        index === -1
          ? [...existing, theme]
          : existing.map((candidate) => (candidate.id === theme.id ? theme : candidate));
      set({ customThemes });
      persist();
    },

    removeCustomTheme: (id) => {
      set({ customThemes: get().customThemes.filter((theme) => theme.id !== id) });
      persist();
    },
  };
});

/**
 * Pushes the resolved theme onto <html>. Called by the store subscription set
 * up in useThemeSync, and once at startup.
 */
export function syncDocumentTheme(state: ThemeStore): void {
  const { theme, custom } = resolveSelection(
    state.selection,
    state.customThemes,
    state.systemAppearance,
  );
  applyTheme(document.documentElement, theme, custom);
}
