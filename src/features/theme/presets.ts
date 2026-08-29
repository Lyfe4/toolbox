import type { ThemeName, ThemePreset } from './types';

/**
 * `Record<ThemeName, ThemePreset>` means "an object with exactly one entry per
 * theme name". Add a name to THEME_NAMES without adding it here and this file
 * stops compiling - the two can never fall out of step.
 */
export const THEME_PRESETS: Record<ThemeName, ThemePreset> = {
  graphite: {
    name: 'graphite',
    label: 'Graphite',
    description: 'Machined dark panel. Cool neutral greys under instrument amber.',
    appearance: 'dark',
    accent: 'Amber',
  },
  vellum: {
    name: 'vellum',
    label: 'Vellum',
    description: 'Daylight bench. Warm paper stock marked in vermilion.',
    appearance: 'light',
    accent: 'Vermilion',
  },
  phosphor: {
    name: 'phosphor',
    label: 'Phosphor',
    description: 'CRT terminal. Green-biased blacks lit by a single phosphor.',
    appearance: 'dark',
    accent: 'Phosphor green',
  },
  blueprint: {
    name: 'blueprint',
    label: 'Blueprint',
    description: 'Drafting table. Deep navy stock drawn in cyan.',
    appearance: 'dark',
    accent: 'Cyan',
  },
};

export const THEME_PRESET_LIST: readonly ThemePreset[] = Object.values(THEME_PRESETS);

/** Which preset a `system` selection resolves to for each OS appearance. */
export const SYSTEM_THEME: Record<'dark' | 'light', ThemeName> = {
  dark: 'graphite',
  light: 'vellum',
};
