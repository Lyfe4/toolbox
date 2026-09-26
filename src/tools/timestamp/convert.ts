import {
  isJsonArray,
  isJsonObject,
  type JsonValue,
  type ToolError,
} from '@/features/registry/types';
import { lost, noted, type ToolNote } from '@/lib/notes';

import {
  MAX_EPOCH_NS,
  MIN_EPOCH_NS,
  NS_PER_SECOND,
  UNIT_NS,
  UNIT_WORDS,
  WEEKDAY_NAMES,
  exactUnit,
  floorDiv,
  floorMod,
  formatOffset,
  formatReadable,
  formatRfc3339,
  formatWall,
  isRfc3339Year,
  isoWeekday,
  daysAt,
  unixDecimal,
  unixInteger,
  wallAt,
  wallSeconds,
  type Unit,
} from './instant';
import { LEAP_SECOND_UNIX } from './leapSeconds';
import { parseTimestamp, type Parsed } from './parse';
import { describeVintage, type Vintage } from './vintage';
import { pickInstant, readWall, type Zone, type ZoneLookup } from './zones';

import type { Target, TimestampOptions } from './options';

/**
 * Everything the conversion needs from outside itself, so the unit tests can
 * hand it IANA's rules from the oracle and the tool can hand it the engine's.
 */
export interface Dependencies {
  readonly lookupZone: (name: string) => ZoneLookup;
  /** The engine's tz data vintage, or null where nobody asked. */
  readonly vintage: () => Vintage | null;
}

export type Input =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'json'; readonly data: JsonValue };

export interface Conversion {
  readonly output: string;
  readonly all: JsonValue;
  readonly summary: string;
  readonly from: string;
  readonly to: string;
  readonly notes: readonly ToolNote[];
}

export type Converted =
  | { readonly ok: true; readonly value: Conversion }
  | { readonly ok: false; readonly error: ToolError };

const failed = (message: string, detail: string): Converted => ({
  ok: false,
  error: { code: 'invalid-input', message, detail },
});

/**
 * THE WINDOW A NUMBER'S UNIT IS JUDGED BY: 1980 to 2100.
 *
 * Any number read in seconds, milliseconds, microseconds and nanoseconds gives
 * four instants at least 1,000 times apart, and this window is narrower than
 * that, so at most one of the four can fall inside it - which is what makes
 * "the unit its size says" a claim rather than a guess for every timestamp a
 * running system has written. Outside it the size still picks a unit, and the
 * tool says the pick is doubtful: a small number is as likely a duration or an
 * id as a date in January 1970.
 */
const PLAUSIBLE_FROM = 315_532_800n * NS_PER_SECOND;
const PLAUSIBLE_TO = 4_102_444_800n * NS_PER_SECOND;

const UNIX_TARGETS: readonly Target[] = ['s', 'ms', 'us', 'ns'];

const TARGET_WORDS: Readonly<Record<Target, string>> = {
  auto: '',
  utc: 'RFC 3339 in UTC',
  local: 'RFC 3339 in the zone',
  rfc9557: 'RFC 3339 with the zone name',
  readable: 'a readable date',
  s: 'Unix seconds',
  ms: 'Unix milliseconds',
  us: 'Unix microseconds',
  ns: 'Unix nanoseconds',
};

const SYNTAX_WORDS = {
  rfc3339: 'RFC 3339',
  iso8601: 'ISO 8601',
  rfc5322: 'an RFC 5322 date',
  readable: 'a readable date',
} as const;

/** Every reading of a number but the chosen one, for the note that doubts it. */
function otherReadings(parsed: Extract<Parsed, { kind: 'number' }>): string {
  // The number as written, in its own unit, read again in each of the others.
  const base = floorDiv(parsed.epochNs, UNIT_NS[parsed.unit]);
  const remainder = floorMod(parsed.epochNs, UNIT_NS[parsed.unit]);
  return (['s', 'ms', 'us', 'ns'] as const)
    .filter((unit) => unit !== parsed.unit)
    .map((unit) => {
      const ns = remainder === 0n ? base * UNIT_NS[unit] : null;
      if (ns === null || ns > MAX_EPOCH_NS || ns < MIN_EPOCH_NS) return null;
      return `as ${UNIT_WORDS[unit]} it is ${formatRfc3339(ns, 0, true)}`;
    })
    .filter((reading): reading is string => reading !== null)
    .join('; ');
}

