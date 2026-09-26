import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { loadTool } from '@/features/registry/loader';
import { getManifestEntry } from '@/features/registry/manifest';
import { canConnect, type JsonValue, type ToolRunContext } from '@/features/registry/types';

import { convert, type Dependencies, type Input } from './convert';
import timestampTool from './index';
import {
  MAX_EPOCH_NS,
  MIN_EPOCH_NS,
  NS_PER_SECOND,
  civilFromDays,
  daysFromCivil,
  formatOffset,
  formatRfc3339,
  unixDecimal,
} from './instant';
import { LEAP_SECOND_DATES, LEAP_SECOND_UNIX } from './leapSeconds';
import { timestampDefaultOptions, type TimestampOptions } from './options';
import { parseTimestamp } from './parse';
import list from './spec/leap-seconds.list?raw';
import { SENTINELS, describeVintage, readVintage } from './vintage';
import { UTC_ZONE, fixedOffsetZone, lookupZone, type Zone, type ZoneLookup } from './zones';

/*
 * NOTHING IN THIS FILE MAY DEPEND ON WHERE OR WHEN IT RUNS.
 *
 * No test here reads the clock, the machine's time zone, its locale or its tz
 * database. Zones with rules come from the oracle (timestamp.oracle.test.ts);
 * the ones here are UTC and fixed offsets, which have no rules to disagree
 * about. The suite was run under TZ=Pacific/Kiritimati, TZ=America/St_Johns,
 * a clock faked to 2031 and a default locale forced to Arabic digits, with
 * identical results - see docs/test-findings.md.
 */

const fixedOnly: Dependencies = {
  lookupZone: (name: string): ZoneLookup => {
    if (/^utc$/i.test(name.trim()) || name.trim() === '') return { ok: true, zone: UTC_ZONE };
    const match = /^([+-])(\d{2}):(\d{2})$/.exec(name.trim());
    if (match) {
      const seconds = Number(match[2]) * 3600 + Number(match[3]) * 60;
      return {
        ok: true,
        zone: fixedOffsetZone(name.trim(), match[1] === '-' ? -seconds : seconds),
      };
    }
    return { ok: false, message: `no zone ${name} in this test`, detail: '' };
  },
  vintage: () => null,
};

const options = (overrides: Partial<TimestampOptions> = {}): TimestampOptions => ({
  ...timestampDefaultOptions,
  ...overrides,
});

const text = (value: string): Input => ({ type: 'text', text: value });

function run(input: Input, overrides: Partial<TimestampOptions> = {}, deps = fixedOnly) {
  const result = convert(input, options(overrides), deps);
  if (!result.ok) throw new Error(`refused: ${result.error.message} ${result.error.detail ?? ''}`);
  return result.value;
}

function refusal(input: Input, overrides: Partial<TimestampOptions> = {}, deps = fixedOnly) {
  const result = convert(input, options(overrides), deps);
  if (result.ok) throw new Error(`converted to ${result.value.output}`);
  return result.error;
}

const warnings = (notes: readonly { level: string; title: string }[]) =>
  notes.filter((note) => note.level === 'warn').map((note) => note.title);

describe('civil arithmetic', () => {
  it('round-trips every day number across the whole range on a fixed stride', () => {
    // A stride rather than a random sample: it either passes for everybody or
    // fails for everybody.
    for (let days = -100_000_000; days <= 100_000_000; days += 9_973) {
      const { year, month, day } = civilFromDays(days);
      expect(daysFromCivil(year, month, day)).toBe(days);
    }
  });

  it('puts the epoch on 1970-01-01, a Thursday', () => {
    expect(civilFromDays(0)).toEqual({ year: 1970, month: 1, day: 1 });
    expect(formatRfc3339(0n, 0, true)).toBe('1970-01-01T00:00:00Z');
  });

  it('writes the edges of the range in the expanded year form ECMAScript uses', () => {
    // The same two strings `new Date(8.64e15).toISOString()` and its negative write.
    expect(formatRfc3339(MAX_EPOCH_NS, 0, true)).toBe('+275760-09-13T00:00:00Z');
    expect(formatRfc3339(MIN_EPOCH_NS, 0, true)).toBe('-271821-04-20T00:00:00Z');
    expect(new Date(8.64e15).toISOString()).toBe('+275760-09-13T00:00:00.000Z');
    expect(new Date(-8.64e15).toISOString()).toBe('-271821-04-20T00:00:00.000Z');
  });

  it('writes an offset that is not a whole minute with its seconds', () => {
    expect(formatOffset(-2670)).toBe('-00:44:30');
    expect(formatOffset(1172)).toBe('+00:19:32');
    expect(formatOffset(19_800)).toBe('+05:30');
    expect(formatOffset(0)).toBe('+00:00');
  });
});

