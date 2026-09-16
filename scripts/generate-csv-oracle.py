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
    "write": [
        {"name": name, "delimiter": delimiter, "rows": rows, "csv": write_rows(rows, delimiter)}
        for name, delimiter, rows in WRITE_CASES
    ],
}

sys.stdout.write(json.dumps(fixture, ensure_ascii=False, indent=2))
sys.stdout.write("\n")