/** `20240926` is also a date, written without its punctuation. */
function compactDateReading(written: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(written);
  if (!match) return null;
  const [, year = '', month = '', day = ''] = match;
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${year}-${month}-${day}`;
}

/** RFC 6901: `/payload/exp`, with `~1` for a slash and `~0` for a tilde. */
function readPointer(
  data: JsonValue,
  pointer: string,
): { found: true; value: JsonValue } | { found: false } {
  if (pointer === '') return { found: true, value: data };
  if (!pointer.startsWith('/')) return { found: false };
  let current: JsonValue = data;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (isJsonArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token)) return { found: false };
      const item: JsonValue | undefined = current[Number(token)];
      if (item === undefined) return { found: false };
      current = item;
    } else if (isJsonObject(current) && Object.hasOwn(current, token)) {
      const member: JsonValue | undefined = current[token];
      if (member === undefined) return { found: false };
      current = member;
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

const escapePointer = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * The members of a wired object that read as a timestamp, as pointers to
 * copy into Field: every string this tool can parse and every number whose
 * size-read unit puts it between 1980 and 2100. Bounded, because a wired
 * document can be large and this only exists to write a refusal.
 */
function timestampPointers(data: JsonValue): string[] {
  const found: string[] = [];
  let visited = 0;
  const walk = (value: JsonValue, pointer: string, depth: number): void => {
    if (found.length >= 8 || visited >= 2000 || depth > 8) return;
    visited += 1;
    // A string of digits is an id far more often than a quoted timestamp -
    // a JWT's `sub` of "1234567890" reads as 2009 - so only numbers are
    // offered as Unix times, and strings only when they are dates.
    if (typeof value === 'number' || (typeof value === 'string' && !/^[\s\d.+-]*$/.test(value))) {
      const parsed = parseTimestamp(String(value), 'auto');
      if (!parsed.ok) return;
      if (parsed.value.kind === 'number') {
        const ns = parsed.value.epochNs;
        if (ns < PLAUSIBLE_FROM || ns >= PLAUSIBLE_TO) return;
      }
      found.push(pointer);
      return;
    }
    if (isJsonArray(value))
      value.forEach((item, index) => {
        walk(item, `${pointer}/${index.toString()}`, depth + 1);
      });
    else if (isJsonObject(value)) {
      for (const [key, member] of Object.entries(value))
        walk(member, `${pointer}/${escapePointer(key)}`, depth + 1);
    }
  };
  walk(data, '', 0);
  return found;
}

interface Resolved {
  readonly epochNs: bigint;
  readonly notes: ToolNote[];
  readonly from: string;
  /** The offset the input stated, if it stated one. */
  readonly statedOffset: number | null;
}

type Resolution = { ok: true; value: Resolved } | { ok: false; error: ToolError };

/** Where every loss note's damage is: the answer and every notation of it. */
const EVERY_PORT = ['output', 'all'];

function resolveNumber(
  parsed: Extract<Parsed, { kind: 'number' }>,
  jsonNumber: boolean,
): Resolution {
  const notes: ToolNote[] = [];
  const at = formatRfc3339(parsed.epochNs, 0, true);

  if (parsed.guessed && (parsed.epochNs < PLAUSIBLE_FROM || parsed.epochNs >= PLAUSIBLE_TO)) {
    const others = otherReadings(parsed);
    const compact = compactDateReading(parsed.written);
    notes.push(
      lost(
        `Read as ${UNIT_WORDS[parsed.unit]} by its size, which is ${at}`,
        `${parsed.written} has the digits of a Unix time in ${UNIT_WORDS[parsed.unit]}, and read that way it is not between 1980 and 2100 - so the unit is a guess this tool cannot stand behind. ${others === '' ? '' : `Read differently: ${others}. `}${compact === null ? '' : `It is also the date ${compact}, written without its dashes. `}Choose the unit under "Numbers are" if you know it, and nothing will be guessed.`,
        EVERY_PORT,
      ),
    );
  }

  if (parsed.dropped) {
    notes.push(
      lost(
        'Digits past the nanosecond were dropped',
        `${parsed.written} is more precise than a nanosecond, which is the finest unit this tool - or any Unix time - carries. It was floored to ${unixDecimal(parsed.epochNs, 'ns')} ns.`,
        EVERY_PORT,
      ),
    );
  }

  if (jsonNumber) {
    const magnitude = parsed.epochNs < 0n ? -parsed.epochNs : parsed.epochNs;
    if (magnitude / UNIT_NS[parsed.unit] > 9_007_199_254_740_992n) {
      notes.push(
        noted(
          'The number arrived as a JSON double',
          `A wired JSON number is a double, which holds integers exactly only up to 2^53. ${parsed.written} is past that, so it may already have been rounded by whatever parsed it - the digits are the double's, and any the source had beyond them were gone before this tool was handed the value. Wire the text instead, or quote the number in the source, to keep every digit.`,
        ),
      );
    }
  }

  if (parsed.key !== null) {
    notes.push(
      noted(
        `Read the value of ${parsed.key}`,
        `The input was a key and a value; the value was read and the key was not.`,
      ),
    );
  }

  return {
    ok: true,
    value: {
      epochNs: parsed.epochNs,
      notes,
      from: `Unix ${UNIT_WORDS[parsed.unit]}${parsed.guessed ? ', by its size' : ''}`,
      statedOffset: null,
    },
  };
}

