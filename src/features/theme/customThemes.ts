import { THEMED_TOKENS, isThemeName, type CustomTheme, type ThemedToken } from './types';

/**
 * THE CUSTOM THEME LIBRARY
 *
 * Namespaced and versioned, and deliberately a DIFFERENT key from the one that
 * holds the current selection. The selection changes every time somebody
 * clicks a radio button; the library changes when they author something. Two
 * lifetimes, two keys - so a write to one can never scramble the other, and a
 * future format change to either is a rename rather than a migration.
 */
export const CUSTOM_THEME_STORAGE_KEY = 'patchbay:themes:v1';

/** A name has to fit in a radio row and in a filename. */
export const MAX_LABEL_LENGTH = 48;

/**
 * Bounds. localStorage is a fixed budget shared with the pipeline graph, and
 * an unbounded list of themes is a way to consume all of it by accident.
 */
export const MAX_CUSTOM_THEMES = 32;

/**
 * THE ONLY COLOUR SYNTAX THAT MAY REACH THE STYLESHEET.
 *
 * This is a security boundary, not a formatting preference.
 *
 * A custom property accepts very nearly any token stream. `--pb-accent` set to
 * `url(https://example.com/pixel.png)` is a perfectly valid custom property,
 * and the moment any rule uses that token in a `background` it becomes a
 * network request - out of an application whose entire premise is that it
 * makes none, and whose CSP would report it rather than silently allow it.
 * `var(--something-else)` is likewise valid and turns a colour into an
 * indirection an attacker chose.
 *
 * So the stored form is an ALLOW-LIST of one shape: a hex literal. Everything
 * the user types is converted to this before it is stored, by the editor,
 * using the colour tool's parser - so hex is not a restriction on what can be
 * typed, only on what can be written into CSS. Anything else in storage is
 * either corruption or an attempt, and is dropped either way.
 */
const CANONICAL_COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isCanonicalColour(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_COLOUR.test(value);
}

/* ========================================================================== *
 * Reading
 * ========================================================================== */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Keeps only the overrides that name a real token AND hold a canonical colour.
 *
 * DROP RATHER THAN REFUSE, here. This is our own data being read back: a theme
 * whose `accent` went bad is still a theme, and losing one colour is a far
 * better outcome than losing the twelve that were fine. Import takes the
 * opposite line - see themeFile.ts - because that is somebody else's file, and
 * partially applying a stranger's theme is how you end up with a document
 * nobody meant.
 */
function readOverrides(value: unknown): Partial<Record<ThemedToken, string>> {
  if (!isRecord(value)) return {};

  const overrides: Partial<Record<ThemedToken, string>> = {};
  // Iterating the known token list rather than the object's own keys is what
  // makes `__proto__` and friends a non-event: a key that is not in this list
  // is never even looked at.
  for (const token of THEMED_TOKENS) {
    const candidate = value[token];
    if (isCanonicalColour(candidate)) overrides[token] = candidate.toLowerCase();
  }
  return overrides;
}

export function readCustomTheme(value: unknown): CustomTheme | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || value.id === '') return null;
  if (typeof value.label !== 'string' || value.label.trim() === '') return null;
  if (!isThemeName(value.base)) return null;

  return {
    id: value.id.slice(0, 64),
    label: value.label.trim().slice(0, MAX_LABEL_LENGTH),
    base: value.base,
    overrides: readOverrides(value.overrides),
  };
}

export interface StoredThemes {
  readonly themes: readonly CustomTheme[];
  /**
   * How many entries were present but unusable. Surfaced in the editor rather
   * than swallowed: silently losing a theme somebody spent time on, with no
   * message, is worse than the crash this is avoiding.
   */
  readonly skipped: number;
}

const EMPTY: StoredThemes = { themes: [], skipped: 0 };

