"""Generates the timestamp tool's oracle from CPython's `datetime` and `zoneinfo`.

Run with CPython and IANA's tz database as the `tzdata` package, pinned:

    python -m pip install --target .tzdata-2026d tzdata==2026.4
    PYTHONPATH=.tzdata-2026d python scripts/generate-timestamp-oracle.py > src/tools/timestamp/spec/timestamp-oracle.json && pnpm format

The output is committed; nothing at test time shells out. The `tzdata` package
is pinned rather than whatever the machine has, because the zone rules ARE the
answer for half of this fixture: an operating system's own copy is a different
release on every machine, and Windows has none at all. The version written into
the fixture is the package's own `IANA_VERSION`, read rather than assumed.

WHAT IT HOLDS, and what each part is the reference for:

  zones     Every UTC offset change from 1900 to 2040, to the second, for the
            zones the tests use - so the tool's arithmetic can be run against
            IANA's rules without asking any engine for them. The tool asks the
            browser; `check:browsers` compares the browser with this.
  instants  Python's own civil date for instants across years 1 to 9999: the
            calendar arithmetic, the weekday, and the local wall time in each
            zone for the ones inside the zones' range.
  walls     A wall time inside every clock change from 1970 to 2030 in those
            zones, and at both edges of every sixth, resolved with PEP 495's fold=0 and
            fold=1: the missing and the doubled hours.
  iso       Strings put to `datetime.fromisoformat`, which is an independent
            ISO 8601 reader: what it made of each, or that it refused.
  rfc5322   Strings put to `email.utils.parsedate_to_datetime`.
  names     The C locale's weekday and month names, from `calendar`.

THE GENERATOR CHECKS ITSELF BEFORE WRITING ANYTHING. PEP 495's fold rules are
the reference for the walls, so the two cases every reader knows - New York's
2024 spring-forward and fall-back - are asserted against their published
answers first, and the transition scan is asserted to reproduce every offset
it sampled. A fixture from a generator whose own premise failed would be a
table of wrong answers with a hash.
"""

import calendar
import email.utils
import json
import locale
import sys
from datetime import datetime, timedelta, timezone

import tzdata
import zoneinfo

sys.stdout.reconfigure(encoding="utf-8", newline="")
locale.setlocale(locale.LC_TIME, "C")

EPOCH = datetime(1970, 1, 1)
EPOCH_AWARE = EPOCH.replace(tzinfo=timezone.utc)

ZONES = [
    "America/New_York",
    "Europe/Berlin",
    "Europe/London",
    "Europe/Moscow",
    "Australia/Sydney",
    "Australia/Lord_Howe",
    "Asia/Kolkata",
    "Asia/Kathmandu",
    "America/St_Johns",
    "Pacific/Apia",
    "Pacific/Kiritimati",
    "America/Sao_Paulo",
    "America/Santiago",
    "America/Havana",
    "America/Asuncion",
    "Africa/Casablanca",
    "Africa/Monrovia",
    "Asia/Tehran",
    "America/Caracas",
    "Antarctica/Troll",
    "Pacific/Chatham",
    "Asia/Pyongyang",
]

RANGE_FROM = int((datetime(1900, 1, 1) - EPOCH).total_seconds())
RANGE_TO = int((datetime(2041, 1, 1) - EPOCH).total_seconds())
WALLS_FROM = int((datetime(1970, 1, 1) - EPOCH).total_seconds())
WALLS_TO = int((datetime(2031, 1, 1) - EPOCH).total_seconds())


def offset_at(zone, seconds):
    """Seconds east of UTC at an instant, with no call into the OS."""
    return int((EPOCH_AWARE + timedelta(seconds=seconds)).astimezone(zone).utcoffset().total_seconds())


def transitions(zone):
    """Every change in [RANGE_FROM, RANGE_TO), found by a 3-hour scan and bisected to the second."""
    found = []
    step = 3 * 3600
    t = RANGE_FROM
    previous = offset_at(zone, t)
    initial = previous
    while t < RANGE_TO:
        nxt = t + step
        current = offset_at(zone, nxt)
        if current != previous:
            low, high = t, nxt
            while high - low > 1:
                middle = (low + high) // 2
                if offset_at(zone, middle) == previous:
                    low = middle
                else:
                    high = middle
            found.append([high, current])
            previous = current
        t = nxt
    return initial, found


def from_table(initial, table, seconds):
    offset = initial
    for at, after in table:
        if at <= seconds:
            offset = after
        else:
            break
    return offset


