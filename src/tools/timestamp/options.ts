import type { OptionField } from '@/features/registry/types';
import { z } from '@/lib/zod';

import { DISAMBIGUATIONS } from './zones';

export const INPUT_UNITS = ['auto', 's', 'ms', 'us', 'ns'] as const;
export const TARGETS = [
  'auto',
  'utc',
  'local',
  'rfc9557',
  'readable',
  's',
  'ms',
  'us',
  'ns',
] as const;
export type Target = (typeof TARGETS)[number];

export const timestampOptionsSchema = z.object({
  /** What a bare number counts. `auto` reads it off the number's size. */
  unit: z.enum(INPUT_UNITS).default('auto'),
  /**
   * `auto` is the other side of whatever arrived: a date for a number, and
   * for a date the coarsest Unix unit that holds it exactly - so the default
   * never drops a digit the input had.
   */
  target: z.enum(TARGETS).default('auto'),
  /**
   * UTC BY DEFAULT, AND NEVER "THIS COMPUTER'S ZONE".
   *
   * The zone is part of the answer, and an answer that depended on the
   * machine it was computed on would be a share link that says one thing to
   * its author and another to everyone else - and a cached result that was
   * right until the laptop crossed a border. Somebody who wants their local
   * time names their zone, and the name travels with the pipeline.
   */
  zone: z.string().max(64).default('UTC'),
  clockChange: z.enum(DISAMBIGUATIONS).default('compatible'),
  /** An RFC 6901 JSON Pointer into a wired JSON value: `/payload/exp`. */
  field: z.string().max(256).default(''),
});

export type TimestampOptions = z.output<typeof timestampOptionsSchema>;

export const timestampDefaultOptions: TimestampOptions = timestampOptionsSchema.parse({});

export const timestampOptionFields: readonly OptionField<TimestampOptions>[] = [
  {
    key: 'target',
    label: 'Convert to',
    control: 'select',
    choices: [
      { value: 'auto', label: 'A date for a number, a number for a date' },
      { value: 'utc', label: 'RFC 3339 in UTC' },
      { value: 'local', label: 'RFC 3339 in the time zone' },
      { value: 'rfc9557', label: 'RFC 3339 with the zone name' },
      { value: 'readable', label: 'A readable date' },
      { value: 's', label: 'Unix seconds' },
      { value: 'ms', label: 'Unix milliseconds' },
      { value: 'us', label: 'Unix microseconds' },
      { value: 'ns', label: 'Unix nanoseconds' },
    ],
  },
  {
    key: 'zone',
    label: 'Time zone',
    description:
      'An IANA name such as Europe/Berlin, UTC, or a fixed offset such as +05:30. Dates are written in it, and a date with no offset is read in it.',
    control: 'text',
    placeholder: 'UTC',
  },
  {
    key: 'unit',
    label: 'Numbers are',
    description:
      'Up to 11 digits reads as seconds, 12 to 14 as milliseconds, 15 to 17 as microseconds and 18 or more as nanoseconds.',
    control: 'select',
    choices: [
      { value: 'auto', label: 'Read from their size' },
      { value: 's', label: 'Seconds' },
      { value: 'ms', label: 'Milliseconds' },
      { value: 'us', label: 'Microseconds' },
      { value: 'ns', label: 'Nanoseconds' },
    ],
  },
  {
    key: 'clockChange',
    label: 'At a clock change',
    description:
      'A local time the clocks skipped, or showed twice, has no single instant. The usual rule is RFC 5545 and Temporal: move a skipped time forward by the gap, and take the first of a doubled one.',
    control: 'select',
    choices: [
      { value: 'compatible', label: 'The usual rule' },
      { value: 'earlier', label: 'Always the earlier instant' },
      { value: 'later', label: 'Always the later instant' },
      { value: 'reject', label: 'Refuse' },
    ],
  },
  {
    key: 'field',
    label: 'Field (wired JSON)',
    description:
      'Which value to read when a JSON object is wired in, as a JSON Pointer: /payload/exp reads a decoded JWT expiry. Text input ignores it.',
    control: 'text',
    placeholder: '/payload/exp',
  },
];
