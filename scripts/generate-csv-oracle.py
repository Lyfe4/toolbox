"""Generates the CSV oracle fixture from Python's own `csv` module.

Run with CPython. The output is committed; nothing at test time shells out.

Regenerate with:

    python scripts/generate-csv-oracle.py > src/tools/structured-data/spec/csv-oracle.json && pnpm format

Prettier reformats the JSON (it collapses the short inner arrays onto one
line), so the format step is part of regenerating rather than an afterthought -
without it `pnpm format:check` fails on a fixture nobody edited.
"""

import csv
import io
import json
import sys

# STDOUT IS FORCED TO UTF-8, AND THAT IS NOT A DETAIL.
#
# Python writes `sys.stdout` in the platform's preferred encoding, which on a
# Windows console is cp1252. `ensure_ascii=False` below writes the real
# characters, so this generator crashed there with a UnicodeEncodeError on the
# coffee cup in the `unicode` case - the loud failure, and the lucky one of the
# two generators. A generator has to CHOOSE its encoding rather than inherit
# it, or the regeneration command in the docstring does not produce the
# committed file on the machine somebody runs it from.
sys.stdout.reconfigure(encoding="utf-8", newline="")

# (name, delimiter, source) - the source is exactly what a user would paste.
CASES = [
    ("plain", ",", "name,age\nada,36\ngrace,45\n"),
    ("crlf", ",", "name,age\r\nada,36\r\ngrace,45\r\n"),
    ("lone cr", ",", "name,age\rada,36\rgrace,45\r"),
    ("no trailing newline", ",", "name,age\nada,36"),
    ("quoted delimiter", ",", 'name,note\nada,"one, two"\n'),
    ("quoted newline", ",", 'name,note\nada,"line one\nline two"\n'),
    ("quoted crlf newline", ",", 'name,note\nada,"line one\r\nline two"\r\n'),
    ("doubled quotes", ",", 'name,note\nada,"she said ""hi"""\n'),
    ("quote mid field", ",", 'name,note\nada,a"b\n'),
    ("empty fields", ",", "a,b,c\n1,,3\n,,\n"),
    ("quoted empty last", ",", 'name\n""\n'),
    ("trailing empty field", ",", "a,b,\n1,2,\n"),
    ("leading spaces", ",", "a, b , c\n1, 2 , 3\n"),
    ("unicode", ",", "name,note\nada,café ☕\ngrace,日本語\n"),
    ("emoji", ",", "a,b\n😀,👨‍👩‍👧\n"),
    ("semicolon", ";", "name;age\nada;36\ngrace;45\n"),
    ("tab", "\t", "name\tage\nada\t36\ngrace\t45\n"),
    ("pipe", "|", "name|age\nada|36\n"),
    ("blank line between records", ",", "a,b\n1,2\n\n3,4\n"),
    ("single column", ",", "name\nada\ngrace\n"),
    ("field that is only a quote pair", ",", 'a,b\n"",""\n'),
    ("quoted field containing only spaces", ",", 'a,b\n"  ",x\n'),
    ("ragged long row", ",", "a,b\n1,2,3\n"),
    ("backslash is not an escape", ",", 'a,b\n1,"x\\"\n'),
    ("carriage return inside quotes", ",", 'a,b\n1,"x\ry"\n'),
    ("many quotes", ",", 'a\n""""\n'),
    ("delimiter at line start", ",", "a,b\n,2\n"),
    ("nul byte in a field", ",", "a,b\n1,x\x00y\n"),
    # This tool quotes a field with leading or trailing whitespace where Python
    # does not. These four are here so the test can show the two spellings mean
    # the same thing to a reader that is not ours.
    ("leading space, quoted as this tool writes it", ",", 'a\n" x"\n'),
    ("leading space, unquoted as Python writes it", ",", "a\n x\n"),
    ("trailing space, quoted as this tool writes it", ",", 'a\n"x "\n'),
    ("trailing space, unquoted as Python writes it", ",", "a\nx \n"),
]

