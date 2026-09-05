import { create } from 'zustand';

import { applyTheme } from './applyTheme';
import { MAX_CUSTOM_THEMES, readCustomThemes, writeCustomThemes } from './customThemes';
import { SYSTEM_THEME } from './presets';
import { readLegacyCustomThemes, readThemeState, writeThemeState } from './storage';

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
  /**
   * The theme being edited right now, applied to the document over everything
   * else and never persisted.
   *
   * A draft is not a selection. Editing a theme should repaint the page so you
   * can see what you are making, without changing which theme is SELECTED -
   * abandoning an edit must leave you exactly where you started, and a draft
   * that wrote itself into the selection could not offer that.
   */
  readonly draftTheme: CustomTheme | null;
  /** How many stored themes were unreadable at startup. Reported, not hidden. */
  readonly skippedThemes: number;
  readonly setSelection: (selection: ThemeSelection) => void;
  readonly setSystemAppearance: (appearance: ThemeAppearance) => void;
  readonly setDraftTheme: (theme: CustomTheme | null) => void;
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

/**
 * What the document should actually show: the draft when one is open, and the
 * selection otherwise. One function, so there is one answer.
 */
export function resolveActive(state: ThemeStore): ResolvedTheme {
  if (state.draftTheme !== null) {
    return { theme: state.draftTheme.base, custom: state.draftTheme };
  }
  return resolveSelection(state.selection, state.customThemes, state.systemAppearance);
}

/* -------------------------------------------------------------------------- *
 * Startup
 * -------------------------------------------------------------------------- */

const onClient = typeof window !== 'undefined';
const persisted = onClient ? readThemeState() : null;
const stored = onClient ? readCustomThemes() : { themes: [], skipped: 0 };

/*
 * One-time move of anything left under the old key. Merged rather than
 * replaced: whatever is already in the new library is the newer truth.
 */
const legacy = onClient ? readLegacyCustomThemes() : [];
const known = new Set(stored.themes.map((theme) => theme.id));
const initialThemes = [...stored.themes, ...legacy.filter((theme) => !known.has(theme.id))].slice(
  0,
  MAX_CUSTOM_THEMES,
);

export const useThemeStore = create<ThemeStore>()((set, get) => {
  const persistSelection = (): void => {
    writeThemeState({ version: 1, selection: get().selection });
  };

  return {
    selection: persisted?.selection ?? { kind: 'system' },
    customThemes: initialThemes,
    systemAppearance: detectSystemAppearance(),
    draftTheme: null,
    skippedThemes: stored.skipped,

    setSelection: (selection) => {
      set({ selection });
      persistSelection();
    },

    setSystemAppearance: (systemAppearance) => {
      set({ systemAppearance });
    },

    setDraftTheme: (draftTheme) => {
      // Guarded, because the editor republishes on every render of its draft
      // and every store write repaints <html> through the subscription.
      if (get().draftTheme === draftTheme) return;
      set({ draftTheme });
    },

    upsertCustomTheme: (theme) => {
      const existing = get().customThemes;
      const index = existing.findIndex((candidate) => candidate.id === theme.id);
      const customThemes =
        index === -1
          ? [...existing, theme].slice(0, MAX_CUSTOM_THEMES)
          : existing.map((candidate) => (candidate.id === theme.id ? theme : candidate));
      set({ customThemes });
      writeCustomThemes(customThemes);
    },

    removeCustomTheme: (id) => {
      const customThemes = get().customThemes.filter((theme) => theme.id !== id);
      set({ customThemes });
      writeCustomThemes(customThemes);
    },
  };
});

/**
 * Pushes the resolved theme onto <html>. Called by the store subscription set
 * up in useThemeSync, and once at startup.
 */
export function syncDocumentTheme(state: ThemeStore): void {
  const { theme, custom } = resolveActive(state);
  applyTheme(document.documentElement, theme, custom);
}
