# Diff

Compare two texts line by line, with word-level highlighting.

## Two required inputs

This is the first tool with more than one required input, and it is the reason
the node model gained per-port typed input. On the canvas both `original` and
`changed` must be satisfied — by a wire or by typing into the node — before the
node runs; in the runner each port gets its own editor.

Before that change a node held a single `input` string, which would have made
the second port permanently blocked. The migration lives in
`features/canvas/persistence.ts` as `migrateV2ToV3`, and it looks the port id up
from the registry rather than assuming it is called `"input"`.

## The algorithm is not ours

`diff` (jsdiff) does the Myers work. It is maintained, heavily exercised, and
has the awkward parts right: the whitespace comparator, the trailing-newline
cases, the abort options. Writing our own would be an enjoyable afternoon and a
permanent liability.

What this tool _does_ own is the shape of the result. jsdiff returns **runs**
("these six lines were removed"), which is right for producing a patch and
useless for rendering a line-numbered, screen-reader-navigable view. `compute.ts`
expands the runs into **rows**, each knowing its own line number on both sides.

## Case-insensitive comparison

jsdiff's line differ supports `ignoreWhitespace` but not `ignoreCase` — that
option only exists on the character and word differs. So when **Ignore case** is
on, the _structure_ is computed from case-folded copies, and every row's text is
then read back from the original line arrays by line number.

The user sees exactly what they typed. Only the comparison ignored case. There
is a test for precisely this, because "the diff tool silently lowercased my
file" would be an unusually annoying bug.

## Rendering, and why it is JSON

The brief's requirement was that additions and removals are distinguishable
**without colour**, and that the result reads as **structured content** rather
than an undifferentiated wall of text. That rules out a coloured `<pre>`.

So there are two outputs:

- **`output`** — a real unified patch. Portable, pipeable, paste-into-a-review
  text, and what a downstream node receives.
- **`changes`** — the row structure, carrying `presentation: 'diff'`.

`presentation` is a small optional field on `OutputPort`: a hint for the rare
case where the data type does not determine how to draw the value. `DiffView`
reads it and renders:

- an **ordered list**, so a screen reader announces "list, 42 items" and can
  navigate item by item;
- a visually hidden prefix per row — "removed, line 12" — so each row says what
  it is;
- a **sign column** (`+`, `-`, space) that survives greyscale, colour-vision
  deficiency and forced-colors mode;
- `<ins>` and `<del>` for word-level changes, which carry the meaning natively
  and are underlined and struck through rather than merely tinted.

Any consumer that ignores `presentation` still gets valid JSON.

## Word-level refinement

Refinement runs only on a removal run and an addition run of the **same length**,
paired by position. That is the "these lines were edited" case. Two unrelated
blocks of different sizes would produce a meaningless soup of fragments, so the
whole-line form is kept instead.

## Limits

| Limit               | Value  | Why                                                                            |
| ------------------- | ------ | ------------------------------------------------------------------------------ |
| `MAX_ROWS`          | 20,000 | Rendering a hundred thousand list items is how a tab dies.                     |
| `MAX_EDIT_DISTANCE` | 4,000  | Myers is O(ND); two large files with nothing in common are the expensive case. |

Both refuse with a plain message. The edit-distance bound is passed to jsdiff as
`maxEditLength`, so it gives up rather than grinding — and "these two texts have
nothing in common" is a far better answer than the worker timeout's "it took too
long".

## Options

| Option                  | Effect                                                        |
| ----------------------- | ------------------------------------------------------------- |
| Ignore whitespace       | Lines differing only in spacing count as unchanged.           |
| Ignore case             | Comparison folds case; the output does not.                   |
| Highlight changed words | Word-level `<ins>`/`<del>` within edited lines.               |
| Context lines           | Unchanged lines kept either side of each change in the patch. |

## Edge cases handled

- **A trailing newline is a terminator**, not an empty last line: `'a\n'` is one
  line and `'a\nb'` is two. Pinned by a test, because it is the difference
  between a round-trip that holds and one that does not.
- **Nearby changes merge into one hunk**; distant ones get their own `@@`.
- **A hunk that only adds lines** has no old line number of its own, and writes
  a count of zero, which is what unified format specifies.
- **Empty lines** still occupy a row in the view (via a zero-width space) rather
  than collapsing.

## Tests

`diff.test.ts` covers line numbering, both ignore options, refinement pairing,
the two limits, and hunk merging. The property tests are the interesting ones:
reading only the old-side rows must reconstruct the original **exactly**, and
only the new-side rows must reconstruct the changed text exactly. If line
numbering, run pairing or the case-folding indirection is wrong anywhere, that
fails. `DiffView.test.tsx` covers the accessibility requirements directly.