describe('reading a number', () => {
  it.each([
    ['1727308800', 's', 1_727_308_800n * NS_PER_SECOND],
    ['1727308800123', 'ms', 1_727_308_800_123_000_000n],
    ['1727308800123456', 'us', 1_727_308_800_123_456_000n],
    ['1727308800123456789', 'ns', 1_727_308_800_123_456_789n],
    ['1727308800.5', 's', 1_727_308_800_500_000_000n],
    ['1.7273088e9', 's', 1_727_308_800n * NS_PER_SECOND],
    ['-1', 's', -NS_PER_SECOND],
    ['"1727308800"', 's', 1_727_308_800n * NS_PER_SECOND],
  ])('%s reads by its size as %s', (written, unit, epochNs) => {
    const parsed = parseTimestamp(written, 'auto');
    expect(parsed.ok && parsed.value.kind === 'number' && parsed.value.unit).toBe(unit);
    expect(parsed.ok && parsed.value.kind === 'number' && parsed.value.epochNs).toBe(epochNs);
  });

  /*
   * EACH THRESHOLD FROM BOTH SIDES. A test that only reads a present-day
   * value in each unit passes with a threshold moved by a factor of ten -
   * which a deliberate break showed, before these were added.
   */
  it.each([
    ['99999999999', 's'],
    ['100000000000', 'ms'],
    ['99999999999999', 'ms'],
    ['100000000000000', 'us'],
    ['99999999999999999', 'us'],
    ['100000000000000000', 'ns'],
    ['-99999999999', 's'],
    ['-100000000000', 'ms'],
  ])('%s is read as %s: the digit rule at its edge', (written, unit) => {
    const parsed = parseTimestamp(written, 'auto');
    expect(parsed.ok && parsed.value.kind === 'number' && parsed.value.unit).toBe(unit);
  });

  it('keeps every digit of a nanosecond count past 2^53, which a double cannot', () => {
    const written = '1727308800123456789';
    expect(Number(written).toString()).not.toBe(written);
    expect(run(text(written), { target: 'ns' }).output).toBe(written);
    expect(run(text(written)).output).toBe('2024-09-26T00:00:00.123456789Z');
  });

  it('floors below the epoch, so -0.5 s is in second -1', () => {
    expect(run(text('-0.5'), { unit: 's', target: 's' }).output).toBe('-1');
    expect(run(text('-0.5'), { unit: 's', target: 'utc' }).output).toBe('1969-12-31T23:59:59.5Z');
    expect(unixDecimal(-500_000_000n, 's')).toBe('-0.5');
  });
});

describe('the losses, each with the control that must say nothing', () => {
  it('doubts a unit it read off a number whose reading is not between 1980 and 2100', () => {
    const doubtful = run(text('86400'));
    expect(warnings(doubtful.notes)).toEqual([
      'Read as seconds by its size, which is 1970-01-02T00:00:00Z',
    ]);
    // Control: a present-day timestamp, and the same number with its unit chosen.
    expect(warnings(run(text('1727308800')).notes)).toEqual([]);
    expect(warnings(run(text('86400'), { unit: 's' }).notes)).toEqual([]);
  });

  it('names the date an eight-digit number also spells', () => {
    const body = run(text('20240926')).notes.find((note) => note.level === 'warn')?.body ?? '';
    expect(body).toContain('It is also the date 2024-09-26');
  });

  it('says when a Unix target drops precision, and not when there is none to drop', () => {
    expect(warnings(run(text('1727308800123'), { target: 's' }).notes)).toEqual([
      'Precision was dropped: 1727308800.123 is not whole seconds',
    ]);
    expect(warnings(run(text('1727308800000'), { target: 's' }).notes)).toEqual([]);
    // The default target never drops: it is the coarsest unit holding the instant.
    expect(run(text('2024-09-26T00:00:00.123Z')).output).toBe('1727308800123');
  });

  it('says when digits past the nanosecond were dropped', () => {
    expect(warnings(run(text('1727308800.1234567891')).notes)).toEqual([
      'Digits past the nanosecond were dropped',
    ]);
    expect(warnings(run(text('1727308800.123456789')).notes)).toEqual([]);
  });

  it('reads a real leap second as the second after it, and says so', () => {
    const leap = run(text('2016-12-31T23:59:60Z'));
    expect(leap.output).toBe('1483228800');
    expect(warnings(leap.notes)).toEqual(['23:59:60 has no Unix time of its own']);
    expect(warnings(run(text('2016-12-31T23:59:59Z')).notes)).toEqual([]);
    // RFC 3339 section 5.8's own example of the same second at another offset.
    expect(run(text('1990-12-31T15:59:60-08:00')).output).toBe('662688000');
  });

  it('refuses a :60 that was not a leap second', () => {
    expect(refusal(text('2017-12-31T23:59:60Z')).message).toContain(
      'a leap second that did not happen',
    );
  });
});

