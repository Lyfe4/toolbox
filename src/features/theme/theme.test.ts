import { beforeEach, describe, expect, it } from 'vitest';

import { applyTheme } from './applyTheme';
import { readThemeState, THEME_STORAGE_KEY, writeThemeState } from './storage';
import { resolveSelection } from './store';

import type { CustomTheme } from './types';

const CUSTOM: CustomTheme = {
  id: 'my-rig',
  label: 'My rig',
  base: 'blueprint',
  overrides: { accent: '#ff0000' },
};

describe('resolveSelection', () => {
  it('follows the OS setting when nothing is chosen', () => {
    expect(resolveSelection({ kind: 'system' }, [], 'light').theme).toBe('vellum');
    expect(resolveSelection({ kind: 'system' }, [], 'dark').theme).toBe('graphite');
  });

  it('uses the named preset when one is chosen', () => {
    expect(resolveSelection({ kind: 'preset', name: 'phosphor' }, [], 'light')).toEqual({
      theme: 'phosphor',
      custom: null,
    });
  });

  it('resolves a custom theme to its base plus overrides', () => {
    expect(resolveSelection({ kind: 'custom', id: 'my-rig' }, [CUSTOM], 'dark')).toEqual({
      theme: 'blueprint',
      custom: CUSTOM,
    });
  });

  it('falls back when the selected custom theme has been deleted', () => {
    expect(resolveSelection({ kind: 'custom', id: 'gone' }, [], 'dark').theme).toBe('graphite');
  });
});

describe('theme storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('returns null when nothing is stored', () => {
    expect(readThemeState()).toBeNull();
  });

  it('round-trips a selection and its custom themes', () => {
    writeThemeState({
      version: 1,
      selection: { kind: 'custom', id: 'my-rig' },
      customThemes: [CUSTOM],
    });

    expect(readThemeState()).toEqual({
      version: 1,
      selection: { kind: 'custom', id: 'my-rig' },
      customThemes: [CUSTOM],
    });
  });

  it('rejects a stored theme name that is not a real preset', () => {
    window.localStorage.setItem(
      THEME_STORAGE_KEY,
      JSON.stringify({ version: 1, selection: { kind: 'preset', name: 'chartreuse' } }),
    );

    expect(readThemeState()).toBeNull();
  });

  it('survives corrupt JSON', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'not json at all');
    expect(readThemeState()).toBeNull();
  });

  it('drops unknown keys from custom theme overrides', () => {
    window.localStorage.setItem(
      THEME_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        selection: { kind: 'system' },
        customThemes: [
          { id: 'x', label: 'X', base: 'graphite', overrides: { accent: '#fff', bogus: '#000' } },
        ],
      }),
    );

    expect(readThemeState()?.customThemes[0]?.overrides).toEqual({ accent: '#fff' });
  });
});

describe('applyTheme', () => {
  it('sets the data-theme attribute', () => {
    const root = document.createElement('html');
    applyTheme(root, 'phosphor', null);
    expect(root.getAttribute('data-theme')).toBe('phosphor');
  });

  it('writes custom overrides as inline custom properties', () => {
    const root = document.createElement('html');
    applyTheme(root, 'blueprint', CUSTOM);
    expect(root.style.getPropertyValue('--pb-accent')).toBe('#ff0000');
  });

  it('clears overrides when switching back to a plain preset', () => {
    const root = document.createElement('html');
    applyTheme(root, 'blueprint', CUSTOM);
    applyTheme(root, 'graphite', null);
    expect(root.style.getPropertyValue('--pb-accent')).toBe('');
  });
});
