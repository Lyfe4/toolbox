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
- [What the count was, and is](#what-the-count-was-and-is)
- [Markdown to HTML, relabelled](#markdown-to-html-relabelled)
- [What changed for a person pasting a document](#what-changed-for-a-person-pasting-a-document)
- [Found this round](#found-this-round)
- [What was looked for and not found](#what-was-looked-for-and-not-found)
- [Still unverified, and how to verify it](#still-unverified-and-how-to-verify-it)

## What the verdicts mean

| Verdict           | Means                                                                                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **exact**         | The output is the one an external reference gives for the same input. Nothing is lost.                                                                                                                                                                                                           |
| **lossy, told**   | Something cannot survive the conversion, the loss is intentional and consistent, **and the user is told without doing anything** — on the panel on `/tools` AND on the canvas node. A port that has to be wired up to be read does not count; see [Where a loss is said](#where-a-loss-is-said). |
| **lossy, silent** | The same, except nobody is told. This is a defect, whatever the reason for the loss.                                                                                                                                                                                                             |
| **broken**        | The output is wrong, for input a person would realistically produce.                                                                                                                                                                                                                             |
| **not verified**  | It may be right. Nothing outside this repository has said so.                                                                                                                                                                                                                                    |

`lossy, silent` is deliberately not a comfortable category. **It is empty.**

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

| From  | Verdict                                 | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSV   | **exact**                               | 32 documents read by CPython's `csv.reader` and by this parser, field for field, including a lone CR terminator, a NUL byte, a quote opening mid-field, a field of four quotes, CRLF inside a quoted cell and every delimiter offered. [`csv.oracle.test.ts`](../src/tools/structured-data/csv.oracle.test.ts)                                                                                                                                                                                                                                                                                                         |
| TSV   | **exact**                               | Same corpus, tab delimiter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| JSON  | **lossy, told**                         | Structure and strings are exact — it is `JSON.parse`. **Integers past 2^53 are rounded**, which is unavoidable, and each one is now reported by path. See [Numbers](#numbers-past-253-unavoidable-and-no-longer-silent).                                                                                                                                                                                                                                                                                                                                                                                               |
| JSONC | **exact**, against VS Code's own parser | `//` and `/* */` comments and trailing commas are removed before parsing, and the document is read as the author meant it. 25 documents are compared against `jsonc-parser` — the parser Visual Studio Code uses for its own settings files — value for value, including every case that decides whether a stripper tracks string state: a `//` inside a URL, a `/*` inside a glob, an escaped quote in front of a comment marker. [`jsonc.oracle.test.ts`](../src/tools/structured-data/jsonc.oracle.test.ts)                                                                                                         |
| YAML  | **exact**, with 9 named exceptions      | 402 cases from the [yaml-test-suite](https://github.com/yaml/yaml-test-suite)'s own `data-2022-01-17` release, committed as [`spec/yaml-test-suite.json`](../src/tools/structured-data/spec/yaml-test-suite.json). 94 documents the suite marks as errors are all refused; 279 carry the value a conforming parser must produce and **270 of them match exactly — 258 before this round**. The 9 that do not are listed by id with a reason, each is asserted to **still** differ, and the 12 that were fixed are asserted to **now agree**. [`yaml.oracle.test.ts`](../src/tools/structured-data/yaml.oracle.test.ts) |

### Writing

| To   | Verdict                              | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON | **exact**                            | `JSON.stringify`. Subject to the same integer ceiling on the way in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| YAML | **exact**, with one named exception  | Every document the tool can read from the yaml-test-suite is re-serialised and read back by **js-yaml**, a separate implementation with a separate ancestry, as a dev-only oracle. 278 of 279 come back as the same value. The one that does not is NAT4, whose strings are nothing but newlines: our writer emits `\n` as a keep-chomped `\|+` block scalar, js-yaml 5.4.2 refuses it, and CPython's PyYAML 6.0.3 — asked as a third opinion, because two implementations disagreeing is evidence about neither — reads it correctly. Recorded as js-yaml's limit, and asserted as itself. |
| CSV  | **exact**, with two stated spellings | 12 record sets written by CPython's `csv.writer` and by this writer, byte for byte. Two deliberate differences, each asserted as itself: no terminator after the last record (RFC 4180 permits both), and a field with leading or trailing whitespace is quoted where Python leaves it bare — the oracle was asked to read both spellings and returned the same field for each.                                                                                                                                                                                                             |
| TSV  | **exact**                            | Same corpus, tab delimiter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Between formats

Every conversion goes through the same JSON-shaped value, so the cell is the
combination of the two halves above plus what the target format cannot hold.

| From → To                     | Verdict                  | What is lost, and whether you are told                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| JSON → YAML                   | **exact**                | Nothing. Key order is preserved unless `sortKeys` is on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| YAML → JSON                   | **lossy, told**          | Comments, anchors, tags and the choice of block style are not JSON and are dropped. Anything JSON genuinely cannot hold — a `!!binary`, a `!!set`, a collection used as a key, a 1.1 timestamp — is **refused by path**, not mangled.                                                                                                                                                                                                                                                                                                                                          |
| JSON/YAML → CSV/TSV           | **lossy, told**          | Three losses, all real and all now reported **by path**: a nested value becomes compact JSON inside the cell (`$[0].user`); a key absent from one row becomes an empty cell indistinguishable from a present-and-empty one, and the columns are named; and every value becomes text. A non-array, or an array of non-objects, is refused clearly. [`reports.test.ts`](../src/tools/structured-data/reports.test.ts)                                                                                                                                                            |
| CSV/TSV → JSON/YAML           | **lossy, told**          | Every cell becomes a **string**, deliberately — `01234` is a part number, not the number 1234 — and the tool's README states it. Line endings inside quoted cells survive verbatim.                                                                                                                                                                                                                                                                                                                                                                                            |
| YAML stream → YAML            | **exact**                | **Fixed in round three.** A `---`-separated stream is written back as a stream, with a `---` in front of each document. It used to come back as a **sequence**, so a Kubernetes manifest that went through this tool was a file `kubectl` will not read, silently. The report says which of the two happened, and says it from the WRITER rather than from the source — `sortKeys` and a value arriving on the `json` port can both put a different array in front of it.                                                                                                      |
| YAML stream → JSON/CSV/TSV    | **lossy, told**          | None of the three has a document separator, so the documents become the elements of an array — which is the only JSON-representable form of a stream, and is still a file that does not convert back. Reported, with the count and with "choose YAML as the target to keep the stream". JSON Lines in is the same fact and gets the same note.                                                                                                                                                                                                                                 |
| An empty document in a stream | **fixed in round three** | Found by the yaml-test-suite in round two. `---` STARTS a document and an empty one is `null`; dropping it made a five-document stream come back as a four-element array with no error. Three references agree about the same bytes — the suite's PUW8, js-yaml 5.4.2, and CPython's PyYAML 6.0.3, each asked directly. The rule is now "an empty document with no `---` to declare it", which keeps the case it was really for: an empty input box still says "nothing to parse" rather than producing `null`. Twelve of the twenty-one suite divergences were this one rule. |
| Anything → CSV                | **lossy, told**          | The output has no terminator after the last record and uses LF, whatever the input used. RFC 4180 specifies CRLF; every reader accepts LF. Reported at `info` on every CSV write — nothing is lost, the table reads back identically, and the fact matters exactly when the next step is a byte comparison or a digest, which on this canvas is one wire away.                                                                                                                                                                                                                 |

### Detection

| Input                                                                                               | Verdict                  | Note                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON, YAML, CSV, TSV, semicolon, `sep=`                                                             | **exact**                | Named regression tests, each from a document that was previously read as the wrong format.                                                                                                                                                                                                                                                                                                                                 |
| Near-JSON: single quotes, unquoted keys, trailing commas                                            | **exact**                | Read as the document the author meant, through the YAML fallback.                                                                                                                                                                                                                                                                                                                                                          |
| Near-JSON: `//` comments, block comments, a literal newline in a string, a key split over two lines | **fixed this round**     | Were **broken**: the YAML fallback folded lines and produced a plausible object. Now reported as the JSON syntax error they are.                                                                                                                                                                                                                                                                                           |
| Prose, a ragged CSV, a log                                                                          | **fixed this round**     | Were **broken**: folded into one string with the line breaks replaced by spaces, reported as success. Now refused.                                                                                                                                                                                                                                                                                                         |
| Two lines of text with one comma each                                                               | **fixed in round three** | Was **broken**: `tags: a, b` over `names: c, d` was read as a one-row table with the columns `tags: a` and `b`. The fix is not a higher bar — "three records or it is not a table" refuses a header and one row, which is a real file — but a different question with an answer: does this also parse as a YAML **mapping**? A genuine CSV folds to a plain scalar. Five realistic tables are asserted to still be tables. |
| Whatever was detected                                                                               | **fixed in round three** | The tool now says which format it decided on, which delimiter it used, and whether it guessed at all, on a `Detected` report port drawn on `/tools` and summarised on the canvas node.                                                                                                                                                                                                                                     |
| Twenty-nine realistic documents                                                                     | **exact**                | Committed as [`spec/detection-corpus.json`](../src/tools/structured-data/spec/detection-corpus.json): the document, the format it is detected as, and the value it reads to. Round one ran a corpus of this shape and did not write it down; this one is a fixture so the next round can re-run it. See [What changed for a person pasting a document](#what-changed-for-a-person-pasting-a-document).                     |

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
> became 12345678901234567000. At `$.id`, `$.ok`. Convert to CSV or TSV to keep
> the digits, where every cell stays a string.

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
what the note suggests as the way out.

## Text convert

[`src/tools/text-convert`](../src/tools/text-convert). Markdown and HTML are
sources; Markdown, plain text and TWO HTML targets — sanitised and normalised —
are the destinations. Everything routes through HTML.

| From → To                | Verdict              | Evidence, and what is lost                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown → HTML          | **lossy, told**      | CommonMark 0.31.2, 624 of 652, and GFM, 21 of 24, compared by parsed DOM — and **624 of 652 is not what `exact` means**, which is what this cell used to claim. Every one of the 28 differs because this tool will not copy raw HTML through, and that refusal is the product. It is now reported: the same chain is run with the allow-list off and the two documents compared, so the note names what was really removed rather than what a schema suggests. See [Markdown to HTML, relabelled](#markdown-to-html-relabelled). |
| HTML → Markdown          | **lossy, told**      | Anything Markdown cannot express is governed by the `unsupported` option — `keep` writes the element back as inline HTML, `text` keeps its text, `drop` removes it. The option is on the panel, which is where the user is told.                                                                                                                                                                                                                                                                                                 |
| HTML → plain text        | **lossy, told**      | All markup, by definition. The options say what happens to links, list markers and tables.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Markdown → plain text    | **lossy, told**      | Same.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Markdown → Markdown      | **lossy, told**      | Normalisation through HTML. Three constructs do not survive and each is named: footnotes stop being footnotes (a reference becomes a link to an anchor, the definitions a `## Footnotes` section), `$$…$$` display maths becomes a fence tagged `math`, and a bare URL becomes an explicit link when `linkify` is on. Reformatting — a different bullet, a different heading style — is reported at `info`, because the document means the same thing and a warning on every run is one nobody reads.                            |
| HTML → HTML (sanitised)  | **lossy, told**      | **New in round three.** The sanitiser and nothing else: no Markdown round trip, so nothing is invented. What the allow-list removes is reported, measured by comparing the two documents rather than by listing the schema.                                                                                                                                                                                                                                                                                                      |
| HTML → HTML (normalised) | **lossy, told**      | The pass that used to be called "HTML". It runs through Markdown, so it is bounded by what Markdown can express, and the two halves now answer separately: input against sanitised is the allow-list’s doing, sanitised against normalised is the round trip’s. Measured: `<img width>` is dropped, a `<div>` is unwrapped, a `colspan` becomes an empty cell, and a `<table>` with no header **gains an empty header row that was not in the input**, reported as an invention.                                                 |
| Detection                | **fixed this round** | Was **broken** for the single most common thing an LLM writes about HTML: `Use \`<div>\` here.` was detected as HTML, **confidently**, because the tag search ran over the document as written. The conversion then read the code span's contents as markup. Fenced blocks and inline code spans are now blanked out before the search, and only before that search — a fence is still a Markdown signal.                                                                                                                        |
| Hard break → text        | **fixed this round** | Was **broken**: Markdown's hard break (two trailing spaces, or a trailing backslash) became `<br>` plus a newline, and the text renderer emitted both, so a line break came out as a blank line. The same `<br>` written without the newline came out correctly, so one construct had two answers.                                                                                                                                                                                                                               |
| `rendered` port          | **exact**            | Always sanitised HTML, for every source and target. Asserted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

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

| Operation                   | Verdict          | Evidence                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decode header and payload   | **exact**        | RFC 7515 appendix A.1, added this round: the published header and payload, decoded to the values the RFC prints.                                                                                                                                                                                                                                                             |
| HS256 verification          | **exact**        | The same appendix's key and signature. Verified, and reported invalid when one character of the signature or of the payload changes.                                                                                                                                                                                                                                         |
| HS384/512, RS\*, PS\*, ES\* | **not verified** | WebCrypto does the work and the surrounding code is exercised, but no published vector is checked for these. RFC 7515 has appendices for RS256 and ES256 and they are not used yet.                                                                                                                                                                                          |
| `alg: none`                 | **exact**        | Refused outright, as its own status.                                                                                                                                                                                                                                                                                                                                         |
| Large numeric claims        | **lossy, told**  | A `sub` or `jti` that is a 64-bit integer is rounded by `JSON.parse`, the same loss as [structured data’s](#numbers-past-253-unavoidable-and-no-longer-silent) and asked the same exact way. Reported by path on a `Report` port; the decoded claims and the signature verdict are unchanged, because the signature is checked against the bytes the rounding never touched. |

## Colour

[`src/tools/color-convert`](../src/tools/color-convert).

| Direction                                  | Verdict                  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hex ↔ rgb                                  | **exact**                | Integer quantised both ways. Every colour in a fixed stride through the whole cube.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| sRGB ↔ HSL                                 | **exact**                | Exact to the 8-bit step from one decimal place.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| sRGB ↔ OKLCH                               | **fixed this round**     | Was **broken** for 13,626 colours. All 16,777,216 were written as `oklch()` and read back at each precision: 3 places lost 3,532,330 colours, **4 places lost 13,626**, 5 places lost none. The default was four. The 13,626 are saturated cyans and teals with the red channel pinned at zero — `#00bec7` wrote as `oklch(0.729 0.1239 200.83)` and read back `#01bec7` — which is the corner a 266-colour corpus is least likely to contain. The default is five.                                       |
| `hsl(h s l)` with bare numbers             | **fixed this round**     | Was **broken**: CSS Color 4 says a bare number in `hsl()` means that many percent, so `hsl(217 91 60)` is `hsl(217 91% 60%)`. It was read as a 0–1 fraction, clamped, and came back **white**. It is the spelling every Tailwind theme and every CSS custom property holding three numbers uses.                                                                                                                                                                                                          |
| A percentage where a hue belongs           | **fixed this round**     | Was **broken**: scaled by 360, so `hsl(50% 100% 50%)` silently became 180deg. A hue is `<number> \| <angle>` in every notation here; a percentage is now refused.                                                                                                                                                                                                                                                                                                                                         |
| Named colours, `color()`, `lab()`, `hwb()` | **lossy, told**          | Refused by name, with the supported notations listed. Deliberate — resolving names means shipping the 148-entry CSS table.                                                                                                                                                                                                                                                                                                                                                                                |
| Out-of-gamut OKLCH                         | **lossy, told**          | Clipped per channel and **reported** as out of gamut rather than silently corrected.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `rgb(50% 50% 50%)`                         | **fixed in round three** | 50% is exactly 127.5, which the payload used to keep — so hex printed `#808080` while oklch printed the value for 127.5, and the report’s own rows described colours one 8-bit step apart. `rgb()` is quantised once, at the parse, because that is what a browser does: `getComputedStyle` on `color: rgb(50% 50% 50%)` returns `rgb(128, 128, 128)`, which is asserted in both engines in `check:browsers` rather than taken on trust. `hsl()` and `oklch()` are continuous in CSS and are not touched. |

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

| Conversion                | Verdict          | Evidence                                                                                                                                                  |
| ------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PNG ↔ WebP (lossless-ish) | **lossy, told**  | Re-encoding always. Pixel fidelity measured on decoded pixels in two real engines.                                                                        |
| → JPEG                    | **lossy, told**  | Quality option, and transparency matted onto white with a note.                                                                                           |
| Animated GIF → still      | **lossy, told**  | Note on the result, repeated in the summary line.                                                                                                         |
| EXIF, GPS, colour profile | **lossy, told**  | Stripped, and the report says what was removed — which in an app whose pitch is that your data does not move is the note that most needed making.         |
| Orientation               | **exact**        | Honoured by both engines, asserted on decoded pixels.                                                                                                     |
| Downscaling               | **not verified** | An 8× downscale of one-pixel stripes comes back uniform grey rather than aliased, which is right, but there is no reference resampler to compare against. |

## Video

[`src/tools/video-remux`](../src/tools/video-remux). A container change, never a
re-encode.

| Conversion                    | Verdict          | Evidence                                                                                                                            |
| ----------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| MKV/MOV/TS/AVI → MP4          | **lossy, told**  | Every coded picture is the encoder's own, byte for byte; the framing around it is rewritten and the result says so.                 |
| Recording location and date   | **lossy, told**  | Warned on the result and asserted on the output bytes.                                                                              |
| Rotation                      | **exact**        | The track header's transform is carried, which a rebuilt header would have dropped.                                                 |
| Codecs an MP4 cannot carry    | **lossy, told**  | Refused by name.                                                                                                                    |
| Playback of the produced file | **not verified** | Nothing in this repository has ever played a file this tool made. It is the last item on [docs/manual-checks.md](manual-checks.md). |

## The canvas: one node's failure reaching another

A `lossy, silent` cell is a value that changes. This is the other kind of
wrongness a canvas can have: a node that reports a failure it did not cause.

| Case                                      | Verdict              | Evidence                                                                                                                                                                       |
| ----------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A node beside one that runs away          | **fixed this round** | Was **broken**, and not on a slow machine — on an idle one, 10 runs out of 10 in both engines. See [The bystander](#the-bystander-a-node-failing-for-something-it-did-not-do). |
| A node downstream of that node            | **fixed this round** | Reported `upstream` for the same reason, on every one of those runs.                                                                                                           |
| A node whose own tool really did run over | **exact**            | Reports `timeout` with the tool's own message, and the worker is destroyed. Unchanged.                                                                                         |
| A node whose buffers were transferred     | **lossy, told**      | Refused a replay, because a transferred buffer is detached and a replay would compute over nothing. Told as an interrupted run rather than as a wrong answer.                  |

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
are on its second or third port. So four of round three's six reports would have
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
  that are not the same.
- `regex-tester` names it as a `warn`, because a BOM sits in front of position 0
  and is exactly why an anchored pattern finds nothing with no explanation.

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

## Still unverified, and how to verify it

In the order I would do them.

1. **JWT beyond HS256.** RFC 7515 appendices A.2 (RS256) and A.3 (ES256) carry
   complete key material and signatures. Two more fixtures.
2. **The worker boundary, with hostile text.** Everything in
   `wireFidelity.integration.test.ts` runs on the main thread, because jsdom has
   no Worker. A structured clone of a string containing a lone surrogate, a NUL
   and an astral character should be asserted in `check:browsers`, in both
   engines, over a real `postMessage`.
3. **Image resampling.** No reference. A fixed 8×8 pattern downscaled by a known
   factor, compared against the same operation in a reference resampler run
   offline and committed as expected pixels, would turn `not verified` into a
   verdict.
4. **The video tool's output, played.** Still nothing in this repository has
   played a file it made.
5. **The 29 YAML cases the suite describes only as an event stream.** They carry
   no `in.json`, so the fixture cannot decide them and the count is asserted
   rather than the cases being dropped. Reading the suite's `test.event` files
   and comparing a composed event stream would decide them; it needs an event
   emitter this tool does not have.
6. **Our YAML writer against a third implementation.** js-yaml is one independent
   reader. PyYAML settled two disagreements by hand — the `\n` block scalar in
   round two and the empty-document rule in round three — but it is not in the
   suite. A generator that runs our writer's output through CPython and commits
   the answers would make the writing row rest on two references rather than one
   and a footnote.
7. **`compareMarkup` against an element that MOVED.** It counts what each
   document contains, so an element that gained a parent is not reported and an
   attribute whose value changed is not either. Both are stated in the code; the
   second one has a real instance — the sanitiser namespaces `id` to
   `user-content-*` — which is documented elsewhere and is not reported by this
   instrument.

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

**Round four — the boundaries jsdom cannot see.** Unchanged from round two's
plan, and now with one more item: the worker boundary with hostile text, plus a
pass over `check:browsers` asking of every check the question the
negative-assertion audit asked — can this fail? Round two did that for the skips
and found one worth converting; it did not do it for the assertions. Round
three's SF5V finding is the same question asked of a different suite, and it
found something, which is an argument for asking it everywhere.

**Round five — the two binary tools.** Image resampling against a reference, and
the video tool's output played by something. Both need work outside the test
suite, which is why they are last rather than because they matter least.

Running through all of them: **every `lossy, silent` cell should become
`lossy, told` or `exact`.** That was the whole of what this document was for,
and the count was the measure. It is **zero**. What replaces it as the measure
is harder and is round four's: of everything this document asserts, how much
could fail?
