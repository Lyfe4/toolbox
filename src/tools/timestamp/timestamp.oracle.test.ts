import { describe, expect, it } from 'vitest';

import { convert, type Dependencies } from './convert';
import {
  MONTH_NAMES,
  NS_PER_SECOND,
  WEEKDAY_NAMES,
  daysAt,
  isoWeekday,
  wallAt,
  wallSeconds,
} from './instant';
import { timestampDefaultOptions, type TimestampOptions } from './options';
import { parseTimestamp } from './parse';
import oracle from './spec/timestamp-oracle.json';
import { UTC_ZONE, fixedOffsetZone, pickInstant, readWall, type Zone } from './zones';

/**
 * THE TOOL'S ARITHMETIC, HELD TO CPYTHON AND TO IANA'S RULES - AND TO NO
 * ENGINE'S.
 *
 * Every zone here is built from `spec/timestamp-oracle.json`: the UTC offset
 * changes Python's `zoneinfo` reports for tzdata 2026d, to the second, from
 * 1900 to 2040. So what is under test is this tool's own code - the calendar,
 * the formatting, the parser and the search for a skipped or doubled wall
 * time - and nothing depends on the tz database of the machine the test runs
 * on, which differs between this repository's CI, its contributors and every
 * browser. Whether each ENGINE's zone data agrees with the same rules is a
 * different question, and `checkTimestampZones` asks it in two real engines.
 */

interface OracleZone {
  readonly initial: number;
  readonly transitions: readonly (readonly number[])[];
}

const RANGE_FROM = -2_208_988_800;
const RANGE_TO = 2_240_524_800;

/** A zone that answers from the oracle's table, and refuses to answer outside it. */
function oracleZone(name: string): Zone {
  const table = (oracle.zones as Readonly<Record<string, OracleZone>>)[name];
  if (table === undefined) throw new Error(`no zone ${name} in the oracle`);
  return {
    name,
    utc: false,
    fixed: false,
    offsetAt(seconds) {
      if (seconds < RANGE_FROM || seconds >= RANGE_TO) {
        throw new Error(`${name} asked about ${seconds.toString()}, outside the oracle's range`);
      }
      let offset = table.initial;
      for (const [at = 0, after = 0] of table.transitions) {
        if (at <= seconds) offset = after;
        else break;
      }
      return offset;
    },
  };
}

const oracleDeps: Dependencies = {
  lookupZone: (name) => {
    if (name === 'UTC') return { ok: true, zone: UTC_ZONE };
    if (/^[+-]\d{2}:\d{2}$/.test(name)) {
      const seconds = Number(name.slice(1, 3)) * 3600 + Number(name.slice(4, 6)) * 60;
      return { ok: true, zone: fixedOffsetZone(name, name.startsWith('-') ? -seconds : seconds) };
    }
    return name in oracle.zones
      ? { ok: true, zone: oracleZone(name) }
      : { ok: false, message: `no ${name}`, detail: '' };
  },
  vintage: () => null,
};

const options = (overrides: Partial<TimestampOptions> = {}): TimestampOptions => ({
  ...timestampDefaultOptions,
  ...overrides,
});

describe('the calendar, against CPython across years 1 to 9999', () => {
  // The microsecond count is a string in the fixture: past 2^53 a JSON number
  // arrives rounded, which is the loss this tool reports and the fixture had.
  const instants = oracle.instants.map((row) => ({
    micros: String(row[0]),
    fields: row.slice(1).map(Number),
  }));

  it.each(instants)('$micros µs', ({ micros, fields }) => {
    const [year, month, day, hour, minute, second, micro = 0, weekday] = fields;
    const epochNs = BigInt(micros) * 1000n;
    expect(wallAt(epochNs, 0)).toEqual({
      year,
      month,
      day,
      hour,
      minute,
      second,
      nanosecond: micro * 1000,
    });
    expect(isoWeekday(daysAt(epochNs, 0))).toBe(weekday);
  });

  it('names weekdays and months as the C locale does', () => {
    expect(WEEKDAY_NAMES).toEqual(oracle.names.weekdays);
    expect(MONTH_NAMES).toEqual(oracle.names.months);
  });
});

