import { describe, expect, it } from 'vitest';

import { THEME_NAMES, THEMED_TOKENS } from '@/features/theme';
import { themeOverrideTokens } from '@/lib/cssTokens';

/**
 * The TypeScript union and the CSS are two descriptions of the same set, so
 * they are checked against each other. Without this, a token added to
 * themes.css but not to THEMED_TOKENS would be invisible to the custom-theme
 * editor, and one removed from the CSS would still be offered.
 */
describe('themed token contract', () => {
  const overrides = themeOverrideTokens();

  it('has an override block for every preset except the default', () => {
    // graphite is the :root default in semantic.css, so it has no block.
    expect([...overrides.keys()].toSorted()).toEqual(
      THEME_NAMES.filter((name) => name !== 'graphite').toSorted(),
    );
  });

  it.each([...overrides.entries()])(
    '%s declares exactly the themed token set',
    (_theme, tokens) => {
      // CSS names are `pb-accent`; the union stores `accent`, because
      // applyTheme re-adds the prefix when it writes the property.
      const declared = tokens.map((name) => name.replace('pb-', ''));
      expect(declared.toSorted()).toEqual([...THEMED_TOKENS].toSorted());
    },
  );
});
