/**
 * Timestamps a person can read, beside the number a machine wrote.
 *
 * A JWT states its times as epoch seconds, which is the correct thing for the
 * token to carry and a useless thing to look at: nobody knows whether
 * 1788706923 has passed. The view shows both - the moment in words, the
 * integer beside it - because the reason someone is reading a token by hand is
 * usually that a server disagreed with them about one of these numbers, and
 * the number is what they will paste into the argument.
 *
 * `nowMs` is a parameter rather than a call to `Date.now()`, the same choice
 * `describeClaims` makes in the tool, so both can be pinned in a test.
 */

/** Second, minute, hour, day, month, year - in seconds, largest last. */
const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['second', 1],
  ['minute', 60],
  ['hour', 3600],
  ['day', 86_400],
  ['month', 2_629_800],
  ['year', 31_557_600],
];

/*
 * `numeric: 'always'`, so a day ago is "1 day ago" and not "yesterday".
 *
 * "Yesterday" is friendlier and worse here: it rounds, and this string sits
 * next to a verdict about whether a token is currently valid. A token that
 * expired "yesterday" may have expired thirty hours ago or ninety seconds
 * after midnight, and those are different conversations.
 */
const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'always' });

/**
 * Absolute, in the reader's own time zone, with the zone named.
 *
 * The zone is not decoration. A token's `exp` is UTC and the machine that
 * refused it may be somewhere else again, so a bare "14:22" invites exactly
 * the wrong conclusion. Explicit components rather than `dateStyle`, because
 * `dateStyle` and `timeZoneName` cannot be combined.
 */
const ABSOLUTE = new Intl.DateTimeFormat('en', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});

/** Epoch milliseconds a `Date` can actually represent. */
const MAX_MS = 8.64e15;

export function isRepresentable(ms: number): boolean {
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_MS;
}

/** "3 days ago", "in 12 minutes". Rounded towards zero, largest unit that fits. */
export function relativeTime(targetMs: number, nowMs: number): string {
  const seconds = (targetMs - nowMs) / 1000;
  const magnitude = Math.abs(seconds);

  // Below a second there is no unit small enough to be honest about.
  if (magnitude < 1) return 'just now';

  let unit: Intl.RelativeTimeFormatUnit = 'second';
  let size = 1;
  for (const [candidate, candidateSize] of UNITS) {
    if (magnitude >= candidateSize) {
      unit = candidate;
      size = candidateSize;
    }
  }

  // Truncated rather than rounded: "in 1 hour" for something 119 minutes away
  // understates it, and understating the time left on a token is the direction
  // that costs somebody an afternoon.
  return RELATIVE.format(Math.trunc(seconds / size), unit);
}

/** "6 Sep 2026, 14:22 GMT+2", in the reader's zone. */
export function absoluteTime(ms: number): string {
  return ABSOLUTE.format(new Date(ms));
}

/**
 * A registered claim's time, in every form worth having.
 *
 * Returns null for anything that is not a usable moment, so a token carrying
 * `"exp": "soon"` or `1e300` yields a missing row rather than "Invalid Date".
 */
export interface Moment {
  readonly iso: string;
  readonly absolute: string;
  /**
   * Null when there is no clock to be relative TO.
   *
   * A payload from a build that predates `checkedAt` has no moment the verdict
   * was computed at, and the alternative - reading this machine's clock at
   * render time - would print a countdown that disagrees with the `expired`
   * flag beside it. Saying less is the honest degradation.
   */
  readonly relative: string | null;
  readonly epochSeconds: number;
}

export function momentOf(epochSeconds: number, nowMs: number | null): Moment | null {
  const ms = epochSeconds * 1000;
  if (!isRepresentable(ms)) return null;

  return {
    iso: new Date(ms).toISOString(),
    absolute: absoluteTime(ms),
    relative: nowMs === null ? null : relativeTime(ms, nowMs),
    epochSeconds,
  };
}
