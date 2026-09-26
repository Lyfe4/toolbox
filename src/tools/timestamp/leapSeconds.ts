import { daysFromCivil } from './instant';

/**
 * EVERY LEAP SECOND THERE HAS EVER BEEN: twenty-seven, all positive, each a
 * 23:59:60 UTC at the end of the 30th of June or the 31st of December.
 *
 * Copied from IANA's `leap-seconds.list`, which is committed beside this file
 * as `spec/leap-seconds.list` and which `timestamp.test.ts` reads, checks
 * against the SHA-1 the file carries for itself, and compares with this table
 * entry for entry. A table rather than the file at run time because the file
 * is 5 kB of prose around 28 numbers, and the numbers cannot change: there has
 * been no leap second since 2016, the CGPM voted in 2022 to stop inserting
 * them by 2035, and the list's own expiry is the thing that would say
 * otherwise - the test reports it.
 *
 * Each entry is the UTC date whose last minute had 61 seconds.
 */
export const LEAP_SECOND_DATES: readonly (readonly [year: number, month: 6 | 12])[] = [
  [1972, 6],
  [1972, 12],
  [1973, 12],
  [1974, 12],
  [1975, 12],
  [1976, 12],
  [1977, 12],
  [1978, 12],
  [1979, 12],
  [1981, 6],
  [1982, 6],
  [1983, 6],
  [1985, 6],
  [1987, 12],
  [1989, 12],
  [1990, 12],
  [1992, 6],
  [1993, 6],
  [1994, 6],
  [1995, 12],
  [1997, 6],
  [1998, 12],
  [2005, 12],
  [2008, 12],
  [2012, 6],
  [2015, 6],
  [2016, 12],
];

/**
 * The Unix second each leap second was folded into: midnight after it.
 *
 * POSIX counts every day as 86,400 seconds, so 23:59:60 has no number, and
 * the formula it gives for converting a broken-down time - which is what
 * `mktime` and every normalising reader apply - lands 23:59:60 on the same
 * number as the 00:00:00 after it. So that number stands for two seconds of
 * UTC, and it is the only kind of Unix time that does.
 */
export const LEAP_SECOND_UNIX: ReadonlySet<number> = new Set(
  LEAP_SECOND_DATES.map(([year, month]) =>
    month === 6 ? daysFromCivil(year, 7, 1) * 86_400 : daysFromCivil(year + 1, 1, 1) * 86_400,
  ),
);
