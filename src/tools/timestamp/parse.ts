import {
  MAX_EPOCH_NS,
  MIN_EPOCH_NS,
  MONTH_NAMES,
  UNIT_EXPONENT,
  civilFromDays,
  UNIT_WORDS,
  WEEKDAY_NAMES,
  daysFromCivil,
  daysInMonth,
  floorDiv,
  floorMod,
  formatYear,
  isoWeekday,
  type Unit,
  type WallTime,
} from './instant';

/**
 * WHAT THIS TOOL READS, AND WHY THE LIST STOPS WHERE IT DOES.
 *
 * Every form below has a specification or a reference implementation that can
 * say whether a reading is right, and that is the rule that decided the list:
 *
 *   - a Unix time: an integer or a decimal, in seconds, milliseconds,
 *     microseconds or nanoseconds, with an optional exponent;
 *   - RFC 3339, and the parts of ISO 8601 around it that real software
 *     writes: a space for the `T`, no seconds, a comma for the decimal point,
 *     `+0200` and `+02` offsets, the basic format `20240926T080000Z`, a date
 *     alone, and a trailing `UTC` or zone abbreviation after a numeric offset,
 *     which is Go's `time.String()`;
 *   - an RFC 9557 zone suffix, `[Europe/Berlin]`, after any of those, which
 *     is the only way to say which zone a wall time is in without an offset;
 *   - RFC 5322's date-time, which is every email `Date:` and every HTTP
 *     `Date:`, `Expires:` and `Last-Modified:` header (RFC 9110's IMF-fixdate
 *     is a subset of it);
 *   - this tool's own readable form, so that what it writes it can read back;
 *   - any of the above as the value of a `key: value` line or a JSON member,
 *     because that is how they arrive: `"created_at": 1727308800`.
 *
 * WHAT IT REFUSES, on purpose: `26/09/2024`, whose day and month nobody can
 * tell apart; natural language - "next Friday" - which has no reference
 * anything can be checked against and depends on the moment it is read; and
 * the formats that carry only an ambiguous zone abbreviation (`CEST`, `IST`),
 * such as `date`'s default and `git log`'s. See the README.
 */

export interface Offset {
  readonly seconds: number;
  /**
   * RFC 3339's `-00:00` and RFC 5322's `-0000`: the instant is known as UTC
   * and the local offset where it was written is explicitly NOT known.
   */
  readonly unknown: boolean;
}

export type Syntax = 'rfc3339' | 'iso8601' | 'rfc5322' | 'readable';

export type Parsed =
  | {
      readonly kind: 'number';
      readonly epochNs: bigint;
      readonly unit: Unit;
      /** The unit was read off the number's size, not chosen by anybody. */
      readonly guessed: boolean;
      /** The number asked for more precision than a nanosecond, and was floored. */
      readonly dropped: boolean;
      readonly written: string;
      /** A key it was the value of, in `key: value`. */
      readonly key: string | null;
    }
  | {
      readonly kind: 'wall';
      readonly syntax: Syntax;
      readonly wall: WallTime;
      readonly offset: Offset | null;
      /** An RFC 9557 suffix, or the zone in this tool's own readable form. */
      readonly zone: string | null;
      /** RFC 9557's `!`: the zone must be honoured or the input refused. */
      readonly zoneCritical: boolean;
      /** 23:59:60 was written, and `wall` holds :59. */
      readonly leapSecond: boolean;
      /** 24:00 was written, and `wall` holds 00:00 the next day. */
      readonly endOfDay: boolean;
      readonly dateOnly: boolean;
      /** RFC 5322's obsolete two- or three-digit year, as it was written. */
      readonly shortYear: string | null;
      /** A zone abbreviation after a numeric offset, not read. */
      readonly abbreviation: string | null;
      /** Fraction digits past the ninth, dropped. */
      readonly dropped: boolean;
      readonly written: string;
      readonly key: string | null;
    };

export type ParseResult =
  | { readonly ok: true; readonly value: Parsed }
  | { readonly ok: false; readonly message: string; readonly detail: string };

const refuse = (message: string, detail: string): ParseResult => ({ ok: false, message, detail });

