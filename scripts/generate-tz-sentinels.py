"""Generates the tz database sentinels, and the instants no release has moved.

A browser does not say which release of the tz database it carries, and the
three this repository drives carry different ones - measured, WebKit answers
America/Vancouver in January 2027 an hour differently from Gecko. So the
timestamp tool asks the engine, at a handful of instants, which side of each
release's change it is on, and reports the release its answers match.

Every sentinel is CHECKED against every release rather than picked by hand and
trusted: for each candidate, every release before the one it is filed under
must give its `before` offset, and that release and every later one its
`after`. The generator refuses to write a candidate that does not flip at
exactly its release and stay flipped.

It writes a second file beside the first: every zone instant of the timestamp
oracle whose offset is the SAME in all the releases installed. Those are the
instants at which an engine disagreeing with the oracle cannot be explained by
its release, and `checkTimestampZones` holds each engine to them exactly. It
is a separate file because the tool imports the sentinels and has no use for
these.

Install each release as its own directory, generate the oracle first (this
reads its zone instants), then:

    for v in 2022.1 2022.2 ... 2026.4; do python -m pip install --target tz/$v tzdata==$v; done
    python scripts/generate-tz-sentinels.py src/tools/timestamp/spec tz/* && pnpm format

Releases with no candidate here - 2022c, 2023b, 2023c and 2026a - changed no
UTC offset at any instant this was looked for at (twice a month, 1900 to
2040), so they cannot be told from the release before them this way and the
tool's answer says "at least" rather than naming them.
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timezone

EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

# (release, zone, instant) - chosen from a diff of every consecutive pair of
# releases, and each a change a person might plausibly ask about.
CANDIDATES = [
    ("2022b", "Asia/Tehran", "1977-04-01T12:00:00"),
    ("2022d", "Europe/Zaporozhye", "1990-07-01T12:00:00"),
    ("2022e", "Asia/Amman", "2022-11-01T12:00:00"),
    ("2022f", "America/Mexico_City", "2023-04-15T12:00:00"),
    ("2022g", "America/Nuuk", "2023-11-01T12:00:00"),
    ("2023a", "Africa/Cairo", "2023-05-01T12:00:00"),
    ("2023d", "America/Scoresbysund", "2024-04-01T12:00:00"),
    ("2024a", "Asia/Almaty", "2024-03-01T12:00:00"),
    ("2024b", "Europe/Lisbon", "1980-04-01T12:00:00"),
    ("2025a", "America/Asuncion", "2025-04-01T12:00:00"),
    ("2025b", "Asia/Tehran", "1978-11-15T12:00:00"),
    ("2025c", "America/Tijuana", "1970-05-01T12:00:00"),
    ("2026b", "America/Vancouver", "2026-11-01T12:00:00"),
    ("2026c", "Africa/Casablanca", "2026-10-01T12:00:00"),
    ("2026d", "America/Inuvik", "2026-11-01T12:00:00"),
]

PROBE = r"""
import json, sys, zoneinfo, tzdata
from datetime import datetime, timedelta, timezone
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
out = {"version": tzdata.IANA_VERSION, "offsets": []}
for zone, seconds in json.load(sys.stdin):
    instant = EPOCH + timedelta(seconds=seconds)
    out["offsets"].append(int(instant.astimezone(zoneinfo.ZoneInfo(zone)).utcoffset().total_seconds()))
print(json.dumps(out))
"""


def seconds_of(at):
    return int((datetime.fromisoformat(at).replace(tzinfo=timezone.utc) - EPOCH).total_seconds())


out_dir = sys.argv[1]
oracle = json.load(open(os.path.join(out_dir, "timestamp-oracle.json"), encoding="utf-8"))
local = [[row[0], row[1], row[2]] for row in oracle["local"]]

probes = [[zone, seconds_of(at)] for _, zone, at in CANDIDATES] + [[zone, seconds] for zone, seconds, _ in local]
releases = []
for directory in sys.argv[2:]:
    env = dict(os.environ, PYTHONPATH=directory)
    result = subprocess.run(
        [sys.executable, "-c", PROBE], env=env, input=json.dumps(probes), capture_output=True, text=True, check=True
    )
    releases.append(json.loads(result.stdout))
releases.sort(key=lambda release: release["version"])
names = [release["version"] for release in releases]
if len(set(names)) != len(names):
    raise SystemExit(f"two directories hold the same release: {names}")
if names[-1] != oracle["tzdata"]:
    raise SystemExit(f"the newest release installed is {names[-1]}, and the oracle was generated from {oracle['tzdata']}")

sentinels = []
for index, (release, zone, at) in enumerate(CANDIDATES):
    if release not in names:
        raise SystemExit(f"{release} is not among the installed releases {names}")
    position = names.index(release)
    if position == 0:
        raise SystemExit(f"{release} is the oldest release installed, so nothing says what came before it")
    before = releases[position - 1]["offsets"][index]
    after = releases[position]["offsets"][index]
    if before == after:
        raise SystemExit(f"{zone} at {at} does not change in {release}")
    for other in releases[:position]:
        if other["offsets"][index] != before:
            raise SystemExit(f"{zone} at {at} is {other['offsets'][index]} in {other['version']}, not {before}")
    for other in releases[position:]:
        if other["offsets"][index] != after:
            raise SystemExit(f"{zone} at {at} is {other['offsets'][index]} in {other['version']}, not {after}")
    sentinels.append({"release": release, "zone": zone, "at": seconds_of(at), "before": before, "after": after})

stable = []
for index, (zone, seconds, offset) in enumerate(local, start=len(CANDIDATES)):
    offsets = {release["offsets"][index] for release in releases}
    if offsets == {offset}:
        stable.append([zone, seconds, offset])

with open(os.path.join(out_dir, "tz-sentinels.json"), "w", encoding="utf-8", newline="\n") as handle:
    json.dump(
        {
            "$note": "Generated by scripts/generate-tz-sentinels.py. Each entry is an instant at which one IANA tz database release changed a zone's UTC offset, checked against every release installed. Do not edit by hand.",
            "releasesChecked": names,
            "sentinels": sentinels,
        },
        handle,
        indent=2,
    )
    handle.write("\n")

with open(os.path.join(out_dir, "tz-stable.json"), "w", encoding="utf-8", newline="\n") as handle:
    json.dump(
        {
            "$note": f"Generated by scripts/generate-tz-sentinels.py: the timestamp oracle's zone instants whose offset is the same in every tz release from {names[0]} to {names[-1]}. Do not edit by hand.",
            "releasesChecked": names,
            "instants": stable,
        },
        handle,
        indent=2,
    )
    handle.write("\n")

print(f"{len(sentinels)} sentinels; {len(stable)} of {len(local)} oracle instants stable across {len(names)} releases")