function resolveWall(
  parsed: Extract<Parsed, { kind: 'wall' }>,
  options: TimestampOptions,
  deps: Dependencies,
): Resolution {
  const notes: ToolNote[] = [];
  const local = wallSeconds(parsed.wall);
  let epochSeconds: number;
  let usedZone: Zone | null = null;

  if (parsed.offset !== null) {
    epochSeconds = local - parsed.offset.seconds;
    if (parsed.zone !== null && !parsed.offset.unknown) {
      const looked = deps.lookupZone(parsed.zone);
      if (!looked.ok)
        return {
          ok: false,
          error: { code: 'invalid-input', message: looked.message, detail: looked.detail },
        };
      const zoneOffset = looked.zone.offsetAt(epochSeconds);
      if (zoneOffset !== parsed.offset.seconds) {
        return {
          ok: false,
          error: {
            code: 'invalid-input',
            message: `${parsed.written} says ${formatOffset(parsed.offset.seconds)}, and ${looked.zone.name} was at ${formatOffset(zoneOffset)} then.`,
            detail:
              "The offset and the zone name disagree about the instant, so one of them is wrong, and RFC 9557 leaves which to the reader. This tool will not choose: drop whichever is not meant. If the zone is right, remember that this browser's copy of its rules may be older or newer than the one that wrote the string.",
          },
        };
      }
      usedZone = looked.zone;
    }
  } else {
    const zoneName = parsed.zone ?? options.zone;
    const looked = deps.lookupZone(zoneName);
    if (!looked.ok)
      return {
        ok: false,
        error: { code: 'invalid-input', message: looked.message, detail: looked.detail },
      };
    const zone = looked.zone;
    usedZone = zone;
    const reading = readWall(zone, local);
    const picked = pickInstant(reading, options.clockChange);
    const wallText = formatWall(parsed.wall).replace('T', ' ');
    const day = wallText.slice(0, wallText.indexOf(' '));
    const clock = wallText.slice(wallText.indexOf(' ') + 1);

    if (reading.kind === 'gap') {
      const gap = reading.offsetAfter - reading.offsetBefore;
      if (picked === null) {
        return {
          ok: false,
          error: {
            code: 'invalid-input',
            message: `${clock} did not happen in ${zone.name} on ${day}: the clocks skipped it.`,
            detail: `The clocks went from ${formatOffset(reading.offsetBefore)} to ${formatOffset(reading.offsetAfter)}, jumping ${formatDuration(gap)} forward, so no instant had that wall time. "At a clock change" is set to refuse; choose a rule there to read it anyway.`,
          },
        };
      }
      const rule =
        options.clockChange === 'earlier'
          ? 'taking the earlier instant'
          : options.clockChange === 'later'
            ? 'taking the later instant'
            : 'the usual rule, moving it forward by the gap';
      notes.push(
        lost(
          `${clock} did not happen in ${zone.name} on ${day}`,
          `The clocks jumped ${formatDuration(gap)} forward there, from ${formatOffset(reading.offsetBefore)} to ${formatOffset(reading.offsetAfter)}, so that wall time never existed. It was read by ${rule}: ${formatRfc3339(BigInt(picked) * NS_PER_SECOND, zone.offsetAt(picked), zone.utc)}. The two instants it could mean are ${formatRfc3339(BigInt(reading.earlier) * NS_PER_SECOND, 0, true)} and ${formatRfc3339(BigInt(reading.later) * NS_PER_SECOND, 0, true)}.`,
          EVERY_PORT,
        ),
      );
    } else if (reading.kind === 'overlap') {
      if (picked === null) {
        return {
          ok: false,
          error: {
            code: 'invalid-input',
            message: `${clock} happened twice in ${zone.name} on ${day}.`,
            detail: `Once at ${formatOffset(reading.offsetBefore)} and again, after the clocks went back, at ${formatOffset(reading.offsetAfter)}. "At a clock change" is set to refuse; add the offset to the input, or choose a rule there.`,
          },
        };
      }
      const which = picked === reading.earlier ? 'first' : 'second';
      notes.push(
        lost(
          `${clock} happened twice in ${zone.name} on ${day}`,
          `The clocks went back there, from ${formatOffset(reading.offsetBefore)} to ${formatOffset(reading.offsetAfter)}, so that wall time was shown twice: at ${formatRfc3339(BigInt(reading.earlier) * NS_PER_SECOND, 0, true)} and at ${formatRfc3339(BigInt(reading.later) * NS_PER_SECOND, 0, true)}. The ${which} was taken. Adding the offset to the input says which was meant.`,
          EVERY_PORT,
        ),
      );
    }
    epochSeconds = picked ?? local;

    if (parsed.zone === null) {
      notes.push(
        noted(
          `No offset was given; read as a wall time in ${zone.name}`,
          `The input names a date and time but not where, so it was read in the Time zone option. Add Z, an offset such as +02:00 or a zone such as [Europe/Berlin] to the input to say where it was written.`,
        ),
      );
    }
  }

  let epochNs = BigInt(epochSeconds) * NS_PER_SECOND + BigInt(parsed.wall.nanosecond);

  if (parsed.leapSecond) {
    if (!LEAP_SECOND_UNIX.has(epochSeconds + 1)) {
      return {
        ok: false,
        error: {
          code: 'invalid-input',
          message: `${parsed.written} names a leap second that did not happen.`,
          detail:
            'A leap second is 23:59:60 UTC at the end of a 30 June or a 31 December on which one was inserted - twenty-seven since 1972, the last on 2016-12-31. Every other :60 is a mistake.',
        },
      };
    }
    epochNs += NS_PER_SECOND;
    notes.push(
      lost(
        '23:59:60 has no Unix time of its own',
        `${parsed.written} is a real leap second, and Unix time does not count leap seconds: every day is 86,400 of them. So it was read as the second after it, ${formatRfc3339(epochNs - BigInt(parsed.wall.nanosecond), 0, true)}, which POSIX gives the same number - and an elapsed time measured across it is a second short.`,
        EVERY_PORT,
      ),
    );
  }

  if (epochNs > MAX_EPOCH_NS || epochNs < MIN_EPOCH_NS) {
    return {
      ok: false,
      error: {
        code: 'invalid-input',
        message: `${parsed.written} is outside the dates this browser can represent.`,
        detail:
          'That is 100,000,000 days either side of 1970: from -271821-04-20 to +275760-09-13.',
      },
    };
  }

  if (parsed.dropped) {
    notes.push(
      lost(
        'Digits past the nanosecond were dropped',
        `${parsed.written} has more than nine digits after the decimal point, and a nanosecond is the finest unit this tool carries. The rest were dropped.`,
        EVERY_PORT,
      ),
    );
  }
  if (parsed.offset?.unknown === true) {
    notes.push(
      noted(
        'The offset is explicitly unknown',
        `${parsed.written} ends in -00:00, which RFC 3339 section 4.3 defines as "the time in UTC is known, the local offset is not". The instant is exact; where it was written is not said, and no output can say it either.`,
      ),
    );
  }
  if (parsed.endOfDay) {
    notes.push(
      noted(
        '24:00 was read as midnight at the start of the next day',
        'ISO 8601 allows 24:00 for the end of a day; it is the same instant as 00:00 of the day after, and RFC 3339 has only that spelling.',
      ),
    );
  }
  if (parsed.shortYear !== null) {
    notes.push(
      noted(
        `The year ${parsed.shortYear} was read as ${parsed.wall.year.toString()}`,
        "A two- or three-digit year is RFC 5322's obsolete form. Section 4.3 says 00 to 49 is 2000 onwards, 50 to 99 the 1900s, and three digits have 1900 added - which is what was done. Python's email.utils puts the line at 69 instead.",
      ),
    );
  }
  if (parsed.abbreviation !== null) {
    notes.push(
      noted(
        `The abbreviation ${parsed.abbreviation} was not read`,
        'The numeric offset before it was. An abbreviation cannot be read reliably - IST is India, Ireland and Israel - and where a numeric offset is present it is the one that decides.',
      ),
    );
  }
  if (parsed.key !== null) {
    notes.push(
      noted(
        `Read the value of ${parsed.key}`,
        'The input was a key and a value; the value was read and the key was not.',
      ),
    );
  }
  if (parsed.dateOnly) {
    notes.push(
      noted(
        'A date alone was read as its first instant',
        'No time was given, so it was read as the start of that day - 00:00, or the first wall time after it where a clock change skipped midnight.',
      ),
    );
  }

  const statedOffset =
    parsed.offset !== null && !parsed.offset.unknown ? parsed.offset.seconds : null;
  const zoneWords = parsed.offset === null && usedZone !== null ? `, in ${usedZone.name}` : '';
  return {
    ok: true,
    value: { epochNs, notes, from: `${SYNTAX_WORDS[parsed.syntax]}${zoneWords}`, statedOffset },
  };
}