const FORMS =
  'This reads a Unix time (1727308800, 1727308800123, 1727308800.5), RFC 3339 or ISO 8601 (2024-09-26T08:00:00+02:00, 2024-09-26 08:00), an RFC 9557 zone suffix (2024-09-26T08:00[Europe/Berlin]) and an email or HTTP date (Thu, 26 Sep 2024 06:00:00 GMT).';

/**
 * The one threshold per unit that the size of a number decides.
 *
 * By DIGITS, because that is how a person tells them apart at a glance: up to
 * eleven digits is seconds, twelve to fourteen milliseconds, fifteen to
 * seventeen microseconds, eighteen or more nanoseconds. For any instant from
 * 1980 to 2100 the four readings of one number are at least 77 times apart, so
 * exactly one of them lands in that window - see `PLAUSIBLE_FROM` - and the
 * thresholds put every such number in the unit that does.
 */
const UNIT_THRESHOLDS: readonly (readonly [bigint, Unit])[] = [
  [100_000_000_000n, 's'],
  [100_000_000_000_000n, 'ms'],
  [100_000_000_000_000_000n, 'us'],
];

const NUMBER = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d{1,4}))?$/;

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/**
 * A Unix time, read exactly.
 *
 * The digits become one BigInt and a power of ten, so `1727308800.123456789`
 * is exactly those nanoseconds and `1.7273088e9` is exactly that second - no
 * double is involved at any point, which is the only way a nanosecond count
 * past 2^53 survives being read.
 */
export function parseNumber(text: string, unit: Unit | 'auto'): ParseResult | null {
  const match = NUMBER.exec(text);
  if (!match) return null;
  const [, sign = '', whole = '', fraction = '', exponent = '0'] = match;

  const digits = BigInt(`${whole}${fraction}`);
  const scale = Number(exponent) - fraction.length;
  const signed = sign === '-' ? -digits : digits;

  const chosen = unit === 'auto' ? unitBySize(digits, scale) : unit;
  const power = scale + UNIT_EXPONENT[chosen];

  if (digits !== 0n && power > 30) return outOfRange(text);
  const divisor = power >= 0 ? 1n : pow10(-power);
  const epochNs = power >= 0 ? signed * pow10(power) : floorDiv(signed, divisor);
  const dropped = power < 0 && floorMod(signed, divisor) !== 0n;

  if (epochNs > MAX_EPOCH_NS || epochNs < MIN_EPOCH_NS) return outOfRange(text);
  return {
    ok: true,
    value: {
      kind: 'number',
      epochNs,
      unit: chosen,
      guessed: unit === 'auto',
      dropped,
      written: text,
      key: null,
    },
  };
}

function unitBySize(digits: bigint, scale: number): Unit {
  if (scale > 30) return 'ns';
  const magnitude = scale >= 0 ? digits * pow10(scale) : digits / pow10(-scale);
  for (const [limit, unit] of UNIT_THRESHOLDS) if (magnitude < limit) return unit;
  return 'ns';
}

function outOfRange(written: string): ParseResult {
  return refuse(
    `${written} is outside the dates this browser can represent.`,
    'That is 100,000,000 days either side of 1970: from -271821-04-20 to +275760-09-13, which is the range of a JavaScript Date and of every time zone database a browser can be asked. Check the unit - a nanosecond count read as seconds is a billion times too far.',
  );
}

const ISO_EXTENDED =
  /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?(?:\s*(Z|z|UTC|GMT|[+-]\d{2}(?::\d{2}(?::\d{2})?)?|[+-]\d{4}(?:\d{2})?)(?:\s+([A-Za-z]{2,6}))?)?(?:\s*\[(!?)([^\]\s]+)\])?$/;

const ISO_BASIC =
  /^(\d{4})(\d{2})(\d{2})[Tt](\d{2})(\d{2})(?:(\d{2})(?:[.,](\d+))?)?(Z|z|[+-]\d{2}(?:\d{2})?)?(?:\[(!?)([^\]\s]+)\])?$/;

const MONTH_ABBREVIATIONS = MONTH_NAMES.map((name) => name.slice(0, 3).toLowerCase());
const WEEKDAY_ABBREVIATIONS = WEEKDAY_NAMES.map((name) => name.slice(0, 3).toLowerCase());

