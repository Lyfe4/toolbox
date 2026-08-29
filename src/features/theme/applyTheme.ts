import type { CustomTheme, ThemeName } from './types';

/**
 * Writes the resolved theme to the document.
 *
 * Presets work purely through the `data-theme` attribute, which flips the
 * [data-theme] blocks in themes.css. Custom themes additionally set individual
 * semantic custom properties inline on <html>, which win over the stylesheet
 * because inline styles have higher precedence - so a custom theme is exactly
 * "a preset plus a handful of overridden tokens".
 */
export function applyTheme(root: HTMLElement, theme: ThemeName, custom: CustomTheme | null): void {
  root.setAttribute('data-theme', theme);

  // Clear any overrides left behind by a previously applied custom theme.
  // Collected first, because removing while iterating shifts the indices.
  const stale: string[] = [];
  for (let index = 0; index < root.style.length; index += 1) {
    const property = root.style.item(index);
    if (property.startsWith('--pb-')) stale.push(property);
  }
  for (const property of stale) root.style.removeProperty(property);

  if (custom === null) return;

  for (const [token, value] of Object.entries(custom.overrides)) {
    if (typeof value === 'string') root.style.setProperty(`--pb-${token}`, value);
  }
}
