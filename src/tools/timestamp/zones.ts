import { daysFromCivil } from './instant';

/**
 * A TIME ZONE IS A FUNCTION FROM AN INSTANT TO AN OFFSET, AND NOTHING ELSE
 * HERE ASKS IT ANYTHING.
 *
 * The one question - "how far east of UTC is this zone at this instant?" - is
 * the whole interface, and that is what keeps the rest of the tool testable
 * away from any engine: the unit tests hand the conversion code zones built
 * from Python's `zoneinfo` (see `timestamp.oracle.test.ts`), and the tool
 * hands it zones built from the engine's `Intl`. The arithmetic is the same
 * code either way, so a disagreement between the two is a disagreement about
 * ZONE DATA, which is a fact about a browser rather than about this tool.
 */
export interface Zone {
  /** How the zone is written in an answer. */
  readonly name: string;
  /** UTC itself, which RFC 3339 writes as `Z` and which needs no database. */
  readonly utc: boolean;
  /**
   * An offset that never changes - UTC, `+05:30` - so no time zone database
   * is consulted and no two browsers can disagree about it.
   */
  readonly fixed: boolean;
  /** Seconds east of UTC at an instant given in whole seconds since the epoch. */
  offsetAt(epochSeconds: number): number;
}

/** `Date`'s range in seconds: what `Intl` can be asked about. */
const MAX_EPOCH_SECONDS = 8_640_000_000_000;

const clampSeconds = (seconds: number): number =>
  Math.max(-MAX_EPOCH_SECONDS, Math.min(MAX_EPOCH_SECONDS, seconds));

export const UTC_ZONE: Zone = { name: 'UTC', utc: true, fixed: true, offsetAt: () => 0 };

export function fixedOffsetZone(name: string, offsetSeconds: number): Zone {
  return { name, utc: false, fixed: true, offsetAt: () => offsetSeconds };
}

/**
 * The names that are UTC itself rather than a zone at offset zero. `GMT` is
 * deliberately not here: RFC 3339 section 4.3 gives `Z` to UTC, and a zone
 * called GMT is Greenwich - at zero, written `+00:00`.
 */
const UTC_NAMES = new Set([
  'utc',
  'z',
  'etc/utc',
  'uct',
  'etc/uct',
  'universal',
  'etc/universal',
  'zulu',
  'etc/zulu',
]);

/**
 * THE ENGINE'S OWN ZONE DATA, ASKED ONE QUESTION.
 *
 * `formatToParts` for the wall clock at an instant, with every choice that
 * could vary by locale pinned: `en-US` digits, a 23-hour clock, and the era
 * written out, because a Gregorian year in `Intl` is a year of an era - 44 BC
 * arrives as `44` and `BC`, never as -43. The offset is the wall clock minus
 * the instant. `longOffset` would be shorter and was measured unusable:
 * WebKit writes `GMT` where Gecko writes `GMT+00:00`, and neither is
 * specified to carry seconds.
 */
export function intlZone(name: string, formatter: Intl.DateTimeFormat): Zone {
  return {
    name,
    utc: false,
    fixed: false,
    offsetAt(epochSeconds) {
      const at = clampSeconds(epochSeconds);
      const parts: Record<string, string> = {};
      for (const part of formatter.formatToParts(new Date(at * 1000)))
        parts[part.type] = part.value;
      const eraYear = Number(parts.year);
      const year = parts.era === 'BC' ? 1 - eraYear : eraYear;
      const local =
        daysFromCivil(year, Number(parts.month), Number(parts.day)) * 86_400 +
        Number(parts.hour) * 3600 +
        Number(parts.minute) * 60 +
        Number(parts.second);
      return local - at;
    },
  };
}

export type ZoneLookup = { ok: true; zone: Zone } | { ok: false; message: string; detail: string };

const FIXED_OFFSET = /^([+-])(\d{2}):?(\d{2})$/;

/**
 * A zone from what somebody typed: an IANA name, UTC, or a fixed `±HH:MM`.
 *
 * THE NAME IS WRITTEN AS IT WAS TYPED, with only its case corrected, and not
 * as the engine resolves it. Measured: `Asia/Calcutta` resolves to
 * `Asia/Kolkata` in Gecko and stays `Asia/Calcutta` in JavaScriptCore and V8;
 * `US/Eastern` is `America/New_York` in two engines and itself in the third.
 * An answer that changed its zone's spelling depending on the browser would
 * be the same instant with three different strings, and a share link that
 * reproduced differently for everyone who opened it.
 */
