import { describe, expect, it } from 'vitest';

import {
  importTheme,
  MAX_THEME_FILE_BYTES,
  serialiseTheme,
  themeFileName,
  THEME_FILE_KIND,
  THEME_FILE_VERSION,
  toThemeFile,
} from './themeFile';
import { readCustomTheme } from '../customThemes';

import type { CustomTheme } from '../types';

const THEME: CustomTheme = {
  id: 'theme-1',
  label: 'Midnight',
  base: 'blueprint',
  overrides: { accent: '#ff0000', 'ink-primary': '#ffffff' },
};

/** A theme file body, with whatever the caller wants changed. */
function file(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: THEME_FILE_KIND,
    version: THEME_FILE_VERSION,
    label: 'Imported',
    base: 'graphite',
    overrides: { accent: '#00ff00' },
    ...overrides,
  });
}

describe('export', () => {
  it('writes a readable document, not a blob', () => {
    const text = serialiseTheme(THEME);
    expect(text).toContain('"kind": "patchbay-theme"');
    expect(text).toContain('"accent": "#ff0000"');
    // Pretty-printed and newline-terminated, so it diffs and cats sensibly.
    expect(text).toContain('\n');
    expect(text.endsWith('\n')).toBe(true);
  });

  it("leaves the id behind, because an id is this machine's bookkeeping", () => {
    expect(toThemeFile(THEME)).not.toHaveProperty('id');
  });

  it('round-trips through import', () => {
    const result = importTheme(serialiseTheme(THEME), []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.theme.label).toBe(THEME.label);
    expect(result.theme.base).toBe(THEME.base);
    expect(result.theme.overrides).toEqual(THEME.overrides);
    // A fresh id: importing is making a new theme here, not adopting one.
    expect(result.theme.id).not.toBe(THEME.id);
  });

  it('names the file after the theme, safely', () => {
    expect(themeFileName('Midnight')).toBe('midnight.patchbay-theme.json');
    expect(themeFileName('My rig / v2')).toBe('my-rig-v2.patchbay-theme.json');
    expect(themeFileName('***')).toBe('theme.patchbay-theme.json');
  });
});

describe('import', () => {
  it('accepts a valid file', () => {
    const result = importTheme(file(), []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.overrides).toEqual({ accent: '#00ff00' });
  });

  it('converts every notation the colour tool reads into stored hex', () => {
    const result = importTheme(
      file({ overrides: { accent: 'oklch(0.72 0.19 145)', 'ink-primary': 'rgb(1 2 3)' } }),
      [],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.theme.overrides['ink-primary']).toBe('#010203');
    expect(result.theme.overrides.accent).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('renames rather than refusing when the name is taken', () => {
    const existing: CustomTheme = { ...THEME, label: 'Imported' };
    const result = importTheme(file(), [existing]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.label).toBe('Imported 2');
  });
});

describe('import refuses', () => {
  it.each([
    ['an empty file', ''],
    ['whitespace', '   \n  '],
    ['something that is not JSON', '<html></html>'],
    ['a JSON scalar', '42'],
    ['a JSON array', '[]'],
    ['a file with no kind', file({ kind: undefined })],
    ['a file claiming to be something else', file({ kind: 'patchbay-pipeline' })],
    ['a future version', file({ version: 2 })],
    ['an empty name', file({ label: '' })],
    ['a name that is all whitespace', file({ label: '    ' })],
    ['an over-long name', file({ label: 'x'.repeat(200) })],
    ['a base that is not a preset', file({ base: 'chartreuse' })],
    ['overrides that are not an object', file({ overrides: 'red' })],
  ])('%s', (_name, text) => {
    const result = importTheme(text, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('an unknown token name, rather than dropping it', () => {
    /*
     * THE DELIBERATE DIFFERENCE FROM STORAGE.
     *
     * `readCustomTheme` drops an unknown key and keeps the theme, because that
     * is our own data being repaired. Import refuses the file, because an
     * unknown token means it was written for a different version of this
     * application and the eleven tokens that DID parse would produce a theme
     * its author never designed.
     *
     * Both behaviours asserted here, side by side, so neither can quietly
     * become the other.
     */
    const payload = { accent: '#00ff00', 'ink-tertiary': '#123456' };

    const imported = importTheme(file({ overrides: payload }), []);
    expect(imported.ok).toBe(false);

    const stored = readCustomTheme({ ...THEME, overrides: payload });
    expect(stored?.overrides).toEqual({ accent: '#00ff00' });
  });

  it('a colour it cannot read, rather than dropping it', () => {
    const imported = importTheme(
      file({ overrides: { accent: '#00ff00', 'ink-primary': 'chartreuse' } }),
      [],
    );
    expect(imported.ok).toBe(false);

    const stored = readCustomTheme({
      ...THEME,
      overrides: { accent: '#00ff00', 'ink-primary': 'chartreuse' },
    });
    expect(stored?.overrides).toEqual({ accent: '#00ff00' });
  });

  it('an unknown top-level key, so nothing rides along unexamined', () => {
    expect(importTheme(file({ apply: true }), []).ok).toBe(false);
  });

  it('a payload larger than the limit, before parsing it', () => {
    const huge = file({ label: 'x'.repeat(MAX_THEME_FILE_BYTES) });
    const result = importTheme(huge, []);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('too large');
  });

  it('a payload whose size is hidden in astral characters', () => {
    /*
     * `text.length` counts UTF-16 code units, so a file of emoji is twice the
     * bytes it appears to be - which is the shape of input somebody probing a
     * size limit sends. The check measures encoded bytes for that reason.
     */
    const emoji = '🚀'.repeat(MAX_THEME_FILE_BYTES / 3);
    expect(emoji.length).toBeLessThan(MAX_THEME_FILE_BYTES);
    expect(importTheme(file({ label: emoji }), []).ok).toBe(false);
  });

  it('a deeply nested structure', () => {
    let nested: unknown = '#ffffff';
    for (let depth = 0; depth < 200; depth += 1) nested = { accent: nested };
    expect(importTheme(file({ overrides: nested }), []).ok).toBe(false);
  });
});

describe('import cannot be used to inject CSS', () => {
  /*
   * The reason storage accepts only hex. Each of these is a legal custom
   * property value and none is a colour; the first would make a NETWORK
   * REQUEST out of an application whose whole premise is that it makes none.
   */
  it.each([
    ['a url', 'url(https://example.com/pixel.png)'],
    ['an image set', 'image-set(url(https://example.com/x.png) 1x)'],
    ['an indirection', 'var(--raw-red-500)'],
    ['a declaration break-out', '#ff0000; background-image: url(https://example.com/x)'],
    ['an expression', 'expression(alert(1))'],
  ])('refuses %s in a token value', (_name, value) => {
    const result = importTheme(file({ overrides: { accent: value } }), []);
    expect(result.ok).toBe(false);
  });

  it('refuses a prototype-shaped key rather than reasoning about it', () => {
    const hostile = `{"kind":"${THEME_FILE_KIND}","version":1,"label":"P","base":"graphite","overrides":{"accent":"#ff0000"},"__proto__":{"polluted":true}}`;

    expect(importTheme(hostile, []).ok).toBe(false);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('never returns a partly-applied theme', () => {
    // One good override and one bad one. Nothing at all comes back, so a
    // partially valid file cannot become a theme nobody designed.
    const result = importTheme(
      file({ overrides: { accent: '#00ff00', 'surface-base': 'not a colour' } }),
      [],
    );
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('theme');
  });
});