def wall_of(local_seconds):
    return EPOCH + timedelta(seconds=local_seconds)


def resolve(zone, wall, fold):
    return int((wall.replace(tzinfo=zone, fold=fold) - EPOCH_AWARE).total_seconds())


def wall_case(zone_name, zone, local_seconds):
    wall = wall_of(local_seconds)
    fold0 = resolve(zone, wall, 0)
    fold1 = resolve(zone, wall, 1)
    back0 = (EPOCH_AWARE + timedelta(seconds=fold0)).astimezone(zone).replace(tzinfo=None) == wall
    back1 = (EPOCH_AWARE + timedelta(seconds=fold1)).astimezone(zone).replace(tzinfo=None) == wall
    if fold0 == fold1:
        kind = "unique"
    elif back0 and back1:
        kind = "overlap"
    elif not back0 and not back1:
        kind = "gap"
    else:
        raise SystemExit(f"fold semantics broke at {zone_name} {wall}: {back0} {back1}")
    return [zone_name, wall.isoformat(), kind, fold0, fold1]


# -- the generator's own premise, checked before anything is written ---------
NEW_YORK = zoneinfo.ZoneInfo("America/New_York")
assert resolve(NEW_YORK, datetime(2024, 3, 10, 2, 30), 0) == int(
    (datetime(2024, 3, 10, 7, 30) - EPOCH).total_seconds()
), "fold=0 in a gap must use the offset before the change (EST): 02:30 is 07:30Z"
assert resolve(NEW_YORK, datetime(2024, 3, 10, 2, 30), 1) == int(
    (datetime(2024, 3, 10, 6, 30) - EPOCH).total_seconds()
), "fold=1 in a gap must use the offset after it (EDT): 02:30 is 06:30Z"
assert resolve(NEW_YORK, datetime(2024, 11, 3, 1, 30), 0) == int(
    (datetime(2024, 11, 3, 5, 30) - EPOCH).total_seconds()
), "fold=0 in an overlap is the first 01:30, EDT: 05:30Z"
assert resolve(NEW_YORK, datetime(2024, 11, 3, 1, 30), 1) == int(
    (datetime(2024, 11, 3, 6, 30) - EPOCH).total_seconds()
), "fold=1 in an overlap is the second 01:30, EST: 06:30Z"

