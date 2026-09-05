import { isCanonicalColour } from './customThemes';

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
    /*
     * THE LAST GATE BEFORE CSS.
     *
     * Every path that produces an override already canonicalises it to hex -
     * the editor through the colour parser, import through its schema, storage
     * through `readCustomTheme`. This checks again anyway, because this is the
     * single line in the application where a string becomes a stylesheet, and
     * a custom property will happily hold `url(...)` or `var(...)` if one ever
     * reached it. One regex here means no future caller can get it wrong.
     */
    if (isCanonicalColour(value)) root.style.setProperty(`--pb-${token}`, value);
  }
}
