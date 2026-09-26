# Timestamp

For the moment a log says `"created_at": 1727308800` and you need to know when
that was - or you have a date in mind and need its number. Unix time in
seconds, milliseconds, microseconds or nanoseconds; RFC 3339 and the ISO 8601
around it; email and HTTP dates; and a readable date in any IANA time zone. In
both directions, with what the conversion could not carry said rather than left
to be noticed.

- [What it reads](#what-it-reads)
- [What it writes](#what-it-writes)
- [The decisions](#the-decisions)
- [What it loses, and how it says so](#what-it-loses-and-how-it-says-so)
- [Time zone data is the browser's](#time-zone-data-is-the-browsers)
- [Evidence](#evidence)
- [What it does not do, on purpose](#what-it-does-not-do-on-purpose)
- [Known limitations](#known-limitations)

## What it reads

| Form                      | Example                                                                        |
| ------------------------- | ------------------------------------------------------------------------------ |
| Unix time                 | `1727308800`, `1727308800123`, `1727308800.5`, `1.7273088e9`                   |
| RFC 3339                  | `2024-09-26T08:00:00+02:00`, `1990-12-31T23:59:60Z`                            |
| ISO 8601 around it        | `2024-09-26 08:00`, `2024-09-26T08:00:00,5+0200`, `20240926T060000Z`           |
| Go's `time.String()`      | `2024-09-26 08:00:00 +0200 CEST` - the offset is read, the name is not         |
| An RFC 9557 zone          | `2024-09-26T08:00[Europe/Berlin]`, `2024-09-26T08:00:00+02:00[!Europe/Berlin]` |
| RFC 5322 (email, HTTP)    | `Thu, 26 Sep 2024 06:00:00 GMT`, `26 Sep 24 08:00 +0200`                       |
| This tool's readable form | `Thursday 26 September 2024, 08:00:00 +02:00 (Europe/Berlin)`                  |
| Any of those as a value   | `"created_at": 1727308800,`, `Date: Thu, 26 Sep 2024 06:00:00 GMT`             |
| A wired JSON value        | a decoded JWT, with **Field** set to `/payload/exp`                            |

A date with no offset and no zone - `2024-09-26 08:00` - is read as a wall time
in the **Time zone** option, and the report says so.

## What it writes

**Converted** is one notation: RFC 3339 in UTC or in the zone, RFC 3339 with
the zone's name (RFC 9557), a readable date, or Unix time in a unit. The
default is the other side of whatever arrived - a date for a number, and for a
date the coarsest Unix unit that holds it exactly, so the default never drops a
digit.

**Notations** is every notation at once, each exact: Unix time in all four units
as decimal strings (`"1727308800.123"`), because a JSON number past 2^53 is a
double and `1727308800123456789` would arrive as `1727308800123456800`.

**Report** is what was read, what was assumed, and what was lost.

## The decisions

**An instant is a BigInt of nanoseconds, not a `Date`.** `Date` is milliseconds
in a double. OpenTelemetry, Go's UnixNano and every tracing system write
nanoseconds, and a nanosecond count for any date since 1970-04 is past 2^53 -
so the first thing a `Date`-based converter does to one is round it. Here the
digits become one BigInt and a power of ten; no double is involved.

**The unit of a bare number is read off its size, by digits**: up to 11 digits
is seconds, 12 to 14 milliseconds, 15 to 17 microseconds, 18 or more
nanoseconds. That is the rule a person applies at a glance, and it is exact
where it matters: from 1980 to 2100 the four readings of any number are at
least 77 times apart, so exactly one of them lands in that window. Outside it,
the rule still picks, and the report doubts it - see
[the losses](#what-it-loses-and-how-it-says-so). **Numbers are** turns guessing
off.

**UTC by default, never "this computer's zone".** The zone is part of the
answer. An answer that depended on the machine would be a share link that says
one thing to its author and another to everybody else, a cached result that was
right until the laptop crossed a border, and a test that passes in Sydney and
fails in CI. Somebody who wants their local time names their zone, and the name
travels with the pipeline.

**The readable form is written here, not by `Intl.DateTimeFormat`.** The
engine's long date format is CLDR data at the engine's own version - `at`
against `,`, a narrow no-break space before `PM` in newer data - in the
reader's locale, so the same instant is a different string in each browser and
nothing can say which is right. English names from a fixed table, a numeric
offset and the IANA name are the same string everywhere, are checked against
Python's `calendar` names and weekday arithmetic, and read back in. Zone
abbreviations are left out: `IST` is India, Ireland and Israel, and they are
CLDR data too.

**A zone is written as it was typed, with its case corrected.** Measured:
`Asia/Calcutta` resolves to `Asia/Kolkata` in Gecko and stays `Asia/Calcutta`
in WebKit and V8; `US/Eastern` becomes `America/New_York` in two engines and
stays itself in the third. An answer whose spelling depended on the browser
would be one instant written three ways.

**Unix time is floored, not truncated.** A Unix time names the second an
instant falls in, and 1969-12-31T23:59:59.5Z falls in second -1. That is
`Math.floor(Date.now() / 1000)`, Go's `Unix()` and POSIX.

**A clock change follows the usual rule, and says so.** A wall time the clocks
skipped moves forward by the length of the gap; one they showed twice is the
first of its two. That is RFC 5545's rule, Temporal's `compatible` and
Python's `fold=0`, and it is checked against the last of those at every clock
change in 22 zones from 1970 to 2030. **At a clock change** offers the earlier
instant, the later one, or a refusal.

**A leap second is read as the second after it.** Unix time has no number for
23:59:60: POSIX counts every day as 86,400 seconds, and its conversion formula
lands 23:59:60 on the same number as the midnight after it. So that is what
`2016-12-31T23:59:60Z` becomes - `1483228800` - with a warning, because an
elapsed time measured across it is a second short. A `:60` that was not a leap
second is refused; the twenty-seven that were are in `leapSeconds.ts`, copied
from IANA's `leap-seconds.list`, which is committed in `spec/` and held to the
hash it carries for itself.

**An offset that is not a whole minute is written with its seconds.**
Africa/Monrovia was -00:44:30 until 1972. RFC 3339 cannot say that; rounding
it would print a wall time and an offset that add up to a different instant,
which is a wrong answer that parses. Python's `isoformat` and Temporal write
`-00:44:30`, and so does this, with a note that a strict RFC 3339 reader will
refuse it.

**An offset and a zone that disagree are refused.** `…T08:00+01:00[Europe/Berlin]`
is either the wrong offset or the wrong zone. RFC 9557 leaves which to the
reader; this reader does not pick.

**Field is a JSON Pointer.** RFC 6901, because it has an escaping rule
(`~1` for `/`, `~0` for `~`) and a specification to be checked against, where a
dotted path has neither. A wired object with no Field is refused with the
pointers in it that read as timestamps, ready to copy.

## What it loses, and how it says so

At `warn`, which is the level a canvas node prints on its own face:

| Loss                                   | Said as                                                      |
| -------------------------------------- | ------------------------------------------------------------ |
| A unit read off a number, and doubtful | `Read as seconds by its size, which is 1970-01-02T00:00:00Z` |
| A Unix target coarser than the instant | `Precision was dropped: 1727308800.123 is not whole seconds` |
| Digits past the nanosecond             | `Digits past the nanosecond were dropped`                    |
| A wall time the clocks skipped         | `02:30:00 did not happen in Europe/Berlin on 2024-03-31`     |
| A wall time the clocks showed twice    | `02:30:00 happened twice in Europe/Berlin on 2024-10-27`     |
| A leap second                          | `23:59:60 has no Unix time of its own`                       |

Each is a row of the loss corpus (rows 21 to 26), so each is held to a note on
`/tools` and on a canvas node in two engines, with a document of the same shape
that loses nothing beside it.

At `info`, on the panel only, because nothing was lost or because the loss is
the target's by definition:

- a date with no offset, read in the zone option;
- the input's own offset, when the answer is in another one or is a Unix time -
  the instant is exact, and the offset said where the clock was;
- RFC 3339's `-00:00`, "local offset unknown", which no output can carry;
- `24:00`, read as the next day's midnight;
- an RFC 5322 two-digit year, read by section 4.3's rule - 50 is the pivot,
  where Python's `email.utils` uses 69;
- a zone abbreviation after a numeric offset, not read;
- a year outside RFC 3339's 0000-9999, written in ISO 8601's expanded form;
- an offset that is not a whole minute;
- a Unix second that also stands for a leap second;
- a wired JSON number past 2^53, which may already be rounded;
- a date before 1583, which is proleptic Gregorian;
- **which tz database the browser's answer came from** - see below.

**Out of range is a refusal, not a loss.** Anything past 100,000,000 days from
1970 - `Date`'s own range, and the range any engine's zone data can be asked
about - is refused, naming the range, with a hint that a nanosecond count read
as seconds is a billion times too far.

## Time zone data is the browser's

Every offset for a named zone comes from the engine's own `Intl`, which carries
its own copy of IANA's tz database at its own release - and the three engines
this repository drives carry different ones. Measured at this commit:

| Engine                  | Answers like | America/Vancouver, 2027-01-15 | Asia/Tehran, 1978-11-20 |
| ----------------------- | ------------ | ----------------------------- | ----------------------- |
| Playwright Firefox 155  | tzdata 2026b | -07:00                        | +03:30                  |
| Playwright WebKit 26.6  | tzdata 2025a | **-08:00**                    | **+04:00**              |
| Node 24.19 (V8, ICU 78) | tzdata 2026b | -07:00                        | +03:30                  |

<!-- unverified: a measurement of three engine builds on one day, not something a gate can hold for every browser -->

Both answers in each column are faithful to a real release; they are different
releases. So **what the tool claims is the browser's answer, and which release
it matches.** It asks the engine for the offset at fifteen instants, one per
release from 2022b to 2026d that changed an offset - each checked against all
twenty releases by `scripts/generate-tz-sentinels.py` - and the report says the
last release whose change the engine has. Where the answers match no single
release it says that instead.

It does not bundle its own copy. A bundled copy would make every engine agree,
and would be as stale as the last deploy rather than as the last browser
update, which for most people is the more recent of the two; it would also be
a copy that answers differently from every other piece of JavaScript on the
same machine. What it does instead is say whose answer it is.

Two measured facts follow for anybody reading an answer: **future dates are the
likeliest to differ** - Vancouver's is a rule British Columbia changed in 2026
for November 2026 onwards - and **history before 1970 differs by design**: IANA
moved pre-1970 detail for many zones into `backzone` in 2022, which no engine
here builds with, so Europe/Amsterdam in 1937 is +00:00 in all three rather
than the +00:20 RFC 3339's own example uses. An explicit offset in the input
is always exact; only a zone's rules are the browser's.

## Evidence

| Claim                                 | Held by                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Civil dates, weekdays, years 1-9999   | CPython's `datetime`, on a fixed stride - `timestamp.oracle.test.ts`                                               |
| Wall time in a zone at an instant     | CPython's `zoneinfo`, tzdata 2026d, 22 zones                                                                       |
| Every clock change's gap and overlap  | `zoneinfo` with PEP 495 `fold`, at every change in those zones from 1970 to 2030                                   |
| ISO 8601 reading                      | `datetime.fromisoformat` over 38 strings, including RFC 3339 section 5.8's five examples; every disagreement named |
| RFC 5322 reading                      | `email.utils.parsedate_to_datetime`; the two disagreements named                                                   |
| Weekday and month names               | `calendar` in the C locale                                                                                         |
| The leap second table                 | IANA's `leap-seconds.list`, verified by its own SHA-1                                                              |
| The tz database sentinels             | Every release from 2022a to 2026d, installed side by side                                                          |
| The engines' zone data                | `checkTimestampZones` in `check:browsers`: each engine against the oracle, and its vintage reported                |
| That no answer depends on the machine | the suite run under three zones, a faked clock and a forced locale                                                 |

The fixtures are generated by `scripts/generate-timestamp-oracle.py` and
`scripts/generate-tz-sentinels.py` and committed, so nothing shells out at
test time.

## What it does not do, on purpose

- **"In 3 hours", "2 years ago".** A relative time is a statement about now,
  and a result here is cached on its inputs and reproduced by a share link. A
  cached "in 3 hours" is false an hour later with nothing to say so, and
  adding the clock to the cache key would re-run every node downstream of this
  one every second. If it ever exists it belongs in a view, computed as it is
  drawn and labelled as the viewer's clock - never on a port.
- **Natural language** - "next Friday 3pm". There is no reference to check a
  reading against, "next Friday" means two different days to two English
  speakers, and it depends on the moment it is read, which is the relative-time
  problem again.
- **`26/09/2024`.** Refused: the digits do not say which is the day.
- **Zone abbreviations on their own** - `date`'s `Thu Sep 26 08:00:00 CEST
2024`, `git log`'s default. An abbreviation is not a zone.
- **Other epochs** - Windows FILETIME, .NET ticks, NTP, GPS time, Excel serial
  dates, snowflake and UUIDv7 timestamps. Each is a different count from a
  different origin, several with their own leap-second rules, and each is a
  tool's worth of decisions of its own rather than a unit here.
- **Calendars other than the proleptic Gregorian.**

## Known limitations

1. **The zone rules are the browser's**, as above. The report names the
   release; it cannot tell you what a newer release would have said.
2. **Two changes to a zone within a day** of one wall time would defeat the
   gap and overlap search, which brackets a wall time with the offsets a day
   either side - the same assumption Temporal's specification makes. No zone in
   the oracle has one from 1900 to 2040.
3. **A wired JSON number** is a double by the time it arrives; past 2^53 its
   last digits are the double's. Said, not fixable here.
4. **Dates before 1583** are proleptic Gregorian, not Julian.
