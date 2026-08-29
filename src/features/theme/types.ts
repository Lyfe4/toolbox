/**
 * Types for the theming engine.
 *
 * The guiding constraint: a theme name is never a bare `string`. Every place a
 * theme is chosen, stored, or applied is checked against a fixed union, so a
 * typo is a compile error rather than a silently broken page.
 */

/**
 * `as const` makes this a readonly tuple of literal strings rather than
 * `string[]`, which is what lets us derive the union type below from it.
 */
export const THEME_NAMES = ['graphite', 'vellum', 'phosphor', 'blueprint'] as const;

/**
 * `(typeof THEME_NAMES)[number]` reads as "the type of any element of
 * THEME_NAMES", producing 'graphite' | 'vellum' | 'phosphor' | 'blueprint'.
 * Adding a preset to the array above extends this union automatically.
 */
export type ThemeName = (typeof THEME_NAMES)[number];

export type ThemeAppearance = 'dark' | 'light';

export interface ThemePreset {
  readonly name: ThemeName;
  readonly label: string;
  readonly description: string;
  readonly appearance: ThemeAppearance;
  /** Short human name for the accent hue, shown in the theme switcher. */
  readonly accent: string;
}

/**
 * The semantic colour tokens a theme is allowed to set. This is the design
 * system's themable surface area, and it is asserted against the actual CSS in
 * themes.tokens.test.ts so the two can never drift apart.
 */
export const THEMED_TOKENS = [
  'surface-sunken',
  'surface-base',
  'surface-raised',
  'surface-overlay',
  'surface-inset',
  'ink-primary',
  'ink-secondary',
  'ink-muted',
  'ink-disabled',
  'ink-inverse',
  'ink-accent',
  'ink-on-accent',
  'border-subtle',
  'border-hairline',
  'border-strong',
  'border-accent',
  'accent',
  'accent-hover',
  'accent-active',
  'accent-subtle',
  'control-surface',
  'control-surface-hover',
  'control-surface-active',
  'control-surface-disabled',
  'control-border',
  'control-border-hover',
  'signal-ok',
  'signal-ok-surface',
  'signal-warn',
  'signal-warn-surface',
  'signal-error',
  'signal-error-surface',
  'signal-on-surface',
  'focus-ring',
  'selection-surface',
  'selection-ink',
] as const;

export type ThemedToken = (typeof THEMED_TOKENS)[number];

/**
 * A user-authored theme. The builder UI comes later; the type and the storage
 * layer exist now so nothing has to be migrated when it arrives.
 *
 * `Partial<Record<ThemedToken, string>>` means "an object whose keys are
 * themed token names and whose values are CSS colours, where every key is
 * optional". A custom theme therefore overrides only what it cares about and
 * inherits everything else from its `base` preset.
 */
export interface CustomTheme {
  readonly id: string;
  readonly label: string;
  readonly base: ThemeName;
  readonly overrides: Partial<Record<ThemedToken, string>>;
}

/**
 * What the user picked. This is a DISCRIMINATED UNION: the `kind` field tells
 * TypeScript which of the three shapes you have, so after
 * `if (selection.kind === 'custom')` it knows `selection.id` exists and that
 * `selection.name` does not.
 */
export type ThemeSelection =
  | { readonly kind: 'system' }
  | { readonly kind: 'preset'; readonly name: ThemeName }
  | { readonly kind: 'custom'; readonly id: string };

/** The whole persisted blob. `version` exists so future migrations are possible. */
export interface PersistedThemeState {
  readonly version: 1;
  readonly selection: ThemeSelection;
  readonly customThemes: readonly CustomTheme[];
}

/** Narrows an arbitrary string to a ThemeName. */
export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === 'string' && (THEME_NAMES as readonly string[]).includes(value);
}