function formatDuration(seconds: number): string {
  const magnitude = Math.abs(seconds);
  const hours = Math.floor(magnitude / 3600);
  const minutes = Math.floor((magnitude % 3600) / 60);
  const parts = [
    hours > 0 ? `${hours.toString()} hour${hours === 1 ? '' : 's'}` : '',
    minutes > 0 ? `${minutes.toString()} minutes` : '',
  ];
  return parts.filter((part) => part !== '').join(' ') || `${magnitude.toString()} seconds`;
}

/**
 * One timestamp in, every notation of it out, with what the conversion could
 * not carry said rather than left to be noticed.
 */
export function convert(input: Input, options: TimestampOptions, deps: Dependencies): Converted {
  const inputNotes: ToolNote[] = [];
  let text: string;
  let jsonNumber = false;

  if (input.type === 'json') {
    const picked = readPointer(input.data, options.field.trim());
    if (!picked.found) {
      const candidates = timestampPointers(input.data);
      return failed(
        `Nothing is at ${options.field.trim()} in the wired JSON.`,
        candidates.length === 0
          ? 'Field is a JSON Pointer (RFC 6901), such as /payload/exp, and nothing in the wired value reads as a timestamp.'
          : `Field is a JSON Pointer (RFC 6901). These read as timestamps: ${candidates.join(', ')}.`,
      );
    }
    const value = picked.value;
    if (typeof value === 'number') {
      text = Number.isInteger(value) ? BigInt(value).toString() : String(value);
      jsonNumber = true;
    } else if (typeof value === 'string') {
      text = value;
    } else {
      const candidates = timestampPointers(value);
      const at =
        options.field.trim() === '' ? 'The wired JSON' : `The value at ${options.field.trim()}`;
      return failed(
        `${at} is ${isJsonArray(value) ? 'an array' : value === null ? 'null' : isJsonObject(value) ? 'an object' : 'a boolean'}, not a timestamp.`,
        candidates.length === 0
          ? 'Set Field to a JSON Pointer naming one value, such as /payload/exp.'
          : `Set Field to the one to read, as a JSON Pointer. These read as timestamps: ${candidates.map((candidate) => `${options.field.trim()}${candidate}`).join(', ')}.`,
      );
    }
    if (options.field.trim() !== '') {
      inputNotes.push(
        noted(
          `Read ${options.field.trim()} of the wired JSON`,
          'Field chose it. Nothing else in the wired value was read - including, for a decoded JWT, the signature verdict beside it: this is when the claim says, not whether the claim is true.',
        ),
      );
    }
  } else {
    text = input.text;
    if (options.field.trim() !== '') {
      inputNotes.push(
        noted(
          'Field was not used',
          'It reads a member of a wired JSON value, and the input is text.',
        ),
      );
    }
  }

  const parsed = parseTimestamp(text, options.unit);
  if (!parsed.ok) return failed(parsed.message, parsed.detail);

  const resolved =
    parsed.value.kind === 'number'
      ? resolveNumber(parsed.value, jsonNumber)
      : resolveWall(parsed.value, options, deps);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { epochNs } = resolved.value;
  const notes = [...inputNotes, ...resolved.value.notes];

  const zoneLookup = deps.lookupZone(options.zone);
  if (!zoneLookup.ok) return failed(zoneLookup.message, zoneLookup.detail);
  const zone = zoneLookup.zone;
  const epochSeconds = Number(floorDiv(epochNs, NS_PER_SECOND));
  const offset = zone.offsetAt(epochSeconds);

  const target: Target =
    options.target !== 'auto'
      ? options.target
      : parsed.value.kind === 'number'
        ? 'local'
        : exactUnit(epochNs);

  const utc = formatRfc3339(epochNs, 0, true);
  const localText = formatRfc3339(epochNs, offset, zone.utc);
  const rfc9557 = `${formatRfc3339(epochNs, offset, false)}[${zone.name}]`;
  const readable = formatReadable(epochNs, offset, zone.name, zone.utc);

  let output: string;
  if ((UNIX_TARGETS as readonly string[]).includes(target)) {
    const unit = target as Unit;
    const { value, dropped } = unixInteger(epochNs, unit);
    output = value.toString();
    if (dropped !== 0n) {
      notes.push(
        lost(
          `Precision was dropped: ${unixDecimal(epochNs, unit)} is not whole ${UNIT_WORDS[unit]}`,
          `The instant is ${utc}, which is ${unixDecimal(epochNs, 'ns')} ns. Unix ${UNIT_WORDS[unit]} are integers, so it was floored to ${output} and the last ${unixDecimal(dropped, 'ns')} ns are not in the answer. The Notations output has every unit exactly.`,
          ['output'],
        ),
      );
    }
  } else if (target === 'utc') {
    output = utc;
  } else if (target === 'local') {
    output = localText;
  } else if (target === 'rfc9557') {
    output = rfc9557;
  } else {
    output = readable;
  }

  const wall = wallAt(epochNs, offset);
  const datedTarget = !(UNIX_TARGETS as readonly string[]).includes(target);

  if (datedTarget && target !== 'readable' && !isRfc3339Year(wall.year)) {
    notes.push(
      noted(
        'The year is outside RFC 3339',
        `RFC 3339 writes years 0000 to 9999; this is ISO 8601's expanded form, a sign and six digits, which ECMAScript reads and a strict RFC 3339 reader refuses.`,
      ),
    );
  }
  if (datedTarget && target !== 'utc' && offset % 60 !== 0) {
    notes.push(
      noted(
        `The offset ${formatOffset(offset)} is not a whole minute`,
        `That is ${zone.name}'s local mean time, from before it had a standard offset, and RFC 3339 has no spelling for seconds in an offset. It is written with them, as Python's isoformat and Temporal do, rather than rounded - a rounded offset and the wall time beside it would name a different instant. A strict RFC 3339 reader will refuse it.`,
      ),
    );
  }
  const stated = resolved.value.statedOffset;
  const answerOffset = datedTarget ? (target === 'utc' ? 0 : offset) : null;
  // Z and +00:00 say nothing about a clock that a UTC answer loses.
  if (stated !== null && stated !== 0 && stated !== answerOffset) {
    notes.push(
      noted(
        `The input's own offset, ${formatOffset(stated)}, is not in the answer`,
        datedTarget
          ? `The instant is exact. The answer is written ${target === 'utc' ? 'in UTC' : `at ${zone.name}'s offset`}, so the offset the input was written at - which says where its clock was - is not in it.`
          : 'The instant is exact. A Unix time has no offset, so the one the input was written at - which says where its clock was - is not in it.',
      ),
    );
  }
  if (parsed.value.kind === 'number' && LEAP_SECOND_UNIX.has(epochSeconds)) {
    notes.push(
      noted(
        'This Unix second also stands for a leap second',
        `POSIX gives the leap second before ${utc.slice(0, 10)} the same number as the midnight after it, so this second of Unix time is two seconds of UTC. The answer is the conventional one, the midnight.`,
      ),
    );
  }
  if (wall.year < 1583 && datedTarget) {
    notes.push(
      noted(
        'The date is proleptic Gregorian',
        'It is in the Gregorian calendar run backwards past its introduction in 1582, as ISO 8601 and ECMAScript define it - not the Julian date a historian would use.',
      ),
    );
  }

  const dependsOnRules = !zone.fixed && datedTarget && target !== 'utc';
  const readRules = parsed.value.kind === 'wall' && parsed.value.offset === null;
  if (dependsOnRules || readRules) {
    const vintage = deps.vintage();
    if (vintage !== null) {
      notes.push(
        noted(
          "The zone rules are this browser's own",
          `${describeVintage(vintage)} Another browser can answer a different offset where IANA has changed a zone since - most often for future dates a government has just moved, and for history before 1970.`,
        ),
      );
    }
  }

  const all: JsonValue = {
    unix: {
      s: unixDecimal(epochNs, 's'),
      ms: unixDecimal(epochNs, 'ms'),
      us: unixDecimal(epochNs, 'us'),
      ns: unixDecimal(epochNs, 'ns'),
    },
    utc,
    local: localText,
    rfc9557,
    readable,
    zone: zone.name,
    offset: formatOffset(offset),
    weekday: WEEKDAY_NAMES[isoWeekday(daysAt(epochNs, offset)) - 1] ?? '',
  };

  const to =
    TARGET_WORDS[target] + (datedTarget && target !== 'utc' && !zone.utc ? `, ${zone.name}` : '');
  return {
    ok: true,
    value: {
      output,
      all,
      summary: `${resolved.value.from} → ${to}`,
      from: resolved.value.from,
      to,
      notes,
    },
  };
}
