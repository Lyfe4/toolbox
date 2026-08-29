import { Field } from '@/components/Field';
import { Select } from '@/components/Select';
import { TextInput } from '@/components/TextInput';
import { Toggle } from '@/components/Toggle';
import type { OptionField } from '@/features/registry/types';

import styles from './runner.module.css';

export interface OptionsPanelProps {
  readonly fields: readonly OptionField<Record<string, unknown>>[];
  readonly values: Record<string, unknown>;
  readonly onChange: (key: string, value: unknown) => void;
  readonly disabled?: boolean;
}

/**
 * Renders a tool's options.
 *
 * The controls are driven by the tool's `optionFields`, whose keys are typed as
 * `keyof Options` and are asserted by registry.test.ts to match the Zod schema
 * exactly. Introspecting the Zod object directly was the alternative, but it
 * would still not know what to CALL a field or how to order them, and it would
 * couple the UI to the validator's internals.
 */
export function OptionsPanel({ fields, values, onChange, disabled = false }: OptionsPanelProps) {
  if (fields.length === 0) {
    return <p className={styles.hint}>This tool has no options.</p>;
  }

  return (
    <div className={styles.stack}>
      {fields.map((field) => {
        const value = values[field.key];

        // The switch is exhaustive over the OptionField union, so adding a new
        // control kind is a compile error here rather than a blank space in
        // the panel.
        switch (field.control) {
          case 'toggle':
            return (
              <Toggle
                key={field.key}
                label={field.label}
                checked={value === true}
                disabled={disabled}
                onCheckedChange={(next) => {
                  onChange(field.key, next);
                }}
              />
            );

          case 'select':
            return (
              <Field
                key={field.key}
                label={field.label}
                {...(field.description !== undefined ? { description: field.description } : {})}
              >
                {(control) => (
                  <Select
                    {...control}
                    value={typeof value === 'string' ? value : ''}
                    options={field.choices}
                    disabled={disabled}
                    onValueChange={(next) => {
                      onChange(field.key, next);
                    }}
                  />
                )}
              </Field>
            );

          case 'number':
            return (
              <Field
                key={field.key}
                label={field.label}
                {...(field.description !== undefined ? { description: field.description } : {})}
              >
                {(control) => (
                  <TextInput
                    {...control}
                    type="number"
                    inputMode="numeric"
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    disabled={disabled}
                    value={typeof value === 'number' ? String(value) : ''}
                    onChange={(event) => {
                      const parsed = Number(event.target.value);
                      // An empty or half-typed value must not become NaN and
                      // fail schema validation on every keystroke.
                      onChange(field.key, Number.isFinite(parsed) ? parsed : field.min);
                    }}
                  />
                )}
              </Field>
            );
        }
      })}
    </div>
  );
}
