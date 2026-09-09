/**
 * The editor's public surface.
 *
 * Deliberately NOT re-exported from `src/features/theme/index.ts`. That barrel
 * is imported by the root layout, which is in the initial payload; this
 * directory pulls in the colour parser, Zod and the raw token stylesheets, and
 * every one of those belongs in the lazily-loaded /styleguide chunk instead.
 * Importing from here rather than from the barrel is what keeps that true.
 */
export { ThemeEditor } from './ThemeEditor';
export type { ThemeEditorProps } from './ThemeEditor';
export {
  importTheme,
  MAX_THEME_FILE_BYTES,
  serialiseTheme,
  themeFileName,
  themeFileSchema,
  THEME_FILE_KIND,
  THEME_FILE_VERSION,
  toThemeFile,
} from './themeFile';
export type { ImportResult, ThemeFile } from './themeFile';
export { sameTheme, useThemeDraft } from './useThemeDraft';
export type { ThemeDraft, UseThemeDraftResult } from './useThemeDraft';
