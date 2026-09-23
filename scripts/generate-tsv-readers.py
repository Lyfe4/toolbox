"""Asks nine TSV readers what they make of each spelling of an awkward cell.

SD-6, round thirteen. TSV has no specification beyond the IANA registration of
`text/tab-separated-values`, which forbids a tab inside a field and says
nothing else, so the question "how should a writer spell a cell that holds a
tab, a line break or a quote" can only be answered by asking readers. This
asks nine, and commits what they said. Nothing at test time shells out.

The readers need installing, and deliberately not into this repository:

    python -m venv tsv-venv && tsv-venv/Scripts/python -m pip install pandas polars duckdb
    mkdir tsv-node && cd tsv-node && npm init -y && npm i papaparse d3-dsv && cd ..

Regenerate with:

    tsv-venv/Scripts/python scripts/generate-tsv-readers.py tsv-node > src/tools/structured-data/spec/tsv-readers.json && pnpm format

`awk` and `cut` are taken from PATH - GNU awk and GNU coreutils in Git for
Windows, which is where the committed fixture was measured.

WHAT IS NOT HERE, AND WHY. Excel and LibreOffice would be the most useful two
readers to have and neither can be driven from a script on this machine; the
fixture does not claim anything about them. PostgreSQL's COPY text format and
MySQL's LOAD DATA both define backslash escapes (`\\t`, `\\n`) and would read
the escaped spelling correctly - from their documentation, not from a run, so
they are named in the tool's README and not in this file.
"""

import csv
import io
import json
import os
import subprocess
import sys
import tempfile

import duckdb
import pandas
import polars

sys.stdout.reconfigure(encoding="utf-8", newline="")

NODE_DIR = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else None
if NODE_DIR is None:
    sys.exit("usage: generate-tsv-readers.py <directory with papaparse and d3-dsv installed>")

# (id, the value the cell must read back as, {spelling: the bytes written})
CASES = [
    ("tab", "has\ttab", {"quoted": '"has\ttab"', "backslash": "has\\ttab", "bare": "has\ttab"}),
    ("line break", "line\nbreak", {"quoted": '"line\nbreak"', "backslash": "line\\nbreak"}),
    ("quote inside", 'say "hi"', {"quoted": '"say ""hi"""', "bare": 'say "hi"'}),
    ("leading quote", '"lead', {"quoted": '"""lead"', "bare": '"lead'}),
    ("wrapped in quotes", '"x"', {"quoted": '"""x"""', "bare": '"x"'}),
    ("edge spaces", " pad ", {"quoted": '" pad "', "bare": " pad "}),
    ("backslash", "a\\b", {"bare": "a\\b", "backslash": "a\\\\b"}),
    ("comma", "a,b", {"bare": "a,b"}),
]

NODE_READER = r"""
const { readFileSync } = require('node:fs');
const Papa = require('papaparse');
const which = process.argv[1];
const text = readFileSync(0, 'utf8');
let rows;
if (which === 'papaparse') rows = Papa.parse(text, { delimiter: '\t', skipEmptyLines: true }).data;
else rows = require('d3-dsv').tsvParseRows(text).filter((r) => !(r.length === 1 && r[0] === ''));
process.stdout.write(JSON.stringify(rows.slice(1)));
"""


def document(spelled):
    """A header, then the awkward cell followed by a sentinel column."""
    return "a\tb\n" + spelled + "\tz\n"


def python_csv(text):
    return list(csv.reader(io.StringIO(text, newline=""), dialect="excel-tab"))[1:]


def pandas_read(text):
    frame = pandas.read_csv(io.StringIO(text), sep="\t", dtype=str, keep_default_na=False)
    return [list(row) for row in frame.itertuples(index=False)]


def polars_read(text):
    frame = polars.read_csv(text.encode(), separator="\t", infer_schema=False)
    return [list(row) for row in frame.iter_rows()]


def duckdb_read(text, sniff):
    with tempfile.NamedTemporaryFile("w", suffix=".tsv", delete=False, encoding="utf-8", newline="") as f:
        f.write(text)
        name = f.name.replace("\\", "/")
    try:
        options = "all_varchar=true, header=true" + ("" if sniff else ", delim='\\t'")
        return [list(row) for row in duckdb.sql(f"select * from read_csv('{name}', {options})").fetchall()]
    finally:
        os.unlink(name)


def node_read(which, text):
    run = subprocess.run(
        ["node", "-e", NODE_READER, which], input=text.encode(), capture_output=True, cwd=NODE_DIR, check=False
    )
    if run.returncode != 0:
        raise RuntimeError(run.stderr.decode().strip().splitlines()[-1])
    return json.loads(run.stdout.decode())


def awk_read(text):
    # Fields re-joined with the unit separator, which no case contains.
    out = subprocess.run(
        ["awk", "-F\t", 'NR>1{ s=$1; for(i=2;i<=NF;i++) s = s "\037" $i; print s }'],
        input=text.encode(),
        capture_output=True,
        check=False,
    ).stdout.decode()
    return [line.split("\x1f") for line in out.split("\n") if line != ""]


def cut_read(text):
    # `cut -f1` prints the first field of every line; the sentinel is ignored,
    # so the verdict is whether the first field of the one data line is right.
    lines = subprocess.run(["cut", "-f1"], input=text.encode(), capture_output=True, check=False).stdout.decode()
    first = lines.split("\n")[1:]
    if first and first[-1] == "":
        first = first[:-1]
    return [[field, "z"] for field in first]


READERS = {
    "python-csv": python_csv,
    "pandas": pandas_read,
    "polars": polars_read,
    "duckdb": lambda text: duckdb_read(text, False),
    "duckdb-sniffed": lambda text: duckdb_read(text, True),
    "papaparse": lambda text: node_read("papaparse", text),
    "d3-dsv": lambda text: node_read("d3", text),
    "awk": awk_read,
    "cut": cut_read,
}


def verdict(read, value):
    return "ok" if read == [[value, "z"]] else "wrong"


def versions():
    node = lambda pkg: json.loads(open(os.path.join(NODE_DIR, "node_modules", pkg, "package.json"), encoding="utf-8").read())["version"]
    first = lambda cmd: subprocess.run(cmd, capture_output=True, check=False).stdout.decode().splitlines()[0]
    return {
        "python": sys.version.split()[0],
        "pandas": pandas.__version__,
        "polars": polars.__version__,
        "duckdb": duckdb.__version__,
        "papaparse": node("papaparse"),
        "d3-dsv": node("d3-dsv"),
        "awk": first(["awk", "--version"]),
        "cut": first(["cut", "--version"]),
    }


cases = []
for case_id, value, spellings in CASES:
    measured = {}
    for spelling, written in spellings.items():
        text = document(written)
        answers = {}
        for name, reader in READERS.items():
            try:
                answers[name] = verdict(reader(text), value)
            except Exception:  # noqa: BLE001 - a reader that throws has not read it
                answers[name] = "error"
        measured[spelling] = {"written": written, "readers": answers}
    cases.append({"id": case_id, "value": value, "spellings": measured})

json.dump({"versions": versions(), "readers": list(READERS), "cases": cases}, sys.stdout, ensure_ascii=False, indent=2)
sys.stdout.write("\n")