zones_out = {}
walls = []
for name in ZONES:
    zone = zoneinfo.ZoneInfo(name)
    initial, table = transitions(zone)
    # The scan must reproduce the zone at every sample it could have missed.
    for probe in range(RANGE_FROM, RANGE_TO, 86_400 * 7 + 3_600):
        assert from_table(initial, table, probe) == offset_at(zone, probe), (name, probe)
    zones_out[name] = {"initial": initial, "transitions": table}

    before = initial
    for index, (at, after) in enumerate(table):
        if WALLS_FROM <= at < WALLS_TO:
            low, high = sorted((at + before, at + after))
            points = [low + (high - low) // 2]
            if index % 6 == 0:
                points += [low - 1, low, high - 1, high]
            for local in sorted(set(points)):
                walls.append(wall_case(name, zone, local))
        before = after

# -- instants: calendar arithmetic over the whole of Python's range -----------
instants = []
first = int((datetime(1, 1, 1) - EPOCH).total_seconds())
last = int((datetime(9999, 12, 31, 23, 59, 59) - EPOCH).total_seconds())
stride = 7_777_777_777
for seconds in list(range(first, last, stride)) + [first, last, 0, -1, 1, 951_782_400, 951_868_800, 4_107_542_400, -2_208_988_800]:
    micro = (seconds * 7919) % 1_000_000
    utc = EPOCH + timedelta(seconds=seconds, microseconds=micro)
    # A STRING, because 253402300799999999 us is past 2^53 and a JSON number
    # that size reaches JavaScript already rounded - the loss this tool
    # reports, and the first version of this fixture had it.
    row = [
        str(seconds * 1_000_000 + micro),
        utc.year, utc.month, utc.day, utc.hour, utc.minute, utc.second, utc.microsecond,
        utc.isoweekday(),
    ]
    instants.append(row)

local = []
for index, name in enumerate(ZONES):
    zone = zoneinfo.ZoneInfo(name)
    for k in range(18):
        seconds = RANGE_FROM + ((index * 104_729 + k * 250_000_033) % (RANGE_TO - RANGE_FROM))
        wall = (EPOCH_AWARE + timedelta(seconds=seconds)).astimezone(zone)
        local.append([
            name, seconds, int(wall.utcoffset().total_seconds()),
            wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second,
        ])

# -- an independent ISO 8601 reader --------------------------------------------
ISO = [
    # RFC 3339 section 5.8, verbatim.
    "1985-04-12T23:20:50.52Z",
    "1996-12-19T16:39:57-08:00",
    "1990-12-31T23:59:60Z",
    "1990-12-31T15:59:60-08:00",
    "1937-01-01T12:00:27.87+00:20",
    # The shapes software writes.
    "2024-09-26T08:00:00Z",
    "2024-09-26t08:00:00z",
    "2024-09-26T08:00:00+02:00",
    "2024-09-26T08:00:00-00:00",
    "2024-09-26 08:00:00+02:00",
    "2024-09-26T08:00:00.123456789Z",
    "2024-09-26T08:00:00,5Z",
    "2024-09-26T08:00Z",
    "2024-09-26T08:00:00+0200",
    "2024-09-26T08:00:00+02",
    "2024-09-26T08:00:00+05:45",
    "2024-09-26T08:00:00+00:19:32",
    "20240926T080000Z",
    "20240926T080000+0200",
    "2024-02-29T00:00:00Z",
    # The century rule, both halves: 2000 was a leap year, 1900 and 2100 are not.
    "2000-02-29T00:00:00Z",
    "1900-02-29T00:00:00Z",
    "2100-02-29T00:00:00Z",
    "2023-02-29T00:00:00Z",
    "2024-13-01T00:00:00Z",
    "2024-09-31T00:00:00Z",
    "2024-09-26T25:00:00Z",
    "2024-09-26T24:00:00Z",
    "2024-09-26T08:60:00Z",
    "2024-09-26T08:00:61Z",
    "2024-09-26T08:00:00+24:00",
    "0001-01-01T00:00:00Z",
    "9999-12-31T23:59:59.999999Z",
    "2024-W39-4T08:00:00Z",
    "2024-270T08:00:00Z",
    "2024-09-26T08Z",
    "2024-09-26",
    "2024-09-26T08:00:00",
]
iso = []
for text in ISO:
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        iso.append([text, None])
        continue
    if parsed.tzinfo is None:
        iso.append([text, "naive", parsed.isoformat()])
    else:
        iso.append([text, "aware", str((parsed - EPOCH_AWARE) // timedelta(microseconds=1))])

# -- an independent RFC 5322 reader --------------------------------------------
RFC5322 = [
    "Thu, 26 Sep 2024 06:00:00 GMT",
    "Thu, 26 Sep 2024 08:00:00 +0200",
    "26 Sep 2024 08:00 +0200",
    "Thu, 26 Sep 2024 02:00:00 EDT",
    "Thu, 26 Sep 2024 01:00:00 CDT",
    "Wed, 25 Sep 2024 23:00:00 PDT",
    "Thu, 26 Sep 2024 06:00:00 UT",
    "Thu, 26 Sep 2024 06:00:00 -0000",
    "Thu, 1 Jan 1970 00:00:00 +0000",
    "Sat, 31 Dec 2016 23:59:60 +0000",
    "Thu, 26 Sep 24 06:00:00 GMT",
    "Fri, 01 Jan 60 00:00:00 GMT",
    "Fri, 01 Jan 99 00:00:00 GMT",
    "Fri, 26 Sep 2024 06:00:00 GMT",
    "thu, 26 sep 2024 06:00:00 gmt",
]
rfc5322 = []
for text in RFC5322:
    try:
        parsed = email.utils.parsedate_to_datetime(text)
    except (ValueError, TypeError):
        rfc5322.append([text, None])
        continue
    rfc5322.append([text, int((parsed.replace(tzinfo=parsed.tzinfo or timezone.utc) - EPOCH_AWARE).total_seconds())])

json.dump(
    {
        "$note": "Generated by scripts/generate-timestamp-oracle.py from CPython's datetime, zoneinfo, email.utils and calendar. Do not edit by hand.",
        "python": sys.version.split()[0],
        "tzdata": tzdata.IANA_VERSION,
        "names": {
            "weekdays": list(calendar.day_name),
            "months": list(calendar.month_name)[1:],
        },
        "zones": zones_out,
        "instants": instants,
        "local": local,
        "walls": walls,
        "iso": iso,
        "rfc5322": rfc5322,
    },
    sys.stdout,
    ensure_ascii=False,
    indent=2,
)
sys.stdout.write("\n")