describe('the leap second table', () => {
  it('is the file IANA publishes, by the hash the file carries for itself', async () => {
    // The hash covers the `#$` and `#@` numbers and every data line's two
    // fields, concatenated - the algorithm the file's own header points at.
    const parts: string[] = [];
    let declared = '';
    for (const line of list.split('\n')) {
      if (line.startsWith('#$') || line.startsWith('#@'))
        parts.push(line.slice(2).trim().split(/\s+/)[0] ?? '');
      else if (line.startsWith('#h')) declared = line.slice(2).trim().split(/\s+/).join('');
      else if (line !== '' && !line.startsWith('#'))
        parts.push(...(line.split('#')[0] ?? '').trim().split(/\s+/));
    }
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(parts.join('')));
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    expect(hex).toBe(declared);
  });

  it('holds exactly the leap seconds in the file, entry for entry', () => {
    const NTP_TO_UNIX = 2_208_988_800;
    const inFile = list
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => Number(line.trim().split(/\s+/)[0]) - NTP_TO_UNIX)
      // The first line is where the table starts, 1972-01-01, not an insertion.
      .slice(1);
    expect([...LEAP_SECOND_UNIX].sort((a, b) => a - b)).toEqual(inFile);
    expect(LEAP_SECOND_DATES).toHaveLength(27);
  });
});

describe('what it reads, and what it refuses', () => {
  it.each([
    ['2024-09-26T08:00:00+02:00', '1727330400'],
    ['2024-09-26 08:00:00 +0200 CEST', '1727330400'],
    ['20240926T060000Z', '1727330400'],
    ['Thu, 26 Sep 2024 06:00:00 GMT', '1727330400'],
    ['Date: Thu, 26 Sep 2024 06:00:00 GMT', '1727330400'],
    ['"created_at": "2024-09-26T06:00:00Z",', '1727330400'],
    ['Thursday 26 September 2024, 08:00:00 +02:00 (+02:00)', '1727330400'],
  ])('%s', (written, seconds) => {
    expect(run(text(written)).output).toBe(seconds);
  });

  it('reads back everything it writes', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -62_135_596_800n * NS_PER_SECOND, max: 253_402_300_799n * NS_PER_SECOND }),
        fc.constantFrom('UTC', '+05:30', '-00:44', '+14:00'),
        fc.constantFrom('utc', 'local', 'rfc9557', 'readable'),
        (epochNs, zone, target) => {
          const written = run(text(epochNs.toString()), {
            unit: 'ns',
            target: target as TimestampOptions['target'],
            zone,
          }).output;
          expect(run(text(written), { target: 'ns', zone }).output).toBe(epochNs.toString());
        },
      ),
      { seed: 20_260_926, numRuns: 300 },
    );
  });

  it('refuses a date whose day and month cannot be told apart', () => {
    expect(refusal(text('26/09/2024')).message).toContain('does not say which number is the day');
  });

  it('refuses natural language rather than guessing at it', () => {
    expect(refusal(text('next Friday 3pm')).detail).toContain('does not read natural language');
  });

  it('refuses a weekday that the date contradicts', () => {
    expect(refusal(text('Fri, 26 Sep 2024 06:00:00 GMT')).message).toContain('was a Thursday');
  });

  it('refuses outside the range a Date can hold, and converts just inside it', () => {
    expect(refusal(text('8640000000001'), { unit: 's' }).message).toContain('outside the dates');
    expect(run(text('8640000000000'), { unit: 's', target: 'utc' }).output).toBe(
      '+275760-09-13T00:00:00Z',
    );
  });
});

describe('a wired JSON value', () => {
  const token: JsonValue = {
    signature: { verified: false, state: 'no-key' },
    payload: { sub: '1234567890', iat: 1_516_239_022, exp: 1_727_308_800 },
  };

  it('reads the member Field names, as RFC 6901 spells it', () => {
    expect(run({ type: 'json', data: token }, { field: '/payload/exp' }).output).toBe(
      '2024-09-26T00:00:00Z',
    );
    expect(
      run({ type: 'json', data: { 'a/b': { '~c': 0 } } }, { field: '/a~1b/~0c', unit: 's' }).output,
    ).toBe('1970-01-01T00:00:00Z');
  });

  it('lists what reads as a timestamp when Field names nothing', () => {
    const error = refusal({ type: 'json', data: token });
    expect(error.detail).toContain('/payload/iat, /payload/exp');
    expect(error.detail).not.toContain('/payload/sub');
  });

  it('says a wired double past 2^53 may already be rounded', () => {
    const notes = run({ type: 'json', data: 1_727_308_800_123_456_800 }).notes;
    expect(notes.some((note) => note.title === 'The number arrived as a JSON double')).toBe(true);
    expect(
      run({ type: 'json', data: 1_727_308_800 }).notes.some((note) =>
        note.title.includes('double'),
      ),
    ).toBe(false);
  });
});

