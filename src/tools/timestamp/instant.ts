/**
 * AN INSTANT IS A BIGINT OF NANOSECONDS, AND NOT A `Date`.
 *
 * `Date` holds milliseconds in a double, so it cannot carry the nanosecond
 * timestamps OpenTelemetry, Go's UnixNano and every tracing system write -
 * `1727308800123456789` is past 2^53, and a double rounds it to a multiple of
 * 256 before anything has been converted. So the instant here is exact
 * integer nanoseconds since 1970-01-01T00:00:00Z, and `Date` appears only
 * where the engine's time zone data has to be asked a question (`zones.ts`).
 *
 * UNIX TIME, NOT UTC. The count skips leap seconds, as POSIX defines it: every
 * day is 86,400 seconds, so 2016-12-31T23:59:60Z has no number of its own.
 * `parse.ts` says so when one arrives.
 *
 * PROLEPTIC GREGORIAN, as ISO 8601 and ECMAScript both define it: the calendar
 * runs backwards past 1582 unchanged, and year 0 is 1 BC.
 */

export const NS_PER_SECOND = 1_000_000_000n;
export const NS_PER_DAY = 86_400n * NS_PER_SECOND;

/**
 * The range this tool will convert, which is `Date`'s own: 100,000,000 days
 * either side of the epoch, -271821-04-20 to +275760-09-13.
 *
 * NOT A LIMIT OF THE ARITHMETIC, which is BigInt and has none. It is the
 * range the engine's time zone data can be asked about - `Intl` takes a
 * `Date` - so an instant outside it has no offset in any zone but UTC, and a
 * tool that answered in UTC alone past a boundary nobody can see would be
 * answering a different question at the same prompt.
 */
export const MAX_EPOCH_NS = 100_000_000n * NS_PER_DAY;
export const MIN_EPOCH_NS = -MAX_EPOCH_NS;

/** Floor division: towards negative infinity, where `/` truncates towards zero. */
export function floorDiv(a: bigint, b: bigint): bigint {
  const quotient = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? quotient - 1n : quotient;
}

/** The remainder that goes with `floorDiv`: always the sign of `b`. */
export function floorMod(a: bigint, b: bigint): bigint {
  return a - floorDiv(a, b) * b;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return MONTH_LENGTHS[month - 1] ?? 0;
}

