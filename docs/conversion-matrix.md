# The conversion matrix

Every conversion this app performs, in every direction, with a verdict and the
evidence behind it.

It exists because the failure that matters here is not a crash. It is a
converter handing back a document that looks exactly like the one you asked
for and is not — and that failure is invisible to a green test suite, because
the tests were written by reading the code and agreeing with it. So the column
that carries the weight in every table below is **Evidence**, and "a test
passes" is not an entry in it.

- [What the verdicts mean](#what-the-verdicts-mean)
- [What counts as evidence](#what-counts-as-evidence)
- [Structured data](#structured-data)
- [Text convert](#text-convert)
- [Base64](#base64)
- [Hash](#hash)
- [JWT](#jwt)
- [Colour](#colour)
- [Diff](#diff)
- [Regex](#regex)
- [Image](#image)
- [Video](#video)
- [The canvas: one node's failure reaching another](#the-canvas-one-nodes-failure-reaching-another)
- [The canvas: what a wire does to a value](#the-canvas-what-a-wire-does-to-a-value)
- [The seven decisions, taken](#the-seven-decisions-taken)
- [Where a loss is said](#where-a-loss-is-said)
- [Where a loss travels](#where-a-loss-travels)
- [What the count was, and is](#what-the-count-was-and-is)
- [Markdown to HTML, relabelled](#markdown-to-html-relabelled)
- [What changed for a person pasting a document](#what-changed-for-a-person-pasting-a-document)
- [Found this round](#found-this-round)
- [What was looked for and not found](#what-was-looked-for-and-not-found)
- [Found in round four, by breaking things on purpose](#found-in-round-four-by-breaking-things-on-purpose)
- [Found in round five, by asking something outside this repository](#found-in-round-five-by-asking-something-outside-this-repository)
- [Found in round six, by reading the appendix list](#found-in-round-six-by-reading-the-appendix-list)
- [Still unverified, and how to verify it](#still-unverified-and-how-to-verify-it)

## What the verdicts mean

| Verdict                    | Means                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **exact**                  | The output is the one an external reference gives for the same input. Nothing is lost.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **exact, from a suite**    | The same, where the external reference is a published TEST SUITE rather than a specification. Round six introduced it: no RFC publishes a vector for RS384, RS512, PS256, PS512 or ES384, and Project Wycheproof does. Ranked below a specification and said out loud, because a suite encodes one project's view of what an implementation should do and occasionally that is not the same thing.                                                                                                                                                                                                                                        |
| **exact, below the token** | The same, where the published vector is not a JWS at all - a key, a message and a signature. Also round six: nothing published is a JWS for HS384, HS512 or ES384, so what is settled is the algorithm table those three depend on and NOT the token handling around it, which the nine vectors that are tokens settle instead.                                                                                                                                                                                                                                                                                                           |
| **lossy, told**            | Something cannot survive the conversion, the loss is intentional and consistent, **and the user is told without doing anything** — on the panel on `/tools` AND on the canvas node. A port that has to be wired up to be read does not count; see [Where a loss is said](#where-a-loss-is-said), and [Where a loss travels](#where-a-loss-travels) for what a node DOWNSTREAM of the loss is told. **Since round nine this verdict is DERIVED rather than written**: where a loss is in the corpus, a cell may say it only when a case proves it. See [The corpus, the ratio](#the-corpus-the-ratio-and-why-it-is-not-a-number-any-more). |
| **lossy, silent**          | The same, except nobody is told. This is a defect, whatever the reason for the loss.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **broken**                 | The output is wrong, for input a person would realistically produce.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **not verified**           | It may be right. Nothing outside this repository has said so.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

`lossy, silent` is deliberately not a comfortable category. **It is not empty,
and every claim that it was has turned out to be wrong.** The column held
nothing at the end of round three because every loss anybody had named was told;
asking a different question found two more. It held nothing again from round
four to round seven; round eight ran every conversion and read its report port,
and found seventeen — five of them in cells this document was carrying as
`lossy, told`.

So the column is no longer described by a word. It is measured, as a ratio over
a committed corpus, by a test that runs every case: see
[The corpus, the ratio](#the-corpus-the-ratio-and-why-it-is-not-a-number-any-more)
for the number and for what it is worth.

It held twelve cells at the end of round two, and round three's job was to take
the seven decisions that would close most of them. The count, cell by cell, is
in [What the count was, and is](#what-the-count-was-and-is); the short version
is that four of the twelve turned out to be **fixable** rather than merely
reportable, seven are now `lossy, told` through a channel that did not exist
before, and the twelfth — the diff's line endings — became an option as well as
a note, so the case where the patch was a lie is now reachable rather than only
described.

**A told loss is one a person SEES.** Not one that is available on a port they
could wire up: this round added a `report` output to four tools, and a report
port is drawn on `/tools` and invisible on a canvas node, where a node
summarises its first output and nothing else. So the node reads the report too
and prints what was lost on its own face, and both halves are asserted in two
real engines rather than in jsdom. See
[Where a loss is said](#where-a-loss-is-said).

Seven cells that were **broken** at the start of round one are marked
`fixed this round` there; none of them was failing a test. Round two added two
more, both on the canvas rather than inside a conversion. Round three's own
`fixed` cells are marked `fixed in round three`, so the three rounds stay
distinguishable in one table.

## What counts as evidence

Ranked, best first. The rank is what decides whether a cell says `exact` or
`not verified`.

1. **An external reference run as an oracle.** A published test suite, an RFC's
   own vectors, or another implementation's output, committed as a fixture. The
   fixtures are generated by scripts in [`scripts/`](../scripts) and checked
   in, so the suite needs neither Python nor git at test time and a change to
   either side shows up as a diff in review.

   **A specification's vectors outrank a suite's, and round six is where that
   started to matter.** A standards document publishes what the format IS; a
   suite publishes what one project believes an implementation should do with
   it, which is usually the same thing and occasionally not — Project
   Wycheproof marks five correctly computed signatures invalid, on a key-policy
   rule this tool's input cannot express. So where both exist the RFC is used
   and the suite is not, that ordering is applied per algorithm rather than per
   tool, and a suite's own files are pinned to a commit and hashed so that
   "published" means a fixed set of bytes rather than whatever is on `main`.

2. **An independent instrument inside the repository.** A second implementation
   of the inverse operation, written not to share a line with the thing it is
   checking, and validated against the oracle before being trusted. The patch
   applier in [`unified.oracle.test.ts`](../src/tools/diff/unified.oracle.test.ts)
   is the example: it is run over git's own patches first.
3. **The platform's own answer.** `String.prototype.matchAll` for the regex
   listing; `TextDecoder` for UTF-8.
4. **An exhaustive sweep.** Only available where the input space is small
   enough — all 16,777,216 sRGB colours, for instance.
5. **A hand-written expected value.** The weakest, and the reason this document
   exists. Where a cell rests on one, it says `not verified`.

Two things are explicitly **not** evidence here, because both have been wrong
in this repository before:

- **A round trip.** `A → B → A` passes just as happily when both directions are
  wrong in mirror-image ways. Every round-trip assertion in this document is
  accompanied by an independent check of `B`.
- **"It parsed" or "it did not throw".** Every broken cell found this round
  parsed, returned success, and produced a plausible-looking document.

## Structured data

[`src/tools/structured-data`](../src/tools/structured-data). Source format is
auto-detected unless you say otherwise; the target is always explicit.

### Reading

| From  | Verdict                                 | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CSV   | **exact**                               | 32 documents read by CPython's `csv.reader` and by this parser, field for field, including a lone CR terminator, a NUL byte, a quote opening mid-field, a field of four quotes, CRLF inside a quoted cell and every delimiter offered. [`csv.oracle.test.ts`](../src/tools/structured-data/csv.oracle.test.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| TSV   | **exact**                               | Same corpus, tab delimiter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| JSON  | **lossy, told**                         | Structure and strings are exact — it is `JSON.parse`. **Integers past 2^53 are rounded**, which is unavoidable, and each one is now reported by path. See [Numbers](#numbers-past-253-unavoidable-and-no-longer-silent). **A key written twice is resolved last-wins** before this tool sees the document — RFC 8259 permits it and leaves the behaviour undefined — and from round twelve the discarded value is reported by path (corpus row 12). It is a note rather than a refusal, which is the opposite of what the YAML reader does with the same shape, because YAML 1.2 makes a duplicate key an error and JSON does not: refusing it would make this tool the odd one out on a file every other reader opens. **A syntax error's position is the same in every engine from round sixteen.** It was read out of the engine's message, and over 2,165 refused documents Gecko's message has a position every time, V8's 72% of the time and JavaScriptCore's **never** - so on the tool page Safari showed no line or column for any JSON syntax error, and Chrome none for a trailing comma in an array or a misspelled `true`. `locateJsonSyntaxError` finds it against RFC 8259's grammar and is held to Gecko's offset on all 2,165 and to V8's wherever V8 gives one, except inside a misspelled keyword, where the two engines disagree and this follows Gecko ([`jsonSyntax.test.ts`](../src/lib/jsonSyntax.test.ts), [`spec/json-syntax-oracle.json`](../src/lib/spec/json-syntax-oracle.json)). Drawn with the same line and column in Firefox and WebKit, in `check:browsers`. |
| JSONC | **exact**, against VS Code's own parser | `//` and `/* */` comments and trailing commas are removed before parsing, and the document is read as the author meant it. 25 documents are compared against `jsonc-parser` — the parser Visual Studio Code uses for its own settings files — value for value, including every case that decides whether a stripper tracks string state: a `//` inside a URL, a `/*` inside a glob, an escaped quote in front of a comment marker. [`jsonc.oracle.test.ts`](../src/tools/structured-data/jsonc.oracle.test.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| YAML  | **exact**, with 9 named exceptions      | 402 cases from the [yaml-test-suite](https://github.com/yaml/yaml-test-suite)'s own `data-2022-01-17` release, committed as [`spec/yaml-test-suite.json`](../src/tools/structured-data/spec/yaml-test-suite.json). 94 documents the suite marks as errors are all refused, **and round four asks what each one was refused FOR**: 92 by the parser, 2 by this file's own directive rules, 0 by the empty-input rule, and the counts are asserted. 279 carry the value a conforming parser must produce and **270 of them match exactly — 258 before round three**. The 9 that do not are listed by id with a reason, each is asserted to **still** differ, and the 12 that were fixed are asserted to **now agree**. [`yaml.oracle.test.ts`](../src/tools/structured-data/yaml.oracle.test.ts) **An explicit `!!float` on an integer spelling is a float, from round thirteen** - `!!float 1` read as the string `"1"`, because the library resolves an explicit tag with its implicit tests; YAML 1.2.2's core float grammar, verbatim, is now the tag's test. A value its standard tag cannot be - `!!float abc`, `!!int 1.5` - is refused by line and column rather than becoming text; js-yaml refuses the same.                                                                                                                                                                                                                                                                                                                                                                             |

### Writing

| To   | Verdict                                                                   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON | **exact**                                                                 | `JSON.stringify`. Subject to the same integer ceiling on the way in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| YAML | **fixed in round five**, with three named differences                     | Every document the tool can read from the yaml-test-suite is re-serialised and read back by **js-yaml**, and — new in round five — by **CPython’s PyYAML**, committed as [`spec/yaml-writer-pyyaml.json`](../src/tools/structured-data/spec/yaml-writer-pyyaml.json). The second reader found what one reader could not: eleven documents came out with a **raw tab inside a plain scalar**, which PyYAML 6.0.3 and ruamel.yaml 0.19.1 both refuse at the scanner — the whole document, not the value — and which js-yaml reads without complaint. Those are quoted now. What is left is 32 of 284, in three groups named and asserted in [`yaml.writer.pyyaml.test.ts`](../src/tools/structured-data/yaml.writer.pyyaml.test.ts): a root-level block scalar at column 0 (PyYAML alone refuses it; `yaml`, js-yaml and ruamel read it), the same with an explicit indentation indicator (the readers split two and two), and three where PyYAML resolves YAML **1.1** timestamps and sexagesimals. NAT4 remains js-yaml’s own limit, asserted as itself. |
| CSV  | **exact**, with two stated spellings                                      | 12 record sets written by CPython's `csv.writer` and by this writer, byte for byte. Two deliberate differences, each asserted as itself: no terminator after the last record (RFC 4180 permits both), and a field with leading or trailing whitespace is quoted where Python leaves it bare — the oracle was asked to read both spellings and returned the same field for each.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| TSV  | **exact** for every cell TSV can spell; **lossy, told** for one it cannot | The CSV corpus with a tab delimiter, for the reader half. For the writer, TSV has no specification to be exact against, so round thirteen asked nine readers - Python's csv, pandas, polars, DuckDB twice, Papa Parse, d3-dsv, awk, cut - and committed their answers as [`spec/tsv-readers.json`](../src/tools/structured-data/spec/tsv-readers.json). The writer is held to it by [`tsv.readers.test.ts`](../src/tools/structured-data/tsv.readers.test.ts): for every case, its spelling is read correctly by as many readers as any spelling measured. A cell holding a tab or a line break is quoted (7 of 9; no spelling reaches awk or cut) and **reported** - corpus row 19. A backslash escape is read by 0 of 9 and is not used. A quote inside a cell or spaces at its edges are written bare, which 9 of 9 read and quoting cost two of.                                                                                                                                                                                                     |

### Between formats

Every conversion is read into the same value model and written back out of it,
so the cell is the combination of the two halves above plus what the target
format cannot hold. See
[the value model, and `YAML → YAML`](#the-value-model-and-yaml-yaml) for what
that route costs and why the cost was accepted.

| From → To                     | Verdict                  | What is lost, and whether you are told                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON → YAML                   | **exact**                | Nothing. Key order is preserved unless `sortKeys` is on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| YAML → JSON                   | **lossy, told**          | Comments, anchors, tags and the choice of block style are not JSON and are dropped. **Said, from round twelve**, as one note whose title is a census — `Not carried over: 2 comments, 1 anchor, 1 tag, 2 block styles` — with each instance named in the body and the anchor described as **expanded** rather than dropped, which is what actually happens to it. This cell read `lossy, told` from round three to round eight with no builder for such a note anywhere in the tool; corpus rows 4 to 7 are what make the claim measurable rather than written. Anything JSON genuinely cannot hold — a `!!binary`, a `!!set`, a collection used as a key, a 1.1 timestamp — is **refused by path**, not mangled, and that half was always true.                                                                                                                                                                                                                                                                |
| JSON/YAML → CSV/TSV           | **lossy, told**          | Three losses, all real and all now reported **by path**: a nested value becomes compact JSON inside the cell (`$[0].user`); a key absent from one row becomes an empty cell indistinguishable from a present-and-empty one, and the columns are named; and every value becomes text. A non-array, or an array of non-objects, is refused clearly. [`reports.test.ts`](../src/tools/structured-data/reports.test.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| CSV/TSV → JSON/YAML           | **lossy, told**          | Every cell becomes a **string**, deliberately — `01234` is a part number, not the number 1234 — and the tool's README states it. Line endings inside quoted cells survive verbatim. An unquoted header cell has its leading and trailing spaces removed, which is the right decision and was made in silence until round twelve; it is reported now, with the cell shown quoted so the spaces are visible (corpus row 11).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| YAML → YAML                   | **lossy, told**          | Not a distinguished path, decided in round eleven: it goes through the same value model as every other cell. A comment, an anchor, a tag and a **folded** scalar are dropped and said (corpus rows 8 and 9, round twelve); a key that is a number, a boolean or null becomes text and is said, by key and by path (row 10). A **literal** block scalar survives this cell — measured against the writer, `lit: \|` in and `lit: \|` out, chomping included — and is deliberately not reported, except where its value has no line break left in it or it is used as a key, which are the two places it does not survive. `.nan`, `.inf`, `!!binary`, `!!set`, `!!omap` and a 1.1 timestamp are **refused**, by path and by line, in a message that names the model rather than naming JSON. A **flow collection** - `a: {b: 1}` - comes back as a block and is said, as a fifth kind in the same census (corpus row 20, round thirteen); a document written entirely in flow is JSON-shaped and is not counted. |
| YAML stream → YAML            | **exact**                | **Fixed in round three.** A `---`-separated stream is written back as a stream, with a `---` in front of each document. It used to come back as a **sequence**, so a Kubernetes manifest that went through this tool was a file `kubectl` will not read, silently. The report says which of the two happened, and says it from the WRITER rather than from the source — `sortKeys` and a value arriving on the `json` port can both put a different array in front of it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| YAML stream → JSON/CSV/TSV    | **lossy, told**          | None of the three has a document separator, so the documents become the elements of an array — which is the only JSON-representable form of a stream, and is still a file that does not convert back. Reported, with the count and with "choose YAML as the target to keep the stream". JSON Lines in is the same fact and gets the same note.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| An empty document in a stream | **fixed in round three** | Found by the yaml-test-suite in round two. `---` STARTS a document and an empty one is `null`; dropping it made a five-document stream come back as a four-element array with no error. Three references agree about the same bytes — the suite's PUW8, js-yaml 5.4.2, and CPython's PyYAML 6.0.3, each asked directly. The rule is now "an empty document with no `---` to declare it", which keeps the case it was really for: an empty input box still says "nothing to parse" rather than producing `null`. Twelve of the twenty-one suite divergences were this one rule.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Anything → CSV                | **lossy, told**          | The output has no terminator after the last record and uses LF, whatever the input used. RFC 4180 specifies CRLF; every reader accepts LF. Reported at `info` on every CSV write — nothing is lost, the table reads back identically, and the fact matters exactly when the next step is a byte comparison or a digest, which on this canvas is one wire away.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Anything → TSV                | **lossy, told**          | The same LF note, and one more: a cell holding a tab or a line break has no TSV spelling, is written in quotes, and is reported with the readers that cannot read it. See the Writing table.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### Detection

| Input                                                                                               | Verdict                  | Note                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON, YAML, CSV, TSV, semicolon, `sep=`                                                             | **exact**                | Named regression tests, each from a document that was previously read as the wrong format.                                                                                                                                                                                                                                                                                                                                 |
| Near-JSON: single quotes, unquoted keys, trailing commas                                            | **exact**                | Read as the document the author meant, through the YAML fallback.                                                                                                                                                                                                                                                                                                                                                          |
| Near-JSON: `//` comments, block comments, a literal newline in a string, a key split over two lines | **fixed this round**     | Were **broken**: the YAML fallback folded lines and produced a plausible object. Now reported as the JSON syntax error they are.                                                                                                                                                                                                                                                                                           |
| Prose, a ragged CSV, a log                                                                          | **fixed this round**     | Were **broken**: folded into one string with the line breaks replaced by spaces, reported as success. Now refused.                                                                                                                                                                                                                                                                                                         |
| A one-column CSV                                                                                    | **refused, stated**      | Round thirteen, SD-1's real gap. It has no delimiter, and "several lines of one field each" is also prose, a log and a word list, so a signal for it would claim everything. Auto-detect refuses it and the refusal says to choose CSV, which reads it. Recorded as known limitation 14 in the tool README.                                                                                                                |
| Two lines of text with one comma each                                                               | **fixed in round three** | Was **broken**: `tags: a, b` over `names: c, d` was read as a one-row table with the columns `tags: a` and `b`. The fix is not a higher bar — "three records or it is not a table" refuses a header and one row, which is a real file — but a different question with an answer: does this also parse as a YAML **mapping**? A genuine CSV folds to a plain scalar. Five realistic tables are asserted to still be tables. |
| Whatever was detected                                                                               | **fixed in round three** | The tool now says which format it decided on, which delimiter it used, and whether it guessed at all, on a `Detected` report port drawn on `/tools` and summarised on the canvas node.                                                                                                                                                                                                                                     |
| Twenty-nine realistic documents                                                                     | **exact**                | Committed as [`spec/detection-corpus.json`](../src/tools/structured-data/spec/detection-corpus.json): the document, the format it is detected as, and the value it reads to. Round one ran a corpus of this shape and did not write it down; this one is a fixture so the next round can re-run it. See [What changed for a person pasting a document](#what-changed-for-a-person-pasting-a-document).                     |

### The value model, and `YAML → YAML`

**Taken in round eleven, and taken as a decision rather than as a fix.** SD-2
and SD-5 report that `a_nan: .nan` is refused on a `YAML → YAML` run with the
message _"`$.a_nan` is NaN, which JSON cannot represent"_, and that a key of
`2024:` comes back as `"2024":`. Both are real. The question they raise is
whether `YAML → YAML` is a distinguished path in this tool.

**It is not, and it was not made one.** Every source here is read into one value
model and every target is written out of it:

| The model holds | The model does not hold                                             |
| --------------- | ------------------------------------------------------------------- |
| text            | `NaN`, `Infinity`, `-Infinity`                                      |
| finite numbers  | dates, binary, sets, ordered maps                                   |
| `true`, `false` | a key that is not text — a number, a boolean, null, or a collection |
| `null`          | a comment, an anchor, a tag, a choice of scalar style               |
| lists, maps     | anything two of which would become one thing                        |

That model is `JsonValue`, and it is not this tool's private business: it is the
payload of the `json` data type every port in the app is typed against, so it is
what the `data` port carries, what a wire carries, and what the run cache is
keyed on. Carrying `.nan` from a YAML reader to a YAML writer needs either a
**second value model that only this one path uses** — two tools wearing one
name — or a **wider `JsonValue`**, which reaches the canvas, the cache key and
`checkConnection` for a case that arises only when the source and target formats
happen to be the same. Neither is a misplaced check, and neither was taken.

**What was wrong was the message, and it has been replaced.** Being told that
JSON cannot represent something on a run where you chose neither JSON as the
source nor JSON as the target is confusing in a way that has nothing to do with
the actual limitation. Three things changed:

| Before                                                | Now                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| `$.a_nan is NaN, which JSON cannot represent.`        | `$.a_nan is NaN, which this tool's value model cannot hold.`       |
| No position at all — a path, and nothing else         | A line and column, at the **value**, not at the key in front of it |
| The first offender only — six `.nan` values, six runs | Every one of them, listed to ten, counted past it                  |

The detail under it says what the model holds, says that the boundary is
deliberate rather than a fault in the document, points at the tool's README, and
— where a pair of quotes really is the way through — says so. The way through is
**asserted rather than offered**: the test that checks the sentence also converts
the quoted document.

**And the loss that is not a refusal is now told.** A key that is a number, a
boolean or null is stringified rather than refused, because a scalar key cannot
collide silently — `collidesAsJsKey` already refuses `1:` beside `"1":`. That
left the only honest thing to do about it being to say it, and nothing did. It
is corpus row 10, and it turns this round: `1 key became text`, naming the key
as its author wrote it and the map it sits in, on `/tools` and on a canvas node.

**What did not change, and is the round-twelve work.** A comment, an anchor and
a scalar style are still dropped in silence on a `YAML → YAML` run. Those are
corpus rows 8 and 9, and they are notes nobody has written rather than a
boundary anybody decided.

### Numbers past 2^53, unavoidable and no longer silent

`{"id": 12345678901234567890}` converts to `{"id": 12345678901234567000}`.

JSON's grammar puts no limit on a number's digits; JavaScript has one numeric
type and it is a double. So `JSON.parse` rounds, and every port downstream
carries the rounded value. A 64-bit database key, a Discord or Twitter
snowflake, a nanosecond timestamp: all of them come back as a different number.
The rounding cannot be avoided in a JavaScript program. Being quiet about it
could be, and is not any more:

> **2 numbers were rounded.** JavaScript has one numeric type and it is a
> double, so an integer past 2^53 cannot be held exactly. 12345678901234567890
> became 12345678901234567000. At `$.id`, `$.ok`. Quoting it in the source —
> `"12345678901234567890"` — keeps every digit, because a quoted scalar is read
> as text, and the YAML output then holds it as a string.

**THAT LAST SENTENCE USED TO BE FALSE, AND IT WAS THE ADVICE.** It read
_"Convert to CSV or TSV to keep the digits, where every cell stays a string"_,
appended whatever the target was. SD-13 filed it as JSON-specific advice
appearing on a non-JSON target, which understates it: **the rounding happens in
the reader**, so no choice of target can undo it, and following the advice
exactly produces the rounded number in a CSV cell. Measured, and now a named
test:

| Source                             | Target | Output                        |
| ---------------------------------- | ------ | ----------------------------- |
| `[{"id": 12345678901234567890}]`   | CSV    | `id` / `12345678901234567000` |
| `[{"id": "12345678901234567890"}]` | CSV    | `id` / `12345678901234567890` |

The second row is the advice that replaced it. Quoting the number in the source
makes it text before the parser can round it, which is true of every target —
and what the output then looks like is not, so the target is threaded into the
read half and the sentence ends differently for a table than for a document.

**THE QUESTION IS ASKED OF THE LITERAL, NOT OF THE VALUE**, and that is the
whole of why the report can be believed. The obvious implementation walks the
parsed document and reports every integer for which `Number.isSafeInteger` is
false — and it is wrong: `9007199254740994` is 2^53 + 2, which no
`isSafeInteger` accepts and which a double holds exactly. A report that names a
number that was never rounded is the same class of confident wrongness this
whole document exists to remove. So each integer literal in the SOURCE is
tested with `BigInt(literal) !== BigInt(Number(literal))`, which is exact and
decides every one of them.

It is gated on a run of sixteen digits, because 2^53 has sixteen and every
shorter integer survives — so a 16 MB document with no such number is walked
once, by one regular expression.

Three readers, one answer: JSON through a scanner over the source
([`lib/jsonNumbers.ts`](../src/lib/jsonNumbers.ts)), YAML through the library's
own scalars, and the JWT tool through the same scanner over the claims. CSV and
TSV have no ceiling at all, because every cell comes out as a string — which is
a fact about CSV as a **source**, and was for four rounds printed as advice
about CSV as a **target**.

**And "three readers, one answer" was two readers and two answers**, which round
four found by asking the two of them the same question. `yamlPath` walks the
ancestors `visit` hands it and pairs each one with the NEXT, so the last
ancestor — the node's own parent — had nothing to pair with and its step was
dropped. For a map that is invisible, because a Pair always stands between a
scalar and the map above it. For a **sequence** the item _is_ the child, and the
index went missing:

| The same two numbers, in        | Reported at  |
| ------------------------------- | ------------ |
| `[12345678901234567890, 9…9]`   | `$[0], $[1]` |
| `- 12345678901234567890\n- 9…9` | **`$, $`**   |

One path, twice, for two different numbers, from the report whose whole claim is
that it says **which**. Fixed, and the two readers are now asserted to give the
same paths for the same document — which is the assertion that would have caught
it, and is stronger than either reader's own expected values.

## Text convert

[`src/tools/text-convert`](../src/tools/text-convert). Markdown and HTML are
sources; Markdown, plain text and TWO HTML targets — sanitised and normalised —
are the destinations. Everything routes through HTML.

| From → To                                 | Verdict                                                        | Evidence, and what is lost                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown → HTML                           | **lossy, told**                                                | CommonMark 0.31.2, 624 of 652, and GFM, 21 of 24, compared by parsed DOM — and **624 of 652 is not what `exact` means**, which is what this cell used to claim. Every one of the 28 differs because this tool will not copy raw HTML through, and that refusal is the product. It is now reported: the same chain is run with the allow-list off and the two documents compared, so the note names what was really removed rather than what a schema suggests. See [Markdown to HTML, relabelled](#markdown-to-html-relabelled).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| HTML → Markdown                           | **lossy, told**                                                | **The census arrived in round ten.** This cell read `lossy, told` from round three on the strength of the `unsupported` option being on the panel — which is a control the user SETS, not a report of what happened, and three findings were silent behind it: a `<caption>` dropped, a table cell's list flattened, an empty header row invented. The reason recorded in `normalisation.ts` — "for Markdown there is nothing to compare" — is true of a Markdown SOURCE and was being applied to the target. For an HTML source there are three documents, and the third was already being computed for the `rendered` port: `markdownToHtml(output)` is exactly what the `html` target calls normalising. So this target now carries the same measured census the HTML targets do, at no extra conversion. Corpus rows 13, 14 and 15. The `unsupported` option is still the control, and it is still on the panel. **From round sixteen the census counts what a reader can SEE, not what a tag is called** - see the four rows at the end of this table. Three notes this cell has carried as `lossy, told` since round ten were false on hand-written HTML: a `<pre>` with no `<code>` told a `<code>` was invented, and a bare `<span>` and a `<div>` wrapper told they could not be carried. None draws a difference in any of three engines. |
| HTML → plain text                         | **lossy, told**                                                | All markup, by definition. The options say what happens to links, list markers and tables.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Markdown → plain text                     | **lossy, told**                                                | Same.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Markdown → Markdown                       | **lossy, told**                                                | Normalisation through HTML. Three constructs do not survive and each is named: footnotes stop being footnotes (a reference becomes a link to an anchor, the definitions a `## Footnotes` section), `$$…$$` display maths becomes a fence tagged `math`, and a bare URL becomes an explicit link when `linkify` is on. Reformatting — a different bullet, a different heading style — is reported at `info`, because the document means the same thing and a warning on every run is one nobody reads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| HTML → HTML (sanitised)                   | **lossy, told**                                                | **New in round three.** The sanitiser and nothing else: no Markdown round trip, so nothing is invented. What the allow-list removes is reported, measured by comparing the two documents rather than by listing the schema. **A class name the schema filters out of a `class` it keeps is reported from round thirteen** - `<a class="btn">` becomes `<a class="">`, which a census of names could not see for eight rounds (corpus row 16). `reversed` on `<ol>` now survives. **Round sixteen: the element note gave a false reason for three elements the list permits.** A link whose address is refused is unwrapped a step after the sanitiser, an image whose source is refused becomes its alt text, and the Google Docs `<b style="font-weight:normal">` is unwrapped before it - and each was reported as "is not on the allowed list", which it is. The note now names only what the list refuses, checked against the schema, and a refused link or image says what happened to it (`1 link became plain text`).                                                                                                                                                                                                                                                                                                                       |
| HTML → HTML (normalised)                  | **lossy, told**                                                | The pass that used to be called "HTML". It runs through Markdown, so it is bounded by what Markdown can express, and the two halves now answer separately: input against sanitised is the allow-list’s doing, sanitised against normalised is the round trip’s. Measured: `<img width>` is dropped, a `colspan` becomes an empty cell, and a `<table>` with no header **gains an empty header row that was not in the input**, reported as an invention — naming `<tr>` and `<th>` rather than the `<thead>` the serialiser writes on its own account, which is a round-ten correction to a note that had been false for six rounds. See the two rows below. **This cell used to list "a `<div>` is unwrapped" among the losses, and for a `<div>` that draws nothing that note was false** - it is unwrapped, and no engine draws the document any differently. Round sixteen: elements are compared by what they render as (`rendering.ts`), held to three engines by the pasted-HTML corpus; a `<div>` that aligns or hides something is still counted.                                                                                                                                                                                                                                                                                          |
| An `id` the author wrote                  | **lossy, told**                                                | **New in round four.** Every `id` and `name` this tool writes is prefixed `user-content-`, so markup pasted into a page cannot shadow a global. That is deliberate and worth keeping; it was also invisible, because `compareMarkup` counts names and `id` is present on both sides. It is a `warn` note now, naming each one, and a slug the tool INVENTED is not reported. See [An identifier, and a link to nothing](#an-identifier-and-a-link-to-nothing).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A link to a heading                       | **fixed in round four**                                        | Was **broken**, in the normalised target only. Markdown has no spelling for a heading's id, so the round trip drops it and `rehypeSlug` invents a new one from the heading's TEXT — while the link that pointed at the old name is carried through untouched. Measured: `<h2 id="location">Where</h2>` with a link to `#location` comes back as `<h2 id="user-content-where">` and `href="#user-content-location"`, which is in no document anywhere. One `id` in, one `id` out; one `href` in, one `href` out. Reported now.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Detection                                 | **fixed this round**                                           | Was **broken** for the single most common thing an LLM writes about HTML: `Use \`<div>\` here.` was detected as HTML, **confidently**, because the tag search ran over the document as written. The conversion then read the code span's contents as markup. Fenced blocks and inline code spans are now blanked out before the search, and only before that search — a fence is still a Markdown signal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Hard break → text                         | **fixed this round**                                           | Was **broken**: Markdown's hard break (two trailing spaces, or a trailing backslash) became `<br>` plus a newline, and the text renderer emitted both, so a line break came out as a blank line. The same `<br>` written without the newline came out correctly, so one construct had two answers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `rendered` port                           | **exact**                                                      | Always sanitised HTML, for every source and target. Asserted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| A table cell with block content           | **fixed in round ten**                                         | Was **broken**, and it produced a document that renders wrongly with nothing to say so. `<td><ul><li>one</li><li>two</li></ul></td>` emitted a literal newline inside the row, and a newline ENDS a GFM row — so the table stopped at that cell and the rest re-parsed as prose. A `<pre>` in a cell was worse: three extra rows and an empty code block tagged `\|`. Byte-identical under all three `unsupported` values, which is the sharper form of the finding and is now asserted: `unsupported` is about elements with no Markdown spelling and a list has one. The bound came from the finding itself — `<td>a<br>b</td>` was always `\| a b \|`, because the serialiser's break handler asks `patternInScope` whether a newline is legal in the construct it is in. The cell is flattened to real phrasing before any block handler is reached, so the content survives joined by a space and the STRUCTURE is what goes, which is what the census reports. Swept: 156 cell documents, none of which produces a line inside a row.                                                                                                                                                                                                                                                                                                         |
| A `<thead>` the serialiser wrote          | **corrected in round ten, by a rule since round sixteen**      | The invention note was **false** on the commonest shape of hand-written table there is. `<table><tr><th>h</th></tr>` parses with its row inside an implied `<tbody>` and no `<thead>`, and every table this tool writes has a `<thead>` — so the census saw an element appear and the note said the table had gained an empty header row. It had not. Shipped on `HTML → HTML (normalised)` since round four, and found by extending the census to the Markdown target. Round ten filtered the two names out of the report as a list; **round sixteen replaced the list with rule 5 of `rendering.ts`** - a row group draws nothing CSS would not draw anyway - and the pasted-HTML oracle confirms it in three engines (`table-header-row-as-tr`). The header-row EXPLANATION is still conditional on `<tr>` or `<th>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `<mark>`, `<kbd>` under Keep the text     | **fixed in round thirteen**                                    | Was **broken** under the default policy, labelled _Keep the text, drop the tag_: `<mark>` became `_emphasis_` and `<kbd>`, `<samp>`, `<var>` became code spans, because the policy registered no handlers and upstream substitutes for seven elements on the list. Each now becomes its words and the census names the element that went (corpus row 17, re-specified - see test-findings).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A reversed list                           | **lossy, told**                                                | Round thirteen, TC-3. `reversed` is content - it decides the numbers shown - so the sanitiser keeps it. CommonMark numbers a list upward, so on the Markdown and normalised targets the list counts up, and the note says that rather than only naming the attribute (corpus row 18).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| A bold `<b>`, an italic `<i>`             | **corrected in round thirteen, by a rule since round sixteen** | The census reported `<b>` as not carried and `<strong>` as invented on every document with a bold word, since round four on the normalised target. Round thirteen filtered four respellings as a list; **round sixteen counts by the HTML Standard's rendering rule instead** (`b, strong`, `cite, dfn, em, i, var`, `code, kbd, samp, tt`, `del, s, strike`, `ins, u` - rule 1 of `rendering.ts`), so `<b>` becoming `<strong>` is no change and `<b>` becoming nothing still is. Round thirteen's tests are unchanged and still pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| A `<pre>` with no `<code>`                | **corrected in round sixteen**                                 | The note was **false**: `<pre>one⏎two</pre>` comes back from Markdown as `<pre><code>`, and the census said `1 element was invented: <code>`. `code` asks for a monospace font inside a box that already has one, and no engine draws a pixel differently (pasted-HTML oracle: `pre-without-code`, `pre-with-spans`, GitHub's rendered README and both browsers' clipboard copies of a highlighted block). Rule 3 of `rendering.ts`: a rule already in effect is not counted. Shipped on both round-trip targets since round four.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| A bare `<span>`, a `<div>` wrapper        | **corrected in round sixteen**                                 | Both notes were **false**: "`<span>` could not be carried" on every paste from Google Docs, Word, Outlook, a highlighter or a browser's own clipboard, and "`<div>` could not be carried" on every wrapper. A `<span>` has no rendering at all and a `<div>` is `display: block` and nothing else; unwrapping either draws nothing different in any of three engines unless the `<div>` is what keeps two lines of text apart, which rule 4 of `rendering.ts` decides from the tree. **Measured on the pasted-HTML corpus before the fix: 22 of 71 documents carried an element note with no difference any engine could see, and 26 named an element nobody could see go. After: 0 and 0.** An attribute such an element carried - `dir`, `lang`, `class` - is still reported, by name, by the attribute census.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Loose text put in a paragraph             | **corrected in round sixteen**                                 | Was a `warn`: `<p> was invented by the round trip`, on the node's face. Whether that `<p>` can be SEEN depends on its neighbours' margins - invisible after a heading at the end of a document (`heading-then-bare-text`) or inside a `<blockquote>`, sixteen pixels in front of a `<div>` and eight at the top of a document, in all three engines - and a census cannot see neighbours without a tree diff. So the claim was weakened to the one the census supports: an `info`, `Loose content was put in a paragraph`, saying the paragraph's space shows "wherever its neighbours do not already have as much". Never on a node's face. Round fifteen judged the blockquote case a visible margin change; the three engines say otherwise, because the paragraph's margins collapse into the quotation's.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A link or image whose address was refused | **corrected in round sixteen**                                 | Was reported as "`<a>` is not on the allowed list" - a false reason for a true loss, because `<a>` is on it and its `javascript:` address is not. `1 link became plain text` and `1 image was replaced by its alt text` now say what happened, and the `href`, `src` or `alt` those two account for is not repeated in the attribute note. Negative controls: a kept link, a relative one, an anchor with no `href` and a kept image each say nothing about links or images; across the whole pasted-HTML corpus the count said matches a DOM count of the links that lost their address.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Two properties hold the round trip honest where a byte comparison cannot:
`md → html → md → html` is asserted **stable**, and `html → text` is asserted
**idempotent**. Both have found real bugs.

## Base64

[`src/lib/base64.ts`](../src/lib/base64.ts).

| Direction                   | Verdict         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| bytes → base64              | **exact**       | RFC 4648 §10 vectors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| base64 → bytes              | **exact**       | The same vectors read backwards, added this round — the decoder had only round trips through this encoder, which cannot tell a matched pair of mistakes from a correct pair.                                                                                                                                                                                                                                                                                                         |
| base64url → bytes           | **exact**       | Same, with and without padding. Both alphabets decode without the caller saying which.                                                                                                                                                                                                                                                                                                                                                                                               |
| text → bytes → base64       | **exact**       | UTF-8 via `TextEncoder`, so every code point survives — including astral characters, which `btoa` cannot encode at all.                                                                                                                                                                                                                                                                                                                                                              |
| Non-canonical trailing bits | **lossy, told** | `QQ==` and `QR==` both decode to `A`: the unused bits of the last character are ignored rather than required to be zero. RFC 4648 §3.5 permits either, and most decoders do what this one does — so the bytes are right and `base64 → bytes → base64` is not the identity on the TEXT. The decode now names the character as written and the canonical spelling of the same bytes, on a `Report` port, which matters because the input is usually a signature somebody is comparing. |

## Hash

[`src/tools/hash`](../src/tools/hash).

| Algorithm | Verdict   | Evidence                                                                                                                                                  |
| --------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MD5       | **exact** | RFC 1321 appendix A.5, all seven vectors, plus a chunking property under `fast-check`. This is the one hash implemented here rather than by the platform. |
| SHA-1     | **exact** | FIPS 180-4 examples: empty, `abc`, and the 448-bit message.                                                                                               |
| SHA-256   | **exact** | Same three.                                                                                                                                               |
| SHA-384   | **exact** | FIPS 180-4 examples, added this round — there was a length assertion and nothing else, which every wrong answer of the right size satisfies.              |
| SHA-512   | **exact** | Same.                                                                                                                                                     |
| → hex     | **exact** | Covered by the vectors above, which are hexadecimal.                                                                                                      |
| → base64  | **exact** | The same encoder the base64 tool uses, held to RFC 4648.                                                                                                  |

## JWT

[`src/tools/jwt-decode`](../src/tools/jwt-decode).

| Operation                                                          | Verdict                                | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Decode header and payload                                          | **exact**                              | RFC 7515 appendix A.1, added this round: the published header and payload, decoded to the values the RFC prints.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| HS256 verification                                                 | **exact**                              | The same appendix's key and signature. Verified, and reported invalid when one character of the signature or of the payload changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| RS256, ES256 and ES512 verification                                | **exact**                              | RFC 7515 appendices A.2, A.3 and **A.4**. Round five recorded this RFC as publishing vectors for HS256, RS256 and ES256 'and for nothing else'; A.4 is a fourth, on curve P-521, and round six added it. The RFC gives its keys as JWKs and this tool takes SPKI PEM, so the conversion is CPython's `cryptography` in [`scripts/generate-jws-oracle.mjs`](../scripts/generate-jws-oracle.mjs), which refuses to write a fixture unless CPython **and** Node's WebCrypto both reach the published verdict for every case and both reject every valid signature with one bit flipped. Two curves rather than one also sharpens the key-swap control: P-256 into the ES512 path and P-521 into the ES256 path must each fail to import, which a curve table naming one curve for both would survive.                                                                                                                                                                 |
| PS384 verification, and a second source for RS256, ES512 and HS256 | **exact**                              | RFC 7520, the JOSE cookbook, sections 4.1 to 4.4. 4.1 and 4.2 sign the same payload with the **same RSA key**, one PKCS#1 v1.5 and one PSS - the only control anywhere in this repository that isolates the padding, because checking each token under the other's algorithm can fail for no other reason: the key imports, the hash exists, the length is right.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| HS384 and HS512 verification                                       | **exact, below the token**             | RFC 4231's HMAC-SHA-384 and HMAC-SHA-512 vectors, test cases 1, 2, 6 and 7. **These are not JWS** - a key, a message and a MAC - because no published JWS or JWT vector for either algorithm exists, in RFC 7515, in the cookbook or in Wycheproof. What was unverified was one entry each in `HASH_FOR`, and the RFC publishes all three MACs over the same key and the same message, so each vector is also checked under the other two algorithms. That isolates the table and nothing else. Token splitting does not vary by hash and is settled by the nine vectors that are tokens.                                                                                                                                                                                                                                                                                                                                                                          |
| RS384, RS512, PS256 and PS512 verification                         | **exact, from a suite**                | Project Wycheproof's JWS vectors, pinned to a commit and hashed so a regeneration from different bytes fails rather than drifts. A published test suite rather than a specification - no RFC publishes a vector for any of these four - and taken only for the algorithms no RFC covers, each group in full rather than sampled. Its negatives are the reason to reach for it: 42 PS256 cases with a modified salt, mask, hash or padding, and `alg: none` in two spellings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ES384 verification                                                 | **exact, below the token**             | Wycheproof's P-384/SHA-384 IEEE-P1363 ECDSA vectors, first group in full - 88 valid and 58 invalid. Not JWS, for the same reason as HS384: nothing published is. P1363 is the fixed-width r&#124;&#124;s encoding JWS itself uses, and the messages are ASCII digit strings, so each vector goes through `verifySignature` unchanged. A P-384 key handed to the ES256 or the ES512 path must not import at all, which is what isolates `CURVE_FOR`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| The whole pipeline, per algorithm                                  | **HS256, RS256, ES256 and PS256 only** | `run` decodes before it verifies and `decodeToken` requires a JSON payload, because RFC 7519 requires a JWT's payload to be one. **Almost every published JOSE example is a JWS and not a JWT**: A.4 signs the ASCII string `Payload`, the cookbook signs a line of Tolkien, Wycheproof signs `foo`. Four published vectors have a payload that parses as JSON - RFC 7515 A.1, A.2 and A.3, and Wycheproof's two PS256 salt cases, whose payload `123400` happens to - and those four run end to end in Gecko and WebKit through the tool's own worker and verdict banner, with a tampered token, a key of another kind and a different key of the same kind as controls. For the other eight, each engine is asked directly whether it reaches the published verdict under the parameters the fixture records - which is what would catch an engine with no RSA-PSS, no P-384 or no P-521, in which the tool would say `unverified` on a token CI calls verified. |
| The JWK `alg` constraint                                           | **not implemented, stated**            | Five Wycheproof cases are correctly computed signatures that the suite publishes as **invalid**, because the JWK they were made with carries an `alg` that restricts the key (RFC 7517 section 4.4). This tool's key input is an SPKI PEM, which carries a key and no policy at all, so it verifies them and says so. This was not designed in - the generator's agreement gate found it and stopped - and the gate now requires both verifiers to find these cryptographically **valid** before writing them, so the disagreement is known to be this one rather than an unexplained failure.                                                                                                                                                                                                                                                                                                                                                                     |
| `alg: none`                                                        | **exact**                              | Refused outright, as its own status.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Large numeric claims                                               | **lossy, told**                        | A `sub` or `jti` that is a 64-bit integer is rounded by `JSON.parse`, the same loss as [structured data’s](#numbers-past-253-unavoidable-and-no-longer-silent) and asked the same exact way. Reported by path on a `Report` port; the decoded claims and the signature verdict are unchanged, because the signature is checked against the bytes the rounding never touched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Colour

[`src/tools/color-convert`](../src/tools/color-convert).

| Direction                                  | Verdict                       | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| hex ↔ rgb                                  | **exact**                     | Integer quantised both ways. Every colour in a fixed stride through the whole cube.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| sRGB ↔ HSL                                 | **exact**                     | Exact to the 8-bit step from one decimal place.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| sRGB ↔ OKLCH                               | **fixed this round**          | Was **broken** for 13,626 colours. All 16,777,216 were written as `oklch()` and read back at each precision: 3 places lost 3,532,330 colours, **4 places lost 13,626**, 5 places lost none. The default was four. The 13,626 are saturated cyans and teals with the red channel pinned at zero — `#00bec7` wrote as `oklch(0.729 0.1239 200.83)` and read back `#01bec7` — which is the corner a 266-colour corpus is least likely to contain. The default is five.                                                                                                                                                                                                                                                                                                                                                                                    |
| `hsl(h s l)` with bare numbers             | **fixed this round**          | Was **broken**: CSS Color 4 says a bare number in `hsl()` means that many percent, so `hsl(217 91 60)` is `hsl(217 91% 60%)`. It was read as a 0–1 fraction, clamped, and came back **white**. It is the spelling every Tailwind theme and every CSS custom property holding three numbers uses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| A percentage where a hue belongs           | **fixed this round**          | Was **broken**: scaled by 360, so `hsl(50% 100% 50%)` silently became 180deg. A hue is `<number> \| <angle>` in every notation here; a percentage is now refused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Named colours, `color()`, `lab()`, `hwb()` | **lossy, told**               | Refused by name, with the supported notations listed. Deliberate — resolving names means shipping the 148-entry CSS table.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Out-of-gamut OKLCH                         | **fixed in round nine**       | Was **lossy, silent**, and this cell said `lossy, told` for five rounds while nothing was wired. `oklch(0.7 0.4 150)` came back as `#00d600` — lightness up 0.06, chroma down 35%, hue moved 7.5° — with no warning anywhere, and the clipped colour drove the contrast table too, so a designer asking whether a wide-gamut colour passes AA got an answer about a different colour. `oklchToRgb` had computed `inGamut` correctly since `e56bd2f` and `parseColor` destructured it away; the tool had no `report` port for it to reach. Both now exist. Corpus row 1.                                                                                                                                                                                                                                                                                |
| Out-of-range `hsl()`                       | **fixed in round nine**       | Was **lossy, silent** and unnamed here. `hsl(361, 110%, -5%)` is black, silently: the clamping is CSS-correct and the silence is the defect, because somebody who typed `-5%` for `5%` gets black rather than a dark red with nothing to say why. The note names the components it clamped and the colour that came out. The hue is deliberately NOT among them — 361 is 1 exactly, in CSS and here, so naming it would be a note about a loss that did not happen. Corpus row 2.                                                                                                                                                                                                                                                                                                                                                                      |
| Out-of-range `rgb()`                       | **fixed in round nine**       | The same defect on the notation people type most often, found in round eight while reproducing the `hsl()` one: `rgb(300 -20 50)` is `#ff0032`, silently. Same note, same control. Corpus row 3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Contrast against black and white           | **fixed in round nine**       | Was **broken** for any translucent colour: `#aabbccdd` reported 10.69:1 and 1.96:1, byte-identical to opaque `#aabbcc`, because `relativeLuminance` has no alpha parameter and nothing composited before calling it — wrong for exactly the colour somebody opens a contrast checker to ask about. Alpha is now composited onto each row's background first, source-over on the gamma-encoded channels, which is what the platform's own compositor does: `check:browsers` paints the same colour over the same backdrop on a real 2D canvas in Firefox and WebKit and reads the pixel back. **It changes numbers people may have recorded, so the table says so on screen**: the caption names the compositing and the line under it names both composited colours. Opaque colours are untouched, because at `a === 1` the composite is the identity. |
| `rgb(50% 50% 50%)`                         | **fixed in round three**      | 50% is exactly 127.5, which the payload used to keep — so hex printed `#808080` while oklch printed the value for 127.5, and the report’s own rows described colours one 8-bit step apart. `rgb()` is quantised once, at the parse, because that is what a browser does: `getComputedStyle` on `color: rgb(50% 50% 50%)` returns `rgb(128, 128, 128)`, which is asserted in both engines in `check:browsers` rather than taken on trust. `hsl()` and `oklch()` are continuous in CSS and are not touched.                                                                                                                                                                                                                                                                                                                                              |
| A red that drifted to 359.98               | **decided in round thirteen** | `#ff0000` through `oklch()` at five places reads back at HSL hue 359.984, beside a hex of `#ff0000`. The hue now prints as 0 when the colour, quantised as its own hex is, has hue exactly 0 - half an 8-bit step either side, 0.118° for a saturated red. A typed `hsl(359.98 …)` snaps too, which is the cost of any tolerance; no 8-bit colour moves, asserted over a stride of the cube.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

The OKLCH matrices themselves were checked against the published sRGB corners:
red is `oklch(0.628 0.258 29.23)`, green `oklch(0.866 0.295 142.5)`, blue
`oklch(0.452 0.313 264.05)`. All three match Ottosson's reference values.

## Diff

[`src/tools/diff`](../src/tools/diff).

| Output                                    | Verdict         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unified patch, at the default setting     | **exact**       | 38 patches from real `git diff --no-index` at two context widths, committed as [`spec/git-unified.json`](../src/tools/diff/spec/git-unified.json). **32 are byte-identical**, re-measured in round three against the regenerated fixture — round one reported the same 32 while the unicode case was corrupted, so the number was not safe until it had been measured again. Of the remaining six, four differ in the order of the lines inside one hunk and two are the line-ending disagreement below.                                           |
| Unified patch, with line endings compared | **exact**       | **38 of 38, byte for byte, including all six.** Every one of the six differs for one reason: with terminators normalised away, a last line with a newline and the same line without one are the SAME line, so git pairs the rows one way and this pairs them another. Set `Line endings: compare` and this tool writes the patch git writes for the whole corpus. That is the strongest single number in this document, and it only became measurable when the option existed.                                                                     |
| Unified patch, meaning                    | **exact**       | All 38 reproduce the changed file exactly when applied, by a patch applier written for the test and validated against git's own patches first. The four that are spelled differently are the terminator cases, where git groups removals then additions and this groups each line with its replacement; both were given to real `git apply`, which produced the right bytes for each.                                                                                                                                                              |
| Line endings                              | **lossy, told** | An option, `ignore` or `compare`, defaulting to `ignore` — which is what this tool has always done, because a file that has been through a Windows editor otherwise comes back entirely red. What was wrong was that the other case was unreachable and unsaid: two files differing only in their terminators compared **equal** and the patch was the **empty string**, which is the one answer that means the files are the same. The fact now travels WITH the patch, as a note after the last hunk.                                            |
| The note on the patch                     | **exact**       | Placed after the hunks rather than before them, and that was measured: real `git apply` skips a leading comment only when the file headers are `a/`-prefixed, and this tool’s name no path — with a comment in front of them git reports `unable to find filename in patch at line 2` where the same patch without it applies. A note after the last hunk parses identically to no note at all in both header styles, and a patch carrying one was applied by real `git apply` and produced the right bytes.                                       |
| Final newline                             | **exact**       | Reported, and carried into the patch by rewriting the last line as itself — which is what `git diff` does.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Invisible differences                     | **lossy, told** | A row whose two sides differ only in a BOM, a zero-width space, a combining sequence or a non-breaking space is flagged `invisible`, because two identical-looking lines are the most confusing thing a diff can show. A trailing carriage return joins them when line endings are compared, which is what keeps that option from producing `-foo` above `+foo` with nothing to say why.                                                                                                                                                           |
| A byte order mark                         | **lossy, told** | A pasted document keeps its `\uFEFF` and the comparison sees it. A dropped FILE loses it to the decoder before this tool is called, so two files differing only in one compared equal — one pair of documents, two answers, depending on how they arrived. The comparison is deliberately NOT changed: this tool is the instrument `wireFidelity.integration.test.ts` uses to measure what a wire does to a value, and an instrument that silently corrects one of the things it measures is not one. The tool reports it instead, from the bytes. |
| Bidi controls                             | **lossy, told** | Reported, and each row is isolated so the reordering cannot escape its cell.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Word-level refinement                     | **lossy, told** | Skipped above a size, and the skip is reported rather than being indistinguishable from "nothing to refine".                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Regex

[`src/tools/regex-tester`](../src/tools/regex-tester).

| Operation                        | Verdict         | Evidence                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Match listing                    | **exact**       | Asserted equal to `String.prototype.matchAll` — the specification's own answer to the same question — across a matrix of patterns, flags and subjects, and again under `fast-check`.                                                                                                                                                |
| Replacement                      | **exact**       | `String.prototype.replace` does the substitution, so `$1`, `` $` ``, `$'`, `$$` and `$<name>` are the engine's rules rather than a reimplementation of them.                                                                                                                                                                        |
| Truncation                       | **lossy, told** | The listing stops at a limit and says so, and the **count outlives the listing** so a truncated list does not misreport how many there were.                                                                                                                                                                                        |
| Catastrophic backtracking        | **lossy, told** | The worker is terminated and replaced, and the tool says what happened.                                                                                                                                                                                                                                                             |
| A byte order mark in the subject | **lossy, told** | U+FEFF is invisible, is a character, and sits in front of position 0 — so `^` followed by anything else does not match at the start and there was nothing to say why. Named as a `warn`. A BOM further into the subject is deliberately not named: it does not explain an anchored pattern failing, and claiming it would be noise. |

## Image

[`src/tools/image-convert`](../src/tools/image-convert). Decoding and encoding
are the browser's; what this tool owns is the header inspection, the limits and
the report.

| Conversion                | Verdict         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PNG ↔ WebP (lossless-ish) | **lossy, told** | Re-encoding always. Pixel fidelity measured on decoded pixels in two real engines.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| → JPEG                    | **lossy, told** | Quality option, and transparency matted onto white with a note.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Animated GIF → still      | **lossy, told** | Note on the result, repeated in the summary line.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| EXIF, GPS, colour profile | **lossy, told** | Stripped, and the report says what was removed — which in an app whose pitch is that your data does not move is the note that most needed making.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Orientation               | **exact**       | Honoured by both engines, asserted on decoded pixels.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Downscaling               | **exact**       | Round five. There is still no specification for `drawImage`, so the reference is built rather than found: a 4× reduction of a pattern of flat 64×64 blocks, downscaled offline by Pillow, with the generator **measuring** which of the 4096 output pixels box, bilinear, Hamming and Lanczos all agree about — 2927 — rather than arguing that they must. On those, both engines are within **one level** and WebKit is exact. The tolerance is two, and it is carried by a control: nearest-neighbour sits 128 levels away on the same pixels, and that control is asserted, so a tolerance loosened until it passed would take the control with it. See [`scripts/generate-resample-oracle.mjs`](../scripts/generate-resample-oracle.mjs). |

## Video

[`src/tools/video-remux`](../src/tools/video-remux). A container change, never a
re-encode.

| Conversion                    | Verdict             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MKV/MOV/TS/AVI → MP4          | **lossy, told**     | Every coded picture is the encoder's own, byte for byte; the framing around it is rewritten and the result says so.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Recording location and date   | **lossy, told**     | Warned on the result and asserted on the output bytes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Rotation                      | **exact**           | The track header's transform is carried, which a rebuilt header would have dropped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Codecs an MP4 cannot carry    | **lossy, told**     | Refused by name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Playback of the produced file | **exact, in Gecko** | Round five, and it is the sentence this document has carried since the tool landed. A real x264 clip — twelve frames, one flat colour each, encoded once by ffmpeg and committed as [`spec/playback.json`](../src/tools/video-remux/spec/playback.json) — goes through the whole product, and the output and the source are both decoded by the engine and compared frame by frame. Identical, all twelve. The comparison is source against output **in the same engine**, because Gecko and ffmpeg disagree about the YUV-to-RGB matrix and that is a decoder's business; what a remuxer must not change is anything. |
| The same, in WebKit           | **not verified**    | Playwright's WebKit on Windows answers `probably` to `canPlayType` for H.264 and then refuses every H.264 file it is given, **including the source clip ffmpeg wrote**. The control runs first for exactly this reason, and the check records an honest skip naming it rather than a failure. Settling it needs Safari itself, which is [docs/manual-checks.md](manual-checks.md)'s job.                                                                                                                                                                                                                               |

## The canvas: one node's failure reaching another

A `lossy, silent` cell is a value that changes. This is the other kind of
wrongness a canvas can have: a node that reports a failure it did not cause.

| Case                                      | Verdict              | Evidence                                                                                                                                                                       |
| ----------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A node beside one that runs away          | **fixed this round** | Was **broken**, and not on a slow machine — on an idle one, 10 runs out of 10 in both engines. See [The bystander](#the-bystander-a-node-failing-for-something-it-did-not-do). |
| A node downstream of that node            | **fixed this round** | Reported `upstream` for the same reason, on every one of those runs.                                                                                                           |
| A node whose own tool really did run over | **exact**            | Reports `timeout` with the tool's own message, and the worker is destroyed. Unchanged.                                                                                         |

### The bystander: a node failing for something it did not do

Round one saw three WebKit checks fail under CPU load — an unrelated `base64`
node reporting `error` after 29,370 ms — and could not tell a harness artefact
from a product defect. It is settled, by measurement rather than by a re-run.

**It is the app.** And the 29,370 ms was the harness's own polling budget, not
a latency: the node's real time to failure is 3.5–5 s.

**It is not about slow machines.** What decides it is whether two edits fall
more than 300 ms apart, which is `RERUN_DEBOUNCE_MS` — in other words, whether
a person types into one node and then into another the way people do. CPU load
only widens the gap; it does not create it.

What was measured, in Gecko and JavaScriptCore, with the message traffic on the
worker port recorded:

| Condition                                    | Bystander           | Posts to a worker                   |
| -------------------------------------------- | ------------------- | ----------------------------------- |
| Idle, two edits as fast as a driver can type | `ok` in ~2.4 s      | regex, base64, base64               |
| 16 busy processes on 16 cores                | `error` 7 / 16      | regex, regex, base64, regex, base64 |
| **Idle, 800 ms between the two edits**       | **`error` 10 / 10** | regex, regex, base64, regex, base64 |

The mechanism, from the recording. The second edit cancels the first run; a
cancelled run is deliberately not cached, so the new run **re-posts the
runaway**. Two copies of it are now queued. The first copy's deadline destroys
worker one and the base64 request is replayed onto worker two; the replayed
runaway wedges worker two, and its death finds the base64 request already
`retried` and fails it with _"This run was interrupted before it could
finish."_ The worker never sent a `started` for that request at all — it had
not executed one instruction.

The fix is in the replay budget, and it is a change of question rather than of
number: the cap now counts **starts, not replays**. A request the worker never
began cannot be the poison the cap exists to contain, so a neighbour's
misbehaviour no longer spends it. A request that did run and was killed anyway
still gets one further attempt and then reports. Measured after: 10 of 10 `ok`
in both engines, in 3.7 s, with the bystander posted three times and started
once.

Held by [`engine.test.ts`](../src/features/execution/engine.test.ts), which was
checked to fail against the old rule, and by two new checks in
`cross-browser-check.mjs` that put the 800 ms pause in on purpose.

## The canvas: what a wire does to a value

A value does not go through a text form between two nodes. It moves as a typed
`ToolValue` — a structured clone across the worker boundary, or the same object
on the main thread — so there is no serialisation step to lose anything in.

That is what the code says. What follows is what an instrument says.

| Link type | Verdict   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`    | **exact** | Sixteen payloads sent along a wire and compared, by the diff tool, against the same string typed into the receiving node the way a person types into the box on `/tools`. CRLF, a lone CR, mixed endings, a missing final newline, a tab, trailing spaces, a run of blank lines, a NUL, an astral character, a zero-width joiner, a combining sequence, a non-breaking space, a right-to-left override. Six negative controls — the smallest possible change to each — come back as differences. [`wireFidelity.integration.test.ts`](../src/features/execution/wireFidelity.integration.test.ts) |
| `bytes`   | **exact** | The same file's bytes reach twelve consumers across several waves, and a cached buffer is still usable on the next run. Buffers are borrowed rather than transferred on the canvas, exactly so that one output feeding several inputs cannot detach.                                                                                                                                                                                                                                                                                                                                              |
| `json`    | **exact** | The parsed structure crosses as a structured clone and is asserted equal at the far end.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `color`   | **exact** | A parsed colour hops between nodes as a payload, which is the whole reason the type exists — it avoids a round trip through text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### The wire against the clipboard

The other half of the question: does wiring `A → B` give what copying A's
output and pasting it into B on `/tools` gives?

| Case                                  | Verdict                       | Note                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A `text` output into a `text` input   | **identical**                 | Asserted both ways for four documents, with the digest of the result compared. The wire carries the same string the Copy button puts on the clipboard.                                                                                                                                                                                                                                             |
| A `bytes` output into a document port | **one difference, now told**  | A UTF-8 byte order mark is **removed** when bytes are decoded at a document port. Typing the same document into the box keeps it, because nothing decoded anything. It is conventional and almost always wanted, and it is still a byte that went in and did not come out — so all four document ports now say so. It stays removed; see [What the count was, and is](#what-the-count-was-and-is). |
| A `json` output into a `text` input   | **different by construction** | There is no wire: `json` and `text` do not overlap, so the canvas refuses the connection rather than silently serialising. On `/tools` you would paste the 2-space JSON the Copy button produces.                                                                                                                                                                                                  |
| A `bytes` output into a `bytes` input | **different by construction** | There is no text on the clipboard that is the bytes. The canvas is the only route.                                                                                                                                                                                                                                                                                                                 |

## The seven decisions, taken

Round two listed seven decisions, each a real defect or a real loss turning on a
judgement that was not its author's to make. They were decided, and round three
implemented them. What follows is what each one turned into, and what it cost.

Five of the seven share a mechanism, which is why they were taken together:
structured data had nowhere to say what it did. Adding that channel and then
filling it is one change rather than five.

### 1. Delimited detection prefers a YAML mapping

**Decided:** verify instead of guessing — if a document that looks delimited
also parses as a YAML **mapping**, prefer YAML.

`tags: a, b` over `names: c, d` is two lines of ordinary YAML with one comma
each, which satisfies "two records, consistent field count" exactly. It came
back as a one-row table whose columns were `tags: a` and `b`.

The alternative on the table was a higher bar — three records before anything is
a table — and it refuses a header and one row, which is the commonest real CSV
file there is. The question asked instead has an answer: a genuine CSV folds to
a plain scalar, not a mapping.

**Cost, measured.** One extra YAML parse, of the same 64 kB prefix
`looksDelimited` already reads, on a document that has already been decided to
look delimited. Five realistic tables are asserted to still be tables — a header
and one row, a header and two rows, quoted cells containing commas, a cell
containing `time: 10`, and a table of numbers — plus a two-column TSV. The
contrived loser is a CSV every one of whose cells is `key: value`.

### 2. A nested value stays in the cell, and is reported by path

**Decided:** keep the compact JSON in the cell and report it. Also report keys
missing from some rows, since they become empty cells.

Flattening to `user.name` was the alternative, and it is ambiguous for arrays
and collides with a key containing a dot — lossy in a new way. Refusing a nested
document outright refuses a conversion people do every day. The current
behaviour was the right trade; the silence was the defect.

Both losses are now named **by path** — `$[0].user` — and capped at five with a
count, because a thousand-row export with one nested column would otherwise
produce a thousand paths and a list nobody reads is a list nobody reads.

### 3. Integers past 2^53 are reported, not changed

**Decided:** keep the double, report each rounded number by path with a count,
wherever JSON or YAML reads a number, including JWT claims.

Parsing them as strings changes the type of a value silently, which is the same
class of problem in the other direction. `BigInt` is already refused at the JSON
boundary. Refusing the document refuses valid JSON.

See [Numbers past 2^53](#numbers-past-253-unavoidable-and-no-longer-silent) for
why the question is asked of the literal rather than of the value, which is the
part that makes the report trustworthy rather than merely present.

### 4. Structured data says what it detected

**Decided:** a `Detected` report carrying the format, the delimiter and levelled
loss notes, visible on the panel and available as an additive output port.

It is `presentation: 'report'`, so `ReportView` draws it — the renderer
`image-convert` already uses. Two rows were added to that view for the two
things structured data measures and nothing else does: the delimiter, and the
document count.

Additive, which is why it could be done at all: a new output port breaks no
share link and no saved canvas.

**And a port is not enough on its own.** See
[Where a loss is said](#where-a-loss-is-said).

### 5. The diff has a line-endings option

**Decided:** `ignore` or `compare`, defaulting to `ignore`; when endings were
ignored and did differ, that fact travels with the patch output.

The default stays what it was, for the reason it was chosen: a file that has
been through a Windows editor otherwise comes back entirely red, which hides the
real changes among thousands of phantom ones. What the option adds is that the
one case where the patch is a lie is now reachable.

The note travels **after** the hunks. That was measured rather than assumed, and
the obvious placement is the one that breaks: see the Diff table above.

The unexpected dividend is in that table too. With the terminators in the
comparison this tool writes the same patch git writes for all 38 oracle cases,
including the four whose spelling had never matched.

### 6. Two HTML targets

**Decided:** `HTML (sanitised)` with no Markdown round trip, inventing nothing;
`HTML (normalised)` as before, reporting anything the Markdown trip changes or
invents.

The control offered one word for two operations and performed the one that
invents. `html` keeps its value in a share link — a renamed value silently drops
back to the default, so every existing link would quietly start doing something
else — and the new capability gets the new name.

**Writing the instrument first moved three claims in this document**, which is
the argument for measuring rather than listing. See
[Found this round](#found-this-round).

### 7. JSONC is a real step

**Decided:** strip comments and trailing commas outside strings, before the YAML
fallback. Reported as JSONC with what was removed. Nothing may ever be folded
into a key again.

`stripJsonc` is string-aware, so a `//` inside a URL is four characters of a URL
and a `/*` inside a glob is not the start of anything. It replaces what it
removes with spaces of the same length and keeps line breaks inside block
comments, so `JSON.parse`'s line and column still point at the character the
user is looking at — and when the stripped document still does not parse, it is
THAT error that is reported, rather than "there is a comment on line 2".

**In front of YAML, not behind it**, which is the whole safety argument: the
YAML fallback folds a comment and the key after it into one key, and by the time
it is asked anything there is no comment left to fold.

It is held to `jsonc-parser`, the parser Visual Studio Code uses for its own
settings files, over 25 documents including every case that decides whether a
stripper tracks string state.

## Where a loss is said

A report is worth nothing if nobody sees it, and the two routes into this app
see different things.

**On `/tools`, every output port is drawn** whether or not anything is wired to
it, so a `report` port is visible there by construction. This document does not
trust constructions: it is asserted in two real engines that the note has a box
with a non-zero size, with no click anywhere.

**On the canvas, a node summarises its FIRST output and nothing else** — a rule
that is right for an answer and wrong for a caveat, because every tool's losses
are on its second or third port. (Round seven added one refinement to the rule
itself: where that first output is a document written out as text, the node
prints the measurement of the document rather than the first line of the
serialisation. The answer does not move —
[architecture.md](architecture.md#a-summary-that-could-not-tell-two-results-apart)
has the reasoning.) So four of round three's six reports would have
been sentences the product really produced, on ports nobody has to wire, and
invisible to anybody standing in front of the canvas.

The node reads them. `lossSummary` collects `warn`-level notes from any output
port presented as a `report` and prints the first on the node's face, prefixed
`Lossy ·`, with `+N more` when there are others. The result summary moves into
the accessible name, where it is listed separately anyway.

**The level is a promise, and the presentation is a filter.** `warn` means
something went in and did not come out; `info` means something worth knowing
that cost nothing, and a node never prints one. `regex-tester` carries `warn`
notes about the PATTERN on a `regex`-presented port — "your pattern has slashes
around it" is advice, not a loss — so reading notes from every json port would
have put that on a node's face. Both halves are asserted, including that one.

The same mechanism gives `image-convert` and `video-remux` node-visible
warnings, which they did not have: "GPS location was removed" was told on
`/tools` and silent on a canvas node. That was a gap in the `lossy, told`
verdicts those two tools already carried, and it closed for free.

**And one tool had no channel at all until round nine.** `color-convert` was
the only shipped tool that changes values and declared no `report` port, so
there was nowhere for a note about a clipped or clamped colour to go — which
means no loss it had could reach the definition above under any wording of any
sentence. That is worth stating as a shape rather than as a bug: the wrong cell
escaped every check in this repository by belonging to the one tool the
enforcing test's subject list — "one input per runnable **reporting** tool" —
defines away. The port exists now, the tool is in that list, and the cell is
enforceable for the first time.

## Where a loss travels

Round three answered "is the loss reported". Round seven answers a different
question, asked by somebody standing in front of a canvas rather than reading a
panel: **whose loss is this, and is the thing I am looking at now the document I
started with?**

Two things read wrong, and neither was a data bug. Both conversions were
correct, and the reports were correct.

**A node carried two verdicts.** Its face said `Lossy · The nested value at
$[0].user was written into the cell…` and its footer said `ok`. Both are true of
the run — it succeeded, and it lost something — but they are not the same
question, and the footer is the row a canvas of ten nodes is scanned by. So the
footer now answers the question the face is answering. `ok` splits into three:

| Verdict      | Means                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------- |
| `ok`         | It ran, it lost nothing, **and nothing it descends from did either.**                    |
| `lossy`      | This node lost something. Its face says what.                                            |
| `after loss` | This node ran cleanly; the value it worked from descends from a conversion that did not. |

They replace one another rather than stacking, which is what keeps them
readable: a canvas where half the nodes are downstream of a loss is a canvas
where the other half still say `ok`, and the contrast a person scans for
survives. A node's own loss outranks an inherited one, so no node ever carries
two.

**Nothing followed a loss along a wire.** A lossy JSON → CSV node wired into a
second structured-data node set to JSON produces exactly what the first node
warned about — `"user": "{\"name\":\"ada\"}"`, a string where the source had an
object, and `"user": ""` for the row that had no key at all. The second node's
face was blank and its status was `ok`, because its own conversion lost nothing.
The node **holding** the damaged value was the silent one, and three nodes
further along there was nothing at all.

### What a downstream node can honestly claim

Not that the damage is still in its output. Nothing in a graph can know that: a
regex over a flattened cell may never touch it, a hash of it is a hash of a
document that is not the original, and the two are indistinguishable from here.

What is knowable exactly, without guessing, is **provenance** — the value this
node worked from descends, through wires, from a conversion that lost something.
That is the only claim `after loss` makes, and it is why the word is not a
warning: the warning is on the node that lost it, which is the node a reader
should be looking at.

### Why it travels per PORT rather than per node

This is the part that decides whether the feature is worth having, and the
answer is not the same for every port of every tool.

`structured-data` declares three outputs. `output` is the document in the target
format; `data` is the **parsed source** structure, whose description is "for
wiring into another tool"; `report` is the notes. Flattening a nested object
into a CSV cell happens in the **write** half — so the damage is in `output`, and
`data` still holds the object intact. Wiring `data` onward is the way **around**
this loss.

A rule that marked every wire leaving a lossy node would therefore put a warning
on the workaround, which is the one thing the accessibility and reporting rules
in this repository refuse outright. So a `warn` note now records which of its
tool's output ports the loss is actually in (`ToolNote.reaches`), and only wires
leaving one of those carry it:

| Note                                                   | In                   | Because                                                            |
| ------------------------------------------------------ | -------------------- | ------------------------------------------------------------------ |
| A nested value written into a cell as JSON             | `output`             | The write half. `data` is the source structure and still has it.   |
| A column absent from some rows                         | `output`             | The same.                                                          |
| A number past 2^53 rounded                             | `output`, `data`     | The **read** half. The parser produced it, so both carry it.       |
| A stream of documents that became an array             | `output`, `data`     | `json` has no document separator either.                           |
| A YAML key that was not text                           | `output`, `data`     | The **read** half. The parsed structure has the text key too.      |
| A TSV cell holding a tab or a line break               | `output`             | The write half, like the nested-value note: `data` is untouched.   |
| `text-convert`: what the sanitiser removed             | `output`, `rendered` | The sanitised hub is `rendered`, and `output` derives from it.     |
| `text-convert`: what the Markdown round trip lost      | `output`             | The round trip runs **after** the hub, so `rendered` still has it. |
| `text-convert`: a class name the sanitiser filtered    | `output`, `rendered` | The sanitiser is the hub, like its other two notes.                |
| `base64`, `jwt-decode`, `image-convert`, `video-remux` | `output`             | One data port each.                                                |

A `report` port carries nothing onward in either direction — not the node's own
loss and not one it inherited. That port holds the **account** of a run, not its
document, so a node fed from it is holding a description rather than a damaged
value.

Beyond the first hop the narrowing stops, and correctly: a tool declares where
**its** losses went and has no way to know its input was already damaged, so
everything an inheriting node produces descends from everything it was given.
That is every port but its report.

### What is asserted, and where

`reaches` fails silently in every direction — a typo, an empty list, a retired
port id and a tool that grows a second data port all look exactly like "this
conversion happened not to lose anything". So the claim is held against the
manifest rather than left to the call sites:

- [`notePorts.test.ts`](../src/features/registry/notePorts.test.ts) runs every
  reporting tool that jsdom can run on an input that really loses something, and
  holds every `warn` note to a **non-empty subset** of that tool's own non-report
  output ports. It also asserts the run lost something in the first place, so an
  empty list of notes cannot pass the test vacuously. `image-convert` and
  `video-remux` cannot run there — no `OffscreenCanvas`, no real container — so
  they are held to the assumption their hard-coded `['output']` rests on instead:
  exactly one non-report output port.
- [`lossTrace.test.ts`](../src/features/canvas/lossTrace.test.ts) is the walk
  itself, including the case that decides the design: a wire out of `data` marks
  nothing.
- [`lossVerdict.test.tsx`](../src/features/canvas/lossVerdict.test.tsx) drives
  the real tools through the real canvas and reads the words off the rendered
  node, including the damaged value itself — `"{\"name\":\"ada\"}"` — so the test
  records the case rather than describing it.
- `checkLossAlongWires` in
  [`cross-browser-check.mjs`](../scripts/cross-browser-check.mjs) asserts in
  Firefox and WebKit that those words are **drawn**, with a box of non-zero size,
  with no click anywhere — and that the LED beside them differs in **shape**
  rather than only in hue, which is a `clip-path` question jsdom resolves to the
  empty string and therefore cannot ask.

- [`lossCorpus.test.ts`](../src/features/registry/lossCorpus.test.ts) is round
  nine's addition, and it asks the question none of the others do: **is a
  documented loss reported at all.** The three above are about `reaches` — which
  port a loss travels to — and every one of them passes happily for a loss
  nothing ever mentions. This one runs every case in
  [`spec/loss-corpus.json`](../src/features/registry/spec/loss-corpus.json),
  derives the verdict from what the tools actually said, and fails when the
  ratio it computes disagrees with the one printed in this document.
- `checkColourReports` in
  [`cross-browser-check.mjs`](../scripts/cross-browser-check.mjs) is the
  two-engine half for the tool that gained its channel this round: the note
  drawn on `/tools` with a box of non-zero size and no click anywhere, the same
  sentence on a canvas node's face and in its accessible name, and the contrast
  table's composited ratios held against the engine's own compositor.
- `checkMarkdownCensus` in the same file is round ten's, for the target that
  gained its census: three reports drawn on `/tools` with boxes of non-zero
  size and no click anywhere, the same sentence on a canvas node's face and in
  its accessible name, and — because this round fixed a correctness bug as well
  as a silence — the Markdown output read back out of the box and asserted to
  be three lines with every one of them a table row. A cell that emits a
  newline fails that last one in a real engine, which is where the document
  people paste actually comes from.
- `checkValueModel` in the same file is round eleven's, and it is the one whose
  subject is a **refusal** rather than a note. A refusal has two surfaces and
  they carry different amounts of text: the panel on `/tools` shows the message,
  the code, the line and column, and the detail under them; a canvas node shows
  the **message alone**, because a node has no detail line. So both are asked,
  and the message is held to naming the value model and to not naming JSON on a
  `YAML → YAML` run in either place. Beside it, the six-offender enumeration,
  the target-fitted rounding advice and corpus row 10's note, each drawn with a
  box of non-zero size and no click anywhere.

Every one of those has a negative control beside it: a conversion that loses
nothing, a wire out of a port the loss is not in, and a **four-node lossless
chain** in which every node must say `ok` and no accessible name may contain the
word. Round eleven's controls are on SUBJECT rather than on wording — a document
the model holds must draw **no error panel at all**, not merely a differently
worded one, and `"2024": launched` must draw no note about a key, which is the
sharp one: it produces the identical parsed value and the identical output as
`2024: launched`, and only one of the two lost anything. The corpus carries its control per case rather than per suite — every
entry names a second document of the same shape that loses nothing, and no note
about that row's subject may fire on it. A mark that fires on a clean canvas is
the one people learn to ignore before the day it is true.

## What the count was, and is

Twelve cells were `lossy, silent` at the end of round two. Every one of them:

| Cell                                | Now                         | How                                                                          |
| ----------------------------------- | --------------------------- | ---------------------------------------------------------------------------- |
| JSON reading: integers past 2^53    | **lossy, told**             | Reported by path, asked of the literal so the report is exact                |
| JSON/YAML → CSV/TSV                 | **lossy, told**             | Nested values and absent keys, both by path                                  |
| YAML stream → any                   | **exact** / **lossy, told** | YAML writes a stream back; the other three say the documents became an array |
| An empty document in a stream       | **fixed in round three**    | `---` starts a document; three references agree                              |
| Anything → CSV: LF, no terminator   | **lossy, told**             | An `info` note on every CSV write                                            |
| Detection never says what it chose  | **fixed in round three**    | The `Detected` report                                                        |
| Markdown → Markdown                 | **lossy, told**             | Three named constructs, plus reformatting at `info`                          |
| HTML → HTML                         | **lossy, told**             | Split in two, and both halves measured rather than listed                    |
| Base64: non-canonical trailing bits | **lossy, told**             | The character as written and the canonical spelling of the same bytes        |
| JWT: large numeric claims           | **lossy, told**             | The same scanner, on a `Report` port                                         |
| Colour: `rgb(50% 50% 50%)`          | **fixed in round three**    | Quantised once, against what a real browser reports                          |
| Diff: line endings on the port      | **lossy, told**             | An option, and a note that travels with the patch                            |

And two cells this round made honest rather than found:

| Cell                             | Was                 | Now             |
| -------------------------------- | ------------------- | --------------- |
| Markdown → HTML                  | `exact`, 95.7%      | **lossy, told** |
| A byte order mark, at four ports | asserted in a table | **lossy, told** |

**Round four found two more, and the count was not zero after all.** The column
being empty meant every loss anybody had NAMED was told; it could not mean there
were none left to name, and saying otherwise was the thing this document exists
to stop doing:

| Cell                            | Was                    | Now                     |
| ------------------------------- | ---------------------- | ----------------------- |
| An `id` the author wrote        | **lossy, silent**      | **lossy, told**         |
| A link to a heading, normalised | **broken**, and silent | **fixed in round four** |

**Where a note lives, and where it does not.** `structured-data`,
`text-convert`, `base64` and `jwt-decode` carry theirs on a `report` port, which
is what the canvas node reads. `diff` and `regex-tester` have no report port and
are not getting one for a single flag: a third output on a 224px node is a
permanent cost for a fact that belongs in the thing it contradicts. So diff's
goes into its node summary, and regex's stays on the panel - where the node's
own answer, the match count, is the thing the note explains rather than
contradicts.

**The byte order mark** was recorded in
[the wire against the clipboard](#the-wire-against-the-clipboard) as "one
difference, now asserted" — which is true and is not the same as being told. A
BOM is removed when bytes are decoded at a document port and kept when the same
document is typed into the box, so one file has two answers depending on how it
arrived. It stays removed; all four document ports now say so:

- `structured-data` and `text-convert` report it on their report ports.
- `diff` reports it beside the rows, and deliberately does **not** put the
  character back — that tool is the instrument the wire-fidelity suite uses, and
  an instrument that corrects one of the things it measures is not one.
- `diff`'s node stops saying `Identical`, which is the one summary in the set
  that asserts sameness rather than measuring something - a file that had a mark
  and a file that did not compared equal, and the node said so about two files
  that are not the same. **This sentence was true of the panel and not of the
  node until round seven**: an identical comparison produces an empty patch, and
  the node summarised the empty patch as `Empty`, so neither `Identical` nor the
  correction to it ever reached a face. `diff`'s `output` is measured by
  `changes` now, and both do.
- `regex-tester` names it as a `warn`, because a BOM sits in front of position 0
  and is exactly why an anchored pattern finds nothing with no explanation.

### The corpus, the ratio, and why it is not a number any more

**The count has now been wrong twice, and both times for the same reason: it
was an absolute over a hand-written list.** Round three reported zero and round
four found two; rounds four to seven reported zero and round eight found
seventeen — five of them in cells this document was carrying as `lossy, told`.
A third attempt at an absolute would have failed the same way, because nothing
anywhere was asking the tools.

So round nine stops printing one. The denominator is
[`spec/loss-corpus.json`](../src/features/registry/spec/loss-corpus.json) — one
document per row of the table in
[docs/test-findings.md](test-findings.md#what-is-actually-silent), each with the
note that row must produce — and the verdicts under it are **run rather than
written**: [`lossCorpus.test.ts`](../src/features/registry/lossCorpus.test.ts)
drives every case through the real tool, reads its `report` ports, and generates
the block between the markers below. A `pnpm test` whose measurement disagrees
with what is printed here is a failing gate, so the sentence a reader sees is
the sentence the tools produced on the run that published it.

Most of it is red, and that is the point. A cell may say `lossy, told` only when
a case proves it; a row with no case reads `not verified`; and the file is
extended by appending one object, which is the only ceremony rounds ten to
thirteen should have to perform.

**Round thirteen moved the last two and added three** — so the ratio is
**20 of 20**, and 17 of 17 on the rows round eight wrote. Row 16 turned on its
original expectation, through a census that now carries class names. **Row 17
turned by a re-specification**, and the row says so in its own
`whyThisExpectation`: its loss - `<mark>` and `<kbd>` given formatting they
never had - was a defect in the conversion, fixed rather than announced, which
left the row describing something that no longer happens. What it measures now
is what the document still loses. Rows 18 to 20 are a reversed list's numbers,
a TSV cell holding a tab, and a YAML flow collection, each a decision this round
took that made a silent loss a told one. The full account is in
[test-findings](test-findings.md#round-thirteen-done).

**Round twelve moved eight** — rows 4 to 9, 11 and 12 — so the ratio was
**15 of 17**, and what is left is rows 16 and 17, both `text-convert`. Six of
the eight are the `YAML → JSON` and `YAML → YAML` presentation losses this
document carried as `lossy, told` from round three to round eight without a
builder for any such note existing anywhere in the tool; the other two are a
trimmed CSV header and a discarded duplicate JSON key.

The six are **one note**, not six, and the reasoning is in
[docs/test-findings.md](test-findings.md#the-one-thing-to-judge-eight-notes-one-line-on-a-node):
a realistic manifest has all four kinds in it, a node's face prints one line,
and the four share a cause and a non-remedy. The title is a census that names
every kind present — `Not carried over: 2 comments, 1 anchor, 1 tag, 2 block
styles` — which is what keeps each row's negative control able to fail.

**Round eleven moved one before that** — row 10, a non-string YAML key. It is
worth saying which KIND of move that was, because the round it belongs to is
mostly about a refusal and a refusal cannot turn a row green: a row measures
whether a loss is told, and a document that is refused has not been converted,
so no note about it exists to find. Row 10 is not one of those. A key of `2024:`
is **not** refused — a scalar key cannot collide silently, so the model
stringifies it and carries on — which left it a genuine silent loss with nothing
standing in the way of saying it.

**Round ten moved three before it** — rows 13, 14 and 15, all `text-convert`,
all `HTML → Markdown`. Row 13's expectation was
**re-specified rather than met as written**, and the corpus says so in the row
itself: round nine asked the note to name the caption's TEXT, and the
instrument round ten was asked to use is a census of NAMES. Rows 14 and 15
were re-specified for a smaller reason with a sharper consequence — their
`titleContains` named the subject the way a person writes it rather than the
way the note's title does, and a subject matcher that can match no note the
tool will ever write makes that row's NEGATIVE CONTROL vacuous rather than
merely failing its positive assertion. A row edited that way is the one thing
in this file that can turn green without the tool changing, so
`whyThisExpectation` is a declared field rather than an unread key.

<!-- loss-corpus:begin -->

**20 of 20** documented losses are told.

A round has reported zero silent losses twice, and every time the next round to look found more — round four found 2, and round eight found 17.

| #   | Loss                                                                        | Where the cell is                      | Tool              | Verdict         |
| --- | --------------------------------------------------------------------------- | -------------------------------------- | ----------------- | --------------- |
| 1   | Out-of-gamut OKLCH clipped                                                  | Colour · Out-of-gamut OKLCH            | `color-convert`   | **lossy, told** |
| 2   | Out-of-range hsl() clamped                                                  | Colour · Out-of-range hsl()            | `color-convert`   | **lossy, told** |
| 3   | Out-of-range rgb() clamped                                                  | Colour · Out-of-range rgb()            | `color-convert`   | **lossy, told** |
| 4   | A YAML comment dropped on the way to JSON                                   | Structured data · YAML → JSON          | `structured-data` | **lossy, told** |
| 5   | A YAML anchor expanded on the way to JSON                                   | Structured data · YAML → JSON          | `structured-data` | **lossy, told** |
| 6   | A YAML tag dropped on the way to JSON                                       | Structured data · YAML → JSON          | `structured-data` | **lossy, told** |
| 7   | A YAML block style collapsed on the way to JSON                             | Structured data · YAML → JSON          | `structured-data` | **lossy, told** |
| 8   | A YAML anchor expanded on the way to YAML                                   | Structured data · YAML → YAML          | `structured-data` | **lossy, told** |
| 9   | A YAML scalar style collapsed on the way to YAML                            | Structured data · YAML → YAML          | `structured-data` | **lossy, told** |
| 10  | A non-string YAML key stringified                                           | Structured data · YAML → YAML          | `structured-data` | **lossy, told** |
| 11  | A CSV header cell trimmed                                                   | Structured data · CSV/TSV → JSON/YAML  | `structured-data` | **lossy, told** |
| 12  | A duplicate JSON key discarded, last wins                                   | Structured data · Reading JSON         | `structured-data` | **lossy, told** |
| 13  | `<caption>` dropped, Markdown target                                        | Text convert · HTML → Markdown         | `text-convert`    | **lossy, told** |
| 14  | A table cell's list structure flattened, Markdown target                    | Text convert · HTML → Markdown         | `text-convert`    | **lossy, told** |
| 15  | An empty header row invented, Markdown target                               | Text convert · HTML → Markdown         | `text-convert`    | **lossy, told** |
| 16  | `class="btn"` emptied to `class=""`                                         | Text convert · HTML → HTML (sanitised) | `text-convert`    | **lossy, told** |
| 17  | `<mark>` and `<kbd>` unwrapped to their text, Markdown target               | Text convert · HTML → Markdown         | `text-convert`    | **lossy, told** |
| 18  | A reversed list's numbers now count up, Markdown target                     | Text convert · HTML → Markdown         | `text-convert`    | **lossy, told** |
| 19  | A cell holding a tab, written to TSV in quotes that cut and awk cannot read | Structured data · Writing TSV          | `structured-data` | **lossy, told** |
| 20  | A YAML flow collection written back as a block                              | Structured data · YAML → YAML          | `structured-data` | **lossy, told** |

<!-- loss-corpus:end -->

## Markdown to HTML, relabelled

The cell said `exact`, 95.7%. Those two things cannot both be true: `exact` in
this document means the output is the one an external reference gives, and 624
of 652 is not that.

The 28 CommonMark examples and 3 GFM examples that differ were re-run, and each
was asked the question that decides whether it matters: **would an LLM or a
README realistically produce this?**

| Group                         | Count | Realistic?                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw HTML the allow-list drops | 22    | **Yes, constantly.** A `<div class>` wrapper, a `<span style>`, an element nobody recognises. This is the group the new report is for.                                                                                                                                                                                                                                    |
| URL schemes not allowed       | 4     | **Rarely.** `irc:`, `a+b+c:`, `made-up-scheme:`, `localhost:5001/foo`. A README with an `irc:` link exists; it is not a thing an LLM writes. The link's text is kept and the link is unwrapped.                                                                                                                                                                           |
| A scheme's case               | 1     | **No.** `<MAILTO:FOO@BAR.BAZ>`. Schemes are case-insensitive (RFC 3986), so lowercasing produces the same URL — and before it, the example lost its href entirely.                                                                                                                                                                                                        |
| A relative URL with a colon   | 1     | **No.** `[link](foo\):)`. Upstream, obscure, and not fixable from outside without re-implementing the protocol check.                                                                                                                                                                                                                                                     |
| GFM: task lists and `ftp:`    | 3     | **No, and two of them are this converter being closer to reality than the spec text.** Two are task lists, where remark-gfm emits `class="contains-task-list"` and github.com does too, while the spec’s expected output does not. The third is `ftp://` not being linkified, which the upstream extension does not do and which Chrome and Firefox both removed in 2021. |

So one group of the five is a document a person actually has, and it is the one
that is now reported. **Measuring it moved the claim as well**: the allow-list
is considerably more generous than "strip the markup" — `<details>`,
`<summary>`, `<kbd>` and `<img align>` all survive — and what goes is an element
the list does not name or an attribute it does not permit.

**One class of removal is deliberately not reported.** GFM's tagfilter escapes
`<script>` and `<iframe>` into visible text before anything else sees them, so
they arrive in the output as `&lt;script&gt;`. Nothing is missing and the reader
can see exactly what happened; a note would claim a removal that did not occur.

## What changed for a person pasting a document

Round one ran "nineteen realistic pasted documents" before and after its
detection fixes and reported that the only changes were the ones it listed. That
was true and it was not re-runnable: the corpus was never written down.

Round three reconstructed one, ran it against the round-two tree (commit
`2853062`, in a git worktree) and against this one, and compared field by field.
**Twenty-nine documents, three changes, and all three are decisions:**

| Document                         | Before                            | After                         |
| -------------------------------- | --------------------------------- | ----------------------------- |
| A stream ending in a separator   | `{apiVersion: v1, kind: Service}` | `[{apiVersion: v1, …}, null]` |
| A tsconfig-shaped JSONC document | refused: "not valid JSON"         | read, reported as JSONC       |
| Two lines of YAML with one comma | a one-row table                   | a mapping                     |

The other 26 are byte-identical: pretty-printed JSON, compact JSON, an array of
objects, a trailing comma, single quotes, unquoted keys, a JavaScript object
literal, NDJSON, a Kubernetes stream, block and folded scalars, a YAML mapping
with comments, a sequence of mappings, comma, semicolon and tab exports, an
Excel `sep=` export, a quoted multi-line cell, a pipe export, prose, a ragged
CSV, a scalar, an empty document, big integers in JSON and YAML, and a literal
newline inside a JSON string.

It is committed this time, as
[`spec/detection-corpus.json`](../src/tools/structured-data/spec/detection-corpus.json),
with an assertion per document per question.

## Found this round

Round three's job was to take decisions rather than to find things, and it found
five anyway. Four of the five are the same shape: **a claim in this document
that the instrument, once written, disagreed with.**

**`class` and `data-*` are dropped by the SANITISER, not by the Markdown round
trip.** The `HTML → HTML` row said the round trip did it, which implies that
switching to a sanitise-only pass would keep them. It would not. Found by
comparing the three documents — input, sanitised, normalised — instead of
listing the transformations. The report now attributes each half correctly, and
`HTML (sanitised)` reports the allow-list's own removals rather than claiming to
lose nothing.

**A footnote does not become `<sup>` markup.** It becomes an ordinary link to an
anchor, plus a `## Footnotes` section with a list under it. The note says what
actually happens.

**`$$…$$` display maths does not become an inline code span.** It becomes a
fenced block tagged `math`, which is what GitHub renders.

**The allow-list is more generous than this document implied.** `<details>`,
`<summary>`, `<kbd>` and `<img align>` all survive `Markdown → HTML`. Every
sentence anybody writes about "the sanitiser strips your markup" should name
what it actually strips.

And one that is not about prose:

**One of the 94 yaml-test-suite error cases was refused for the wrong reason.**
SF5V is `%YAML 1.2` twice over a bare `---`, which the spec forbids. It was
refused — by the rule that a document with nothing in it is not a document, with
the message "nothing to parse: the input is empty", which is not what is wrong
with it. So "94 of 94 refused" included one coincidence, and correcting the
empty-document rule made the parser accept a document the spec says is invalid.
The `yaml` library does not flag it at any log level, so it is now checked here:
one document, one `%YAML` directive.

That is the second time in three rounds that fixing one thing has exposed an
assertion that was passing for a reason nobody had checked. The pattern is worth
naming: **a test that passes for the wrong reason is invisible until the right
reason changes.**

## What was looked for and not found

Stated because an absence is only worth anything if somebody says what they
looked for. Round one and two's list still holds; these are round three's.

- **A report that fires on input that lost nothing.** Every note added this
  round has a negative control beside it — the same shape of document with the
  loss removed — and several are the whole reason a design choice was made: an
  integer past 2^53 that a double holds EXACTLY produces no note, a key whose
  value is the empty string produces no note, JSON with no comment in it is not
  described as JSONC, a `//` inside a URL is not a comment, a plain paragraph
  through `HTML → HTML` reports nothing, and Markdown that comes back byte for
  byte says nothing at all.
- **A behaviour change nobody asked for.** Twenty-nine realistic documents run
  against the round-two tree and against this one. Three changed and all three
  are decisions. See
  [What changed for a person pasting a document](#what-changed-for-a-person-pasting-a-document).
- **The 32-of-38 diff number being an artefact of the corrupted fixture.** Round
  one measured it while `scripts/generate-diff-oracle.py` was writing cp1252 into
  a file it declared as UTF-8. Re-measured against the regenerated fixture: still
  32, and the six that differ are the six that were named. It was worth
  re-asking; the answer did not move.
- **A note that says a stream survived when it did not.** The first version of
  the stream note was written at read time and told a YAML-to-YAML conversion
  that its stream "became an array" while a stream sat in the output beside it.
  It is written from the WRITER now, which is the only place that knows.
- **A canvas node that reports a loss it did not have.** Asserted in two engines,
  with the negative control in the same run.
- **The `report` ports changing what any tool produces.** `output` and `data`
  are byte-identical either way; the reports are additive. The JWT tool's decoded
  value and signature verdict are asserted unchanged beside the new note.

And round five's, all of them from the new instruments rather than from the
suite:

- **The two engines disagreeing about a downscale.** The expectation going in
  was that Gecko and WebKit would differ enough to force a loose tolerance.
  Measured over all 4096 output pixels: Gecko is within **one** level of the
  reference and WebKit is **exact**. The tolerance is two because the
  measurement is one, not because the engines needed room.
- **`imageSmoothingQuality` mattering, or `imageSmoothingEnabled` mattering.**
  High, medium and low give identical results in both engines at an integer
  reduction — and in Gecko, setting `imageSmoothingEnabled` to **false** changes
  nothing either. The two lines in `convert.ts` that set them are insurance
  against an engine that is not one of these two, and they say so; this is the
  measurement behind that sentence rather than a guess. What _does_ point-sample
  is `createImageBitmap`'s own `resizeQuality: 'pixelated'`, which lands 128
  levels from the reference — so the check has been shown to fail against a real
  API rather than only against a hypothetical.
- **A frame dropped, repeated or reordered by the remuxer.** The playback check
  resolves each decoded frame to its own colour among the twelve and requires
  the sequence to be 0..11. It was, first run, in the one engine that can play
  anything.
- **A second scanner-level fault in what this tool writes as YAML.** After the
  tab fix, **zero** of the 284 documents fail PyYAML's scanner; every remaining
  refusal is a `ParserError`, which is a different stage and a different
  question. The assertion is on the stage rather than on the ids, so a value
  going back to being written raw reappears here.
- **An error case in the yaml-test-suite refused by the key-collision rule.**
  Zero of the 94, which is the same question round four asked of the empty-input
  rule and could not ask of this one until the two collisions were separated.
- **A malformed signature that makes WebCrypto throw.** The `try` in `verify.ts`
  says one does. An empty, 32-, 63- and 65-byte P-256 signature and an empty and
  a 7-byte RSA one all come back `false` from Node's WebCrypto, and rethrowing
  from that catch leaves the whole suite green. What the engines do is a
  measurement in `check:browsers` now rather than a claim in a comment.

And round six's, all of them about the JWT tool:

- **A published JWT — not JWS — vector for anything past RFC 7515 A.3.** RFC
  7515 A.4, all four of RFC 7520's signature examples and every Wycheproof JWS
  group sign a payload that is not JSON, so none of them can be driven through
  `decodeToken` and `run`. Two Wycheproof PS256 cases sign the digit string
  `123400`, which parses as JSON by accident rather than by intent, and they are
  the only exception found. If a published JWT vector for PS384, ES512 or any
  HS\* exists, it was not found in RFC 7515, RFC 7519, RFC 7520, RFC 7797, RFC
  8037 or Wycheproof.
- **A published vector for HS384, HS512 or ES384 in JWS form.** Looked for in
  the same six places. RFC 4231 and Wycheproof's P-1363 ECDSA file are what
  exist, and both are a key, a message and a signature rather than a token — so
  that is what the matrix says they settle.
- **An algorithm this tool offers with no published vector at all.** There is
  none left; the ledger in
  [`jwt.test.ts`](../src/tools/jwt-decode/jwt.test.ts) asserts a named source for
  each of the twelve and fails if one is added without one.
- **RS384 and RS512 being covered.** They were not, and neither round five's
  gap list nor the brief for round six mentioned them — both named "HS384/512,
  PS\*, ES384/512" and stopped. Two algorithms the tool offers were missing from
  the list of algorithms nothing had checked.
- **A fixture that verifies because the generator and the tool share a table.**
  The generator derives its WebCrypto parameters itself rather than importing
  `verify.ts`, and `check:browsers` reads them from the fixture rather than
  deriving them a third time. A shared table would make a wrong one agree with
  itself in every engine.

## Found in round twelve, by writing the notes the matrix had already promised

Eight rows of the loss corpus turned at once, so the ratio went from **7 of 17**
to **15 of 17**. Six of the eight were cells this document had carried as
`lossy, told` since round three with no builder for such a note anywhere in the
tool; the other two were a trimmed CSV header and a discarded duplicate JSON
key. The verdicts are generated from the corpus, so those numbers are what the
tools did on the run that published this page.

Three things came out of the work that were not the notes.

### A file nobody could read, behind a naming rule

`column_2` is a name this tool invents for an empty header cell, and it was
invented without looking at the document it was going into. A file whose author
had written a column called `column_2` therefore collided with the invention and
was **refused outright**, with a message blaming its author for a duplicate they
had not written — and there is no spelling of that header that gets the file
read, because the offending column is the one the tool made up. The reserved set
is now every name the header declares plus every name assigned so far, computed
in a pass of its own: checking only the names already assigned would invent
`column_1` for the first cell of `,column_1` and then refuse the second.

### A block scalar rule that had to be measured three times

The presentation note's one target-dependent claim, and each attempt was swept
over the yaml-test-suite's 284 readable documents before it was believed:

| Attempt                                        | Named and false | Lost and silent |
| ---------------------------------------------- | --------------- | --------------- |
| "a literal block survives a YAML target"       | 0               | **8**           |
| plus "unless it is used as a key"              | **3**           | 0               |
| plus "unless its value has no line break left" | **0**           | **0**           |

A **folded** block is always lost, because folding happens in the READER —
`three\nfour` is `three four` before any writer sees it. A **literal** block
survives a YAML target, measured against the writer rather than predicted
(`lit: |` in, `lit: |` out, chomping included), unless its value has no line
break left in it or it is used as a mapping key. The newline is the thing that
carries the style, which is why testing for it is the rule rather than a list of
cases.

### The instrument: the output, not a second opinion about the input

A note saying a comment was not carried over is true exactly when the source has
one and the output does not, so
[`presentation.sweep.test.ts`](../src/tools/structured-data/presentation.sweep.test.ts)
asks both halves, of two different documents, and asserts **both** directions:
nothing named that the output still has, and nothing lost that no note mentions.
Over 284 documents on both targets, both are zero, with 44 comments, 30 anchors,
34 tags and 59 block styles correctly named. It is in the gate rather than being
a number somebody once produced, and it caught eight of the eighteen deliberate
breaks this round was checked against.

The note fires on 133 of the 284 on a JSON target. That is a high proportion and
it is what the suite is — a corpus built out of YAML's corners. On the
29-document detection corpus it fires five times across 116 runs, and all five
documents genuinely have the thing.

### What is still silent, and is now named

**Flow style.** `a: {b: 1}` comes back as a block mapping and nothing says so.
It is deliberately not folded into the presentation note: it would fire on a
large share of ordinary Kubernetes-shaped YAML for a difference few people would
call a loss, and that judgement deserves a row in the corpus rather than a quiet
inclusion. It is a new silent loss on the list, not a closed one.

_Round thirteen: closed, as corpus row 20, and the worry above was measured
rather than inherited._ The census is one line on a node whatever it holds, so
a kind adds a word to a note already printing for any document with a comment,
and starts a note only on a document that had nothing else - 22 of the suite's 284. The first version did cry wolf, on three near-JSON documents in the
detection corpus, which is why a document written entirely in flow is not
counted. See [round thirteen](test-findings.md#round-thirteen-done).

## Found in round four, by breaking things on purpose

Round four asked one question of everything in this document: **could the
assertion behind it fail?** The method was mutation — one small, valid change to
the conversion code at a time, with the tests that claim to cover it run against
each. A change nothing notices is a claim nothing is holding.

150 mutants over `structured-data`, on a deterministic sample of the whole file
set. 32 survived. Reading each one is the work: **about half were equivalent** —
`cellToString`'s `typeof value === 'number' || typeof value === 'boolean'`
becomes `&&`, and a number falls through to `JSON.stringify(42)`, which is the
same string — and every one of those is a reason to read survivors rather than
count them. What was left:

| Broken on purpose                                        | What nothing noticed                                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `yamlPath`'s sequence index                              | Two rounded integers in a YAML sequence both reported at `$`. **A real defect**, fixed; see above                |
| The YAML block-sequence detection guard                  | `- a, b` over `- c, d` read as a two-column table again — round one's fix, with no test since                    |
| The detector's "a quote only opens a field at its start" | A CSV whose first heading contains a comma falls through to YAML and comes back as one string                    |
| A CRLF inside a quoted cell counting as one line         | Every line number reported after a multi-line cell is one too high — the hazard the code comment beside it names |
| `slice(0, 5)` on the by-path lists                       | The cap this document calls "five with a count" was six, or none                                                 |
| `detected: !chosen` on the report port                   | The report says it guessed when it was told, and told when it guessed, to every reader but the panel             |

Each of those is now a test, and each test was **run against the break that
exposed it** and seen to fail — eighteen breaks, eighteen red. That last step is
not a formality: the first version of the CRLF test asserted a position computed
from a byte offset, which is recomputed from the text and is therefore right
whatever the line counter does. It passed against the break. The test asks a
ROW's own line now.

### Two guards, each covering for the other

Detection bounds its prefix twice — fifty records and 64 kB — and removing
either constant moved no verdict anywhere in the suite, because whichever was
left still stopped the walk. Two numbers, no test between them, each looking
covered because of the other. There is a document per guard now, built so that
its own guard alone decides it, and each comes back as a mapping rather than a
table when that guard is taken away.

### The stopwatch that was measuring the machine

`decides from the start of a large document rather than reading all of it`
asserted 250 ms against a defect measured at 119, and this suite runs a hundred
and twenty files at once — so it failed whenever the machine was busy. Two
repairs were measured rather than assumed. A **ratio** against a smaller
document wandered between 2 and 34 for correct behaviour, because the whole
string is still trimmed and scanned for a `sep=` directive. A **tighter
absolute bound** on the fastest of three samples separated 3.8–7.8 ms correct
from 17.8–27.5 ms broken, and 2.3× is not enough margin for a wall clock with a
hundred and nineteen competitors.

So the cost is **no longer asserted**, and the verdict-from-a-bounded-prefix
half — which is deterministic, and is the half that protects the user — is. A
line that says "not measured" beats a green one that means "the machine was
quiet". The same shape was found and fixed in three `video-remux` properties,
where a 500 ms stopwatch ran inside each of three hundred cases; the budget is
on the property now, at fifteen times its measured cost.

### An identifier, and a link to nothing

The matrix listed the sanitiser's `id` namespacing under
[still unverified](#still-unverified-and-how-to-verify-it) with the note that it
is "documented elsewhere". Elsewhere was a comment in this repository. Round
four's question — is the user told **on screen**? — has one answer, which is no:
`id="location"` went in, `id="user-content-location"` came out, and the report
said `notes: []`.

It is a `warn` note now, which is the closer call. The byte order mark next door
is `info`: removed, deliberate, and nothing outside the document was pointing at
it. An identifier is different in that last respect — links inside the document
are moved to match, so those still work, but a stylesheet, a script or a link
from another page that named `#location` now finds nothing, and finding nothing
is the failure nobody reports.

**And writing the instrument found something worse than the thing it was written
for**, which is the third time in four rounds. Asking the question of the OUTPUT
rather than of the sanitised hub is what showed it: `HTML → HTML (normalised)`
takes the document out to Markdown, Markdown has no spelling for a heading's id,
and the id comes back as a slug of the heading's TEXT — while the link to the old
name rides through untouched. A table of contents can arrive dead with every
count equal, which is exactly what `compareMarkup` is documented as being unable
to see. Both halves are reported now, and the negative control is a document that
arrived with a dead anchor already in it, which is not this tool's to claim.

## Found in round five, by asking something outside this repository

Round five is the one that was left until last because none of it could be done
inside the test suite. Every item below needed a reference from somewhere else:
a specification's own bytes, another language's library, a real encoder, a real
decoder.

### The twenty-nine the suite would only describe

The yaml-test-suite answers most of its cases with an `in.json`. Twenty-nine
carry none, and for three rounds this document counted them and moved on —
visible, which was the point, and undecided, which was the cost.

They are not undescribed. Every case in the suite carries a `test.event`, and
an event stream fixes the node graph completely: what opened, what closed, every
scalar with the style it was written in, every anchor and every alias. So the
generator composes the value from the events, and the suite's own answer decides
all twenty-nine.

**The composer is not trusted on its own say-so**, because it is code this
repository wrote, which is the evidence this document ranks lowest. Before it is
allowed to decide a case the suite does not answer, it has to reproduce the ones
the suite does: **278 of the 279**, the exception being RR7F, whose `in.json`
prints a mapping in a different order and which this document has called an
ordering difference since round two. The generator throws rather than writing a
fixture if anything else disagrees.

The twenty-nine come out as:

| What the events describe          | How many | What this tool must do                                                |
| --------------------------------- | -------- | --------------------------------------------------------------------- |
| A value JSON can hold             | 13       | Produce it. All thirteen already agreed.                              |
| A key that is itself a collection | 15       | Refuse at the value-model boundary, which it does, with that message. |
| Two keys that collide             | 1        | Refuse — and **the message was wrong**, which is the next section.    |

**The key-naming rule came out of the measurement rather than out of taste.** A
mapping key is named by its own scalar TEXT, not by the value it resolves to.
The two differ in exactly one place and it is the place that matters: an empty
plain key resolves to `null`, and `JSON.stringify(null)` is the four letters
`null` — a key that was never in the document. Naming it `""` is what the
document says, what this tool produces, and what agrees with **278** of the
suite's own answers. The other rule agreed with 277.

### A document told it was invalid, which was valid

2JQS is `: a` over `: b` — a mapping with the same empty key twice. The suite
composes it rather than marking it an error, so refusing it is this tool's
decision and not the document's fault. The message said **"That is not valid
YAML."**

It is the same shape as round three's SF5V and round four's 9MMA: a case refused
for a reason that was about something else. And it was not only the suite's
case. The rule that produced it is `collidesAsJsKey`, which exists because
`true:` and `"true":` are two keys to YAML and one key to JavaScript — and so
are `1:` and `"1":`, and `~:` and `"":`. Every one of those documents is valid
YAML by every reference there is: the suite composes them, js-yaml reads them,
PyYAML reads them. What cannot hold them is **this tool's value model**, whose
keys are text — the same boundary that refuses a `!!set`, a `!!binary` and a
collection key, and the only one of the four that was blaming the document.

Someone told their valid YAML is invalid goes looking for a syntax error that is
not there. The two are separated now:

- `That mapping has the same key twice.` — genuinely one key written twice.
- `Two different YAML keys become one key in this tool.` — the value-model
  boundary, worded like its three neighbours. It said `the same JSON key` until
  round eleven, which named a format that is in neither half of a `YAML → YAML`
  run; see [the value model](#the-value-model-and-yaml-yaml).

Both are asserted in both directions, because a distinction that only fires one
way is decoration. And the oracle test can now ask of the 94 error cases what it
could not ask before: **none of them is refused by the key-collision rule**,
which is the same question round four asked of the empty-input rule.

### A third implementation, reading what this tool writes

The writing row has rested on js-yaml since round two. One independent reader is
enough to catch a writer that is wrong and not enough to tell a wrong writer
from a limited reader — which came up twice, and both times was settled by
asking CPython by hand, in a comment, with nothing to notice if the answer
changed.

So the same corpus is written out, read by **PyYAML**, and the verdict committed.
It found what one reader could not: **eleven documents came out with a raw tab
inside a plain scalar**. PyYAML 6.0.3 and ruamel.yaml 0.19.1 both refuse those at
the SCANNER — the whole document, not the value — and js-yaml reads them without
complaint. One tab anywhere in a converted file and every Python reader refuses
all of it.

That is legal YAML by the 1.2 grammar and it is a file CPython cannot open, so
it is fixed: a string with a tab in it is written double-quoted, where the tab
becomes `\t` and all four implementations agree. Narrowly — only where the
library would have used a PLAIN scalar. A tab inside a block scalar is read
correctly by all four, and a Makefile arriving as one long escaped line would be
a worse document than the one it replaced.

**What is left is 32 of 284, in three groups, each recorded with who agrees:**

| Group                                                    | How many | Who reads it                                                       |
| -------------------------------------------------------- | -------- | ------------------------------------------------------------------ |
| A root block scalar with content at column 0             | 23       | `yaml`, js-yaml, ruamel. PyYAML alone refuses.                     |
| The same with an explicit indentation indicator (`\|1-`) | 6        | `yaml` and js-yaml. PyYAML and ruamel refuse.                      |
| PyYAML resolving YAML **1.1** types                      | 3        | A 1.2 reader returns the strings; PyYAML returns dates and base-60 |

The first is recorded as PyYAML's limit and **is not fixed**: the emitter has no
option for root indentation, and fixing it means rewriting emitted YAML text by
hand to insert an indentation indicator — which is the very thing the second
group shows implementations disagree about. The third is the reader's schema
rather than this writer's output, and is worth knowing about for a different
reason: a file from this tool fed to a YAML 1.1 reader can change type on the
way in, and no quoting decision on this side is visible to it.

### The one conversion with no reference at all

Image resampling is `drawImage` onto a smaller canvas — the browser's own
resampler, which no specification pins down. It has been `not verified` since
round one on exactly that ground, and the check that existed was narrow: one
pattern, one question, "is this an average rather than a sample".

A reference is possible anyway, and the way in is to stop asking which filter an
engine uses. At an integer reduction, a region constant over a wide
neighbourhood has one answer and every filter gives it. So the pattern is a 4x4
grid of 64x64 flat blocks — two of them one-pixel checkerboards, which is where
a point sampler gives black or white and every symmetric kernel gives the
mean — reduced 4x, and the generator **measures** which of the 4096 output
pixels Pillow's box, bilinear, Hamming and Lanczos all agree about. 2927 of
them.

Measured on those pixels: **Gecko is within one level and WebKit is exact**, at
`imageSmoothingQuality` high, medium and low alike. Both engines do an exact
area average at an integer reduction.

The tolerance is **two**, and it is carried by a control rather than by taste:
nearest-neighbour sits 128 levels from the reference on the same pixels, and
that control is asserted, so a tolerance loosened until it passed would take the
control with it. Shown failing against two deliberate breaks, both measured in
Gecko: `createImageBitmap`'s `resizeQuality: 'pixelated'` gives **128** levels,
and drawing the bitmap at its own size into the smaller canvas — a crop instead
of a scale, which is a plausible edit — gives **255**. Where the four reference filters disagree — by up to 57
levels — the bound is their own spread and the number is reported rather than
asserted, because holding a browser to one of four kernels is not a claim about
this tool.

### Something played a file the video tool made

`docs/manual-checks.md` has carried one line since the tool landed: nothing here
has ever played a file it made. Everything in the suite is about bytes — the
coded pictures survive, the index is in front of the media, the parameter set
says 640x480 — and every one of those is true of files no player will open. A
container is a contract with a decoder.

A real x264 clip is committed for the purpose: twelve frames at 320x240, one
flat colour each, every frame a keyframe, 2.4 kB. It goes through the whole
product, and then the output and the source are **both decoded by the engine**
and compared frame by frame. Identical, all twelve, in Gecko.

Shown failing against two deliberate breaks, both measured in Gecko: the same
clip re-encoded in reverse resolves to `[11, 10, ... 0]` against the ordering
check, and a copy with the sample table's count overwritten does not load at
all. Three things make the equality mean something rather than nothing:

- **The comparison is source against output in the same engine.** Gecko returns
  `rgb(237, 39, 19)` where ffmpeg returns `rgb(219, 18, 18)` for the same coded
  frame — a different YUV-to-RGB matrix, which is a decoder's business. What a
  remuxer must not change is anything.
- **Equality is the easiest thing in the world to get for the wrong reason.**
  Two files that decode to nothing are equal, and so are twelve samples of one
  frame. So each decoded frame is also required to be nearest to its OWN colour
  among the twelve, which is a frame count, an ordering and a drop check in one
  comparison.
- **The decoder has to be able to say no.** The same bytes with the sample
  table's count overwritten must fail to load, or "it played" means only that
  something was handed a URL.

**WebKit records a skip, and the skip is measured.** Playwright's WebKit on
Windows answers `probably` to `canPlayType` for H.264 and then refuses every
H.264 file it is given, **including the source clip ffmpeg wrote**. The control
runs first for exactly that reason: without it, the engine's refusal of our
output would read as a defect in the remuxer.

### RS256 and ES256, from the RFC rather than from ourselves

Every verification in this repository outside RFC 7515 appendix A.1 signed with
WebCrypto and then checked with WebCrypto, which proves two halves of one
primitive agree with each other and is equally true of a broken pair. A.2 and
A.3 publish the key, the signing input and the signature for RS256 and ES256.

The RFC gives its keys as JWKs and this tool takes SPKI PEM, so the conversion
is the only step between the specification's bytes and a test — and it happens
in the generator, in CPython's `cryptography`, not in the test file. The
generator refuses to write a fixture unless CPython **and** Node's WebCrypto both
accept the RFC's signature with the derived key and both reject it with one bit
flipped.

**And one claim in the code turned out to be false.** The `try` around
`subtle.verify` says a malformed signature "throws rather than returning false".
Measured against Node's WebCrypto: an empty, 32-, 63- and 65-byte P-256
signature and an empty and a 7-byte RSA one all come back `false`. Rethrowing
from that catch leaves the whole suite green. The test that looks like it covers
it says so in its own comment rather than claiming coverage it does not have,
and which engines throw is now MEASURED in `check:browsers` instead of asserted
from a code comment.

### A cost guard that is not a clock

Round four deleted a timing assertion rather than repairing it, because
measurement showed no wall-clock bound could separate correct from broken in a
suite running a hundred and twenty files at once. That was right and it left
nothing guarding the path getting several times slower.

There is a guard, and looking for it found the hole it was needed for. The
expensive thing in detection is not the record walk — that is bounded twice and
both bounds have had a document each since round four. It is the YAML
verification: when a document looks delimited, detection asks whether it also
parses as a **mapping**, and that is a real parse. It is given
`body.slice(0, DETECTION_BUDGET)` for the same reason the walk is bounded, and
**removing the slice moved no verdict anywhere in the suite**. A 16 MB paste
would have been fully parsed by a function whose entire job is to guess, and
every test would have stayed green.

The guard works because a YAML fault past the budget cannot be seen by a bounded
parse and cannot be missed by an unbounded one, so the VERDICT says which
happened: a head of `key: a, b` lines that is both delimited-looking and a
mapping, and a fault after 64 kB. Bounded, the verdict stays `yaml`; unbounded,
the parse fails and it becomes `csv`. The positive partner puts the same fault
inside the budget and requires the verdict to move.

**What is still not guarded, said plainly.** `stripBom`, the `sep=` scan and
`trim` all touch the whole string before any bound applies, so detection is
linear in the input whatever happens. There is no clock-free witness for that:
the function has no observable seam a counter could sit in, and the only way to
see the work is to time it.

### The harness now says which harness it was

Round four made `check:browsers` refuse to drive a stale build, and the
exclusion it uses is a path pattern over test files and nothing else — which is
correct, and which says nothing about the harness itself. `scripts/` is not a
source root and should not be: an edit to a check cannot make `dist` stale.

But harness code changes what a run MEANS, and an edit made while a run is in
flight produces a summary about a mixture of two harnesses, with the half that
ran first carrying the old assertions. So the harness hashes itself and
everything it loads, prints the digest at the start so a run can be matched to a
tree, and asserts it unchanged at the end.

### The category round four wrote down, emptied

Round four ran mutation over a **deterministic sample** and said so, and wrote
"the survivors it has not reached" down as a real category rather than pretending
the number was a score. Round five ran the whole space over the conversion code:
**765 mutants**, every one of them, with the tests that claim to cover each file.

| File                         | Mutants | Killed | Timed out | Survived |
| ---------------------------- | ------- | ------ | --------- | -------- |
| `structured-data/convert.ts` | 333     | 253    | 6         | 74       |
| `structured-data/csv.ts`     | 147     | 133    | 3         | 11       |
| `structured-data/jsonc.ts`   | 64      | 44     | 8         | 12       |
| `structured-data/report.ts`  | 9       | 9      | 0         | 0        |
| `diff/compute.ts`            | 212     | 177    | 2         | 33       |

A **timeout is a kill**, and it is recorded separately rather than absorbed
because the thing it catches is different: `index += 1` becoming `index += 0`
inside a scanner is an infinite loop, and vitest cannot interrupt a blocked
worker thread. The first sweep of this round sat on one for four minutes before
anybody looked at it.

**The diff tool was the thinnest of the five going in** — round four's forty
mutants against a tool held to real `git diff` output — and it is the whole file
now.

Reading the survivors is the work, and the shape of what they found is the same
every time: **not a wrong answer, but a claim with nothing behind it.**

| Broken on purpose                                                      | What nothing noticed                                                                                                         |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `fellBack: false`, at five separate returns                            | The Detected report says it GUESSED when it was told. Round four fixed this once at the other end, for `detected: !chosen`   |
| `detected.fellBack && foundNothing`                                    | A `---` document whose lines YAML folds is refused as "not a format", instead of being the document it declared itself to be |
| The doubled-quote skip in detection                                    | A quoted field holding `","` counts three fields, the rows go ragged, and a CSV falls through to YAML                        |
| `fieldStarted = false` at a record boundary                            | The opening quote of the SECOND row is read as a literal, and the comma inside it is counted                                 |
| `counts.length >= DETECTION_RECORDS`                                   | The cap reads fifty-one records. Only a document with exactly fifty terminated records can tell                              |
| The CRLF skip in detection                                             | A record whose first character is the delimiter loses it, and comes back a field short                                       |
| `depth + 1` in the OBJECT branch                                       | The depth guard never fires for `{"a":{"a":…}}`. The existing test was `[[[[…]]]]`, arrays only                              |
| The line and column pulled out of a `JSON.parse` message               | A caret under innocent text. The only thing asserted was that a position EXISTED                                             |
| `invisible: differs && rendersTheSame(…)`                              | Every line an option ignored — a case difference, say — reported as an invisible one                                         |
| `invisible: false` on an added line                                    | An addition reported as an invisible difference from nothing                                                                 |
| `MAX_REFINE_LINE_LENGTH` and `MAX_REFINE_TOTAL_CHARS`, at the boundary | Every test near those bounds was far past them or far short of them                                                          |
| The two offsets that end a block comment                               | One swallows the character after the comment, the other the rest of the file. Both still parse                               |
| `+` inside the two messages this round added                           | The detail under the headline becomes the three letters `NaN`                                                                |

**Thirty-three of the 130 survivors are killed by the twelve assertions round
five added**, and every one of those was run against the specific mutant that
exposed it and seen to fail — which is the only reason to believe a new test is
about what its name says. The `fellBack` table alone accounts for ten of them,
because one table over one function's returns is worth more than ten examples.

**And what is left is written down rather than counted.** A survivor is not a
defect, and about half of these cannot be one:

- **Equivalent.** `sortKeysDeep`'s comparator returning `-0` instead of `-1`
  still sorts, because the `a > b` arm returns 1; `<` becoming `<=` there cannot
  fire, because object keys are unique. `cellToString`'s `||` becoming `&&` is
  round four's own example and is still equivalent. A scanner reading one
  character past the end reads `undefined`, which is not a delimiter, a quote or
  a newline.
- **Reachable, and the reach does not change an answer.** Three of the four CRLF
  mutants in detection move the cursor by one character, and detection's verdict
  is a comparison of field COUNTS that one character cannot move — unless that
  character is the delimiter, which is the document that killed the fourth.
- **Unreachable with this runtime** - and the reason given was false. `jsonErrorPosition` had a second arm for a
  message with an offset and no line and column. This note said "V8 prints both, always". It does not:
  measured in round sixteen, V8's message has NO position at all for 28% of refused documents - every
  "Unexpected token" - and JavaScriptCore's never has one. The one test document happened to be in
  V8's other format. The function is gone; the position is `locateJsonSyntaxError`'s, found from the
  document rather than the message (see [Structured data](#reading)).
- **Unreachable with a valid document.** The JSONC stripper's block-comment
  guard is `char === '/' && source[index + 1] === '*'`, and an `||` there would
  open a comment on a lone `/`. There is no lone `/` outside a string in any
  JSON document — the line-comment branch above it takes `//` first — so the
  only inputs that reach it are ones this tool already refuses.

The honest summary is that the **unreached** category is now empty and the
**unkilled** one is not. What replaced "we sampled" is a list somebody can read,
with a reason beside each entry, and `node scripts/mutate.mjs` to re-run it.

## Found in round six, by reading the appendix list

### The other nine algorithms, and the appendix nobody had read

Round five closed RS256 and ES256 and wrote down why it could close no more:
"RFC 7515 publishes vectors for HS256, RS256 and ES256 and for nothing else".
**That sentence is wrong, and it was wrong in the specification round five had
open.** Appendix A.4 is a fourth example — ECDSA on curve P-521, `alg: ES512` —
and it had been there since 2015. It is also the sharpest of the four for this
tool, because P-521 is the row where a curve table that reads the algorithm name
as the curve name goes wrong: ES512 is not P-512.

Nothing clever found it. The list of appendices was read instead of remembered.

With A.4 in, the remaining eight came from three more places:

| Source                      | Covers                             | What kind of thing it is                                                           |
| --------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| RFC 7520, the JOSE cookbook | PS384, and RS256/ES512/HS256 again | A standards-track document of worked JOSE examples.                                |
| RFC 4231                    | HS384, HS512                       | HMAC-SHA-2 vectors. **Not JWS**: a key, a message and a MAC.                       |
| Project Wycheproof          | RS384, RS512, PS256, PS512, ES384  | A published suite, pinned to a commit. Used only where no RFC has anything to say. |

**Two of those are below the token, and that is stated rather than papered
over.** No published JWS or JWT vector exists for HS384, HS512 or ES384. What
was unverified for those three was one entry each in a table — which hash, which
curve — and `verifySignature` takes its signing input as a string, so a vector
that is a key, a message and a signature goes through the real function
unchanged and settles the real question. What it does not exercise is token
splitting, which does not vary by hash and is settled by the nine vectors that
are tokens.

**Each table entry is isolated by a control, not just covered by a positive.**
RFC 4231 publishes all three MACs over the same key and the same message, so
every vector is also checked under the other two algorithms: same key, same
input, same code path, different hash. The cookbook's 4.1 and 4.2 sign the same
payload with the same RSA key, one PKCS#1 v1.5 and one PSS, so checking each
under the other's algorithm can fail for no reason except the padding. A P-384
key is offered to the ES256 and ES512 paths and must not import; with A.4 in the
fixture, so are P-256 and P-521 to each other's.

All seventeen of those table entries and branches were then broken on purpose,
one at a time, and every break is caught — see
[Seventeen breaks](#seventeen-breaks-and-every-one-of-them-caught).

### The pipeline the published vectors cannot reach

`run` decodes before it verifies, and `decodeToken` requires the payload to be
JSON because RFC 7519 requires a JWT's payload to be one. **Almost every
published JOSE example is a JWS and not a JWT.** RFC 7515 A.4 signs the ASCII
string `Payload`. The cookbook signs a line of Tolkien. Wycheproof signs `foo`.

So of twelve algorithms with published vectors, exactly four can be driven
through this tool's own UI at all: A.1 (HS256), A.2 (RS256), A.3 (ES256), and
Wycheproof's two PS256 salt cases, whose payload is `123400` — which happens to
parse as JSON. Those four run end to end in Gecko and WebKit through the worker
and the verdict banner, with three controls each: a flipped bit, a key of
another kind, and — new, and only possible now that there is more than one key
of each kind — a DIFFERENT key of the same kind, which must read `broken` rather
than `unverified` because a real check happens and loses.

A.1 also drives the **Secret encoding** select, because its key is the RFC's
base64url secret rather than a PEM. Leaving that alone would hash the RFC's
ASCII spelling of the secret instead of the secret, read `broken`, and look
exactly like a signature problem — so the select is driven for every example,
which makes the other three assert that the default really is the default.

The other eight are put to each engine directly: import this key, verify these
bytes, under the parameters the fixture records. That is a narrower question and
it is the one worth asking of a browser — an engine with no RSA-PSS, no P-384 or
no P-521 is one where this tool says `unverified` on a token CI calls verified.
The parameters are read out of the JSON rather than re-derived in the harness,
because a harness that computes "PS384 means a 48-byte salt" for itself is
asserting its own belief twice.

This is a limitation of the tool's input contract, and it is now asserted in
both directions — the refusal happens, and the same bytes verify — so a change
to it is a failing test and a decision rather than something that quietly starts
or stops happening.

### Seventeen breaks, and every one of them caught

A test that passes against a broken version of the code is not a test, and the
twelve algorithms above are twelve table entries whose whole content is one
string each. So each was broken on purpose, one at a time, and the suite run
against it. All seventeen are caught, and by the test written for them:

| The break                                  | Noticed by                                      |
| ------------------------------------------ | ----------------------------------------------- |
| HS384, HS512 given the wrong hash          | RFC 4231's vectors for that algorithm           |
| RS384, RS512 given the wrong hash          | Wycheproof's JWS vectors for that algorithm     |
| PS256, PS512 given the wrong hash          | Wycheproof's JWS vectors for that algorithm     |
| PS384 given the wrong hash                 | RFC 7520 4.2, and the PKCS#1-versus-PSS control |
| ES384, ES512 given the wrong hash          | Wycheproof's ES384 group; RFC 7515 A.4          |
| ES384 on P-256; ES512 on P-256             | the same, 146 and 6 assertions respectively     |
| PS\* verified as PKCS#1 v1.5; salt halved  | RFC 7520 4.2 and every Wycheproof PS case       |
| PS\* imported as PKCS#1 v1.5               | the same twelve                                 |
| `none` compared case-sensitively           | Wycheproof's `alg: NONE` case                   |
| a failed import reported as a failed check | the key-of-another-kind controls                |
| every signature reported as verified       | 136 of 316                                      |

The least-covered break is `PS384 given the wrong hash`, at two failing tests.
That is the one algorithm covered by a single positive vector plus one control,
and it is worth knowing which row is thinnest.

### A check that was measuring the machine, again

Round six did not go looking for this one; a run reported it. **The first screen
renders with no JavaScript at all** failed in Gecko, on the same bytes WebKit
passed on two lines further down the same log, in a round that changed nothing
about the first screen.

The mechanism, produced on purpose rather than guessed at: with JavaScript off
that document has no scripts, so Gecko fires `DOMContentLoaded` **without
waiting for the render-blocking stylesheet** - and `isVisible()` does not wait
for anything. Delay the stylesheet by 150ms and the snapshot is false on every
run, while the bounding box that arrives a moment later is the UNSTYLED
1264x38 `h1`. The element was always there; the answer was about timing, on a
browser twenty minutes and two thousand checks into a run.

It is the same shape as round four's stopwatch and round five's
wait-for-the-previous-answer: a check whose verdict depends on how busy the
machine is. It waits for the state now instead of sampling it, and the repair
was held to the same standard as a new check - it passes with the stylesheet
delayed, and it still FAILS when the headline is renamed out of
`dist/index.html`, which is the break it exists to catch.

### The disagreement the gate found

The generator's rule is that CPython and Node must both reach the published
verdict before a fixture is written. On the first Wycheproof run it stopped:
case 332 is published as **invalid** and both verifiers called it valid.

Neither was wrong. Wycheproof gives its keys as JWKs, and a JWK may carry an
`alg` that RESTRICTS the key (RFC 7517 section 4.4); case 332 is a correctly
computed RS256 signature made with a key whose JWK says `alg: PS512`, so a
library that honours the key must refuse it. This tool's key input is an SPKI
PEM, which carries a key and no policy at all — there is nowhere for that
restriction to live, and inventing one would mean guessing at a constraint the
user never expressed.

So the five cases of that shape are kept, classified as `key-policy` rather than
`cryptographic`, and the gate now asserts the OPPOSITE for them: both verifiers
must find them valid, which is what makes the disagreement with the suite the
one named here rather than an unexplained failure. The alternative was to drop
five cases quietly, and a suite you are allowed to delete from is not a suite.

## Still unverified, and how to verify it

Six rounds in, the list is short and every item on it is short for a stated
reason rather than for want of trying. Round six closed the first entry as far
as anything published allows and replaced it with two narrower ones — one a
limit of this tool's input contract, one a feature it does not have.

1. **The whole pipeline, for eight of the twelve algorithms.** Closed as far as
   anything published allows: all twelve now rest on an external vector, and
   round six's list of what remains is shorter and different in kind. What is
   left is that `run` cannot be driven by most of them, because `decodeToken`
   requires a JSON payload and almost every published JOSE example is a JWS
   rather than a JWT. HS256, RS256, ES256 and PS256 go end to end in two
   engines; the other eight are settled at `verifySignature`, and each engine is
   separately asked whether it reaches the published verdict for the published
   bytes.
   **What it would take:** either a published JWT — not JWS — vector for the
   other eight, which does not appear to exist, or a decision to let this tool
   verify a JWS whose payload is not JSON. The second is a product change rather
   than a test, and it is the tool's input contract, so it belongs in a commit
   that argues for it.

2. **The JWK `alg` constraint.** Five Wycheproof cases are valid signatures the
   suite refuses because the key's JWK restricts it to another algorithm. This
   tool takes an SPKI PEM, which carries no such field. **What it would take:** a
   JWK key input, which is a feature and not a fix — and a real one, since a JWKS
   endpoint's keys are JWKs. Recorded rather than done.

3. **Playback in WebKit.** Gecko plays the file the video tool made and every
   frame matches the source. Playwright's WebKit refuses every H.264 file it is
   given, _including the one ffmpeg wrote_, so it cannot answer. **What it would
   take:** Safari itself, on a Mac. That is what
   [docs/manual-checks.md](manual-checks.md) is for, and the entry is now a
   comparison against a known-good clip rather than "play it and see".

4. **`compareMarkup` against an element that MOVED, and against a VALUE that
   changed.** It counts what each document contains, so an element that gained a
   parent is not reported. Stated in the code, and still true. **What it would
   take:** a tree diff rather than a census — which is a different instrument,
   not a fix to this one.
   **The sentence that used to end this item was wrong.** It said the other half
   of that note, an attribute whose VALUE changed, "was resolved in round four".
   Round four resolved it for `id` and `name`, via `renamedIdentifiers`. `class`
   is a second case and is not covered: `hast-util-sanitize` allows `className`
   on `<a>` with a value filter, so `class="btn"` is EMPTIED rather than removed
   and a census of names cannot tell `class=""` from `class="btn"`. That is
   corpus row 16, and round ten is the evidence rather than the argument — the
   census was added to the target the finding was reported on and the row did
   not move.
   **Round thirteen built the smaller half of it.** The census now carries
   class NAMES per element - the second set of values a pipeline here rewrites,
   after `id` - and row 16 turned on its original expectation. A general value
   census was measured and rejected: the round trip percent-encodes a URL, so
   it would name every link with a space in it. **The text dimension is still
   not built**, and is still what corpus row 13 needs to name a dropped
   caption's CONTENTS rather than its tag.

5. **A root-level block scalar, and which implementation is right.** Round five
   measured it rather than settling it: `yaml`, js-yaml and ruamel.yaml read a
   root `|` with content at column 0; PyYAML refuses it. With an explicit
   indicator the readers split two and two, because the indicator is defined
   relative to the parent node and at the root that is -1. **What it would take:**
   a ruling, not a measurement — the spec text is not decisive and four
   implementations do not agree. Writing the output differently would mean
   rewriting emitted YAML by hand, which is a new hazard in exchange for a
   contested one.

6. **The cost of detection, in wall-clock terms.** Round four deleted the
   assertion and round five replaced the part that could be replaced: the three
   bounds on the decision are each held by a document that its own bound alone
   decides, and the third of those — the YAML verification — is what turns a
   bounded guess into a full parse of a 16 MB file if it is removed. What is left
   is linear: `stripBom`, the `sep=` scan and `trim` touch the whole string
   before any bound applies. **What it would take:** an observable seam for a
   counter to sit in, and there is not one; the only other way to see that work
   is a clock, which measurement showed cannot separate correct from broken in a
   suite this parallel.

## A plan for the rounds after this one

**Round two — done.** The evidence: YAML against the suite and against js-yaml,
the nine skips in `check:browsers` examined one at a time, the generators re-run
from a clean checkout, every randomised test run thirty times, and the
worker-wedge question settled by measurement.

**Round three — done, and it was the decisions.** All seven, plus the five
smaller silent losses and the byte order mark. The `lossy, silent` column is
empty. Four cells turned out to be **fixable** rather than merely reportable,
which was not the expectation going in: the empty document in a stream, the
delimited-detection guess, the colour quantisation, and the YAML stream itself.

**Round four — done, and it was one question.** _Of everything this document
asserts, how much could fail?_ Asked by mutation over the conversion code, by
breaking the harness on purpose, and by classifying the 94 YAML refusals instead
of counting them. It found a real defect in the by-path reports, a broken
in-document link `compareMarkup` is documented as unable to see, a second suite
case refused for the wrong reason, and six claims in this file that nothing was
holding.

**Round five — done, and it was everything that needed a second opinion.** The
cells left were the ones no test could settle from inside: a specification's own
bytes for RS256 and ES256, a second language's YAML library reading what this
one writes, a reference resampler for an image downscale, and a real decoder for
a file the video tool made. Of the six items round four left, **five moved**:
image downscaling and RS256/ES256 are `exact`, the video tool's output is
`exact` in one engine and an honest skip in the other, the 29 YAML cases the
suite would only describe are decided, and the writing row rests on two
independent readers rather than one and a footnote. The sixth — `compareMarkup`
against an element that moved — is unchanged and is a different instrument
rather than a fix to this one.

Each of the four new instruments found something the round was not looking for:
a valid document told it was invalid, eleven files CPython cannot open, a code
comment that was false about every engine, and a 64 kB bound that nothing was
holding.

**Round six — done, and it was one gap taken seriously.** Round five closed
RS256 and ES256 and left nine of the twelve JWS algorithms resting on nothing
outside this repository, with a note saying no published vector existed. Looking
properly found one for every single one of them, in four places, and found that
the note was wrong about the specification it had open — RFC 7515 appendix A.4
had been publishing an ES512 vector since 2015. It also found that the gap list
itself had a gap: RS384 and RS512 were not on it and were not covered either.

What the round could not close it wrote down rather than worked around: nine of
the twelve cannot be driven through the tool's whole pipeline by anything
published, because almost every published JOSE example is a JWS and not a JWT.

**Round seven — the shape of it.** Two candidates, and they are different in
kind:

- **The evidence that is still ours.** Two fixtures in this repository are
  generated by a script this repository wrote: the YAML event composer and the
  resampling agreement mask. Each is validated against an external answer before
  it is trusted — 278 of the suite's own cases, four reference filters — and
  that is the right shape, but it is worth asking of each one whether the
  validation could pass while the generator was wrong. The JWS fixtures were the
  third, and round six answered it for them: the generator derives its own
  parameters rather than importing the tool's, and two independent verifiers
  have to agree with the published verdict before anything is written.
- **The tools this document has never covered.** Base64, hash, regex and colour
  each have a row, and the rows are thinner than the four above. Hash has
  published vectors and does not use them; regex has no corpus at all. **This is
  the one to take**: round six's whole result came from asking "what has somebody
  published for this?" about a tool whose row said nothing had, and hash is the
  same question with an easier answer waiting.

Running through all of them: **every `lossy, silent` cell should become
`lossy, told` or `exact`.** That was the whole of what this document was for,
and the count was the measure. It is **zero**, and round four's question was the
one that replaced it: of everything this document asserts, how much could fail?