describe('a wall time in a zone, against zoneinfo', () => {
  it.each(oracle.local)(
    '%s at %i',
    (zone, seconds, offset, year, month, day, hour, minute, second) => {
      const rules = oracleZone(String(zone));
      expect(rules.offsetAt(Number(seconds))).toBe(offset);
      const wall = wallAt(BigInt(seconds) * NS_PER_SECOND, Number(offset));
      expect([wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second]).toEqual([
        year,
        month,
        day,
        hour,
        minute,
        second,
      ]);
    },
  );
});

describe('every clock change from 1970 to 2030, against PEP 495', () => {
  /*
   * `fold=0` is what RFC 5545, Temporal's `compatible` and this tool's
   * default agree on; the earlier and the later of the two folds are the
   * other two rules. A wall time is a gap when neither fold survives the round
   * trip, an overlap when both do and differ - the generator classified each.
   */
  it('covers gaps and overlaps in every zone the oracle holds', () => {
    const kinds = new Set(oracle.walls.map((wall) => `${String(wall[0])}:${String(wall[2])}`));
    expect(oracle.walls.length).toBeGreaterThan(2000);
    expect([...kinds].filter((kind) => kind.endsWith(':gap')).length).toBeGreaterThan(15);
    expect([...kinds].filter((kind) => kind.endsWith(':overlap')).length).toBeGreaterThan(15);
  });

  it.each(oracle.walls)('%s %s is %s', (zone, written, kind, fold0, fold1) => {
    const parsed = parseTimestamp(String(written), 'auto');
    if (!parsed.ok || parsed.value.kind !== 'wall')
      throw new Error(`did not read ${String(written)}`);
    const reading = readWall(oracleZone(String(zone)), wallSeconds(parsed.value.wall));
    expect(reading.kind).toBe(kind);
    const earlier = Math.min(Number(fold0), Number(fold1));
    const later = Math.max(Number(fold0), Number(fold1));
    expect(pickInstant(reading, 'compatible')).toBe(fold0);
    expect(pickInstant(reading, 'earlier')).toBe(earlier);
    expect(pickInstant(reading, 'later')).toBe(later);
    expect(pickInstant(reading, 'reject')).toBe(kind === 'unique' ? fold0 : null);
  });
});

/*
 * WHERE THIS READER AND PYTHON'S DISAGREE, EACH ON PURPOSE, BY NAME.
 *
 * A disagreement not in this table fails, and so does an entry here that has
 * stopped disagreeing - so the table can neither grow in silence nor go stale.
 */
const ISO_DIFFERENCES: Readonly<Record<string, string>> = {
  '1990-12-31T23:59:60Z':
    'a real leap second, RFC 3339 section 5.8; Python has no second 60 and refuses it',
  '1990-12-31T15:59:60-08:00': 'the same leap second at an offset; the same refusal',
  '2024-09-26t08:00:00z':
    'RFC 3339 section 5.6 allows a lower-case t and z; fromisoformat does not',
  '2024-W39-4T08:00:00Z': 'an ISO week date, which this tool does not read',
  '2024-09-26T08Z': 'an hour with no minutes, which this tool does not read',
};

