import {
  type CustomTheme,
  type PersistedThemeState,
  type ThemeSelection,
  type ThemedToken,
  THEMED_TOKENS,
  isThemeName,
} from './types';

/**
 * Namespaced so Patchbay can never collide with anything else on the origin,
 * and versioned so a future format change is a rename rather than a migration
 * of corrupt data.
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

function parseOverrides(value: unknown): Partial<Record<ThemedToken, string>> {
  if (!isRecord(value)) return {};

  const overrides: Partial<Record<ThemedToken, string>> = {};
  for (const token of THEMED_TOKENS) {
    const candidate = value[token];
    if (typeof candidate === 'string') overrides[token] = candidate;
  }
  return overrides;
}

function parseCustomTheme(value: unknown): CustomTheme | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || typeof value.label !== 'string') return null;
  if (!isThemeName(value.base)) return null;

  return {
    id: value.id,
    label: value.label,
    base: value.base,
    overrides: parseOverrides(value.overrides),
  };
}

/** Reads and validates persisted theme state. Returns null if absent or unusable. */
export function readThemeState(): PersistedThemeState | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // Storage can throw outright in private modes or when blocked by policy.
    return null;
  }
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  const selection = parseSelection(parsed.selection);
  if (selection === null) return null;

  const customThemes = Array.isArray(parsed.customThemes)
    ? parsed.customThemes
        .map(parseCustomTheme)
        .filter((theme): theme is CustomTheme => theme !== null)
    : [];

  return { version: 1, selection, customThemes };
}

/** Persists theme state. Silently does nothing if storage is unavailable. */
export function writeThemeState(state: PersistedThemeState): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Not being able to remember the theme is not worth breaking the app over.
  }
}
