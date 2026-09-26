import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Select } from '@/components/Select';
import { TextArea } from '@/components/TextArea';
import { TextInput } from '@/components/TextInput';
import { Toggle } from '@/components/Toggle';
import type { OptionField } from '@/features/registry/types';

import { setOptionNotesShown, useOptionNotes } from './optionNotes';
import styles from './runner.module.css';

/**
 * ONE CONTROL FOR THE WHOLE PANEL, IN THE PANEL'S OWN TITLE BAR.
 *
 * It belongs in `Panel`'s `actions` slot rather than above the fields, and the
 * reason is arithmetic: a row of its own costs a 24px control and a 12px gap on
 * every tool, which is more than the descriptions it hides on the tools that
 * declare one short one. The title bar is 24px tall whether or not anything is
 * in it, so there it is free.
 *
 * `aria-pressed` rather than a checkbox: this is a toggle button that changes
 * what is drawn, not a value the tool is run with, and putting it among the
 * option fields would make it look like one.
 *
 * Rendered by both hosts - the tool page and the canvas inspector - which is
 * why the state lives in a module rather than in either of them.
 */
export function OptionNotesToggle() {
  const shown = useOptionNotes();

  return (
    <Button
      size="sm"
      variant="ghost"
      aria-pressed={shown}
      onClick={() => {
        setOptionNotesShown(!shown);
      }}
    >
      Notes
    </Button>
  );
}

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
  /*
   * WHETHER AN OPTION'S SENTENCE IS PAINTED. It is announced either way - the
   * element stays in the DOM and stays the target of `aria-describedby` - so
   * this is a density preference and not an accessibility one. See
   * `optionNotes.ts`, and `OptionNotesToggle` above for the control.
   */
  const notes = useOptionNotes();

  /*
   * Fields can declare `when`, so a tool whose options depend on what it is
   * converting shows only the ones that apply. Filtered here rather than in
   * each tool so every tool gets it, and so a field with no predicate keeps
   * behaving exactly as before.
   */
  const visible = fields.filter((field) => field.when?.(values) ?? true);

  if (fields.length === 0) {
    return <p className={styles.hint}>This tool has no options.</p>;
  }

  return (
    <div className={styles.stack}>
      {visible.map((field) => {
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
                descriptionVisible={notes}
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

          case 'text':
            return (
              <Field
                key={field.key}
                label={field.label}
                {...(field.description !== undefined ? { description: field.description } : {})}
                descriptionVisible={notes}
              >
                {(control) =>
                  field.multiline === true ? (
                    <TextArea
                      {...control}
                      rows={3}
                      spellCheck={false}
                      placeholder={field.placeholder ?? ''}
                      disabled={disabled}
                      value={typeof value === 'string' ? value : ''}
                      onChange={(event) => {
                        onChange(field.key, event.target.value);
                      }}
                    />
                  ) : (
                    <TextInput
                      {...control}
                      type="text"
                      spellCheck={false}
                      placeholder={field.placeholder ?? ''}
                      disabled={disabled}
                      value={typeof value === 'string' ? value : ''}
                      onChange={(event) => {
                        onChange(field.key, event.target.value);
                      }}
                    />
                  )
                }
              </Field>
            );

          case 'number':
            return (
              <Field
                key={field.key}
                label={field.label}
                {...(field.description !== undefined ? { description: field.description } : {})}
                descriptionVisible={notes}
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