/**
 * Reads the library. Total: every failure path returns an empty library rather
 * than throwing, because this runs during the first render and an exception
 * here is a blank page.
 *
 * WHY THIS IS NOT ZOD, when the import path is.
 *
 * This function runs at startup, so whatever it imports is in the initial
 * payload. Zod is 87 kB raw, measured, against 54 kB of remaining budget - it
 * would not fit, and buying it would mean every visitor downloads a validation
 * library to answer a question three `typeof` checks answer.
 *
 * That is a bundle argument, but it is not the whole argument, because the two
 * validators are not doing the same job. This one is lenient by design: it
 * repairs our own data and keeps going. The import schema is strict by design:
 * it refuses a stranger's file whole. They would still be two implementations
 * if they agreed, so it is worth saying plainly that they are meant to differ,
 * and themeFile.test.ts asserts the difference rather than leaving it implied.
 */
export function readCustomThemes(): StoredThemes {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(CUSTOM_THEME_STORAGE_KEY);
  } catch {
    // Storage throws outright in some private modes and under some policies.
    return EMPTY;
  }
  if (raw === null) return EMPTY;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY;
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.themes)) return EMPTY;

  const themes: CustomTheme[] = [];
  let skipped = 0;
  const seen = new Set<string>();

  for (const entry of parsed.themes.slice(0, MAX_CUSTOM_THEMES)) {
    const theme = readCustomTheme(entry);
    // A duplicate id would make one of the two unselectable, which looks like
    // the app losing a theme. Treated as corruption, because it is.
    if (theme === null || seen.has(theme.id)) {
      skipped += 1;
      continue;
    }
    seen.add(theme.id);
    themes.push(theme);
  }

  if (parsed.themes.length > MAX_CUSTOM_THEMES) {
    skipped += parsed.themes.length - MAX_CUSTOM_THEMES;
  }

  return { themes, skipped };
}

/** Persists the library. Silent on failure, as the selection store is. */
export function writeCustomThemes(themes: readonly CustomTheme[]): void {
  try {
    window.localStorage.setItem(
      CUSTOM_THEME_STORAGE_KEY,
      JSON.stringify({ version: 1, themes: themes.slice(0, MAX_CUSTOM_THEMES) }),
    );
  } catch {
    // Not being able to remember a theme is not worth breaking the app over.
  }
}

/* ========================================================================== *
 * Names and ids
 * ========================================================================== */

/**
 * Ids are internal and never shown. Time plus randomness is enough to make a
 * collision impossible in practice without reaching for `crypto.randomUUID`,
 * whose availability is a browser-support question this does not need to ask.
 */
export function newThemeId(): string {
  const random = Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(4, '0');
  return `theme-${Date.now().toString(36)}-${random}`;
}

export function normaliseLabel(label: string): string {
  // Collapse runs of whitespace: two themes called "My rig" and "My  rig" are
  // the same name to a person, and a uniqueness rule that disagrees is a rule
  // that looks broken.
  return label.trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL_LENGTH);
}

/**
 * Is this name already taken?
 *
 * Case-insensitive, because "Midnight" and "midnight" in the same radio group
 * is a bug report waiting to happen. `exceptId` lets a theme keep its own name
 * while being edited.
 */
export function labelTaken(
  label: string,
  themes: readonly CustomTheme[],
  exceptId?: string,
): boolean {
  const wanted = normaliseLabel(label).toLocaleLowerCase();
  return themes.some(
    (theme) => theme.id !== exceptId && theme.label.toLocaleLowerCase() === wanted,
  );
}

/**
 * A free name derived from `base`: "Midnight", then "Midnight 2", "Midnight 3".
 *
 * Used by Duplicate and by Import, where refusing because of a name collision
 * would be obstructive - the user asked for another copy, and naming it is a
 * chore they can undo by typing.
 */
export function availableLabel(base: string, themes: readonly CustomTheme[]): string {
  const root = normaliseLabel(base) || 'Custom theme';
  if (!labelTaken(root, themes)) return root;

  for (let suffix = 2; suffix < MAX_CUSTOM_THEMES + 2; suffix += 1) {
    // Trim the root so the suffix cannot push the name past the limit.
    const numbered = `${root.slice(0, MAX_LABEL_LENGTH - 4).trim()} ${suffix.toString()}`;
    if (!labelTaken(numbered, themes)) return numbered;
  }

  return `${root.slice(0, MAX_LABEL_LENGTH - 8).trim()} ${newThemeId().slice(-4)}`;
}