describe('a decoded JWT, wired in', () => {
  /*
   * THE WIRE THIS TOOL'S `json` TYPE EXISTS FOR, END TO END.
   *
   * jwt-decode has one output and it is `json` - deliberately, so the claims
   * never travel without the verdict (architecture.md, "the port set"). A
   * text-only input here would make the wire illegal to draw; `json` makes it
   * legal, and Field reads one claim out of what arrives.
   */
  const base64url = (value: string) =>
    btoa(value).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
  const token = `${base64url('{"alg":"HS256","typ":"JWT"}')}.${base64url('{"sub":"1234567890","iat":1516239022,"exp":1727308800}')}.c2ln`;

  it('is a legal wire, by the same check the canvas makes', () => {
    const jwt = getManifestEntry('jwt-decode');
    const here = getManifestEntry('timestamp');
    const decoded = jwt.outputs.find((port) => port.id === 'output');
    const input = here.inputs.find((port) => port.id === 'input');
    expect(decoded !== undefined && input !== undefined && canConnect(decoded, input)).toBe(true);
  });

  it('reads exp, iat and nbf out of what jwt-decode really produces', async () => {
    const context: ToolRunContext = { signal: new AbortController().signal };
    const jwt = await loadTool('jwt-decode');
    const decoded = await jwt.run({
      inputs: { input: { type: 'text', text: token } },
      options: jwt.defaultOptions,
      context,
    });
    if (!decoded.ok) throw new Error(decoded.error.message);
    const output = decoded.value.output;
    if (output?.type !== 'json') throw new Error('jwt-decode did not produce json');

    const read = (field: string) => run({ type: 'json', data: output.data }, { field }).output;
    expect(read('/payload/exp')).toBe('2024-09-26T00:00:00Z');
    expect(read('/payload/iat')).toBe('2018-01-18T01:30:22Z');
    // The note says the verdict did not come along.
    const notes = run({ type: 'json', data: output.data }, { field: '/payload/exp' }).notes;
    expect(notes.find((note) => note.title.startsWith('Read /payload/exp'))?.body).toContain(
      'signature verdict',
    );
  });
});

describe('the tz data vintage', () => {
  /** A zone that answers every sentinel as the releases up to `through` do. */
  const asOf =
    (through: string) =>
    (name: string): Zone | null => {
      const mine = SENTINELS.filter((sentinel) => sentinel.zone === name);
      if (mine.length === 0) return null;
      return {
        name,
        utc: false,
        fixed: false,
        offsetAt: (at) => {
          const sentinel = mine.find((candidate) => candidate.at === at);
          if (sentinel === undefined) return 0;
          return sentinel.release <= through ? sentinel.after : sentinel.before;
        },
      };
    };

  it('names the last release whose change the engine has', () => {
    expect(readVintage(asOf('2025a'))).toEqual({
      kind: 'matches',
      release: '2025a',
      next: '2025b',
    });
    expect(readVintage(asOf('2026b'))).toEqual({
      kind: 'matches',
      release: '2026b',
      next: '2026c',
    });
    expect(describeVintage(readVintage(asOf('9999z')))).toContain(
      'the newest release this tool knows of',
    );
  });

  it('says so when no single release explains the answers', () => {
    const cherryPicked = (name: string): Zone | null => {
      const zone = asOf('2024a')(name);
      if (name !== 'America/Vancouver' || zone === null) return zone;
      return { ...zone, offsetAt: () => -25_200 };
    };
    expect(readVintage(cherryPicked).kind).toBe('mixed');
  });
});

describe('the tool, through the registry', () => {
  const context: ToolRunContext = { signal: new AbortController().signal };

  it('carries every notation exactly and its report', async () => {
    const result = await timestampTool.run({
      inputs: { input: { type: 'text', text: '1727308800123' } },
      options: timestampDefaultOptions,
      context,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.output).toEqual({ type: 'text', text: '2024-09-26T00:00:00.123Z' });
    const all = result.value.all;
    expect(all?.type === 'json' && all.data).toMatchObject({
      unix: {
        s: '1727308800.123',
        ms: '1727308800123',
        us: '1727308800123000',
        ns: '1727308800123000000',
      },
      utc: '2024-09-26T00:00:00.123Z',
      zone: 'UTC',
    });
  });

  it("never writes the machine's own zone as UTC's", () => {
    // The engine's lookup is the real one here; UTC needs no data, so the
    // answer cannot depend on the machine it runs on.
    expect(lookupZone('UTC')).toEqual({ ok: true, zone: UTC_ZONE });
    expect(lookupZone('')).toEqual({ ok: true, zone: UTC_ZONE });
  });
});