describe('ISO 8601, against datetime.fromisoformat', () => {
  it.each(oracle.iso)('%s', (text, verdict, answer) => {
    const ours = convert(
      { type: 'text', text: String(text) },
      options({ unit: 'us', target: 'us' }),
      oracleDeps,
    );
    const known = ISO_DIFFERENCES[String(text)];

    if (verdict === 'aware') {
      if (known !== undefined && !ours.ok) return;
      expect(ours.ok, `${String(text)}: ${ours.ok ? '' : ours.error.message}`).toBe(true);
      if (ours.ok) expect(ours.value.output).toBe(String(answer));
      return;
    }
    if (verdict === 'naive') {
      // Python leaves a naive time naive; this reads it in the zone option.
      expect(ours.ok && ours.value.output).toBe(
        String(BigInt(Date.parse(`${String(answer)}Z`)) * 1000n),
      );
      return;
    }
    // Python refused it.
    if (known !== undefined) {
      expect(ours.ok, `${String(text)} was expected to be read: ${known}`).toBe(true);
      return;
    }
    expect(ours.ok, `${String(text)} should be refused, as Python refuses it`).toBe(false);
  });

  it('has no entry in its table of differences that no longer differs', () => {
    const stale = Object.keys(ISO_DIFFERENCES).filter((text) => {
      const case_ = oracle.iso.find((entry) => entry[0] === text);
      if (case_ === undefined) return true;
      const ours = convert(
        { type: 'text', text },
        options({ unit: 'us', target: 'us' }),
        oracleDeps,
      );
      const [, verdict, answer] = case_;
      if (verdict === null) return !ours.ok;
      return ours.ok && ours.value.output === String(answer);
    });
    expect(stale).toEqual([]);
  });
});

const RFC5322_DIFFERENCES: Readonly<Record<string, string>> = {
  'Sat, 31 Dec 2016 23:59:60 +0000': 'a real leap second; Python refuses second 60',
  'Fri, 01 Jan 60 00:00:00 GMT':
    'RFC 5322 section 4.3 puts a two-digit 60 in 1960; Python pivots at 69 and says 2060',
  'Fri, 26 Sep 2024 06:00:00 GMT':
    'section 3.3 requires the weekday to match the date; Python ignores it, this refuses',
};

describe('RFC 5322, against email.utils.parsedate_to_datetime', () => {
  const dates = oracle.rfc5322.map((row) => ({ text: String(row[0]), seconds: row[1] ?? null }));

  it.each(dates)('$text', ({ text, seconds }) => {
    const ours = convert({ type: 'text', text }, options({ target: 's' }), oracleDeps);
    const known = RFC5322_DIFFERENCES[text];
    if (known !== undefined) {
      expect(ours.ok ? ours.value.output : null, known).not.toBe(
        seconds === null ? null : String(seconds),
      );
      return;
    }
    expect(ours.ok ? ours.value.output : null).toBe(seconds === null ? null : String(seconds));
  });

  it('reads 60 as 1960, as the RFC says, where Python says 2060', () => {
    const ours = convert(
      { type: 'text', text: 'Fri, 01 Jan 60 00:00:00 GMT' },
      options({ target: 'utc' }),
      oracleDeps,
    );
    expect(ours.ok && ours.value.output).toBe('1960-01-01T00:00:00Z');
  });
});

describe('RFC 3339 section 5.8, which says what each example means', () => {
  it.each([
    [
      '1985-04-12T23:20:50.52Z',
      '1985-04-12T23:20:50.52Z',
      '20 minutes and 50.52 seconds after the 23rd hour of April 12th, 1985 in UTC',
    ],
    [
      '1996-12-19T16:39:57-08:00',
      '1996-12-20T00:39:57Z',
      '39 minutes and 57 seconds after the 16th hour of December 19th, 1996 with an offset of -08:00',
    ],
    ['1990-12-31T23:59:60Z', '1991-01-01T00:00:00Z', 'the leap second inserted at the end of 1990'],
    [
      '1990-12-31T15:59:60-08:00',
      '1991-01-01T00:00:00Z',
      'the same leap second in Pacific Standard Time',
    ],
    [
      '1937-01-01T12:00:27.87+00:20',
      '1937-01-01T11:40:27.87Z',
      'noon, 27.87 seconds, in the Netherlands, 20 minutes ahead of UTC',
    ],
  ])('%s', (text, utc) => {
    const ours = convert({ type: 'text', text }, options({ target: 'utc' }), oracleDeps);
    expect(ours.ok && ours.value.output).toBe(utc);
  });
});
