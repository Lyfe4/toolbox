"""Generates the unified-diff oracle fixture from real `git diff`.

`git diff --no-index` is the reference implementation of the unified format
this tool writes. The output is committed; nothing at test time shells out.

Run from the repository root with git on PATH.

Regenerate with:

    python scripts/generate-diff-oracle.py > src/tools/diff/spec/git-unified.json && pnpm format

Prettier reformats the JSON (it collapses the short inner arrays onto one
line), so the format step is part of regenerating rather than an afterthought -
without it `pnpm format:check` fails on a fixture nobody edited.
"""

import json
import os
import subprocess
import sys
import tempfile

# STDOUT IS FORCED TO UTF-8, AND THAT IS NOT A DETAIL.
#
# Python writes `sys.stdout` in the platform's preferred encoding, which on a
# Windows console is cp1252. `ensure_ascii=False` below writes the real
# characters, so on Windows this generator SUCCEEDED and wrote mojibake: the
# `unicode changed` case came out holding a cp1252 byte that is not valid
# UTF-8, exit code 0, and the one case in the fixture that is about non-ASCII
# text no longer contained any. That is the quiet half of the same fault the
# CSV generator has - there it crashes, here it does not.
sys.stdout.reconfigure(encoding="utf-8", newline="")

# (name, original, changed) - written verbatim, in binary, so a line ending is
# whatever the case says it is rather than whatever the platform prefers.
CASES = [
    ("one line changed", "a\nb\nc\n", "a\nB\nc\n"),
    ("one line added", "a\nb\n", "a\nb\nc\n"),
    ("one line removed", "a\nb\nc\n", "a\nc\n"),
    ("everything changed", "a\nb\nc\n", "x\ny\nz\n"),
    ("empty to one line", "", "a\n"),
    ("one line to empty", "a\n", ""),
    ("loses its final newline", "x\na\n", "y\na"),
    ("gains a final newline", "x\na", "y\na\n"),
    ("no final newline either side", "x\na", "y\na"),
    ("two hunks far apart", "".join("l%d\n" % i for i in range(1, 21)),
     "".join(("CHANGED\n" if i in (2, 19) else "l%d\n" % i) for i in range(1, 21))),
    ("two changes inside one context window", "a\nb\nc\nd\ne\n", "a\nB\nc\nD\ne\n"),
    ("change at the first line", "a\nb\nc\nd\n", "A\nb\nc\nd\n"),
    ("change at the last line", "a\nb\nc\nd\n", "a\nb\nc\nD\n"),
    ("crlf against lf", "a\r\nb\r\n", "a\nb\n"),
    ("a blank line added", "a\nb\n", "a\n\nb\n"),
    ("trailing whitespace added", "a\nb\n", "a \nb\n"),
    ("a tab for spaces", "a\tb\n", "a    b\n"),
    ("unicode changed", "café\n", "cafe\n"),
    ("identical", "a\nb\n", "a\nb\n"),
]


def hunks_of(patch):
    """The patch from its first hunk header on, which is the part both write.

    Git appends a "section heading" after the closing @@ - the enclosing
    function it guessed at - which the format allows as an optional extra and
    this tool does not produce. It is removed here rather than tolerated in the
    comparison, so the fixture holds only what both sides claim.
    """
    lines = patch.split("\n")
    start = None
    for index, line in enumerate(lines):
        if line.startswith("@@"):
            start = index
            break
    if start is None:
        return ""

    kept = []
    for line in lines[start:]:
        if line.startswith("@@"):
            end = line.find("@@", 2)
            kept.append(line[: end + 2] if end != -1 else line)
        else:
            kept.append(line)
    return "\n".join(kept)


def git_diff(original, changed, context):
    directory = tempfile.mkdtemp()
    left = os.path.join(directory, "left")
    right = os.path.join(directory, "right")
    with open(left, "wb") as handle:
        handle.write(original.encode("utf-8"))
    with open(right, "wb") as handle:
        handle.write(changed.encode("utf-8"))

    result = subprocess.run(
        [
            "git",
            # autocrlf would rewrite the line endings the case is about.
            "-c", "core.autocrlf=false",
            "-c", "core.safecrlf=false",
            "diff",
            "--no-index",
            "--no-color",
            "--no-ext-diff",
            "-U%d" % context,
            "--",
            "left",
            "right",
        ],
        capture_output=True,
        # RUN FROM THE TEMPORARY DIRECTORY, NOT THE REPOSITORY.
        #
        # `--no-index` still reads the attributes of whatever repository the
        # process is standing in, and this one sets `* text=auto eol=lf`. With
        # the cwd left at the repository root, git normalised both files before
        # comparing them and reported NO DIFFERENCE AT ALL for the case that is
        # entirely about line endings - a fixture recording that a CRLF file
        # and an LF file are the same. The temp directory is not a repository,
        # so nothing is applied to the bytes on the way in.
        cwd=directory,
    )
    # `--no-index` exits 1 when the files differ, which is not an error.
    if result.returncode not in (0, 1):
        raise SystemExit(result.stderr.decode("utf-8", "replace"))
    return result.stdout.decode("utf-8")


fixture = {
    "generator": subprocess.run(["git", "--version"], capture_output=True)
    .stdout.decode("utf-8")
    .strip(),
    "cases": [
        {
            "name": name,
            "original": original,
            "changed": changed,
            "context": context,
            "hunks": hunks_of(git_diff(original, changed, context)),
        }
        for name, original, changed in CASES
        for context in (0, 3)
    ],
}

sys.stdout.write(json.dumps(fixture, ensure_ascii=False, indent=2))
sys.stdout.write("\n")
