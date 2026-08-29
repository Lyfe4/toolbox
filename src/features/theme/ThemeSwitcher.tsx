import { useId } from 'react';

import { cx } from '@/lib/cx';

import styles from './ThemeSwitcher.module.css';
import { useTheme } from './useTheme';

import type { ThemeName, ThemeSelection } from './types';

/**
 * Each row's preview chips. Written as data-theme so the chips can be coloured
 * by the stylesheet for a theme that is not currently applied.
 */
interface SwitcherOption {
  readonly id: string;
  readonly label: string;
  readonly meta: string;
  readonly selection: ThemeSelection;
  readonly previewTheme: ThemeName | null;
}

function isSelected(current: ThemeSelection, option: ThemeSelection): boolean {
  if (current.kind !== option.kind) return false;
  if (current.kind === 'preset' && option.kind === 'preset') return current.name === option.name;
  if (current.kind === 'custom' && option.kind === 'custom') return current.id === option.id;
  return true;
}

export interface ThemeSwitcherProps {
  readonly className?: string;
  readonly legend?: string;
}

/**
 * Theme picker built on native radio inputs.
 *
 * A radio group is exactly the right semantic here, and using the real element
 * means arrow-key navigation, roving tab order and the "one of these" semantic
 * all come from the browser rather than from hand-written ARIA.
 */
export function ThemeSwitcher({ className, legend = 'Theme' }: ThemeSwitcherProps) {
  const { selection, presets, customThemes, setSelection } = useTheme();
  const groupName = useId();

  const options: SwitcherOption[] = [
    {
      id: 'system',
      label: 'System',
      meta: 'Follows your OS setting',
      selection: { kind: 'system' },
      previewTheme: null,
    },
    ...presets.map((preset) => ({
      id: preset.name,
      label: preset.label,
      meta: `${preset.appearance === 'dark' ? 'Dark' : 'Light'} / ${preset.accent}`,
      selection: { kind: 'preset', name: preset.name } as const,
      previewTheme: preset.name,
    })),
    ...customThemes.map((theme) => ({
      id: theme.id,
      label: theme.label,
      meta: 'Custom',
      selection: { kind: 'custom', id: theme.id } as const,
      previewTheme: theme.base,
    })),
  ];

  return (
    <fieldset className={cx(styles.root, className)}>
      <legend className={styles.legend}>{legend}</legend>

      {options.map((option) => (
        <label key={option.id} className={styles.option}>
          <input
            className={styles.input}
            type="radio"
            name={groupName}
            value={option.id}
            checked={isSelected(selection, option.selection)}
            onChange={() => {
              setSelection(option.selection);
            }}
          />
          <span className={styles.marker} aria-hidden="true" />
          <span className={styles.swatch} aria-hidden="true">
            {/*
              The preview chips are painted by a nested [data-theme] scope, so
              each row can show its own palette without that theme being active.
            */}
            <span data-theme={option.previewTheme ?? undefined} className={styles.chipGroup}>
              <span className={styles.chip} data-role="surface" />
              <span className={styles.chip} data-role="ink" />
              <span className={styles.chip} data-role="accent" />
            </span>
          </span>
          <span className={styles.text}>
            <span className={styles.label}>{option.label}</span>
            <span className={styles.meta}>{option.meta}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