export function lookupZone(typed: string): ZoneLookup {
  const trimmed = typed.trim();
  if (trimmed === '' || UTC_NAMES.has(trimmed.toLowerCase())) return { ok: true, zone: UTC_ZONE };

  const fixed = FIXED_OFFSET.exec(trimmed);
  if (fixed) {
    const [, sign, hours, minutes] = fixed;
    const magnitude = Number(hours) * 3600 + Number(minutes) * 60;
    if (Number(hours) > 23 || Number(minutes) > 59) {
      return {
        ok: false,
        message: `"${trimmed}" is not an offset: hours run to 23 and minutes to 59.`,
        detail: 'A fixed offset is written ±HH:MM, such as +05:30.',
      };
    }
    const name = `${sign ?? '+'}${hours ?? '00'}:${minutes ?? '00'}`;
    return { ok: true, zone: fixedOffsetZone(name, sign === '-' ? -magnitude : magnitude) };
  }

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: trimmed,
      numberingSystem: 'latn',
      calendar: 'gregory',
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch {
    const suggestion = suggestZone(trimmed);
    return {
      ok: false,
      message: `"${trimmed}" is not a time zone this browser knows.`,
      detail: `${suggestion === null ? '' : `Did you mean ${suggestion}? `}A zone is an IANA name such as Europe/Berlin or America/New_York, UTC, or a fixed offset such as +05:30.`,
    };
  }

  const resolved = formatter.resolvedOptions().timeZone;
  const name = resolved.toLowerCase() === trimmed.toLowerCase() ? resolved : trimmed;
  return { ok: true, zone: intlZone(name, formatter) };
}

/**
 * `Berlin` → `Europe/Berlin`, offered rather than applied.
 *
 * The list is the engine's own and differs by a few dozen names between the
 * three measured, which is fine for a suggestion and would not be for an
 * answer: nothing here picks a zone on somebody's behalf.
 */
function suggestZone(typed: string): string | null {
  const supported = (Intl as { supportedValuesOf?: (key: string) => readonly string[] })
    .supportedValuesOf;
  if (supported === undefined) return null;
  const wanted = typed.toLowerCase().replace(/ /g, '_');
  const matches = supported('timeZone').filter(
    (zone) => zone.toLowerCase() === wanted || zone.toLowerCase().endsWith(`/${wanted}`),
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/** How a wall time that a clock change made missing or doubled is read. */
export const DISAMBIGUATIONS = ['compatible', 'earlier', 'later', 'reject'] as const;
export type Disambiguation = (typeof DISAMBIGUATIONS)[number];

export type WallReading =
  | { readonly kind: 'unique'; readonly epochSeconds: number }
  | {
      /** A wall time the clocks skipped: it happened nowhere in this zone. */
      readonly kind: 'gap';
      /** Read with the offset before the change - later, and what `compatible` takes. */
      readonly later: number;
      /** Read with the offset after it. */
      readonly earlier: number;
      readonly offsetBefore: number;
      readonly offsetAfter: number;
    }
  | {
      /** A wall time the clocks showed twice. */
      readonly kind: 'overlap';
      readonly earlier: number;
      readonly later: number;
      readonly offsetBefore: number;
      readonly offsetAfter: number;
    };

/**
 * EVERY INSTANT AT WHICH A ZONE'S CLOCKS SHOWED A WALL TIME.
 *
 * Zero, one or two of them. The offset a day before and a day after bracket
 * any single change, and a candidate counts only if the zone really is at the
 * offset it was computed with - which is how a missing hour is told from a
 * doubled one without anybody knowing where the change was. This is the
 * algorithm the Temporal proposal's GetPossibleEpochNanoseconds describes,
 * and it assumes at most one change within a day of the wall time, which
 * `timestamp.oracle.test.ts` holds over every transition in the oracle's
 * zones from 1900 to 2040.
 *
 * `localSeconds` is the wall time read as though it were UTC.
 */
export function readWall(zone: Zone, localSeconds: number): WallReading {
  const offsetBefore = zone.offsetAt(localSeconds - 86_400);
  const offsetAfter = zone.offsetAt(localSeconds + 86_400);
  const found = [...new Set([offsetBefore, offsetAfter])]
    .map((offset) => localSeconds - offset)
    .filter((candidate) => zone.offsetAt(candidate) === localSeconds - candidate)
    .sort((a, b) => a - b);

  const [first, second] = found;
  if (first !== undefined && second !== undefined) {
    return { kind: 'overlap', earlier: first, later: second, offsetBefore, offsetAfter };
  }
  if (first !== undefined) return { kind: 'unique', epochSeconds: first };
  return {
    kind: 'gap',
    later: localSeconds - offsetBefore,
    earlier: localSeconds - offsetAfter,
    offsetBefore,
    offsetAfter,
  };
}

/** The instant a disambiguation picks, or null where it refuses to. */
export function pickInstant(reading: WallReading, rule: Disambiguation): number | null {
  if (reading.kind === 'unique') return reading.epochSeconds;
  if (rule === 'reject') return null;
  if (rule === 'earlier') return reading.earlier;
  if (rule === 'later') return reading.later;
  // `compatible` is what RFC 5545, Temporal and Python's fold=0 agree on: a
  // skipped time moves forward by the length of the gap, and a doubled one
  // is the first of its two.
  return reading.kind === 'gap' ? reading.later : reading.earlier;
}
