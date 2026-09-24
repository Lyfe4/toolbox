import * as RadixSelect from '@radix-ui/react-select';

import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from '@/components/Icon';
import { cx } from '@/lib/cx';

import styles from './Select.module.css';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly options: readonly SelectOption[];
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly className?: string;
  /*
   * These four mirror FieldControlProps, so `<Select {...control} />` works.
   * They are written as `T | undefined` rather than plain optionals because
   * `exactOptionalPropertyTypes` otherwise refuses an explicitly-undefined value.
   */
  readonly id?: string | undefined;
  readonly 'aria-label'?: string | undefined;
  readonly required?: boolean | undefined;
  readonly 'aria-describedby'?: string | undefined;
  readonly 'aria-invalid'?: true | undefined;
}

/**
 * Listbox built on Radix Select.
 *
 * A native <select> cannot be styled to match the rest of the panel, and a
 * hand-rolled listbox means owning roving focus, typeahead, collision-aware
 * positioning and pointer-vs-keyboard state. Radix ships all of that already
 * audited; we supply only the appearance.
 */
export function Select({
  value,
  onValueChange,
  options,
  placeholder = 'Select',
  disabled = false,
  className,
  id,
  'aria-label': ariaLabel,
  required = false,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
}: SelectProps) {
  return (
    <RadixSelect.Root
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      required={required}
    >
      <RadixSelect.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        className={cx(styles.trigger, className)}
      >
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon className={styles.icon}>
          <ChevronDownIcon size={12} />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>

      <RadixSelect.Portal>
        <RadixSelect.Content className={styles.content} position="popper" sideOffset={4}>
          {/*
            THE SCROLL BUTTONS ARE THE LIST'S ONLY SCROLLBAR. Radix's viewport
            hides the native one with a stylesheet of its own - allowed by its
            hash in public/_headers - and draws these in its place, each only
            while there is more of the list in its direction. Without them a
            list that does not fit, which is every list on a phone held
            sideways, ends at its last visible row with nothing to say that it
            continues. `data-select-scroll` is the handle check:browsers
            measures them by.
          */}
          <RadixSelect.ScrollUpButton className={styles.scroll} data-select-scroll="up">
            <ChevronUpIcon size={12} />
          </RadixSelect.ScrollUpButton>
          <RadixSelect.Viewport className={styles.viewport}>
            {options.map((option) => (
              <RadixSelect.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled ?? false}
                className={styles.item}
              >
                {/* The wrapper always renders, so the checkmark column
                    reserves its width and unchecked rows stay aligned. */}
                <span className={styles.indicator}>
                  <RadixSelect.ItemIndicator>
                    <CheckIcon size={12} />
                  </RadixSelect.ItemIndicator>
                </span>
                <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
          <RadixSelect.ScrollDownButton className={styles.scroll} data-select-scroll="down">
            <ChevronDownIcon size={12} />
          </RadixSelect.ScrollDownButton>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