const RFC5322 =
  /^(?:(mon|tue|wed|thu|fri|sat|sun)\s*,\s*)?(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{2,4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+([+-]\d{4}|ut|gmt|est|edt|cst|cdt|mst|mdt|pst|pdt)$/i;

/** RFC 5322 section 4.3's obsolete zone names, which are all the zones it names. */
const RFC5322_ZONES: Readonly<Record<string, number>> = {
  ut: 0,
  gmt: 0,
  est: -5,
  edt: -4,
  cst: -6,
  cdt: -5,
  mst: -7,
  mdt: -6,
  pst: -8,
  pdt: -7,
};

const READABLE = new RegExp(
  `^(?:(${WEEKDAY_NAMES.join('|')})\\s+)?(\\d{1,2})\\s+(${MONTH_NAMES.join('|')})\\s+([+-]\\d{6}|\\d{4}),\\s+(\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d+))?)?\\s+(UTC|[+-]\\d{2}:\\d{2}(?::\\d{2})?)(?:\\s+\\(([^)]+)\\))?$`,
  'i',
);

/** `+02:00`, `+0200`, `+02`, `+00:19:32`, `Z`: seconds east of UTC. */
function readOffset(text: string): Offset {
  if (/^(?:z|utc|gmt)$/i.test(text)) return { seconds: 0, unknown: false };
  const digits = text.slice(1).replace(/:/g, '');
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2, 4) || '0');
  const seconds = Number(digits.slice(4, 6) || '0');
  const magnitude = hours * 3600 + minutes * 60 + seconds;
  const negative = text.startsWith('-');
  return { seconds: negative ? -magnitude : magnitude, unknown: negative && magnitude === 0 };
}

function offsetInRange(text: string): boolean {
  const digits = text.replace(/[+:-]/g, '');
  return (
    Number(digits.slice(0, 2)) <= 23 &&
    Number(digits.slice(2, 4) || '0') <= 59 &&
    Number(digits.slice(4, 6) || '0') <= 59
  );
}

interface Fields {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly fraction: string;
}

type Checked =
  | { ok: true; wall: WallTime; leapSecond: boolean; endOfDay: boolean; dropped: boolean }
  | { ok: false; message: string; detail: string };

/**
 * The ranges RFC 3339 section 5.7 sets, applied to every syntax.
 *
 * `24:00` is ISO 8601's end of a day and is read as 00:00 of the next one;
 * RFC 3339 does not allow it. `:60` is kept as a flag, because whether it is
 * a real leap second depends on the instant, which is not known until the
 * offset has been applied.
 */
function check(fields: Fields, written: string): Checked {
  const { year, month, day, hour, minute, second, fraction } = fields;
  if (month < 1 || month > 12) {
    return {
      ok: false,
      message: `${written} has no month ${month.toString()}.`,
      detail: 'Months run from 01 to 12.',
    };
  }
  const length = daysInMonth(year, month);
  if (day < 1 || day > length) {
    return {
      ok: false,
      message: `${written} names day ${day.toString()} of a month that has ${length.toString()}.`,
      detail:
        month === 2 && day === 29
          ? `${formatYear(year)} is not a leap year.`
          : 'The date does not exist.',
    };
  }
  const endOfDay = hour === 24 && minute === 0 && second === 0 && /^0*$/.test(fraction);
  if ((hour > 23 && !endOfDay) || minute > 59 || second > 60) {
    return {
      ok: false,
      message: `${written} is not a time of day.`,
      detail:
        'Hours run from 00 to 23, minutes from 00 to 59 and seconds from 00 to 59 - or 60 for a leap second.',
    };
  }
  const nanosecond = Number(fraction.slice(0, 9).padEnd(9, '0'));
  const dropped = /[1-9]/.test(fraction.slice(9));
  if (endOfDay) {
    const next = daysFromCivil(year, month, day) + 1;
    return {
      ok: true,
      wall: { ...civilFromDays(next), hour: 0, minute: 0, second: 0, nanosecond: 0 },
      leapSecond: false,
      endOfDay: true,
      dropped: false,
    };
  }
  return {
    ok: true,
    wall: { year, month, day, hour, minute, second: second === 60 ? 59 : second, nanosecond },
    leapSecond: second === 60,
    endOfDay: false,
    dropped,
  };
}

