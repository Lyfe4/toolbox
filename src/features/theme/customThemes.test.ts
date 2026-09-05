import { beforeEach, describe, expect, it } from 'vitest';

import {
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
import { TOKEN_GROUPS, ungroupedTokens } from './tokenGroups';
import { THEMED_TOKENS, type CustomTheme } from './types';

const THEME: CustomTheme = {
  id: 'theme-1',
  label: 'Midnight',
  base: 'blueprint',
  overrides: { accent: '#ff0000', 'ink-primary': '#ffffff' },
};

function store(value: unknown): void {
  window.localStorage.setItem(CUSTOM_THEME_STORAGE_KEY, JSON.stringify(value));
}

describe('isCanonicalColour', () => {
  it('accepts the four hex lengths', () => {
    for (const value of ['#abc', '#abcd', '#aabbcc', '#aabbccdd', '#ABCDEF']) {
      expect(isCanonicalColour(value), value).toBe(true);
    }
  });

  /*
   * THE SECURITY BOUNDARY, stated as a test.
   *
   * A custom property will hold almost any token stream, and `--pb-accent: url(...)`
   * used anywhere as a background is a network request out of an application
   * that makes none. Every one of these is a valid custom-property value and
   * none of them is a colour, which is exactly why the guard is an allow-list.
   */
  it.each([
    ['a url', 'url(https://example.com/pixel.png)'],
    ['an image set', 'image-set(url(a.png) 1x)'],
    ['an indirection', 'var(--raw-red-500)'],
    ['a declaration break-out', 'red; background: url(https://example.com/x)'],
    ['a named colour', 'red'],
    ['a function this app parses but does not store', 'oklch(0.7 0.2 40)'],
    ['a bare word', 'transparent'],
    ['nothing', ''],
    ['whitespace around a real one', ' #aabbcc '],
    ['five digits', '#aabbc'],
    ['seven digits', '#aabbccd'],
    ['not a string', 123],
  ])('refuses %s', (_name, value) => {
    expect(isCanonicalColour(value)).toBe(false);
  });
});

describe('readCustomTheme', () => {
  it('reads a well-formed theme', () => {
    expect(readCustomTheme(THEME)).toEqual(THEME);
  });

  it('lowercases colours so two spellings of one theme compare equal', () => {
    expect(readCustomTheme({ ...THEME, overrides: { accent: '#FF0000' } })?.overrides).toEqual({
      accent: '#ff0000',
    });
  });

  it('drops an override that is not a real token', () => {
    expect(
      readCustomTheme({ ...THEME, overrides: { accent: '#ff0000', bogus: '#000000' } })?.overrides,
    ).toEqual({ accent: '#ff0000' });
  });

  it('drops an override that is not a canonical colour, keeping the rest', () => {
    /*
     * Lenient on purpose: this is our own data being read back, and losing one
     * colour beats losing the theme. Import takes the opposite line - see
     * themeFile.test.ts, which asserts the difference.
     */
    expect(
      readCustomTheme({
        ...THEME,
        overrides: { accent: '#ff0000', 'ink-primary': 'url(https://example.com/x)' },
      })?.overrides,
    ).toEqual({ accent: '#ff0000' });
  });

  it('ignores a prototype-shaped key without treating it as one', () => {
    const parsed = readCustomTheme(
      JSON.parse('{"id":"x","label":"X","base":"graphite","overrides":{"__proto__":{"a":1}}}'),
    );
    expect(parsed?.overrides).toEqual({});
    expect(Object.prototype).not.toHaveProperty('a');
  });

  it.each([
    ['a missing id', { ...THEME, id: undefined }],
    ['an empty id', { ...THEME, id: '' }],
    ['a whitespace-only label', { ...THEME, label: '   ' }],
    ['a base that is not a preset', { ...THEME, base: 'chartreuse' }],
    ['not an object', 'nope'],
    ['null', null],
  ])('refuses %s', (_name, value) => {
    expect(readCustomTheme(value)).toBeNull();
  });
});

describe('the theme library in localStorage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('is empty when nothing is stored', () => {
    expect(readCustomThemes()).toEqual({ themes: [], skipped: 0 });
  });

  it('survives a reload', () => {
    writeCustomThemes([THEME]);
    expect(readCustomThemes()).toEqual({ themes: [THEME], skipped: 0 });
  });

  it('uses its own key, separate from the selection', () => {
    writeCustomThemes([THEME]);
    expect(window.localStorage.getItem('patchbay:theme:v1')).toBeNull();
    expect(window.localStorage.getItem(CUSTOM_THEME_STORAGE_KEY)).not.toBeNull();
  });

  it.each([
    ['corrupt JSON', 'not json at all'],
    ['a JSON array where an object belongs', '[]'],
    ['an object with no themes list', '{"version":1}'],
  ])('returns an empty library rather than throwing on %s', (_name, raw) => {
    window.localStorage.setItem(CUSTOM_THEME_STORAGE_KEY, raw);
    expect(() => readCustomThemes()).not.toThrow();
    expect(readCustomThemes().themes).toEqual([]);
  });

  it('skips one bad entry and keeps the good ones, saying how many', () => {
    store({ version: 1, themes: [THEME, { id: 'x' }, { ...THEME, id: 'theme-2' }] });

    const { themes, skipped } = readCustomThemes();
    expect(themes.map((theme) => theme.id)).toEqual(['theme-1', 'theme-2']);
    expect(skipped).toBe(1);
  });

  it('treats a duplicate id as corruption, because one of the two would be unreachable', () => {
    store({ version: 1, themes: [THEME, { ...THEME, label: 'Other' }] });

    const { themes, skipped } = readCustomThemes();
    expect(themes).toHaveLength(1);
    expect(themes[0]?.label).toBe('Midnight');
    expect(skipped).toBe(1);
  });

  it('bounds the library, and counts what it refused', () => {
    const many = Array.from({ length: MAX_CUSTOM_THEMES + 3 }, (_unused, index) => ({
      ...THEME,
      id: `theme-${index.toString()}`,
    }));
    store({ version: 1, themes: many });

    const { themes, skipped } = readCustomThemes();
    expect(themes).toHaveLength(MAX_CUSTOM_THEMES);
    expect(skipped).toBe(3);
  });

  it('trims an over-long label rather than refusing the theme', () => {
    store({ version: 1, themes: [{ ...THEME, label: 'x'.repeat(200) }] });
    expect(readCustomThemes().themes[0]?.label).toHaveLength(MAX_LABEL_LENGTH);
  });
});

