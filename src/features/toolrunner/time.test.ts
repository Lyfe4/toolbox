import { describe, expect, it } from 'vitest';

import { absoluteTime, momentOf, relativeTime } from './time';

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);

describe('relativeTime', () => {
  it('picks the largest unit that fits', () => {
    expect(relativeTime(NOW + 30_000, NOW)).toBe('in 30 seconds');
    expect(relativeTime(NOW + 90_000, NOW)).toBe('in 1 minute');
    expect(relativeTime(NOW - 7_200_000, NOW)).toBe('2 hours ago');
    expect(relativeTime(NOW - 3 * 86_400_000, NOW)).toBe('3 days ago');
    expect(relativeTime(NOW - 400 * 86_400_000, NOW)).toBe('1 year ago');
  });

  /*
   * Truncated, not rounded. Something 119 minutes away rounds to "in 2 hours"
   * and truncates to "in 1 hour"; a token with 1h59m left described as having
   * two hours is the direction that costs somebody an afternoon.
   */
  it('truncates towards zero rather than rounding up', () => {
    expect(relativeTime(NOW + 119 * 60_000, NOW)).toBe('in 1 hour');
    expect(relativeTime(NOW - 119 * 60_000, NOW)).toBe('1 hour ago');
  });

  /*
   * "1 day ago" rather than "yesterday". Yesterday rounds, and this string
   * sits beside a verdict on whether a token is valid right now.
   */
  it('always states a number, never "yesterday"', () => {
    expect(relativeTime(NOW - 86_400_000, NOW)).toBe('1 day ago');
    expect(relativeTime(NOW + 86_400_000, NOW)).toBe('in 1 day');
  });

  it('says "just now" below a second rather than inventing a unit', () => {
    expect(relativeTime(NOW, NOW)).toBe('just now');
    expect(relativeTime(NOW + 400, NOW)).toBe('just now');
  });
});

describe('absoluteTime', () => {
  it('names the time zone, because a bare clock time invites the wrong conclusion', () => {
    // The zone itself is the machine's, so the assertion is that one is named
    // at all rather than which one it is.
    expect(absoluteTime(NOW)).toMatch(/\b(GMT|UTC)/);
    expect(absoluteTime(NOW)).toContain('2026');
  });
});

describe('momentOf', () => {
  it('gives the ISO form, the readable form and the raw seconds together', () => {
    const moment = momentOf(NOW / 1000, NOW + 60_000);

    expect(moment?.iso).toBe('2026-09-06T12:00:00.000Z');
    expect(moment?.relative).toBe('1 minute ago');
    expect(moment?.epochSeconds).toBe(NOW / 1000);
  });

  /*
   * A payload from a build that predates `checkedAt` has no moment to be
   * relative to. Printing this machine's clock instead would produce a
   * countdown that disagrees with the `expired` flag beside it, so the
   * relative half is simply absent.
   */
  it('omits the relative phrase when there is no clock to be relative to', () => {
    const moment = momentOf(NOW / 1000, null);

    expect(moment?.relative).toBeNull();
    expect(moment?.absolute).toContain('2026');
    expect(moment?.epochSeconds).toBe(NOW / 1000);
  });

  /*
   * A token is attacker-controlled text. `"exp": 1e300` must produce a missing
   * row, not "Invalid Date" printed where a date belongs.
   */
  it('refuses a timestamp no Date can represent', () => {
    expect(momentOf(1e300, NOW)).toBeNull();
    expect(momentOf(Number.NaN, NOW)).toBeNull();
    expect(momentOf(Number.POSITIVE_INFINITY, NOW)).toBeNull();
  });
});