function wallResult(
  checked: Checked,
  rest: Omit<
    Extract<Parsed, { kind: 'wall' }>,
    'kind' | 'wall' | 'leapSecond' | 'endOfDay' | 'dropped'
  >,
): ParseResult {
  if (!checked.ok) return refuse(checked.message, checked.detail);
  return {
    ok: true,
    value: {
      kind: 'wall',
      wall: checked.wall,
      leapSecond: checked.leapSecond,
      endOfDay: checked.endOfDay,
      dropped: checked.dropped,
      ...rest,
    },
  };
}

function parseIso(text: string): ParseResult | null {
  const extended = ISO_EXTENDED.exec(text);
  const basic = extended ? null : ISO_BASIC.exec(text);
  const match = extended ?? basic;
  if (!match) return null;

  const [, yearText = '', month = '', day = '', hour, minute, second, fraction = ''] = match;
  const offsetText = match[8];
  const abbreviation = extended ? (match[9] ?? null) : null;
  const critical = (extended ? match[10] : match[9]) === '!';
  const zone = (extended ? match[11] : match[10]) ?? null;

  if (yearText === '-000000') {
    return refuse(
      `${text} writes year zero as -000000.`,
      'ISO 8601 and ECMAScript write year zero as 0000 or +000000; a minus zero is not a year.',
    );
  }
  if (zone?.includes('=')) {
    return refuse(
      `${text} carries the annotation [${zone}], which this tool does not read.`,
      'RFC 9557 annotations other than a time zone name - a calendar, u-ca=, for one - are not supported. Remove it, or keep only the zone.',
    );
  }
  if (abbreviation !== null && (offsetText === undefined || /^[a-z]/i.test(offsetText))) {
    return null;
  }
  if (offsetText !== undefined && /^[+-]/.test(offsetText) && !offsetInRange(offsetText)) {
    return refuse(
      `${text} has an offset of ${offsetText}, which is not one.`,
      'An offset is at most ±23:59.',
    );
  }

  const dateOnly = hour === undefined;
  // RFC 3339 is the strict core of ISO 8601: `T`, seconds, a full stop for
  // the fraction, four-digit years and `Z` or `±HH:MM`. Anything looser is
  // ISO 8601, which says so in the report and changes nothing else.
  const rfc3339 =
    extended !== null &&
    /[Tt]/.test(text) &&
    second !== undefined &&
    !text.includes(',') &&
    /^\d{4}$/.test(yearText) &&
    offsetText !== undefined &&
    /^(?:[Zz]|[+-]\d{2}:\d{2})$/.test(offsetText) &&
    abbreviation === null;
  const syntax: Syntax = rfc3339 ? 'rfc3339' : 'iso8601';

  return wallResult(
    check(
      {
        year: Number(yearText),
        month: Number(month),
        day: Number(day),
        hour: Number(hour ?? '0'),
        minute: Number(minute ?? '0'),
        second: Number(second ?? '0'),
        fraction,
      },
      text,
    ),
    {
      syntax,
      offset: offsetText === undefined ? null : readOffset(offsetText),
      zone,
      zoneCritical: critical,
      dateOnly,
      shortYear: null,
      abbreviation,
      written: text,
      key: null,
    },
  );
}

function parseRfc5322(text: string): ParseResult | null {
  const match = RFC5322.exec(text);
  if (!match) return null;
  const [
    ,
    weekday,
    day = '',
    monthName = '',
    yearText = '',
    hour = '',
    minute = '',
    second,
    zoneText = '',
  ] = match;

  /*
   * RFC 5322 section 4.3: a two-digit year from 00 to 49 is 2000 onwards and
   * from 50 to 99 is the 1900s; a three-digit year has 1900 added. Obsolete,
   * and still what some mail software writes.
   */
  const written = Number(yearText);
  const year =
    yearText.length === 4
      ? written
      : yearText.length === 3
        ? written + 1900
        : written < 50
          ? written + 2000
          : written + 1900;
  const month = MONTH_ABBREVIATIONS.indexOf(monthName.toLowerCase()) + 1;

  const offset: Offset = /^[+-]/.test(zoneText)
    ? readOffset(zoneText)
    : { seconds: (RFC5322_ZONES[zoneText.toLowerCase()] ?? 0) * 3600, unknown: false };

  const checked = check(
    {
      year,
      month,
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: Number(second ?? '0'),
      fraction: '',
    },
    text,
  );
  if (checked.ok && weekday !== undefined) {
    const actual = isoWeekday(daysFromCivil(year, month, Number(day)));
    const named = WEEKDAY_ABBREVIATIONS.indexOf(weekday.toLowerCase()) + 1;
    if (actual !== named) {
      return refuse(
        `${text} says ${WEEKDAY_NAMES[named - 1] ?? weekday}, and that date was a ${WEEKDAY_NAMES[actual - 1] ?? ''}.`,
        'RFC 5322 section 3.3 requires the day of the week to be the one the date implies, so one of the two is wrong and this tool will not choose which.',
      );
    }
  }
  return wallResult(checked, {
    syntax: 'rfc5322',
    offset,
    zone: null,
    zoneCritical: false,
    dateOnly: false,
    shortYear: yearText.length === 4 ? null : yearText,
    abbreviation: null,
    written: text,
    key: null,
  });
}