# (name, delimiter, source) for the RECORD-SHAPING half.
#
# `csv.reader` answers "what are the fields"; this tool also answers "what are
# the records", which is the step that turns a table into JSON objects and the
# step where it has to decide what a row of the wrong length means. Python's
# closest equivalent is `csv.DictReader`, and it is included here so that the
# two decisions this tool takes differently are held to something rather than
# merely described:
#
#   - A SHORT row. DictReader fills the missing columns with `restval`, which
#     defaults to None. This tool fills them with the empty string.
#   - A LONG row. DictReader collects the extra fields under `restkey`, which
#     defaults to None - a key that has no JSON spelling. This tool refuses the
#     document and names the row.
#
# None is written as null in the fixture, which is exactly the point: it is
# what a JSON document shaped this way would have to contain.
RECORD_CASES = [
    ("even rows", ",", "name,age\nada,36\ngrace,45\n"),
    ("short row", ",", "a,b,c\n1,2\n"),
    ("short row, one field", ",", "a,b,c\n1\n"),
    ("long row", ",", "a,b\n1,2,3\n"),
    ("long row by two", ",", "a,b\n1,2,3,4\n"),
    ("header only", ",", "a,b,c\n"),
    ("present but empty", ",", "a,b\n1,\n"),
    ("duplicate column names", ",", "a,a\n1,2\n"),
    ("empty header cell", ",", "a,,c\n1,2,3\n"),
]

# (name, delimiter, rows) for the writer half.
WRITE_CASES = [
    ("plain", ",", [["name", "age"], ["ada", "36"]]),
    ("needs quoting for delimiter", ",", [["a", "b"], ["one, two", "x"]]),
    ("needs quoting for quote", ",", [["a"], ['she said "hi"']]),
    ("needs quoting for newline", ",", [["a"], ["line one\nline two"]]),
    ("needs quoting for cr", ",", [["a"], ["line one\rline two"]]),
    ("empty field", ",", [["a", "b"], ["", "x"]]),
    ("all empty", ",", [["a", "b"], ["", ""]]),
    ("unicode", ",", [["name"], ["café ☕"]]),
    ("semicolon", ";", [["a", "b"], ["x;y", "z"]]),
    ("tab", "\t", [["a", "b"], ["x\ty", "z"]]),
    ("leading space", ",", [["a"], [" x"]]),
    ("trailing space", ",", [["a"], ["x "]]),
]


def read_rows(source, delimiter):
    reader = csv.reader(io.StringIO(source, newline=""), delimiter=delimiter)
    return [row for row in reader]


def read_records(source, delimiter):
    """What `csv.DictReader` makes of the same document, JSON-shaped.

    `restkey` and `restval` are left at their defaults on purpose: the question
    is what the reference implementation does out of the box, not what it can
    be configured to do.
    """
    reader = csv.DictReader(io.StringIO(source, newline=""), delimiter=delimiter)
    records = []
    for row in reader:
        # DictReader keys the leftovers of a long row under `restkey`, which is
        # None. JSON has no such key, so it is written under the string "null"
        # and the test reads it as "Python put something here that this tool
        # would have to invent a key for".
        records.append({("null" if key is None else key): value for key, value in row.items()})
    return records


def write_rows(rows, delimiter):
    out = io.StringIO(newline="")
    writer = csv.writer(out, delimiter=delimiter, lineterminator="\n")
    for row in rows:
        writer.writerow(row)
    return out.getvalue()


fixture = {
    "generator": "CPython %s, csv module, dialect=excel" % sys.version.split()[0],
    "read": [
        {"name": name, "delimiter": delimiter, "source": source, "rows": read_rows(source, delimiter)}
        for name, delimiter, source in CASES
    ],
    "records": [
        {
            "name": name,
            "delimiter": delimiter,
            "source": source,
            "records": read_records(source, delimiter),
        }
        for name, delimiter, source in RECORD_CASES
    ],
    "write": [
        {"name": name, "delimiter": delimiter, "rows": rows, "csv": write_rows(rows, delimiter)}
        for name, delimiter, rows in WRITE_CASES
    ],
}

sys.stdout.write(json.dumps(fixture, ensure_ascii=False, indent=2))
sys.stdout.write("\n")