describe('names', () => {
  it('collapses whitespace, so two names that look the same are the same', () => {
    expect(normaliseLabel('  My   rig ')).toBe('My rig');
  });

  it('compares case-insensitively', () => {
    expect(labelTaken('midnight', [THEME])).toBe(true);
    expect(labelTaken('MIDNIGHT', [THEME])).toBe(true);
    expect(labelTaken('Midnigh', [THEME])).toBe(false);
  });

  it('lets a theme keep its own name while being edited', () => {
    expect(labelTaken('Midnight', [THEME], 'theme-1')).toBe(false);
  });

  it('numbers a duplicate rather than refusing it', () => {
    const two: CustomTheme = { ...THEME, id: 'theme-2', label: 'Midnight 2' };
    expect(availableLabel('Midnight', [THEME])).toBe('Midnight 2');
    expect(availableLabel('Midnight', [THEME, two])).toBe('Midnight 3');
  });

  it('keeps a numbered name inside the length limit', () => {
    const long = 'x'.repeat(MAX_LABEL_LENGTH);
    const taken: CustomTheme = { ...THEME, label: long };
    expect(availableLabel(long, [taken]).length).toBeLessThanOrEqual(MAX_LABEL_LENGTH);
  });

  it('falls back to something usable when given nothing', () => {
    expect(availableLabel('   ', [])).toBe('Custom theme');
  });

  it('mints ids that do not collide', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newThemeId()));
    expect(ids.size).toBe(200);
  });
});

describe('token groups', () => {
  it('covers every themable token exactly once', () => {
    expect(ungroupedTokens()).toEqual([]);

    const all = TOKEN_GROUPS.flatMap((group) => group.tokens.map((one) => one.token));
    expect(all).toHaveLength(THEMED_TOKENS.length);
    expect(new Set(all).size).toBe(all.length);
  });

  it('explains what each token is for', () => {
    for (const group of TOKEN_GROUPS) {
      for (const descriptor of group.tokens) {
        expect(descriptor.hint.length, descriptor.token).toBeGreaterThan(10);
      }
    }
  });
});