function parseReadable(text: string): ParseResult | null {
  const match = READABLE.exec(text);
  if (!match) return null;
  const [
    ,
    weekday,
    day = '',
    monthName = '',
    yearText = '',
    hour = '',
    minute = '',
    second,
    fraction = '',
    offsetText = '',
    zone,
  ] = match;
  const year = Number(yearText);
  const month = MONTH_NAMES.findIndex((name) => name.toLowerCase() === monthName.toLowerCase()) + 1;
  const checked = check(
    {
      year,
      month,
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: Number(second ?? '0'),
      fraction,
    },
    text,
  );
  if (checked.ok && weekday !== undefined) {
    const actual = isoWeekday(daysFromCivil(year, month, Number(day)));
    const named =
      WEEKDAY_NAMES.findIndex((name) => name.toLowerCase() === weekday.toLowerCase()) + 1;
    if (actual !== named) {
      return refuse(
        `${text} says ${WEEKDAY_NAMES[named - 1] ?? weekday}, and that date was a ${WEEKDAY_NAMES[actual - 1] ?? ''}.`,
        'One of the two is wrong, and this tool will not choose which.',
      );
    }
  }
  return wallResult(checked, {
    syntax: 'readable',
    offset: readOffset(offsetText),
    zone: zone ?? null,
    zoneCritical: false,
    dateOnly: false,
    shortYear: null,
    abbreviation: null,
    written: text,
    key: null,
  });
}

const KEY_VALUE = /^"?([A-Za-z_][\w.-]*)"?\s*:\s+(.+?)\s*,?$/;
const AMBIGUOUS_ORDER = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}(?:[ T,]|$)/;

/**
 * Reads one timestamp.
 *
 * A pair of double quotes around the whole of it is removed, because a JSON
 * string is how a timestamp most often arrives, and so is a `key:` in front
 * of it - `"created_at": 1727308800` and `Date: Thu, 26 Sep 2024 ...` are
 * read as the value they carry, with the key reported.
 */
export function parseTimestamp(input: string, unit: Unit | 'auto'): ParseResult {
  const trimmed = input.trim();
  if (trimmed === '') return refuse('Nothing to convert: the input is empty.', FORMS);

  const direct = parseOne(trimmed, unit);
  if (direct !== null) return direct;

  const pair = KEY_VALUE.exec(trimmed);
  if (pair) {
    const [, key = '', value = ''] = pair;
    const inner = parseOne(value, unit);
    if (inner !== null) {
      return inner.ok ? { ok: true, value: { ...inner.value, key } } : inner;
    }
  }

  if (AMBIGUOUS_ORDER.test(trimmed)) {
    return refuse(
      `${trimmed} does not say which number is the day and which the month.`,
      `The same digits are a date in September in Europe and a date in a different month in the United States, and nothing in them says which was meant. Write it as ISO 8601, year first: 2024-09-26. ${FORMS}`,
    );
  }
  return refuse(
    `"${trimmed.slice(0, 80)}" is not a timestamp this tool reads.`,
    `${FORMS} It does not read natural language such as "next Friday".`,
  );
}

function parseOne(text: string, unit: Unit | 'auto'): ParseResult | null {
  const unquoted =
    text.length >= 2 && text.startsWith('"') && text.endsWith('"')
      ? text.slice(1, -1).trim()
      : text;
  return (
    parseNumber(unquoted, unit) ??
    parseIso(unquoted) ??
    parseRfc5322(unquoted) ??
    parseReadable(unquoted)
  );
}

export { UNIT_WORDS };
