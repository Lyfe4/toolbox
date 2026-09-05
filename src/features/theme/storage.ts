import { readCustomTheme } from './customThemes';
import {
  isThemeName,
  type CustomTheme,
  type PersistedThemeState,
  type ThemeSelection,
} from './types';

/**
 * Namespaced so Patchbay can never collide with anything else on the origin,
 * and versioned so a future format change is a rename rather than a migration
 * of corrupt data.
 *
 * This key holds ONE thing: which theme is selected. The library of authored
 * themes lives under its own key - see customThemes.ts for why the two are
 * separate.
 */
export const THEME_STORAGE_KEY = 'patchbay:theme:v1';

/**
 * localStorage is writable by the user and by anything else running on this
 * origin, so everything read back out is treated as untrusted. These guards
 * turn `unknown` into real types; anything that fails is discarded rather than
 * crashing the app on load.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseSelection(value: unknown): ThemeSelection | null {
  if (!isRecord(value)) return null;

  switch (value.kind) {
    case 'system':
      return { kind: 'system' };
    case 'preset':
      return isThemeName(value.name) ? { kind: 'preset', name: value.name } : null;
    case 'custom':
      return typeof value.id === 'string' ? { kind: 'custom', id: value.id } : null;
    default:
      return null;
  }
}

function readRaw(): unknown {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // Storage can throw outright in private modes or when blocked by policy.
    return null;
  }
  if (raw === null) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Reads and validates the persisted selection. Returns null if absent or unusable. */
export function readThemeState(): PersistedThemeState | null {
  const parsed = readRaw();
  if (!isRecord(parsed)) return null;

  const selection = parseSelection(parsed.selection);
  if (selection === null) return null;

  return { version: 1, selection };
}

/** Persists the selection. Silently does nothing if storage is unavailable. */
export function writeThemeState(state: PersistedThemeState): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Not being able to remember the theme is not worth breaking the app over.
  }
}

/**
 * Themes left in the OLD shape, where the library shared this key with the
 * selection.
 *
 * Nothing ever wrote one, because the editor that would have produced them is
 * what this feature adds - the type and the storage layer went in first, and
 * sat unused. So this is a migration for a format that in practice has no
 * users, kept because "in practice" is doing real work in that sentence: a
 * hand-edited localStorage, or a branch someone was carrying, would otherwise
 * lose data silently. It costs one read at startup and can be deleted once
 * this version has been out long enough that nobody is arriving from before it.
 */
export function readLegacyCustomThemes(): readonly CustomTheme[] {
  const parsed = readRaw();
  if (!isRecord(parsed) || !Array.isArray(parsed.customThemes)) return [];

  return parsed.customThemes
    .map(readCustomTheme)
    .filter((theme): theme is CustomTheme => theme !== null);
}
