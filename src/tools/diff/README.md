# Diff

Compare two texts line by line, with word-level highlighting.

- [Two required inputs](#two-required-inputs)
- [The algorithm is not ours](#the-algorithm-is-not-ours)
- [What the comparison normalises, and why it says so](#what-the-comparison-normalises-and-why-it-says-so)
- [Options, and what they actually ignore](#options-and-what-they-actually-ignore)
- [Word-level refinement](#word-level-refinement)
- [Rendering](#rendering)
- [The unified patch](#the-unified-patch)
- [Limits](#limits)
- [Known limitations](#known-limitations)

## Two required inputs

This is the only tool with more than one required input, and it is the reason
the node model gained per-port typed input — and, later, per-port FILE input.
On the canvas both `original` and `changed` must be satisfied — by a wire, by a
file, or by typing into the node — before the node runs; in the runner each port
gets its own editor. Half-wired, the node says **which** port is missing
("Needs Changed"), because "Needs input" is no help when one of the two is
already satisfied.

**Comparing two files is this tool's obvious use and was possible on neither
route.** The tool page has one file control and sends its file to "the first
port that accepts bytes", so the second port could never be given one; the
canvas had no file control at all. The inspector draws one per unwired port, so
`Choose file for Original` and `Choose file for Changed` are two distinct
controls. A file dropped onto a `diff` node deliberately does NOT guess between
them: it selects the node and opens the inspector, because neither port is "the"
one and picking the first would make one of the two comparisons unreachable by
drag. See [a file as an input](../../../docs/architecture.md#a-file-as-an-input).

The 8 MB limit is across both ports, and it is checked when you choose the
second file rather than when you run — so two 5 MB files are refused at the
control, naming what the other port already holds, instead of by the engine
after the fact.

Before that change a node held a single `input` string, which would have made
the second port permanently blocked. The migration lives in
`features/canvas/persistence.ts` as `migrateV2ToV3`, and it looks the port id up
from the registry rather than assuming it is called `"input"`.

Both ports accept `text`, `json` and `bytes`. **`json` is accepted here and
refused by `hash`, and the asymmetry is deliberate.** Comparing two structures
means serialising them, and the indentation that gets picked changes how the
comparison _reads_ rather than whether it is true — where the same choice made
inside a hash tool would change the digest, which is a number people compare
across machines. So "diff two JSON documents" works by wiring
`structured-data`'s `data` port straight in, and "fingerprint a structure" goes
through its `output` port, where the serialisation is an explicit setting.

## The algorithm is not ours

`diff` (jsdiff) does the Myers work. It is maintained, heavily exercised, and
has the awkward parts right. Writing our own would be an enjoyable afternoon and
a permanent liability.

What this tool owns is everything jsdiff has no opinion about:

1. **What counts as the same line** — normalisation, below.
2. **The shape of the result.** jsdiff returns **runs** ("these six lines were
   removed"), which is right for producing a patch and useless for rendering a
   line-numbered, screen-reader-navigable view. `compute.ts` expands the runs
   into **rows**, each knowing its own line number on both sides.
3. **What the comparison threw away**, which is the part that makes it
   trustworthy.

## What the comparison normalises, and why it says so

Every normalisation is a real difference that will not appear as a changed row.
Each one is therefore reported as a fact of its own, in `notes`, and rendered
above the rows. **A diff that answers "identical" about two texts that are not
identical is the worst thing this tool can do, because nobody reports it.**

### Line endings

CRLF and lone CR are collapsed to LF before anything else happens. This is not
an option.

The same file saved on Windows and on Linux used to report **every line** as
removed and re-added, and each `-foo` sat directly above an identical-looking
`+foo` — so the reader could not tell why, and any real change was buried among
thousands of phantom ones. That output is not merely unhelpful; it hides the
answer.

The change is not discarded: `notes.lineEndings` carries what each side uses
(`lf`, `crlf`, `cr`, `mixed`, `none`), and the view says so in a sentence. One
sentence carries strictly more information than ten thousand rows of it.

A lone CR is a terminator too. Left alone, a classic-Mac file is one enormous
line and the diff is useless in a different way.

### The final newline

Splitting into lines discards the difference between a last line with a
terminator and one without, so adding a line to a file no longer reports the
previous line as rewritten. `notes.finalNewline` records both sides, the view
states it, and the unified patch writes `\ No newline at end of file` where it
applies.

### `identical` is not `equal`

Two separate answers, because they are two separate questions:

| Field       | Means                                                              |
| ----------- | ------------------------------------------------------------------ |
| `identical` | The two inputs are the same string, character for character.       |
| `equal`     | The comparison found no added or removed lines, given the options. |

The view says "The two inputs are identical" only for the first, and "No lines
were added or removed" plus the notes for the second.

### Differences you cannot see

A `-café` sitting above a `+café` is the most confusing thing a diff can show.
A row whose counterpart differs from it **only in characters that do not
render** is marked `invisible`, and the view says so in words, because there is
nothing to point at. That covers a BOM, a zero-width space, a combining
sequence against its precomposed form, and a space-lookalike such as a
non-breaking space.

Homoglyphs are deliberately **not** folded. Cyrillic `а` really is a different
letter, and deciding which lookalikes to merge has no correct answer and no end.

Explicit bidirectional formatting controls get their own note. Those characters
reorder the text around them, so a line can render in a different order from the
one it is stored in — the "trojan source" family — and a diff is exactly where
someone is trusting what they see. The row text is also `unicode-bidi: isolate`,
so the reordering cannot escape its cell and rearrange the sign column or the
line numbers. `isolate` rather than `isolate-override`, which would render
genuine Hebrew and Arabic backwards; containment plus a warning, rather than
mangling.

## Options, and what they actually ignore

| Option                  | Effect                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Whitespace              | `Compare it` / `Ignore leading and trailing` / `Ignore all whitespace`.                      |
| Ignore case             | Comparison folds case; the output does not.                                                  |
| Highlight changed words | Word-level `<ins>`/`<del>` within edited lines.                                              |
| Context lines           | Unchanged lines kept either side of each change — in the patch **and** in the rendered view. |

### Why whitespace became a three-way choice

It was a toggle labelled "treat lines that differ only in spacing as unchanged",
and that is not what it did: jsdiff's `ignoreWhitespace` trims each line, so
`foo   bar` against `foo bar` was still a change. Rather than relabel a
half-measure, both behaviours are offered by name, matching what `diff` and
`git diff` offer:

- **Ignore leading and trailing** — indentation and trailing spaces. What people
  usually mean.
- **Ignore all whitespace** — `git diff -w`. Also the one that can hide a real
  change, which is why it is not the default and why the description says so.

Whitespace means the JavaScript definition, which includes the non-breaking
space. A blank line is a line at every setting; `git` needs
`--ignore-blank-lines` for that too, and it is a different question.

Word-level highlighting stops marking whitespace-only fragments under **ignore
all whitespace**, and only there. Under `trailing`, a line differing only in
its leading or trailing whitespace is an unchanged row and never reaches
refinement — so a space change that does reach it is inside the line, where
`trailing` does not ignore it and it really is the change.

The option **key** is still `ignoreWhitespace`, now holding a string. Options
travel in saved canvases and in share links, so renaming it would have dropped
it back to its default and an old link would quietly start comparing whitespace
it was made to ignore. A schema field that reads a little oddly is cheaper than
that.

### The comparison is ours, not jsdiff's

Case and whitespace are applied to a separate **comparison copy** of the text,
and every row's text is read back from the real line arrays by line number. The
user sees exactly what they typed; only the comparison ignored anything. That
indirection already existed for case, because jsdiff's line differ has no
`ignoreCase`; extending it to whitespace means one set of rules to explain
instead of two, and it is the only way to express "ignore all whitespace" at
all.

The comparison text is terminated with a newline. That is load-bearing: without
it, a text whose last line is empty splits back into one line fewer, and the
rows and the line arrays disagree. The misalignment guard below is what found
that — during this hardening pass, in code written the same hour.

## Word-level refinement

Refinement runs on a removal run and an addition run of the **same length**,
paired by position — the "these lines were edited" case. Unequal runs are left
alone; pairing three lines against seven by position produces fragments of
unrelated text.

Same-length runs are not enough on their own, though. `alpha beta gamma` against
`wholly different words here` refines to _every word changed and the two spaces
unchanged_, which reads as "only the spacing survived" — noise presented as
information, and strictly worse than showing the line as replaced. So the
refinement is measured before it is kept: the unchanged material, **ignoring
parts that are only whitespace**, must be at least 30% of the longer line.
Above that a heavily but genuinely edited line still refines; below it, the
whole-line form is kept.

`diffWordsWithSpace`, never `diffWords`. The latter reports common runs using
the _new_ side's whitespace, so the parts of a removed row do not concatenate
back to the removed row. It looks like the tidier API and it silently corrupts
the old side; a property test pins it.

### It is bounded now

Refinement had **no bound at all**, and it is the same O(ND) Myers search over
word tokens. Measured on two dissimilar single lines:

| Line length | Time  |
| ----------- | ----- |
| 2 kB        | 0.4 s |
| 8 kB        | 5 s   |
| 34 kB       | 124 s |

The worker timeout is 20 seconds, so a pair of minified bundles — precisely what
someone pastes into a diff tool — produced "it took too long" from a two-row
line diff. Three bounds now apply:

| Bound                    | Value   | Why                                                          |
| ------------------------ | ------- | ------------------------------------------------------------ |
| `MAX_REFINE_LINE_LENGTH` | 4,000   | A longer line cannot be read word by word anyway.            |
| `MAX_REFINE_EDITS`       | 200     | jsdiff aborts instead of grinding: 42 kB went 124 s → 13 ms. |
| `MAX_REFINE_TOTAL_CHARS` | 400,000 | Per-line bounds do not compose across twenty thousand rows.  |

`maxEditLength` rather than jsdiff's `timeout`: a wall-clock bound would make
the **output** depend on how busy the machine was, which is not something a diff
may do.

The total is decided **once, up front**. A comparison where the first hundred
lines are refined and the rest are not looks like a bug and cannot be explained
to the person looking at it, so refinement is either on for the whole result or
reported as skipped.

## Rendering

The brief's requirement was that additions and removals are distinguishable
**without colour**, and that the result reads as **structured content** rather
than an undifferentiated wall of text. That rules out a coloured `<pre>`.

So there are two outputs:

- **`output`** (Unified patch) — a real unified patch. Portable, pipeable,
  paste-into-a-review text, and what a downstream node receives.
- **`changes`** (Changes) — the row structure, carrying `presentation: 'diff'`.

`Unified patch` is one of two labels in the whole set that deliberately runs
past the 84px label box on a node and takes a tooltip instead. Both output
ports are `text` and `json` respectively, and neither type says which one is
the patch — the word `patch` is information the type cannot carry, so it is
worth the ellipsis.

`presentation` is a small optional field on `OutputPort`: a hint for the rare
case where the data type does not determine how to draw the value. `DiffView`
reads it and renders:

- an **ordered list**, so a screen reader announces "list, 42 items" and can
  navigate item by item;
- a visually hidden prefix per row naming the change, **the side** and the line
  — "removed, original line 12". A removal is numbered in the original and an
  addition in the changed text, so the two are different lines with the same
  number, and the gutters that make that obvious on screen are `aria-hidden`;
- a **sign column** (`+`, `-`, `~`, space) that survives greyscale, colour-vision
  deficiency and forced-colors mode;
- `<ins>` and `<del>` for word-level changes, which carry the meaning natively
  and are underlined and struck through rather than merely tinted;
- the **notes** above the rows, saying what the comparison looked past.

Any consumer that ignores `presentation` still gets valid JSON.

The view also carries a **Raw** toggle, and it is not redundant with the patch.
It was tempting to call `output` the raw form and stop there, but the two are
different serialisations with different losses: the `~` rows, the `oldText` an
ignore-case comparison keeps, and the per-row `parts` the word-level highlight is
built from exist only in `changes`. Until the toggle existed, the only way to
read any of them was to wire the port into another node.

### `~`: unchanged, but not the same

An unchanged row whose two sides are not the same string — what "ignore case"
and "ignore whitespace" produce — gets `~` rather than a space. Its `oldText`
carries the original's version. Without that field a `same` row asserted that
both sides read the way the changed side does, the original's text was
unrecoverable, and the patch emitted context lines that did not match the file
it claimed to patch.

The row displays the **changed** side; the patch writes the **original**. That
is a deliberate difference: the view answers "what does the changed text say",
and a patch has to describe the file it applies to. Both texts are in the JSON.

### Folding

A forty-line file with one changed line was forty rows to scroll past. Runs of
unchanged rows longer than the context window fold into a button that says how
many lines it is hiding and expands in place. The window is the tool's own
`context` option, so "3 context lines" means one thing in the patch and on
screen rather than two; at context 0 every unchanged line folds, which is the
honest reading of asking for no context.

### Why not side-by-side

Considered and rejected. Two columns halve the readable width, which is the one
resource a code diff cannot spare — and a node on the canvas has less of it than
a full page does. More decisively, two parallel columns have no sensible reading
order for a screen reader: the row list is a single sequence, and the two gutters
give both line numbers without the layout cost. Offering it as an option would
mean shipping a mode that is worse on both counts for the sake of familiarity.

## The unified patch

The format `git apply` and every code host understands, so the node can be wired
onward or pasted into a review.

The file headers name no path, because this tool has none. Applying the result
means substituting real names into the `---`/`+++` lines first; **the hunks
themselves are correct as written**, and a test asserts it by applying our own
patches with jsdiff's independent applier.

Two things it used to get wrong:

- **A hunk that touches only one side.** Unified format writes `-N,0` where N is
  the last line before the insertion point, and `0` only at the very start of
  the file. This wrote `@@ -0,0 +7,1 @@` for an insertion in the middle, which
  `git apply` refuses. It only showed up below three context lines, because at
  three every hunk happens to contain a line from both sides — which is why
  nobody noticed.
- **Context lines from the wrong side.** With an ignore option on, the two sides
  of an unchanged row are different strings and only one can appear. It has to
  be the pre-image, or the patch does not describe the file it is a patch for.
  `git diff -w` makes the same choice.

Nearby changes merge into one hunk; distant ones get their own `@@`.

## Limits

| Limit                    | Value   | Why                                                                            |
| ------------------------ | ------- | ------------------------------------------------------------------------------ |
| `maxInputBytes`          | 8 MB    | Both ports combined. Two 4 MB source files is already an unusual comparison.   |
| `MAX_ROWS`               | 20,000  | Rendering a hundred thousand list items is how a tab dies.                     |
| `MAX_EDIT_DISTANCE`      | 4,000   | Myers is O(ND); two large files with nothing in common are the expensive case. |
| `MAX_REFINE_LINE_LENGTH` | 4,000   | See above.                                                                     |
| `MAX_REFINE_EDITS`       | 200     | See above.                                                                     |
| `MAX_REFINE_TOTAL_CHARS` | 400,000 | See above.                                                                     |

`maxInputBytes` stays at 8 MB rather than dropping to something the view could
certainly render, because the row cap gives a _specific_ refusal ("it would
produce 91,204 rows") where a byte cap gives a vaguer one. Both refuse in plain
words rather than freezing.

### And a guard rather than a plausible lie

Every line of each input must appear in exactly one row. If the run lengths and
the line arrays ever disagree, the comparison is discarded with an `internal`
error instead of being rendered — because the alternative is blank rows in the
middle of a file, which looks like data. This is not theoretical: it fired
during development on `""` against `" "` with whitespace trimmed, which is what
led to the terminated comparison text above.

## Known limitations

- **A textarea eats carriage returns.** The browser normalises a textarea's
  value to LF, so text _typed or pasted_ into either route never contains a CR
  whatever the clipboard held. Line-ending differences therefore only arrive via
  a file (read as raw bytes) or a wired upstream node — which is where comparing
  a Windows checkout against a Unix one actually happens, and it is now
  reachable on the canvas as well as on the tool page. Not something this tool
  can change.
- **A trailing-newline-only change has no patch.** The rows are identical, so
  there is no hunk to hang `\ No newline at end of file` on. It is reported in
  `notes.finalNewline` and stated in the view; the patch is empty.
- **`bytes` input strips a BOM, typed text does not.** `TextDecoder` removes a
  leading BOM by default, so the same file compared as a dropped file and as
  pasted text can disagree about its first line. The `invisible` marker is what
  makes the pasted case legible rather than baffling.
- **Runs of unequal length are never refined**, even when they clearly
  correspond. Pairing by position across unequal runs misaligns everything after
  the first difference, and a similarity search across the whole block is a much
  larger algorithm than the value justifies here.
- **Case folding is locale-independent** (`toLowerCase`). `STRASSE` does not
  fold to `straße`. A diff whose answer depends on the reader's locale is worse
  than one that is consistently a little conservative.
- **Comparing against nothing is not possible on the canvas.** A required port
  treats empty typed text as "not yet filled", so "what did I add to an empty
  file" leaves the node blocked. A zero-byte file does not get round it either:
  the port is satisfied, but the comparison is then between two empty documents
  rather than between something and nothing. That is a platform-wide rule about
  required ports, not a decision this tool makes.
- **Two binary files are refused rather than compared.** Both ports accept
  `bytes`, which is what lets two decoded text files be compared — and until
  the [port audit](../../../docs/architecture.md#the-port-set) the bytes were
  decoded leniently, so two PNGs produced a well-formed unified diff of two
  walls of U+FFFD. They now decode strictly, through
  [`lib/text.ts`](../../lib/text.ts), and the refusal names which port it was:
  with two document ports, "those bytes" is not an answer.

## Tests

`diff.test.ts` covers line endings, both ignore options, refinement pairing and
its bounds, the two limits, hunk merging and hunk arithmetic. Several groups
exist because of a specific bug and say so at the top.

The property tests are the interesting ones, and they got stronger during this
pass: reading only the old-side rows must reconstruct the original **exactly**
and only the new-side rows the changed text **exactly**, now with the ignore
options in the generator — which is how the old-text loss stayed green for so
long. Applying our own unified patch with jsdiff's applier must reproduce the
changed text, at every context width. `DiffView.test.tsx` covers the
accessibility requirements, the notes and the folding directly.