/**
 * Days since 1970-01-01 for a proleptic Gregorian date.
 *
 * Howard Hinnant's `days_from_civil`, which shifts the year to start in March
 * so February's variable length falls at the end of it. Exact for every date
 * in range: the day count is at most 10^8, well inside a double's integers.
 */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const shiftedMonth = month > 2 ? month - 3 : month + 9;
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** The inverse of `daysFromCivil`, from the same paper. */
export function civilFromDays(days: number): CivilDate {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1;
  const month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

/** ISO weekday, 1 for Monday to 7 for Sunday. 1970-01-01 was a Thursday. */
export function isoWeekday(days: number): number {
  return ((((days + 3) % 7) + 7) % 7) + 1;
}

export const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** A wall-clock reading with no zone attached: what a clock on a wall shows. */
export interface WallTime extends CivilDate {
  readonly hour: number;
  readonly minute: number;
  /** 0-59. A leap second's 60 is handled before a WallTime exists. */
  readonly second: number;
  /** 0 to 999,999,999. */
  readonly nanosecond: number;
}

/** Whole seconds since the epoch for a wall time read as though it were UTC. */
export function wallSeconds(wall: WallTime): number {
  return (
    daysFromCivil(wall.year, wall.month, wall.day) * 86_400 +
    wall.hour * 3600 +
    wall.minute * 60 +
    wall.second
  );
}

/** The wall time at an instant, `offset` seconds east of UTC. */
export function wallAt(epochNs: bigint, offsetSeconds: number): WallTime {
  const local = epochNs + BigInt(offsetSeconds) * NS_PER_SECOND;
  const days = Number(floorDiv(local, NS_PER_DAY));
  const withinDay = floorMod(local, NS_PER_DAY);
  const secondOfDay = Number(withinDay / NS_PER_SECOND);
  const { year, month, day } = civilFromDays(days);
  return {
    year,
    month,
    day,
    hour: Math.floor(secondOfDay / 3600),
    minute: Math.floor((secondOfDay % 3600) / 60),
    second: secondOfDay % 60,
    nanosecond: Number(withinDay % NS_PER_SECOND),
  };
}

/** The day number of an instant's wall date at an offset, for its weekday. */
export function daysAt(epochNs: bigint, offsetSeconds: number): number {
  return Number(floorDiv(epochNs + BigInt(offsetSeconds) * NS_PER_SECOND, NS_PER_DAY));
}

const pad = (value: number, width: number): string => value.toString().padStart(width, '0');

/**
 * A year as ISO 8601 writes it: four digits from 0000 to 9999, and outside
 * that the EXPANDED form, a sign and six digits - which is also what
 * ECMAScript's `toISOString` writes, so `+275760` and `-000001` are spellings
 * every JavaScript reader already accepts. RFC 3339 has no such form; see
 * `isRfc3339Year`.
 */
export function formatYear(year: number): string {
  if (year >= 0 && year <= 9999) return pad(year, 4);
  return `${year < 0 ? '-' : '+'}${pad(Math.abs(year), 6)}`;
}

/** RFC 3339's `date-fullyear` is exactly four digits. */
export function isRfc3339Year(year: number): boolean {
  return year >= 0 && year <= 9999;
}

/**
 * `.123`, `.123456789`, or nothing: the nanoseconds with trailing zeros
 * removed, so a whole second is written as one and nothing is invented.
 */
export function formatFraction(nanosecond: number): string {
  if (nanosecond === 0) return '';
  return `.${pad(nanosecond, 9).replace(/0+$/, '')}`;
}

/**
 * An offset as `+02:00`, or `+00:19:32` when it is not a whole minute.
 *
 * THE SECONDS ARE WRITTEN RATHER THAN ROUNDED AWAY. Local mean time before a
 * zone's first standard offset is to the second - Africa/Monrovia was
 * -00:44:30 until 1972 - and RFC 3339 has no spelling for that: its offset is
 * hours and minutes. Rounding would print a local time and an offset that no
 * longer add up to the instant, which is a wrong answer that parses; writing
 * the seconds, as Python's `isoformat` and Temporal both do, is a string a
 * strict RFC 3339 reader refuses loudly. The tool says which it did.
 */
export function formatOffset(offsetSeconds: number): string {
  const sign = offsetSeconds < 0 ? '-' : '+';
  const magnitude = Math.abs(offsetSeconds);
  const hours = Math.floor(magnitude / 3600);
  const minutes = Math.floor((magnitude % 3600) / 60);
  const seconds = magnitude % 60;
  return `${sign}${pad(hours, 2)}:${pad(minutes, 2)}${seconds === 0 ? '' : `:${pad(seconds, 2)}`}`;
}

/** `2024-09-26T08:00:00.5` - date, `T`, time, fraction. No offset. */
export function formatWall(wall: WallTime): string {
  return `${formatYear(wall.year)}-${pad(wall.month, 2)}-${pad(wall.day, 2)}T${pad(wall.hour, 2)}:${pad(wall.minute, 2)}:${pad(wall.second, 2)}${formatFraction(wall.nanosecond)}`;
}

/**
 * RFC 3339, at an offset. `Z` when the zone IS UTC, and `+00:00` when a zone
 * merely happens to be at zero - RFC 3339 section 4.3 distinguishes the two,
 * and so does anything that reads the string back into a zone.
 */
export function formatRfc3339(epochNs: bigint, offsetSeconds: number, utc: boolean): string {
  const wall = wallAt(epochNs, offsetSeconds);
  return `${formatWall(wall)}${utc ? 'Z' : formatOffset(offsetSeconds)}`;
}

/**
 * `Thursday 26 September 2024, 08:00:00 +02:00 (Europe/Berlin)`.
 *
 * WRITTEN HERE RATHER THAN BY `Intl.DateTimeFormat`, and that is the whole of
 * why this format can be tested. The engine's long date format comes from its
 * CLDR data at its own version - `at` against `,` between date and time, a
 * narrow no-break space before `PM` in newer data and not older - and from the
 * reader's locale, so the same instant is a different string in each browser
 * and nothing outside this repository can say which is right. English names
 * from a fixed table, a numeric offset and the zone's IANA name are the same
 * string in every engine, can be checked against Python's `strftime`, and read
 * back in by this tool. Abbreviations (`CEST`, `IST`) are left out because
 * they are ambiguous - IST is India, Ireland and Israel - and because they
 * are CLDR data too.
 */
export function formatReadable(
  epochNs: bigint,
  offsetSeconds: number,
  zoneName: string,
  utc: boolean,
): string {
  const wall = wallAt(epochNs, offsetSeconds);
  const weekday = WEEKDAY_NAMES[isoWeekday(daysAt(epochNs, offsetSeconds)) - 1] ?? '';
  const month = MONTH_NAMES[wall.month - 1] ?? '';
  const time = `${pad(wall.hour, 2)}:${pad(wall.minute, 2)}:${pad(wall.second, 2)}${formatFraction(wall.nanosecond)}`;
  const where = utc ? 'UTC' : `${formatOffset(offsetSeconds)} (${zoneName})`;
  return `${weekday} ${wall.day.toString()} ${month} ${formatYear(wall.year)}, ${time} ${where}`;
}

export const UNITS = ['s', 'ms', 'us', 'ns'] as const;
export type Unit = (typeof UNITS)[number];

/** Nanoseconds in one of each unit. */
export const UNIT_NS: Readonly<Record<Unit, bigint>> = {
  s: NS_PER_SECOND,
  ms: 1_000_000n,
  us: 1_000n,
  ns: 1n,
};

/** The powers of ten `UNIT_NS` is, for exact decimal arithmetic. */
export const UNIT_EXPONENT: Readonly<Record<Unit, number>> = { s: 9, ms: 6, us: 3, ns: 0 };

export const UNIT_WORDS: Readonly<Record<Unit, string>> = {
  s: 'seconds',
  ms: 'milliseconds',
  us: 'microseconds',
  ns: 'nanoseconds',
};

/**
 * Unix time in a unit, as an INTEGER, floored.
 *
 * Floored rather than truncated towards zero: a Unix time names the second an
 * instant falls in, and 1969-12-31T23:59:59.5Z falls in second -1, not 0.
 * That is `Math.floor(Date.now() / 1000)`, Go's `Unix()` and POSIX's own
 * definition; `int()` of a Python float disagrees below the epoch and is the
 * odd one out. Whether anything was dropped is the caller's to report.
 */
export function unixInteger(epochNs: bigint, unit: Unit): { value: bigint; dropped: bigint } {
  return {
    value: floorDiv(epochNs, UNIT_NS[unit]),
    dropped: floorMod(epochNs, UNIT_NS[unit]),
  };
}

/**
 * Unix time in a unit, EXACTLY, as a decimal: `1727308800.123`.
 *
 * What the Notations output carries, so that no notation there is a rounding
 * of another: an integer where the instant is whole in that unit, and the
 * decimal digits that make it exact where it is not.
 */
export function unixDecimal(epochNs: bigint, unit: Unit): string {
  const { value, dropped } = unixInteger(epochNs, unit);
  if (dropped === 0n) return value.toString();
  // Written from the magnitude so that -0.5 s is `-0.5` rather than `-1.5`.
  const negative = epochNs < 0n;
  const magnitude = negative ? -epochNs : epochNs;
  const whole = magnitude / UNIT_NS[unit];
  const fraction = (magnitude % UNIT_NS[unit])
    .toString()
    .padStart(UNIT_EXPONENT[unit], '0')
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/** The coarsest unit that holds an instant exactly: nothing lost choosing it. */
export function exactUnit(epochNs: bigint): Unit {
  for (const unit of UNITS) {
    if (floorMod(epochNs, UNIT_NS[unit]) === 0n) return unit;
  }
  return 'ns';
}
