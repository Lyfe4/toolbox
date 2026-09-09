export { applyTheme } from './applyTheme';
export { SYSTEM_THEME, THEME_PRESET_LIST, THEME_PRESETS } from './presets';
export {
  availableLabel,
  CUSTOM_THEME_STORAGE_KEY,
  isCanonicalColour,
  labelTaken,
  MAX_CUSTOM_THEMES,
  MAX_LABEL_LENGTH,
  newThemeId,
  normaliseLabel,
  readCustomTheme,
  readCustomThemes,
  writeCustomThemes,
} from './customThemes';
export {
  readLegacyCustomThemes,
  readThemeState,
  THEME_STORAGE_KEY,
  writeThemeState,
} from './storage';
export { detectSystemAppearance, resolveActive, resolveSelection, useThemeStore } from './store';
export type { ResolvedTheme, ThemeStore } from './store';
export { useTheme, useThemeSync } from './useTheme';
export type { UseThemeResult } from './useTheme';
export {
  isThemeName,
  THEME_NAMES,
  THEMED_TOKENS,
  type CustomTheme,
  type PersistedThemeState,
  type ThemeAppearance,
  type ThemedToken,
  type ThemeName,
  type ThemePreset,
  type ThemeSelection,
} from './types';
export { ThemeSwitcher } from './ThemeSwitcher';
export type { ThemeSwitcherProps } from './ThemeSwitcher';

/*
 * The token GROUPING is safe to export from here - it is data with no imports
 * of its own. `./contrast` and `./editor` deliberately are not: they reach for
 * the colour parser and the raw stylesheets, and this barrel is loaded by the
 * root layout. Import those two by path, from the lazy route that uses them.
 */
export { TOKEN_GROUPS, tokenHint, ungroupedTokens } from './tokenGroups';
export type { TokenDescriptor, TokenGroup } from './tokenGroups';
