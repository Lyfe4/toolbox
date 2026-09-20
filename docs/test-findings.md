# Patchbay tools — test findings

**This document is two voices, and they are marked.** Everything from
_Scope_ down to _Not yet tested_ is the manual write-up exactly as it was
handed over, numbering included, so that a finding can be referred to by its
number for as long as it is open. Every block headed **Verified** is the
reply: what reproducing it found, whether a check should have caught it, and
where a decision is already recorded. Nothing in the original has been
edited — where the reply disagrees with it, the reply says so and the
original stays as written.

Round eight, 2026-09-20, against `592b3b2`.

> **Round nine, 2026-09-20, against `8a5f8ae`, is at the end of this
> document** — [Round nine, done](#round-nine-done). It builds the first item
> of the plan below and the instrument the count section asks for. The plan
> and the count section are left exactly as round eight wrote them, because
> what round nine measured is only interesting next to what round eight
> predicted: **the plan says four, and the corpus measures three.** Round nine
> says why under [What the framing got wrong](#what-the-framing-got-wrong).
>
> **Round ten, 2026-09-20, against `17349a3`, is after it** —
> [Round ten, done](#round-ten-done). It builds the second item of the plan —
> the census the Markdown target never had — and fixes TC-1's newline, which
> is the one open item in this document that produces a wrongly rendered
> document. **The ratio goes from 3 of 17 to 6 of 17.** It also found two
> sentences the tool was printing that were false, one of them since round
> four, and both were found by a negative control rather than by reading
> anything.

**The four-line summary of the reply.** Of the 40 numbered findings, 15
reproduce exactly as described, 11 reproduce with a different cause or scope,
3 are worse than reported, 6 do not reproduce, and 5 are behaviour with the
decision already recorded somewhere. Reproducing them found four defects the
write-up does not name — one of which, a YAML alias with no anchor reported as
a resource-exhaustion refusal, is fixed here — and **two matrix cells that say
`lossy, told` and are silent**, not one. The three cross-cutting themes are
right about what is wrong and wrong about what to do: one of them is three
different jobs, one is settled here against the write-up's argument, and the
largest group in the document is a fourth theme it does not name — **a tool
with no channel to say anything at all.**

---

**Scope:** 8 of 10 tools tested. Image convert and Video remux untested (require binary inputs). Canvas wiring between tools untested.

**How to read this:** Every finding was reproduced with a specific input, recorded below. "Confirmed working" sections matter as much as the findings — they mark ground already covered, and several of them contain the counter-example that shows a fix is cheap.

---

## Method

Testing was done manually through the live UI at `patchbay-tools.netlify.app`, in a loop:

1. **Fixture written** against a specific hypothesis — not random input. Each one stacks several edge cases that a given tool is plausibly wrong about, with the source format, target format and any relevant option settings specified alongside it.
2. **Run in the browser**, with the result returned as a screenshot of the full page (or pasted output text where the output was long). Screenshots rather than copied text mattered: several findings only surfaced because the options panel, the Report block, the lossy-output port or a status banner was visible alongside the output.
3. **Result assessed** against what the format spec requires and what the tool's own description claims. Anything ambiguous became the next fixture rather than a guess.
4. **Narrowed by bisection** when a fixture failed for unclear reasons. Several findings took three or four follow-up runs to isolate — SD-1 needed four to separate "ragged rows" from "no quoted fields" as the cause of the detection failure, and SD-4 needed three to establish that header trimming happens on output and not just during the uniqueness check.

Two things shaped the findings beyond simple pass/fail:

- **Claims in the tool's own descriptions were treated as testable.** CC-1 and CC-3 are findings specifically because the colour tool says out-of-gamut colours are reported rather than clipped. Diff's invisible-character claim was tested the same way and passed.
- **Fail-fast behaviour hid results.** Where a tool stops at the first error, the remaining cases in that fixture were never exercised, so several fixtures had to be split and re-run one value at a time. SD-12 is itself a finding about this.

Where a result couldn't be judged by eye — `&nbsp;` versus a regular space renders identically — it was settled by measurement. TC-2 was confirmed by hashing the tool's output and a hand-typed control and comparing digests.

**Not covered by this method:** file-upload paths (everything was pasted text), the canvas wiring between tools, and anything requiring a binary input. See _Not yet tested_ at the end.

> ### Verified — the method
>
> **The method is sound, and one step of it is where every one of the six
> mis-attributions comes from.** Step 1 stacks several edge cases into one
> fixture on purpose. That is the right way to find things and the wrong way
> to _attribute_ them, because when such a fixture fails there are several
> candidate causes and only one result. SD-1, SD-4, SD-7, SD-14, TC-7 and TC-8
> are each a correct observation with the wrong variable named, and in every
> case the variable that was named is one the fixture happened to vary
> alongside the one that mattered.
>
> The counter-measure is not more runs. It is that a fixture which has
> narrowed to a cause should be **re-run minimally** — the smallest document
> that still fails — and the reply below records that minimal document for
> every finding it disagrees with, so the next round starts from a file rather
> than from a sentence.
>
> **The one step that should be kept exactly as it is** is treating a
> description as testable. CC-1 is the single most valuable finding in this
> document and it exists only because the conversion matrix's sentence was
> read as a claim that could be false.

---

## Cross-cutting themes

Three patterns account for most findings. Fixing them as groups will be more efficient than working through the table row by row.

### 1. Silent normalisation

The tool adjusts input in ways the user cannot see: colour clipping and clamping, CSV header trimming, `&nbsp;` → space, duplicate JSON keys, `<caption>`, `!mytype` tags, YAML anchors.

The disclosure machinery is already excellent where it exists — the JSONC report, the sanitiser attribute report, the big-int warning, and Diff's invisible-character annotations are all best-in-class. The gap is that it isn't wired to every path that changes data.

### 2. Target-format blindness in Structured data

Everything routes through a JSON-shaped intermediate representation, so JSON's limits get enforced on every target regardless of what that target can hold.

**Important counter-example:** CSV→YAML quotes `"true"`, `"99.5"`, `"0"` while leaving `Ada` and `ops` bare. The writer demonstrably _can_ reason about what the target format will do with a value, per value. So SD-2, SD-5 and SD-13 are a misplaced check, not an architectural limitation.

### 3. Error positions

Structured data reports positions at the construct start or EOF rather than the offending token. Base64 and Regex get this right and can serve as the model.

> ### Verified — the themes
>
> **Theme 1 holds and is the largest group, but it is two groups wearing one
> name.** "Silent" is true of every item listed, and the cause is not the same
> for any two of them:
>
> | Sub-group                                                        | Which findings                | Why it is silent                                                                                                                                                                                                                       |
> | ---------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | **A. No channel exists at all**                                  | CC-1, CC-2, CC-3, CC-5        | `color-convert` declares three output ports and **none of them is a `report`**. There is nowhere for a note to go, so no note can be written. This is the only tool in the app in that position.                                       |
> | **B. A channel exists and this path does not reach it**          | SD-4a, SD-9, SD-10, SD-16     | `structured-data` has a `report` port, `lossSummary` reads it onto the node's face, and these four conversions write nothing to it.                                                                                                    |
> | **C. A channel exists and the instrument cannot see the change** | TC-1, TC-3, TC-5, TC-9, TC-13 | `text-convert` has a `report` port and a real instrument, `compareMarkup` — and the instrument is a **census of names**. An attribute whose value changed, and an element the Markdown target dropped, are both invisible to a census. |
>
> Those three want completely different work: A is a new port on one tool, B
> is four `lost()` calls, C is a different instrument. Treating them as one
> theme would size the round wrongly, which is the thing this round exists to
> get right. `&nbsp;` is struck from the list — see TC-2, which does not
> reproduce.
>
> **Theme 2 does not hold, and the counter-example does not say what it is
> read as saying.** This is the finding this round was asked to settle first
> and it is settled below, under **SD-2 / SD-5 / SD-13**. The short version:
> the CSV→YAML quoting decision is in the **writer**, and the check in
> question is in the **reader**, on the other side of a value model that is a
> compile-time type. SD-13 really is a misplaced check and can be fixed the
> way the write-up suggests. SD-2 and SD-5 cannot.
>
> **Theme 3 is half right, and the half that is wrong is worth knowing
> because it is the good half.** Measured:
>
> | Case                                 | Reported at            | Verdict                                       |
> | ------------------------------------ | ---------------------- | --------------------------------------------- |
> | Unterminated quote opening on line 8 | **line 8, column 3**   | The opening quote exactly. Correct.           |
> | Unterminated quote opening on line 2 | **line 2, column 3**   | Correct.                                      |
> | Duplicate column name, third column  | **line 1, column 1**   | The construct start. As reported.             |
> | An unresolved YAML alias             | had no position at all | Fixed this round: it now points at the alias. |
>
> So the theme is real for **header-level** errors in CSV and for the YAML
> thrown-error path, and is not real for the quote case the write-up leads
> with. A fourth member joins it that the write-up does not name: every
> `unsupported-type` refusal (`$.a_nan is NaN…`) carries a path and **no
> position at all**, so a `.nan` on line 400 of a 900-line document names the
> path and leaves the reader to find it.
>
> ### The theme the write-up does not name
>
> **A tool that cannot say anything.** Sub-group A above is not a variant of
> silent normalisation; it is a structural absence, and it is worth its own
> line because it explains four findings at once and because the remedy is one
> change. `color-convert` is the only shipped tool that both _changes values_
> and has _no `report` port_:
>
> | Tool                | Changes values                | Has a `report` port |
> | ------------------- | ----------------------------- | ------------------- |
> | `structured-data`   | yes                           | yes                 |
> | `text-convert`      | yes                           | yes                 |
> | `base64`            | yes                           | yes                 |
> | `jwt-decode`        | yes                           | yes                 |
> | `image-convert`     | yes                           | yes                 |
> | `video-remux`       | yes                           | yes                 |
> | `diff`              | no (reports into its summary) | by design, no       |
> | `regex-tester`      | no (notes on the panel)       | by design, no       |
> | **`color-convert`** | **yes**                       | **no**              |
>
> The matrix's own rule for `lossy, told` is that the user is told "on the
> panel on `/tools` AND on the canvas node". A canvas node reads `warn` notes
> off a port presented as a `report`. With no such port, `color-convert`
> cannot reach that bar for any loss, present or future — which is why CC-1's
> matrix cell is wrong in a way correcting the sentence would not fix.

---

## Structured data

| #     | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Severity |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| SD-1  | **Auto-detect fails on unquoted CSV.** `id,name,amount` plus two uniform rows returns `invalid-input` — "This is not JSON, YAML, CSV or TSV that this tool can read." The identical file with CSV selected manually converts fine. Detector appears to key on quote characters or embedded delimiters; a file with quoted fields _is_ detected. A field-count heuristic on the first few lines would fix it. This is the default mode, so it's the first thing users hit                                                                                                                                                   | High     |
| SD-2  | **Unsupported-type check ignores target format.** YAML→**YAML** with `a_nan: .nan` errors: "`$.a_nan` is NaN, which JSON cannot represent." JSON is not involved in either direction. YAML has native syntax for `.nan`, `.inf`, `-.inf`, so this blocks a class of valid documents with no workaround available from the UI                                                                                                                                                                                                                                                                                               | High     |
| SD-3  | **Merge keys emitted as a broken construct.** Input `merged: {<<: *base, b: 2}` produces output `merged:` / `  <<:` / `    a: 1` / `  b: 2`. With no anchor anywhere in the document, most parsers treat `<<` as a literal string key, so re-parsing gives `{"<<": {a: 1}, "b": 2}` rather than a merged map. If merges are being expanded, expand fully to `{a: 1, b: 2}` — a bare `<<` is the one option that's wrong either way                                                                                                                                                                                         | High     |
| SD-4  | **CSV header normalisation is silent and not collision-aware.** Three symptoms of one cause: (a) `" beta "` silently becomes key `"beta"` — values preserve whitespace exactly, headers don't; (b) `alpha,,beta, beta ,Beta` errors "Duplicate column name beta" on a file containing no duplicates; (c) a blank header becomes `column_2`, so `alpha,,column_2,gamma` also falsely errors. Fix: run the uniqueness check against the final key set, and either preserve headers verbatim or disclose the trimming                                                                                                         | Med-High |
| SD-5  | **YAML→YAML stringifies non-string keys.** `1:` becomes `"1":`, `true:` becomes `"true":`. YAML supports integer and boolean keys natively, so the round trip is not equivalent to the input                                                                                                                                                                                                                                                                                                                                                                                                                               | Medium   |
| SD-6  | **TSV writer uses CSV-style quoting.** A field containing a tab is written as `"has\ttab"` with a literal tab inside quotes. TSV has no quoting convention — standard readers (Excel, `cut -f`, pandas) split on tabs unconditionally and see four fields. Round-trips internally because the tool's reader honours quotes, but the file is unusable elsewhere, which defeats the purpose of exporting TSV. The reader also treats `\t` as literal backslash-t, so there is currently no working representation for such data in either direction. Fix: escape as `\t`/`\n`, or refuse fields containing tabs and newlines | Medium   |
| SD-7  | **TSV writer emits short rows.** A 3-field record with empty/null trailing values came out as a single field (`4` with nothing after it), giving the row the wrong field count                                                                                                                                                                                                                                                                                                                                                                                                                                             | Medium   |
| SD-8  | **`!!float 1` resolves to string `"1"`** instead of `1.0`. Note the contrast: `!!str 123` → `"123"` is correct, so the tag is being read — the float case resolves to the wrong type                                                                                                                                                                                                                                                                                                                                                                                                                                       | Medium   |
| SD-9  | **Custom tag dropped silently.** `custom_tag: !mytype {a: 1}` becomes a plain map with no tag and no report entry. The tag is the only thing distinguishing it from an ordinary mapping                                                                                                                                                                                                                                                                                                                                                                                                                                    | Medium   |
| SD-10 | **Duplicate JSON keys resolved last-wins silently**, while duplicate CSV headers are a hard error. Same situation, opposite treatment. The JSONC report goes to the trouble of counting comments and trailing commas but doesn't mention a discarded value                                                                                                                                                                                                                                                                                                                                                                 | Low-Med  |
| SD-11 | **Long rows rejected with no lenient option.** Short rows correctly pad with `""`, which is the right asymmetry — but there's no path through for a file with a surplus field                                                                                                                                                                                                                                                                                                                                                                                                                                              | Low-Med  |
| SD-12 | **Unsupported-value errors stop at the first offender.** Six `.nan`/`.inf` values required six separate runs to enumerate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Low      |
| SD-13 | **Big-int rounding warning gives JSON-specific advice on non-JSON targets.** On YAML→YAML it says "Convert to CSV or TSV to keep the digits", implying YAML can't hold the value. It can. Quoting in the source is the workaround that actually applies                                                                                                                                                                                                                                                                                                                                                                    | Low      |
| SD-14 | **Error positions off-target.** Unterminated quote reported at line 9 col 3 (EOF) when the opening quote was on line 8. Duplicate header reported at line 1 col 1 rather than the offending column                                                                                                                                                                                                                                                                                                                                                                                                                         | Low      |
| SD-15 | **Sort collation is mixed and undocumented.** `"2"` before `"10"` is natural sort; `Mango` before `apple` is codepoint order. Someone diffing sorted outputs or expecting `sort`-compatible ordering would be surprised                                                                                                                                                                                                                                                                                                                                                                                                    | Info     |
| SD-16 | Anchors dropped, scalar styles collapsed, empty-vs-missing CSV fields indistinguishable — candidates for the lossy-output port                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Info     |

### Confirmed working — Structured data

- **YAML 1.2 core schema applied consistently.** No Norway bug (`NO` stays a string), no sexagesimal (`12:30:45` stays a string), no octal (`0755` → 755). Quoted `"0042"` stays a string while bare `042` becomes 42.
- **JSONC** with the best disclosure report in the app: counts what was removed (2 comments, 1 trailing comma), explains what JSONC is, states the output won't contain comments.
- **CSV reads are string-only** — no type inference, so `0042`, `TRUE`, `1e5`, `1234.50` and `9007199254740993` all survive intact.
- **CSV→YAML minimal quoting is genuinely type-aware** (see theme 2).
- **Sort keys** is case-sensitive and leaves array values untouched.
- **Escapes round-trip** correctly in all tested directions.
- **Malformed input errors are precise** on unterminated quotes and field-count mismatches.

> ### Verified — Structured data
>
> | #     | Verdict                                       | What reproducing it found                                                                                                                         |
> | ----- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
> | SD-1  | **Not reproducible as described**             | The exact document converts. See below.                                                                                                           |
> | SD-2  | **Confirmed; behaviour is recorded**          | `src/tools/structured-data/README.md` §"What happens to data that cannot survive the conversion" and §"The JSON boundary". Not a misplaced check. |
> | SD-3  | **Working as designed; the premise is wrong** | Recorded at `src/tools/structured-data/README.md` §"Schema and version". Nothing is expanded. A real defect was underneath it.                    |
> | SD-4  | **Split three ways**                          | (a) recorded decision, (b) recorded decision, (c) confirmed defect.                                                                               |
> | SD-5  | **Confirmed; architectural, not a check**     | Same root as SD-2.                                                                                                                                |
> | SD-6  | **Confirmed exactly, both halves**            |                                                                                                                                                   |
> | SD-7  | **Not reproducible**                          | The row has the right field count; the fields are empty.                                                                                          |
> | SD-8  | **Confirmed, and narrower than reported**     | Only an integer-looking scalar.                                                                                                                   |
> | SD-9  | **Confirmed**                                 | Nowhere recorded.                                                                                                                                 |
> | SD-10 | **Confirmed**                                 |                                                                                                                                                   |
> | SD-11 | **Confirmed as recorded**                     | `src/tools/structured-data/README.md` §"CSV: hand-written, deliberately".                                                                         |
> | SD-12 | **Confirmed**                                 |                                                                                                                                                   |
> | SD-13 | **Confirmed**                                 | The sentence is a hard-coded literal.                                                                                                             |
> | SD-14 | **Half refuted, half confirmed**              | The quote position is exact; the header position is not.                                                                                          |
> | SD-15 | **Confirmed exactly**                         |                                                                                                                                                   |
> | SD-16 | **Confirmed with three corrections**          | Anchors are expanded, not dropped; block scalars survive; empty-vs-missing is already reported.                                                   |
>
> #### SD-1, in detail — the first of the four
>
> **The document in the finding converts.** `id,name,amount` over `1,ada,10`
> and `2,bob,20` is detected as CSV, delimiter `,`, `fellBack: false`, and
> reads to two records. So does the same file with a trailing newline, with
> CRLF, with spaces after the commas, with a blank line between the rows, with
> a leading blank line, with `#`-leading cells, with `- `-leading cells, with
> cells containing `: `, and with every cell quoted. Twenty-four shapes were
> swept; **quoting moved no verdict in either direction**, which is the part of
> the finding that can be ruled out cleanly.
>
> **Three shapes do refuse, and two of them are the finding:**
>
> | Document                                         | Verdict | Status                                           |
> | ------------------------------------------------ | ------- | ------------------------------------------------ |
> | `id,name,amount` / `1,ada,10` / `2,bob`          | refused | A **ragged** row. Recorded decision.             |
> | `id,name,amount` / `1,ada,10` / `2,bob,20,extra` | refused | The same, long instead of short.                 |
> | `name` / `ada` / `bob`                           | refused | A **single-column** file. Not recorded anywhere. |
>
> A ragged CSV being refused is round three's own decision, recorded in
> [docs/conversion-matrix.md](conversion-matrix.md#detection) as _"Prose, a
> ragged CSV, a log — fixed this round — Were broken: folded into one string
> with the line breaks replaced by spaces, reported as success. Now refused"_,
> and asserted by `refuses a ragged CSV rather than folding it into a
sentence` in `structured-data.test.ts`. **And it is exactly the file that
> converts when CSV is chosen manually**, because the reader pads a short row —
> which is the observation in the finding, attributed to the wrong variable.
> A fixture that stacks a ragged row and an absence of quoting has two
> candidate causes and one result.
>
> **Was there a check that should have caught this, and why didn't it?**
> There was, and it did its job. The negative control the brief asks about is
> `decision 1: two lines of YAML are not a table` → `still reads %s as a table`
> in `reports.test.ts`, and it **does** test what it claims: five documents,
> including _a header and one row_ and _a header and two rows_, driven through
> the whole tool and asserted to report `from.format === 'CSV'`. It is not a
> detector-level assertion that could pass while the tool refused — it runs
> `convert` and reads the report. Re-run this round: green, and the verdict it
> asserts is the verdict the swept corpus gives.
>
> **So detection did not narrow, and nothing regressed.** Traced across every
> commit that touched `convert.ts`: the round-three mapping guard
> (`parsesAsYamlMapping`) fires only when a document parses as a YAML
> **mapping**, and no plain CSV does. `looksDelimited`'s two bars —
> `first >= 2` fields and `counts.length >= 2` records — predate round three.
> The suspicion in the brief that "round three's detection change shipped with
> a control that does not test what it claims" is not borne out: the control
> is sound and the change is not the cause.
>
> **The genuine gap next to it, which the write-up does not name.** A
> single-column CSV cannot be auto-detected at all, because `looksDelimited`
> requires two fields in the first record and a one-column file has one. That
> is defensible — a file with no delimiter in it is not distinguishable from
> prose by a delimiter test — but it is undocumented, and it is a real export
> shape (one column of ids, one column of emails). It belongs in the plan as a
> **detection** question, not a bug: the answer is either a documented
> limitation or a different signal, and both are decisions.
>
> #### SD-2 / SD-5 / SD-13 — the target-format group, settled
>
> **The write-up's argument is right about one of the three and wrong about
> the other two, and the distinction is worth having exactly.**
>
> The counter-example is real: `writeYaml` does decide per value whether a
> scalar needs quoting, so `"true"` and `"99.5"` come out quoted and `Ada`
> bare. But that decision is taken **in the writer, on a value that has
> already been through the intermediate**. The check in SD-2 and SD-5 is in
> the **reader**, and what it is guarding is not a formatting choice — it is
> the type of the value model:
>
> ```
> YAML source ──parse──▶ unknown ──toJsonValue──▶ JsonValue ──writeTarget──▶ YAML
>                                  ▲                  ▲
>                            the check            the type
> ```
>
> `Reading.data` is `JsonValue`, and `JsonValue` is
> `string | number | boolean | null | readonly JsonValue[] | { [k: string]: JsonValue }`
> — a **compile-time type** in `src/features/registry/types.ts`, not a
> convention. It is also the payload of the `json` data type that every port
> in the app is typed against, so it is what `structured-data`'s own `data`
> port carries, what a wire carries, and what the cache key is built from.
>
> So for SD-2, "move the check to the writer" does not describe a smaller
> change than it sounds like. `NaN` cannot _reach_ the writer: there is no
> value of type `JsonValue` that is `NaN`, and the object keys of a
> `JsonValue` are `string`, which is SD-5 in one line. Carrying `.nan`,
> `.inf` and an integer key from a YAML reader to a YAML writer means either a
> second value model that only YAML→YAML uses, or widening `JsonValue`
> app-wide. Both are design decisions with consequences on the canvas, and
> neither is a misplaced check.
>
> **SD-13 is different and the write-up is exactly right about it.** The
> sentence _"Convert to CSV or TSV to keep the digits"_ is a hard-coded string
> literal in `roundedNumberNotes`, appended to every rounding note whatever the
> target is. There is no type in the way; the note is simply written in a
> function that has not been told the target. That is a misplaced check — or
> more precisely misplaced advice — and it can be fixed the way the write-up
> says. It is not fixed here only because the target is not in scope at the
> point the note is built, so the fix threads a parameter through the read
> half, which is more than "touches nothing else".
>
> **Verdict on the grouping: SD-13 leaves the group.** SD-2 and SD-5 are one
> item — _the value model_ — and they are a round of their own, not a
> condition.
>
> #### SD-3 — working as designed, and the defect underneath it
>
> **Merges are not being expanded, so the finding's dilemma does not arise.**
> Under the YAML 1.2 core schema `<<` is an ordinary key with no special
> meaning, which is recorded in `src/tools/structured-data/README.md`:
> _"`<<` is an ordinary key rather than a merge"_, with the 1.1 behaviour
> recorded beside it. Measured:
>
> | Input                                              | Reads to                                         |
> | -------------------------------------------------- | ------------------------------------------------ |
> | `base: &base {a: 1}` / `merged: {<<: *base, b: 2}` | `{"base":{"a":1},"merged":{"<<":{"a":1},"b":2}}` |
> | The same with `%YAML 1.1` declared                 | `{"base":{"a":1},"merged":{"a":1,"b":2}}`        |
>
> The second row is the merge working. The first is the document's own meaning
> under the version it did not override, and the round trip through the writer
> is **stable**: written out and read back gives the identical value. So the
> output does re-parse, and it re-parses to what went in.
>
> **What was wrong was one step earlier.** The finding's literal input —
> `merged: {<<: *base, b: 2}` with no anchor anywhere — did not produce the
> output in the write-up at all. It produced:
>
> ```
> limit-exceeded: That YAML expands to too much data to convert.
>   Unresolved alias (the anchor must be set before the alias): base
> ```
>
> Twenty-six bytes reported as a resource-exhaustion refusal, with the detail
> underneath contradicting the message. The `yaml` package throws a bare
> `ReferenceError` for two unrelated faults — an alias with no anchor, and the
> billion-laughs expansion guard — and both were mapped onto the second.
> **Fixed this round**, and the fix asks the _document_ rather than the error's
> wording; see the fix list.
>
> #### SD-4 — three symptoms, two of them the recorded decision
>
> `src/tools/structured-data/README.md` §"CSV: hand-written, deliberately"
> already records the rule and its reason: _"Unquoted header cells are
> trimmed; quoted ones are not. ` name, age` is how hand-typed CSV looks, and
> a key of `" age"` helps nobody — but trimming a cell its author quoted is a
> silent edit, and it also made `a` and `" a "` collide as duplicate columns
> when they are different names."_
>
> - **(a)** Measured both spellings, because the finding writes the header
>   with quotes and the rule turns on exactly that:
>
>   | Header                    | Key                                |
>   | ------------------------- | ---------------------------------- |
>   | `alpha, beta ` (unquoted) | `beta` — trimmed                   |
>   | `alpha," beta "` (quoted) | `" beta "` — **preserved exactly** |
>   | `alpha,""` (quoted empty) | `""` — preserved, not renamed      |
>
>   So the literal finding does not reproduce and the unquoted one does:
>   **confirmed for the unquoted spelling, and it is the recorded decision.**
>   The loss is the whitespace and it is silent, which puts it in theme 1
>   sub-group B rather than in a collision bug.
>
> - **(b)** `alpha,,beta, beta ,Beta`: **working as designed.** After the
>   recorded trimming, `beta` and `beta` really are the same key, so the file
>   does contain a duplicate. What is wrong is that the message says
>   _"Duplicate column name beta"_ and never mentions that trimming is why two
>   visibly different headers collided. That is a message defect, not a check
>   defect.
> - **(c)** `alpha,,column_2,gamma`: **confirmed defect, and it is the only
>   one of the three.** The blank header is given the synthesised name
>   `column_2`, and the synthesised name is not checked against the names
>   already in the file. A file whose author really has a column called
>   `column_2` cannot be read at all, and the error blames a duplicate the
>   author did not write.
>
> **A check that should have caught (c)**: `csv.oracle.test.ts` holds 32
> documents against CPython's `csv.reader`, and CPython's reader returns rows
> rather than dictionaries — so the header-naming rule is outside what the
> oracle can see. The naming is only exercised by hand-written expectations,
> which is the weakest evidence tier in
> [docs/conversion-matrix.md](conversion-matrix.md#what-counts-as-evidence).
> There is a `DictReader` corpus (9 dictionaries) and a document with a
> literal `column_N` header is not in it.
>
> #### SD-7 — not reproducible
>
> Measured byte for byte. `[{"a": 4, "b": null, "c": ""}]` written to TSV is
> `a\tb\tc` over `4\t\t` — **three fields**, two of them empty, which is the
> correct field count and the correct rendering of a null in a format with no
> null. The same record to CSV is `a,b,c` over `4,,`. What the finding
> describes is what a trailing tab looks like on screen: nothing. The claim
> that the row has the wrong field count is not true of the bytes.
>
> `null` and `""` being the same cell **is** a real loss and is already
> recorded as known limitation 3 in the tool's README.
>
> #### SD-8 — confirmed, and narrower
>
> `!!float 1` reads to the string `"1"`. It is specifically an
> **integer-looking** scalar: `!!float 1.5` reads to `1.5`, `!!int "3"` reads
> to `3`, `!!str 123` reads to `"123"`. So the tag is honoured everywhere
> except the one case where honouring it would have to change the scalar's
> _kind_, and the failure mode is the worst available — a silent type change
> to a string, not an error.
>
> #### SD-14 — the quote half does not reproduce
>
> A document whose quote opens on line 8, column 3, with a further line after
> it, reports **line 8, column 3, offset 30**. The same fault on line 2
> reports line 2, column 3. The position is the opening quote, exactly, which
> is the behaviour the finding asks for. The duplicate-header half **is**
> confirmed: line 1, column 1 for a collision in the third column.

---

## Text convert

| #     | Finding                                                                                                                                                                                                                                                                                                                                                                                                    | Severity |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| TC-1  | **Table cells ignore the markup policy and emit literal newlines.** `<td><ul><li>one</li><li>two</li></ul></td>` produces a cell containing `- one\n- two` under **both** policy settings. A literal newline terminates a GFM table row, so the row breaks and everything after it renders as a paragraph. Two faults: cell content isn't newline-guarded, and the cell path ignores the dropdown entirely | High     |
| TC-2  | **`&nbsp;` (U+00A0) silently converted to a regular space**, including on HTML→HTML sanitised where nothing should touch it. Confirmed by hash: the tool's output of `<p>a&nbsp;b</p>` and a hand-typed `<p>a b</p>` both give MD5 `209a751c62053a9208ec078d6e0cbd86`                                                                                                                                      | Medium   |
| TC-3  | **`<ol reversed>` emits ascending numbers.** Items `three, two, one` render as 1, 2, 3 — the opposite of what a reversed list displays. This is wrong content, not lost styling. GFM can't express `reversed`, but emitting incorrect numbers is worse than dropping the list style                                                                                                                        | Medium   |
| TC-4  | **Drop policy substitutes lookalike formatting instead of plain text.** Under _Keep the text, drop the tag_, `<mark>` becomes `_…_` and `<kbd>` becomes backticks — formatting the source never had. Under _Keep as HTML_, `<mark>` is correctly preserved, so this is a fallback issue on the drop path specifically                                                                                      | Medium   |
| TC-5  | **`<caption>` content dropped silently** with no report entry                                                                                                                                                                                                                                                                                                                                              | Low-Med  |
| TC-6  | **Bullet marker switches to `*` on some lists** despite hyphen being selected. Probably intentional (changing the marker forces a list break in CommonMark), but it overrides an explicit user setting without saying so                                                                                                                                                                                   | Low-Med  |
| TC-7  | **Link title with quotes is invalid CommonMark.** `title='He said "hi"'` emits as `"He said \"hi\""` — backslashes aren't escapes inside a title, so it terminates at the second quote. Use `'…'` or `(…)` as the delimiter                                                                                                                                                                                | Low-Med  |
| TC-8  | **Markdown output over-escapes.** `\\` becomes `\\\` (odd-numbered, so it renders as one backslash plus an escape) and bare `~` becomes `\~`. Round-trips correctly within the tool, but renders wrong in GitHub or any other CommonMark processor — and the Markdown output is the deliverable users take elsewhere                                                                                       | Low      |
| TC-9  | **`class="btn"` becomes `class=""`** rather than being removed. Class handling is inconsistent across elements: removed cleanly from `<img>` and `<div>`, kept in full on `<code>`, emptied on `<a>`                                                                                                                                                                                                       | Low      |
| TC-10 | **Plain text target strips inline markers but keeps block markers.** `**`, `_` and backticks are removed; `#` and `>` survive. Inconsistent on a target labelled "strip formatting"                                                                                                                                                                                                                        | Low      |
| TC-11 | **`<img>` with no alt passes through without `alt=""` added**, despite alt being preserved carefully elsewhere                                                                                                                                                                                                                                                                                             | Low      |
| TC-12 | **`<br>` → trailing `\`** is valid CommonMark but unsupported by some older renderers and linters                                                                                                                                                                                                                                                                                                          | Low      |
| TC-13 | Headerless tables get a synthesised empty header rather than first-row promotion. Defensible, but most converters promote and headerless tables are very common in real HTML                                                                                                                                                                                                                               | Info     |
| TC-14 | Plain text is output-only; the tool description implies it's also a source format                                                                                                                                                                                                                                                                                                                          | Info     |

### Confirmed working — Text convert

- **Security is solid.** `&lt;script&gt;` stays inert through all three targets. Markdown→HTML strips `onclick`, `onerror` and a `javascript:` URL, with a counted and explained report.
- **Attribute removal is disclosed by name** with reasoning (`target`, `rel`, `data-*`, `loading`, `style`), and id namespacing (`cta` → `user-content-cta`) gets its own warning explaining what breaks as a result.
- **Colspan and rowspan produce correct cell counts** — alignment holds throughout the table.
- **Code span delimiter sizing is right**: ` `foo`bar`` `` picks two backticks, `` ` `double` ` `` uses one with padding.
- **`<pre>` without `<code>` keeps indentation byte-exact.**
- **Link destinations pick the right strategy per case** — backslash escape for an unbalanced paren, `<>` wrapping for a URL containing a space.
- **Escaping of structural text is correct**: `1\.`, `\-`, `\>`, `snake\_case\_word`, `mid\*word\*stars`, `\[brackets\]`.
- **GFM extensions all correct** — task lists, strikethrough, autolinking, and footnotes with unusually thorough accessibility markup (backrefs, `aria-describedby`, screen-reader heading).

> ### Verified — Text convert
>
> | #     | Verdict                                                                 | What reproducing it found                                                   |
> | ----- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
> | TC-1  | **Confirmed exactly, both faults**                                      | Under all three policy values, not two.                                     |
> | TC-2  | **Not reproducible**                                                    | U+00A0 survives every path. See below.                                      |
> | TC-3  | **Confirmed**                                                           | And the numbers are silent even though the attribute's removal is reported. |
> | TC-4  | **Confirmed, on the `text` policy**                                     | `drop` removes the text as well, correctly.                                 |
> | TC-5  | **Confirmed on the Markdown target; reported on HTML→HTML**             |                                                                             |
> | TC-6  | **Confirmed, and it is the library's doing**                            | `remark-stringify` alternates the marker to force a list break.             |
> | TC-7  | **Refuted**                                                             | CommonMark permits a backslash-escaped `"` inside a title.                  |
> | TC-8  | **Refuted**                                                             | The count changes; the rendering does not.                                  |
> | TC-9  | **Confirmed, and the cause is upstream and precise**                    |                                                                             |
> | TC-10 | **Confirmed exactly**                                                   |                                                                             |
> | TC-11 | **Confirmed**                                                           |                                                                             |
> | TC-12 | **Confirmed**                                                           |                                                                             |
> | TC-13 | **Confirmed as recorded — and reported on only one of the two targets** |                                                                             |
> | TC-14 | **Confirmed, and it is a sentence rather than a mismatch**              |                                                                             |
>
> #### TC-1 — confirmed, and one word worse
>
> Measured on `<table><tr><th>h</th></tr><tr><td><ul><li>one</li><li>two</li></ul></td></tr></table>`:
>
> ```
> | h           |
> | ----------- |
> | - one
> - two |
> ```
>
> The cell carries a literal U+000A, which ends the row. The finding says
> "both policy settings"; there are three, and it is **all three** — `keep`,
> `text` and `drop` produce byte-identical output, which is the sharper form
> of the same claim: the cell path does not consult `unsupported` at all.
>
> Worth recording beside it, because it bounds the fix: `<td>a<br>b</td>` is
> handled correctly and comes out `| a b |`. So something in the cell path
> already knows a newline is fatal there; it is the block-content case that
> does not go through it.
>
> #### TC-2 — not reproducible, and the entity is the real observation
>
> Measured by code point and by digest, on every path:
>
> | Path                                 | Output                | MD5                                |
> | ------------------------------------ | --------------------- | ---------------------------------- |
> | `<p>a b</p>` → HTML (sanitised)      | `<p>a` U+00A0 `b</p>` | `8c254514d8dc7f2741c69787dc033f4e` |
> | `<p>a&nbsp;b</p>` → HTML (sanitised) | `<p>a` U+00A0 `b</p>` | `8c254514d8dc7f2741c69787dc033f4e` |
> | `<p>a b</p>` → Markdown              | `a` U+00A0 `b`        | —                                  |
> | `<p>a b</p>` → Plain text            | `a` U+00A0 `b`        | —                                  |
> | Hand-typed control `<p>a b</p>`      | `<p>a b</p>`          | `209a751c62053a9208ec078d6e0cbd86` |
>
> The digest in the finding is the digest of the control, and the tool's own
> output does not have it. **The character is preserved on every route.**
>
> What _is_ true, and is what the fixture was really showing, is that the
> **spelling** changes: `&nbsp;` the entity becomes U+00A0 the character. The
> two are the same character to a browser and different bytes to a diff or a
> digest — which is exactly the class of fact the byte-order-mark row in the
> matrix exists for. It is a smaller finding than the one reported and it is a
> real one.
>
> **What this does not settle.** The write-up measured through the live UI and
> this reply measured through the conversion functions and the tool's `run`.
> Nothing between them normalises U+00A0 — it is not in the sanitiser, the
> pipelines, the output views or either clipboard path, and the only
> ` ` in the source tree is the diff tool's space-lookalike list. But
> "there is no such code" is a negative assertion, and the subject of this one
> is a browser. The minimal next step is named in the plan: paste
> `<p>a&nbsp;b</p>`, copy the output, and hash it — in a browser, not here.
>
> #### TC-4 — confirmed, with the policy named correctly
>
> Under `unsupported: 'text'` — labelled _Keep the text, drop the tag_, and
> the default — `<mark>hi</mark>` becomes `_hi_` and `<kbd>Esc</kbd>` becomes
> `` `Esc` ``. Under `drop` both are removed entirely, which is right.
> `<sub>x</sub>` becomes `x`, which is also right. So the substitution is not
> a general fallback: it is specific elements acquiring emphasis and code
> formatting they never had, on the policy most people are using.
>
> #### TC-7 — refuted
>
> CommonMark 0.31.2 defines a link title as characters between `"` quotes
> _"including a `"` character only if it is backslash-escaped"_. `[t](/x "He
said \"hi\"")` is therefore valid and parses with the quotes in the title.
> The output is correct as written.
>
> #### TC-8 — refuted, and the measurement is the interesting part
>
> The backslash count really does change, exactly as reported: two backslashes
> in the HTML come out as three in the Markdown. What does not happen is the
> consequence. Put through a CommonMark renderer — this repository's own,
> which is held to CommonMark 0.31.2 at 624 of 652 — every case reproduces the
> input:
>
> | HTML in  | Markdown out | Rendered back |
> | -------- | ------------ | ------------- |
> | `a \\ b` | `a \\\ b`    | `a \\ b`      |
> | `a \ b`  | `a \ b`      | `a \ b`       |
> | `a \\`   | `a \\\\`     | `a \\`        |
> | `a \\b`  | `a \\\b`     | `a \\b`       |
> | `a ~ b`  | `a \~ b`     | `a ~ b`       |
>
> The reasoning in the finding — _"odd-numbered, so it renders as one backslash
> plus an escape"_ — does not hold, because a backslash before a space or
> before `b` is not an escape in CommonMark and renders as itself. `\\\ ` is
> one escaped backslash plus one literal one, which is two, which is what went
> in. The `\~` half is correct for a different reason: it is what stops a pair
> of tildes becoming strikethrough, and it renders as `~`.
>
> So the output is ugly and right. Recorded rather than dropped, because "the
> Markdown output is the deliverable users take elsewhere" is the correct
> instinct and is worth applying to something that is actually wrong.
>
> #### TC-9 — confirmed, and the cause is exact
>
> `hast-util-sanitize`'s default schema allows `className` on `<a>` **with a
> value filter**: the only permitted value is `data-footnote-backref`. An
> attribute that is allowed-with-values and whose value is not permitted keeps
> the attribute and empties it, where an attribute that is not allowed at all
> is removed. That is the whole of the inconsistency:
>
> | Element  | Schema entry                             | Result               |
> | -------- | ---------------------------------------- | -------------------- |
> | `<a>`    | `['className', 'data-footnote-backref']` | `class=""`           |
> | `<code>` | `['className', /^language-./]`           | kept when it matches |
> | `<div>`  | no `className` entry                     | removed              |
> | `<img>`  | no `className` entry                     | removed              |
>
> **And it is silent for a reason worth naming.** `compareMarkup` is a census
> of _names_, so `class` present-and-empty and `class` present-and-full are the
> same to it — the `<div>` case is reported (`1 attribute was removed by the
sanitiser`) and the `<a>` case reports nothing. This is the one live
> counter-example to a sentence in
> [docs/conversion-matrix.md](conversion-matrix.md#still-unverified-and-how-to-verify-it),
> item 4, which says _"The other half of that note, an attribute whose VALUE
> changed, was resolved in round four."_ It was resolved for `id` and `name`,
> via `renamedIdentifiers`. `class` is a second case and it is not covered.
> The code comment in `src/lib/markup/changes.ts` says so plainly — _"The one
> case in this app is `id`"_ — and is now wrong.
>
> **A second inaccuracy in the same area**, found while checking it: the
> comment in `src/lib/markup/sanitise.ts` says classes are allowed _"on the
> specific elements that need them (`li`, `ol`, `code`, `div`, `span`)"_. In
> the schema that is actually inherited, `div` and `span` have no `className`
> entry at all and `a`, `h2`, `section` and `ul` do. Both belong to the
> documentation round.
>
> #### TC-13 — confirmed as recorded, reported on one target of two
>
> The decision is recorded in
> [docs/conversion-matrix.md](conversion-matrix.md#text-convert): _"a `<table>`
> with no header **gains an empty header row that was not in the input**,
> reported as an invention."_ Measured, it is reported — on `HTML → HTML
(normalised)`, where the run says `3 elements were invented by the round
trip`. On `HTML → Markdown` the same input produces `|   |   |` with an
> empty report. So the brief's "should be reported" is half true, and which
> half depends on the target the user picked.
>
> #### The root cause under TC-1, TC-3, TC-5 and TC-13
>
> **The Markdown target has no change report at all.** For an HTML target the
> tool compares three documents — input, sanitised, normalised — and each half
> answers for itself. For a Markdown target `src/tools/text-convert/normalisation.ts`
> records the reason it does not: _"For Markdown there is nothing to compare:
> the loss is a CONSTRUCT with no Markdown spelling on the way back"_ — so only
> three named constructs (footnotes, display maths, bare URLs) are reported,
> and everything else HTML→Markdown loses is silent.
>
> That reasoning is sound for a **Markdown** source and does not hold for an
> **HTML** source, where there is something to compare and the instrument to
> compare it with already exists. `HTML → HTML (normalised)` is exactly
> `markdownToHtml(htmlToMarkdown(sanitised))`, and the Markdown target already
> computes the inner half. One more call to `markdownToHtml` on the output
> would give the Markdown target the same census the HTML target has, and
> `<caption>`, the dropped list structure in TC-1 and the invented header row
> in TC-13 would all be reported by the code that is already there. That is
> the single highest-value item in this document after CC-1, and it is in the
> plan rather than here because it changes what a shipped port reports.
>
> #### TC-14 — a sentence, and none of the three classifications fits
>
> The tool's `summary` reads _"Convert between Markdown, HTML and plain text,
> with GitHub Flavoured syntax"_, and the tool table in `README.md` says
> _"Markdown, HTML and plain text"_. Its input port description is precise
> (_"Markdown or HTML"_) and `detect.ts` states the rule in its first line.
>
> This is not aspirational (plain-text-as-a-source was never intended — the
> options file argues against it), not drift (it has always been this way) and
> not a deliberate change (nothing changed). It is an ambiguous sentence:
> "convert between A, B and C" is true of a tool that converts A→C and B→C.
> Recorded here so the documentation round can decide whether to tighten it,
> and flagged because the same phrasing is in two places.

---

## JWT decode

| #     | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Severity |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| JWT-1 | **Header missing the required `alg` renders as amber "Not verified"** — the same state as a well-formed token where the user simply didn't supply a key. Other structural failures (2 segments, bad base64, non-JSON payload) all produce hard parse errors. The Report line reads `no alg`, so the condition is detected; it just isn't routed to the red path. The boilerplate advice to supply a key is misleading when no algorithm exists to check with | Medium   |
| JWT-2 | **`nbf` in the future gets a table row while `exp` gets a red status banner.** A not-yet-valid token fails validation as surely as an expired one and deserves equal prominence                                                                                                                                                                                                                                                                              | Low      |
| JWT-3 | Claims table appears to show only registered claims (`name` was absent while `sub`, `exp`, `nbf`, `iat` appeared). Reasonable, but undocumented — a user scanning the table could think the token has fewer claims than it does                                                                                                                                                                                                                              | Info     |

### Confirmed working — JWT decode

Four visually distinct states, all correctly differentiated:

- **Red REJECTED** for `alg: none`, with an explanation of why it's a known attack rather than just "unsupported"
- **Amber NOT VERIFIED** when no key is supplied, naming which key types would verify that specific algorithm
- **Green VERIFIED**, claiming only that the content hasn't been altered since signing — no overclaiming
- **Red INVALID** for a wrong key, naming both possible causes without guessing

Payload heading tracks the state (NOT TRUSTWORTHY / UNVERIFIED / VERIFIED). Expiry shown with absolute time, local timezone and relative age. This is the strongest tool in the app.

> ### Verified — JWT decode
>
> | #     | Verdict                                          | What reproducing it found                           |
> | ----- | ------------------------------------------------ | --------------------------------------------------- |
> | JWT-1 | **Confirmed, with one correction to the detail** |                                                     |
> | JWT-2 | **Not reproducible**                             | The two are drawn identically, and each has a test. |
> | JWT-3 | **Confirmed**                                    |                                                     |
>
> **JWT-1.** A header with no `alg` returns `status: 'unsupported'`, which
> `JwtView`'s verdict table maps to `trust: 'unverified'` — the same tone and
> the same word as `no-key`. The condition is detected: the summary line reads
> _"NOT VERIFIED - the header declares no algorithm."_, which is more specific
> than the finding credits. What is boilerplate is the **detail** underneath
> it, which is the shared `NOT_VERIFIED_DETAIL` about a payload being base64,
> plus — on the `no-key` path only — the sentence about supplying a key. So
> the misleading advice appears on the `no-key` path and the `unsupported`
> path is merely _indistinguishable in tone_, which is still the finding.
>
> RFC 7515 §4.1.1 makes `alg` REQUIRED, so a header without one is a malformed
> JWS rather than an unsupported one, and the other malformed shapes the
> write-up lists are all hard errors. Routing it is a **product decision about
> a fifth state** — is a structurally invalid token `broken` or a new word? —
> which is why it is in the plan and not in the code.
>
> **JWT-2.** Both claims produce the same strip, with the same class and the
> same icon:
>
> | Claim               | Element                       | Class                               | Icon        |
> | ------------------- | ----------------------------- | ----------------------------------- | ----------- |
> | `exp` in the past   | `<p data-validity="expired">` | `validityBad` → `--pb-signal-error` | `ErrorIcon` |
> | `nbf` in the future | `<p data-validity="not-yet">` | `validityBad` → `--pb-signal-error` | `ErrorIcon` |
>
> and each has a test in `JwtView.test.tsx` (`flags an expired token separately
from the signature verdict`, `says when a token is not usable yet`). Neither
> is a banner — the banner is the signature verdict, and `exp` does not get one
> either. The one asymmetry is in the **tests** rather than in the app: the
> expired test asserts the strip's text and the not-yet test asserts only its
> `data-validity`, so a regression in the wording of one would be caught and
> in the other would not. Noted for the plan; not a user-visible defect.
>
> **JWT-3.** Confirmed: `STRING_CLAIMS` in `JwtView.tsx` is a fixed list of
> registered claims, and a `name` claim appears only in the raw payload view.
> The behaviour is deliberate and the finding is that nothing says so.

---

## Colour convert

| #    | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Severity |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| CC-1 | **Out-of-gamut colours silently clipped, contradicting the stated behaviour.** `oklch(0.7 0.4 150)` returns `oklch(0.7587 0.25817 142.5)` — lightness up 0.06, chroma down 35%, hue shifted 7.5° — with no warning anywhere. The clipped values also drive the contrast check, so a designer checking whether their wide-gamut colour passes AA gets an answer about a different colour. The tool has the numbers to detect this: comparing input components against returned ones would be enough | Med-High |
| CC-2 | **Contrast ratios ignore alpha.** `#aabbccdd` (87% opaque) gives ratios byte-identical to opaque `#aabbcc` — 10.69:1 and 1.96:1 in both cases. Each row names its background, so compositing is possible; as it stands the numbers are wrong for any translucent colour, which is exactly the case where a designer would check                                                                                                                                                                    | Medium   |
| CC-3 | **Out-of-range hsl clamped silently.** `hsl(361, 110%, -5%)` → black with no notice. The clamping is CSS-correct; the silence is the problem. A user who typed `-5%` for `5%` gets black instead of a dark red with no hint their input was adjusted                                                                                                                                                                                                                                               | Medium   |
| CC-4 | **Checkerboard backdrop renders behind opaque colours too**, so transparency isn't visually distinguishable and solid swatches are misrepresented. Keep the backdrop but render opaque colours as a solid fill                                                                                                                                                                                                                                                                                     | Low-Med  |
| CC-5 | **Hue drifts to 359.98 rather than 0** after a round trip through oklch. Same colour (0.02° apart on a circle), but alarming next to every other red in a stylesheet. Snap to 0 within a rounding tolerance of 360                                                                                                                                                                                                                                                                                 | Low      |
| CC-6 | **CSS named colours unsupported** (`rebeccapurple`). The error is clear and offers working alternatives in each accepted format, and the description doesn't claim named support — so a feature request rather than a defect. It's a 148-entry lookup table                                                                                                                                                                                                                                        | Low      |

### Confirmed working — Colour convert

- All four notations accurate for every colour tested.
- Hex parsing at 3, 4, 6 and 8 digits, with correct doubling (`#ABC` → `#aabbcc`, not `#0a0b0c`).
- Modern slash-alpha syntax parsed; alpha carried into every notation in that format's idiom.
- WCAG ratios internally consistent — black × white ≈ 21 held on every colour tested.
- oklch round-trips exactly at 5 decimal places, and the decimal-places help text documents that threshold at the point of decision.

> ### Verified — Colour convert
>
> | #    | Verdict                                                          | What reproducing it found                        |
> | ---- | ---------------------------------------------------------------- | ------------------------------------------------ |
> | CC-1 | **Confirmed exactly, to the digit**                              | The doc mismatch is **aspirational**. See below. |
> | CC-2 | **Confirmed exactly, to the digit**                              |                                                  |
> | CC-3 | **Confirmed, and wider than reported**                           | `rgb()` clamps silently too.                     |
> | CC-4 | **Confirmed — FIXED this round**                                 |                                                  |
> | CC-5 | **Confirmed; a second symptom found beside it — that one FIXED** |                                                  |
> | CC-6 | **Confirmed as a recorded refusal**                              |                                                  |
>
> #### CC-1 — the one to read
>
> Measured: `oklch(0.7 0.4 150)` → `oklch(0.7587 0.25817 142.5)`, every figure
> in the finding correct. Contrast from the clipped colour: 10.60:1 on black,
> 1.98:1 on white — answers about `#00d600`, not about the colour typed.
>
> **The tool does not merely have the numbers. It computes the verdict and
> throws it away.** `oklchToRgb` returns `{ rgb, inGamut }`, `inGamut` is
> correct (`false` for this input, measured), and its comment says _"Reported
> rather than silently corrected"_. Every consumer discards it:
>
> | Caller                         | What it does with `inGamut`                           |
> | ------------------------------ | ----------------------------------------------------- |
> | `parseColor`, the oklch branch | `const { rgb } = oklchToRgb(...)` — destructured away |
> | `color-convert/index.ts`       | never calls it                                        |
> | `ColorView`                    | never sees it                                         |
> | `color.test.ts`                | **the only reader in the repository**                 |
>
> **The classification the brief asks for: aspirational.** `inGamut` was
> introduced in `e56bd2f` ("feat: complete core tool set") and `git log -S`
> over the whole history finds no other commit touching it — it has never been
> wired to anything, in any version. The matrix records an intention the code
> never implemented. It is not drift: nothing was removed.
>
> **And the right correction is not to the sentence.** An aspirational claim
> means a feature is missing, and the missing feature here is bigger than one
> note: as set out under the themes, `color-convert` has **no `report` port**,
> so there is no channel that could carry it to a node's face, and the
> matrix's own definition of `lossy, told` requires exactly that. Until a port
> exists the honest cell is `lossy, silent`. The two changes are one piece of
> work and it is the first item in the plan.
>
> **Was there a check that should have caught this?** Two, and both pass
> honestly while the feature is absent:
>
> - `color.test.ts` asserts `inGamut` is `false` for `oklch(0.7 0.37 150)` and
>   `true` across a stride of in-gamut colours. It tests the **function**, and
>   the function is correct. Nothing asserts a caller.
> - [docs/conversion-matrix.md](conversion-matrix.md#colour) carries the cell
>   as `lossy, told`, and `lossy, told` is the one verdict in that document
>   with a _testable_ definition — told on `/tools` **and** on the canvas node.
>   Nothing tests it. The nearest thing, `notePorts.test.ts`, was built to
>   assert `ToolNote.reaches` rather than to enforce the verdict, and its
>   subject list is "one input per runnable **reporting** tool" —
>   `color-convert` has no report port, so it cannot be a subject.
>
> That is the shape worth naming: **the claim escaped by belonging to the one
> tool the enforcing test's subject list defines away.** Adding
> `color-convert` to that list is what makes the fix hold, and it is only
> possible once the port exists — which is why the two are one piece of work.
>
> #### CC-2 — confirmed, to the digit
>
> `#aabbccdd` and `#aabbcc` both give 10.69:1 and 1.96:1. `ColorView` calls
> `relativeLuminance(color.r, color.g, color.b)` and `color.a` is not a
> parameter of that function anywhere in the app. Each row does name its
> background (`On black`, `On white`), so the composite is computable from what
> is already on screen — the finding's own point, and correct.
>
> **A check that should have caught it**: the matrix's colour section has no
> contrast row at all. WCAG ratios are asserted _internally consistent_ — black
> × white ≈ 21 — which a function ignoring alpha satisfies perfectly, since
> both controls are opaque. This is round four's shape again: an assertion
> true of the correct code and equally true of the broken code.
>
> #### CC-3 — confirmed, and one case wider
>
> `hsl(361, 110%, -5%)` → `#000000`, silently. So does `rgb(300 -20 50)` →
> `#ff0032`, which the finding does not name and which is the same defect on a
> notation people type far more often. Both clamps are CSS-correct. Both are
> unsayable for the reason in CC-1: there is no port to say them on.
>
> #### CC-4 — confirmed, and fixed
>
> `background-image` paints above `background-color`, so the four gradients
> that draw the chequerboard were painted **on top of** every swatch. An
> opaque `#aabbcc` was shown as `#aabbcc` in 16px squares of
> `--pb-surface-raised`. The finding's own remedy is the one taken: the
> chequerboard is now applied only when `a < 1`. See the fix list.
>
> #### CC-5 — confirmed, and it is two things
>
> Confirmed: `#ff0000` written as `oklch()` at five places and read back gives
> `hsl(359.98 100% 50%)` where the direct answer is `hsl(0 100% 50%)`. The hex
> is identical either way, so the colour is right and the _notation_ drifted.
> Snapping it needs a tolerance — how far from 360 is "meant to be 0"? — and a
> tolerance is a decision, so it is in the plan.
>
> **The second symptom is not a tolerance and is fixed.** `#800000` through
> the same round trip printed `hsl(360 100% 25.1%)`. Both `rgbToHsl` and
> `rgbToOklch` document and deliver a hue in **[0, 360)**; only the formatter's
> rounding can produce 360, and `hsl(360 …)` is a wrap point printed as the
> value it wraps to. That is an identity rather than a guess, so it could be
> corrected here without touching the 359.98 question at all.
>
> #### CC-6 — confirmed as recorded
>
> `rebeccapurple` is refused with _"…is not a colour this tool recognises"_ and
> the four accepted spellings. Recorded as deliberate in
> [docs/conversion-matrix.md](conversion-matrix.md#colour) (_"Refused by name,
> with the supported notations listed. Deliberate — resolving names means
> shipping the 148-entry CSS table"_) and in the tool's own README. Still
> behaves as recorded; not re-opened.

---

## Regex tester

| #    | Finding                                                                                                                                                                                                                                                                                                                                                                                        | Severity |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| RX-1 | **`\p{...}` with Unicode set to Off returns "No matches" with no hint.** Without the `u` flag JavaScript treats `\p` as a literal `p`, which is valid but matches nothing — indistinguishable from a correct negative result. The condition is reliably detectable (pattern contains `\p{`, flag is off), and it's the one place this tool stays quiet where it diagnoses well everywhere else | Low      |

### Confirmed working — Regex tester

- **Catastrophic backtracking killed at 2s** with a `timeout` code distinct from a parse error, and the message names the likely cause and points at the exact construct in the user's own pattern.
- **Named and numbered group references resolve together** in one replacement string.
- **Group table** shows index, name, value and per-group offset, with match offsets labelled as UTF-16 plus line:col.
- **Non-BMP handling correct** — `𝕏` matched as one unit under `u`, offsets consistent with UTF-16 counting.
- **The UTF-16 note fires contextually**, only when the input contains non-BMP characters, and explains why they count as 2. Correct trigger condition: it's about the input, not the pattern.

> ### Verified — Regex tester
>
> **RX-1: confirmed, worse than reported, and fixed.**
>
> The finding says the tool stays quiet. Measured, `\p{L}+` over `hello world`
> with Unicode off produced **no notes at all** — not one. Not even the
> generic `Even the first part does not match` that `zzz` over `hello` gets,
> because `prefixesOf` yields nothing for a pattern that is a single atom. The
> tool that diagnoses a missing `i`, a missing `m`, a missing `s`, a stray
> `/`, a CRLF ending and a byte order mark said nothing whatsoever about the
> one failure that a flag causes.
>
> **Why the existing checks did not catch it.** `flagProbes` asks the question
> in one direction only: for `i`, `m` and `s` it asks _would this match if the
> flag were ON_, and for `u` and `v` it asks _would this match if the flag were
> OFF_. There is no probe for `u` being off, and `\p{...}` is the only
> construct where that is the whole story. The symmetry was never there to be
> broken, so nothing could fail.
>
> Fixed: see the fix list.

---

## Base64, Hash, Diff — no findings

### Base64

UTF-8 correct in both directions (emoji and accents round-trip byte-identical). Lenient on missing padding. URL-safe alphabet mapped correctly with characters landing in the right positions. Precise errors with accurate column positions on over-padding (`column 18` = the third `=`) and invalid characters (`column 8` = the `@`), the latter listing both permitted alphabets. 76-column wrapping correct with no padding of the short final line. The tool's own wrapped output round-trips, so whitespace is stripped before the strict character check.

### Hash

All five NIST vectors for `abc` exact:

```
MD5     900150983cd24fb0d6963f7d28e17f72
SHA-1   a9993e364706816aba3e25717850c26c9cd0d89d
SHA-256 ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
SHA-384 cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7
SHA-512 ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f
```

No trailing newline added to input (which would have changed every digest). UTF-8 encoding confirmed — `café` and `cafe` differ across all five algorithms.

### Diff

The rendered Changes view annotates affected lines `[differs only in invisible characters]` and carries a warning specifically naming bidirectional formatting characters with an explanation of the consequence. All three whitespace modes produce distinct results, and suppressed differences are disclosed rather than hidden: "1 line differs only in whitespace or case and is shown unchanged, marked ~."

The unified patch drops these annotations, which is **correct** — embedding them would break `git apply`. Worth noting only as documentation: if the patch is the artefact being shared, the invisible-character warnings don't travel with it.

> ### Verified — Base64, Hash, Diff
>
> **Not re-derived, and that is a deliberate choice rather than an omission.**
> Every claim in this section is already held to an external reference that
> outranks anything a manual pass could produce: base64 to RFC 4648 §10 in both
> directions, the five digests to RFC 1321 A.5 and the FIPS 180-4 examples, and
> the unified patch to 38 patches from real `git diff --no-index` at two
> context widths. Re-running them by hand would be a weaker instrument
> agreeing with a stronger one.
>
> What was checked instead is that the write-up's _last_ paragraph is right,
> because it is the only claim in this section that is not covered by a
> fixture: the invisible-character annotations really are absent from the
> unified patch, and [docs/conversion-matrix.md](conversion-matrix.md#diff)
> records why. Confirmed, and it is documentation rather than a finding, as
> stated.

---

## Suggested fix order

1. **SD-1** — auto-detect on unquoted CSV. Default mode, most common input format, and the error message actively misdirects.
2. **SD-2 / SD-5 / SD-13** — target-format awareness. One condition unblocks a whole class of documents. Model it on the CSV→YAML writer, which already does this correctly per value.
3. **TC-1** — table cells. Produces structurally broken output under every setting.
4. **CC-1 / CC-3** — silent colour adjustment. A documented capability that doesn't fire, plus wrong contrast numbers downstream.
5. **SD-4** — CSV header normalisation. Falsely rejects valid files with no workaround.
6. **SD-3** — merge key expansion. Produces output that doesn't re-parse.
7. Everything else, roughly by severity.

> ### Verified — the fix order
>
> The proposed order is replaced by the one in **A proposed fix order** below,
> for three reasons that are findings rather than preferences: item 1 does not
> reproduce, item 2 is two items of very different size, and item 6 is
> behaviour with the decision recorded. What survives unchanged is the
> _instinct_ — TC-1 and CC-1 are near the top there too.

---

## Not yet tested

- **Image convert** — needs a JPEG with EXIF orientation 6 and GPS tags. Checking: output is upright, the strip report names GPS specifically, and the output genuinely carries no EXIF.
- **Video remux** — needs an MKV with H.264 video plus FLAC audio. FLAC isn't carryable in MP4 under most muxers, so it should refuse with the codec named rather than produce a broken file.
- **Canvas wiring** — chaining one tool's output into another's input. The ports are declared on every tool page but no chain has been exercised.
- **File upload paths** — all testing used pasted text; the "Choose file" path and its size limits are untested on every tool.

> ### Verified — not yet tested
>
> Two of these four are covered by an instrument the manual pass could not
> reach, and saying so is worth more than leaving them open:
>
> - **Canvas wiring** is exercised in two real engines by `check:browsers`,
>   and `wireFidelity.integration.test.ts` measures what a wire does to a value
>   using the diff tool as the instrument. Every legal output/input pair whose
>   declared types overlap has been run with real data — recorded in
>   [docs/architecture.md](architecture.md#what-was-looked-at-and-found-sound).
> - **File upload paths** are driven in both engines through a real
>   `DataTransfer`, and `fileInput.test.ts` asserts the sniff's slice and the
>   whole file give a byte-identical verdict.
>
> The other two are genuinely open, and both need a binary fixture the pass
> did not have. **Video remux with FLAC in an MKV is the more valuable of the
> two**, because it tests a _refusal_, and a refusal that fails open produces a
> file that does not play rather than an error — which is the failure shape
> this whole document is about.

---

## What was fixed this round

Four, each self-contained, each with the input that exposed it, and each
assertion run against the break it was written for and watched failing — which
is the house rule and is not a formality here: two of the four were written
first in a form that passed against the broken code.

| Fix                                                                    | Exposing input                                             | Test                                                                                                                       | Watched failing against                                                                                              |
| ---------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **RX-1.** A `\p{…}` property escape with Unicode off is named          | `\p{L}+` over `hello world`, flags `g`                     | `diagnose.test.ts` — `names the Unicode flag when a property escape found nothing without it`, plus four negative controls | The note removed: the pattern is then diagnosed by **nothing at all**, which is the assertion `toHaveLength(1)` pins |
| **An unresolved YAML alias reported as a resource-exhaustion refusal** | `merged: {<<: *base, b: 2}` — found while reproducing SD-3 | `structured-data.test.ts` — three documents, plus a positive partner that a resolving alias still resolves                 | The document argument removed: all three come back `limit-exceeded`                                                  |
| **CC-4.** The chequerboard behind opaque swatches                      | any opaque colour, e.g. `#aabbcc`                          | `ColorView.test.tsx` — four alphas including the boundary                                                                  | The flag forced true: the opaque case fails                                                                          |
| **CC-5b.** A hue that rounds to 360 printed as 360                     | `#800000` written as `oklch()` at 5 places and read back   | `color.test.ts` — the wrap, plus four hues that must not move                                                              | The wrap removed: `hsl(360 100% 25.1%)` against `hsl(0 100% 25.1%)`                                                  |

Two details worth keeping, because they are the reason those fixes are in the
code and the rest are in the plan.

**The alias fix asks the document, not the error.** `yaml`'s `toJS` throws a
bare `ReferenceError` for two unrelated faults and neither carries a code, so
the only thing in the _error_ that separates them is the wording of a message —
and this repository has already written down why that is the wrong thing to
match on (`src/tools/structured-data/README.md`, known limitation 9, on
preferring the library's declared `RESOURCE_EXHAUSTION` code). So the
document is asked instead: `visit` walks in document order, so the anchors
seen when an alias is reached are exactly the ones the library resolves
against. That is why an alias written _before_ its anchor is one of the three
test cases — it is unresolved in YAML however far down the file the `&`
appears, and a check that merely collected every anchor would call it
resolved.

**The 360 fix is an identity and the 359.98 one is a guess**, which is the
line that decided what could be done here. `rgbToHsl` and `rgbToOklch` both
document and deliver [0, 360); only rounding can produce 360; `hsl(360 …)` is
the wrap point printed as the value it wraps to. 359.98 is a different number
from 360 and no formatter can tell a hue that drifted from a hue somebody
meant, so it needs a tolerance, and a tolerance is a decision.

---

## A proposed fix order

Grouped by root cause, sized into rounds. Two of the groups **look like one
change and are not**, and that is said against each.

### Round nine — the tool that cannot speak

**One group, one tool, and it closes four findings and a wrong matrix cell.**

CC-1, CC-2, CC-3 and CC-5a are all the same absence: `color-convert` is the
only shipped tool that changes values and has no `report` port, so no loss it
has can ever meet the matrix's own definition of `lossy, told`. The work is:

1. A `report` output on `color-convert`, `presentation: 'report'`, the same
   shape every other reporting tool uses. Additive, so it breaks no share
   link and no saved canvas.
2. `inGamut` carried out of `parseColor` instead of destructured away, and
   written as a `warn` note naming the input and the nearest sRGB colour.
3. The same note for the `hsl()` and `rgb()` clamps (CC-3), which are the same
   sentence with different numbers.
4. `color-convert` added to `notePorts.test.ts`'s `LOSSY_RUNS`, which is what
   stops this recurring: that list is the nearest thing in the repository to
   an enforcement of `lossy, told`, and the claim escaped it by belonging to
   the one tool the list's own definition — "one input per runnable
   **reporting** tool" — excludes.
5. The matrix cell corrected — and corrected _after_ the port exists, because
   until then the honest cell is `lossy, silent` and writing that down first
   is the point of the count.

**This is genuinely one change.** One tool, one new port, one note builder,
one test-list entry. CC-2 rides along only if the decision below is taken.

**One decision inside it, and it should be taken explicitly:** does the
contrast table composite alpha (CC-2), or does it say it does not? Compositing
is the better answer — each row already names its background, so the maths is
available — but it changes numbers people may have recorded, so it wants to be
a stated change rather than a quiet improvement.

### Round ten — the Markdown target has no census

**Looks like four findings. Is one change plus three consequences.**

TC-1, TC-3, TC-5 and TC-13 are all silent for the same reason: for an HTML
source with a Markdown target, nothing compares the input with the result.
The instrument exists — `compareMarkup` — and `HTML → HTML (normalised)` is
exactly one further `markdownToHtml` call away from what the Markdown target
already computes.

1. Run the same three-document comparison for an HTML source with a Markdown
   target. `<caption>`, the dropped list structure and the invented header row
   are then reported by code that is already written and already tested.
2. **TC-1's actual defect is separate and must not be folded in.** The cell
   emitting a literal newline is a correctness bug in the cell path, not a
   reporting gap, and it is the highest-severity item in this document that is
   still open: it produces a GFM document that renders wrongly, under all
   three policy values. Fix the newline; the report is what tells the user
   what was lost when the list is flattened.
3. **TC-9 does not ride along**, and this is the one to say out loud. A census
   of names cannot see `class="btn"` becoming `class=""`, so adding the census
   to the Markdown target does not report it, and the matrix's claim that
   value changes were "resolved in round four" is true only of `id`. That is
   a change to the _instrument_, which is a different job.

### Round eleven — the value model

**Looks like one condition. Is a change to a compile-time type.**

SD-2 and SD-5 are one item: `Reading.data` is `JsonValue`, which is the
payload of the `json` data type every port in the app is typed against, so a
`.nan` and an integer key cannot reach a YAML writer without either a second
value model for YAML→YAML or widening `JsonValue` everywhere. Both have
consequences on the canvas, in the cache key and in `checkConnection`.

**Do not start this by moving a check.** Start it by deciding whether
YAML→YAML is a distinguished path in this tool at all. If it is not, the
right outcome is a better refusal, not a wider type — and a better refusal is
cheap: the message should not name JSON on a run where the user chose neither
JSON as source nor JSON as target.

Riding along, and each is small on its own:

- **SD-13** — the rounding note's `"Convert to CSV or TSV"` sentence is a
  hard-coded literal appended whatever the target is. The write-up is right
  that this is a misplaced check; it needs the target threaded into the read
  half, which is why it is here and not in the fixed list.
- **SD-12** — collect every unsupported value rather than stopping at the
  first. Same function, same walk.
- **Every `unsupported-type` refusal carries a path and no position.** The
  YAML reader knows the node's range; the JSON boundary check does not receive
  it. That is theme 3's fourth member and it belongs with this work.

### Round twelve — the reports that do not fire

**Four small, genuinely independent items.** No shared cause beyond "a `warn`
note was never written", so they can be done in any order or split across
people.

| Item  | Note to add                                                                                                                         |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- |
| SD-4a | Header cells were trimmed, naming which. The decision is recorded; the silence is not.                                              |
| SD-9  | A YAML tag was dropped, naming it.                                                                                                  |
| SD-10 | A duplicate JSON key was discarded, naming the key and the value that lost. Next to the JSONC report, which counts trailing commas. |
| SD-16 | Anchors were expanded (they are **expanded**, not dropped — the alias structure is what goes); scalar styles were collapsed.        |

And two message fixes in the same area, which are not notes:

- **SD-4b** — say that trimming is why two visibly different headers collided.
- **SD-4c** — the real defect: check a synthesised `column_N` against the
  names already in the file before using it.

### Round thirteen — the rest, and the two questions

- **SD-6**, the TSV writer's CSV-style quoting. Both halves of the finding are
  confirmed. It needs a decision — escape, or refuse — and the decision is
  about a format with no specification, so it wants the same treatment as the
  root-block-scalar question in the matrix: measure what real readers do.
- **SD-8**, `!!float 1` → `"1"`.
- **SD-14b**, the duplicate-header position.
- **SD-15**, the sort collation. Almost certainly a documentation item rather
  than a change: the current order is `localeCompare`-shaped and changing it
  would move every sorted output anyone has saved.
- **TC-8**, **TC-11**, **TC-12**, **JWT-3** — each a one-line decision.
- **JWT-1** — a product decision about a fifth verdict state, not a routing
  change. A header with no `alg` is a malformed JWS under RFC 7515 §4.1.1,
  and the other malformed shapes are hard errors; whether this becomes
  `broken` or a new word is the question.
- **SD-1's real gap** — a single-column CSV cannot be auto-detected, because
  `looksDelimited` requires two fields. Either a documented limitation or a
  different signal.
- **CC-5a** — the 359.98 hue, once somebody picks a tolerance.

### Not on the list, with reasons

- **SD-3**, **SD-11**, **CC-6**, **TC-13's decision** — behaviour with the
  decision recorded; confirmed still true this round and not re-opened.
- **SD-7**, **SD-14a**, **TC-2**, **TC-7**, **JWT-2** — do not reproduce.
- **SD-1 as written** — does not reproduce; what reproduces is the ragged-row
  refusal, which is a recorded decision.

---

## The silent-loss count

The brief asks how many silent losses there really are, and what the count
should say instead "given it has now been wrong twice". The answer to the
first is **worse than the write-up's eight**, and the answer to the second is
that the count should stop being an absolute number.

### What is actually silent

Measured by running each conversion and reading its `report` port, not by
reading the code.

| #   | Loss                                                     | Named in the matrix?             | Told?  |
| --- | -------------------------------------------------------- | -------------------------------- | ------ |
| 1   | Out-of-gamut OKLCH clipped                               | Yes — as **`lossy, told`**       | **No** |
| 2   | Out-of-range `hsl()` clamped                             | No                               | No     |
| 3   | Out-of-range `rgb()` clamped                             | No                               | No     |
| 4   | A YAML **comment** dropped on the way to JSON            | Yes — as **`lossy, told`**       | **No** |
| 5   | A YAML **anchor** expanded on the way to JSON            | Yes — as **`lossy, told`**       | **No** |
| 6   | A YAML **tag** dropped on the way to JSON                | Yes — as **`lossy, told`**       | **No** |
| 7   | A YAML **block style** collapsed on the way to JSON      | Yes — as **`lossy, told`**       | **No** |
| 8   | A YAML anchor expanded on the way to **YAML**            | No                               | No     |
| 9   | A YAML scalar style collapsed on the way to **YAML**     | No                               | No     |
| 10  | A non-string YAML key stringified                        | No                               | No     |
| 11  | A CSV header cell trimmed                                | No (recorded in the tool README) | No     |
| 12  | A duplicate JSON key discarded, last wins                | No                               | No     |
| 13  | `<caption>` dropped, Markdown target                     | No                               | No     |
| 14  | A table cell's list structure flattened, Markdown target | No                               | No     |
| 15  | An empty header row invented, Markdown target            | For the **HTML** target only     | No     |
| 16  | `class="btn"` emptied to `class=""`                      | No                               | No     |
| 17  | `<mark>` and `<kbd>` given formatting they never had     | No                               | No     |

**This table is now a fixture.** Every row of it is a document in
[`spec/loss-corpus.json`](../src/features/registry/spec/loss-corpus.json), with
the note that row must produce, and the `Told?` column above is frozen at what
round eight measured by hand. The live answer is derived by running the tools:
see [the corpus and the ratio](conversion-matrix.md#the-corpus-the-ratio-and-why-it-is-not-a-number-any-more)
in the conversion matrix, which is generated and compared by a gate. Rows 1 to
3 are told as of round nine; the other fourteen are not.

Seventeen, of which **five are cells the matrix already carries as
`lossy, told`** — one in Colour and four inside one row of Structured data.
That is the finding, and it is not the one the brief expected: the problem is
not mainly losses the matrix fails to name. It is losses the matrix names and
records as told, which are not told.

`&nbsp;` is not on the list; it does not reproduce (TC-2). Two of the
write-up's eight are on it as four rather than two, because "YAML anchors" and
"scalar styles" are each silent on two different target paths and the matrix
treats them as one claim.

### Both wrong cells are aspirational

- **Colour, out-of-gamut.** `inGamut` has been computed and discarded since
  `e56bd2f`; `git log -S inGamut` over the whole history returns that one
  commit. Nothing was ever wired, so nothing drifted.
- **`YAML → JSON`.** No note for a comment, an anchor, a tag or a block style
  has ever been written: there is no builder for one in `report.ts` and no
  commit that removed one. The `report` port arrived in round three with
  notes for the losses that round _fixed_, and this row's four were described
  as told in the same document without being told.

### What the count should say instead

**The count has been wrong twice for the same reason, and it is the reason
the matrix itself gives.** Round four wrote it down: _"The column being empty
meant every loss anybody had NAMED was told; it could not mean there were none
left to name."_ That diagnosis is right and the remedy taken from it was not:
the remedy was to name more losses and re-report zero, which is the same
instrument with a longer list behind it.

The deeper problem is different, and this round is the evidence for it:
**nothing anywhere enforces `lossy, told`.** The verdict in each cell is
written by hand, and the only test that comes near it was built for something
else. `notePorts.test.ts` runs one input per reporting tool that really loses
something and holds every `warn` note to a non-empty subset of that tool's own
output ports — but its subject is `ToolNote.reaches`, which port a loss
travels to, not whether a documented loss is reported at all. Its own comment
says so: _"this list is not a second opinion about what is lossy — it is the
same losses, asked a different question."_

Both wrong cells pass straight through it, by two different routes:

- `color-convert` is not in `LOSSY_RUNS` at all. It could not be: the list is
  "one input per runnable **reporting** tool", and a tool with no report port
  would fail the list's own `notes.length > 0` guard rather than being covered
  by it.
- `structured-data` **is** in the list, three times, and passes — because the
  three inputs chosen are three losses that _are_ reported. Nothing asks about
  the fourth, fifth, sixth and seventh, and one `warn` note satisfies the test
  for every row the tool owns.

So the count was not wrong because somebody miscounted. It was wrong because
there was no instrument, and the nearest thing to one is a test about a
different field with a hand-picked input list.

So the recommendation is three lines rather than a number:

1. **Stop printing an absolute count.** Replace _"it is zero"_ with a
   ratio over a named, committed corpus: _"N of N losses in
   `spec/loss-corpus.json` are told"_, one document per row of this document's
   table, each with the note it must produce. A ratio has a denominator, and a
   denominator is a thing somebody can add to.
2. **Make `lossy, told` a derived verdict rather than a written one.** A cell
   may say `told` only if a case in that corpus proves it. A row with no case
   reads `not verified`, which is the honest word this document already has
   and already ranks. That is the change that would have caught both cells.
3. **Keep an absolute number, but of the other thing.** The sentence worth
   printing beside the ratio is not "zero are silent" — it is _"a round has
   reported zero twice, and both times the next round to look found more."_
   Round three reported zero and round four found two; rounds four to seven
   reported zero and this round found seventeen. Counting the rounds is the
   only number in this area that has never been wrong, and it is the one that
   tells a reader what the ratio above it is worth.

---

## The crash B timeline

**The question in the brief is why a fault that hits roughly one run in three
never showed up, when every round has reported `check:browsers` green. The
answer is that the window in which it could show up is two rounds wide, and
the exposure inside that window tripled at a commit that can be named.**

### The check that can see it did not exist before round five

`jwtVerdict` — the helper that drives a published JWS token through the real
UI and waits for `[data-trust]` — first appears in
`scripts/cross-browser-check.mjs` at **`825d50a`**, round five. Traced across
every commit that has touched the harness:

| Commit                | Round    | `jwtVerdict`            | UI-driven RSA verifications per engine |
| --------------------- | -------- | ----------------------- | -------------------------------------- |
| …–`7eeb2f8`           | one–four | **absent**              | **0**                                  |
| `825d50a`             | five     | present, bare `waitFor` | **2**                                  |
| `326a057`             | six      | present, 4 examples     | **6**                                  |
| `51151bd` … `592b3b2` | seven    | unchanged               | **6**                                  |

Before `825d50a` no harness in this repository ever asked a real engine to
verify an RSA signature through the tool's own worker and banner. A green run
from rounds one to four is therefore not evidence about this fault; the fault
had nothing to happen inside. That is the whole of the paradox in the brief.

**And at `825d50a` an occurrence would not have looked green — it would have
looked like a crash.** The wait was a bare `waitFor`, so a timeout threw an
uncaught `TimeoutError` and took the run with it. So round five's green runs
are honest evidence of _no occurrence in those runs_, and a run that did hit
it would have been reported as a harness explosion with a stack trace naming a
line, not as a JWT finding. Round seven is the first round in which an
occurrence reports itself as what it is — which is exactly when the three
recorded occurrences appear.

### Is the rate rising? Yes, and the step is measurable

The brief's mechanism — more checks running before it, more accumulated
browser state — is a hypothesis about position in the run, and it is not the
one the harness's own history supports. What rose is not the number of checks
before the JWT block. **It is the number of RSA verifications inside it.**

|                                                  | `825d50a`        | `326a057` onwards              | Change |
| ------------------------------------------------ | ---------------- | ------------------------------ | ------ |
| UI examples driven                               | 2 (RS256, ES256) | 4 (HS256, RS256, ES256, PS256) | ×2     |
| `jwtVerdict` page loads in the block             | 7                | 16                             | ×2.3   |
| **RSA/RSA-PSS verifications actually performed** | **2**            | **6**                          | **×3** |

The last row is the one that matters if the standing hypothesis is right — a
verification overrunning `jwt-decode`'s own 10s worker deadline. Under that
hypothesis, a per-verification failure probability `p` gives a per-run
probability of `1 − (1−p)ⁿ`, and `n` went from 2 to 6 at `326a057`. At a `p`
small enough to be invisible in round five, that is very close to a threefold
rise in occurrences per run — and all three recorded occurrences are in round
seven, none in round five or six.

**So the brief's conclusion stands and its mechanism does not.** The rate has
risen, it rose at a nameable commit, and it will rise again the next time an
algorithm is added to `JWS_UI_EXAMPLES` — which round six's own note makes
likely, since it records that only four of twelve algorithms can be driven
through the whole pipeline today and that widening the payload contract would
admit more. This is not parkable on the grounds that it is rare, because what
makes it rare is a number the project intends to increase.

It is _also_ not evidence against the accumulated-state idea; nothing here
separates the two, and separating them is the instrumented occurrence that is
already deferred. What can be said without chasing it is that **exposure alone
accounts for the pattern of observations**, which is the cheaper explanation
and the one that predicts the next rise.

### What was run, and what the runs can and cannot support

| Run | Commit    | Result               | Checks                       |
| --- | --------- | -------------------- | ---------------------------- |
| 1   | `592b3b2` | green, no occurrence | 2,627 ok, 0 fail, 10 skipped |
| 2   | `592b3b2` | green, no occurrence | 2,627 ok, 0 fail, 10 skipped |
| 3   | `592b3b2` | green, no occurrence | 2,627 ok, 0 fail, 10 skipped |

**These runs cannot settle the rate and are not offered as if they could.**
At the recorded ~1-in-3, three clean runs have probability 0.30 — unremarkable
either way, and consistent both with the recorded rate and with a lower one.
Reaching 95% confidence that a commit _does not_ exhibit the fault needs about
eight consecutive clean runs; at roughly 50 minutes a run that is close to
seven hours for one commit, and the comparison the brief asks for needs at
least two commits. That was not spent, for a stated reason: **the structural
answer above is decisive and needs no runs at all**, and an underpowered
sample placed beside it would invite a conclusion it cannot carry.

**One thing the three runs do say**, because it is a qualitative claim rather
than a rate: the fault did not reproduce on an otherwise idle machine in three
consecutive full runs, which is consistent with every previous report of it —
it has never reproduced in isolation either (six consecutive passes of
`checkOutputViews` alone under load). Nothing here contradicts the existing
record; nothing here adds to it.

What the runs do establish is the denominator the brief asked about: the suite
is **2,627 checks with 10 skips**, not "over 2,300". The 2,200 → 2,300 figures
in the brief are low, which slightly weakens the accumulated-state reading
rather than strengthening it — the suite has grown more than was thought, and
the fault's three occurrences still cluster in the one round where the JWT
block itself grew.

### What would settle it, cheaply, when somebody does look

Recorded here rather than done, because the brief defers the mechanism:

1. **Count the RSA verifications in the block from inside the run** and print
   it in the summary. One number, no browsers, and it turns "exposure rose"
   from an archaeology exercise into a line in every log.
2. **Time each `jwtVerdict` call** and report the slowest. If the deadline
   hypothesis is right, the distribution in WebKit should already have a tail
   near 10s in runs that pass, and that is visible without ever catching a
   failure.
3. Only then, the instrumented occurrence.

---

## What was looked for and not found

Recorded because an absence is worth nothing unless somebody says what they
looked for.

- **A detection regression from round three.** Traced every commit that has
  touched `convert.ts`. `parsesAsYamlMapping` fires only when a document parses
  as a YAML _mapping_, and no plain CSV does; `looksDelimited`'s two bars both
  predate round three. The negative control the brief suspected
  (`still reads %s as a table`) tests what it claims — it drives the whole tool
  and reads the report, rather than asserting on the detector — and passes.
- **Anything in this app that normalises U+00A0.** Grepped the whole source
  tree: the only occurrence is the diff tool's space-lookalike list, which is
  a different tool doing a different job on purpose. Not in the sanitiser, the
  pipelines, the output views or either clipboard path.
- **An asymmetry between `exp` and `nbf` prominence.** Same element, same
  class, same signal colour, same icon, and a test each.
- **A quoting-dependent detection path.** Twenty-four CSV shapes swept with and
  without quoting; quoting moved no verdict in either direction.
- **A merge key being expanded.** Nothing in the tool expands `<<`. Under 1.2
  core it is an ordinary key and the round trip is byte-stable; under a
  declared `%YAML 1.1` it merges correctly.
- **A TSV row with the wrong field count.** Measured byte for byte; the row
  has the right count and the fields are empty.
- **A third `lossy, told` cell that is false.** The other reporting tools were
  run on input that exercises their named losses and each produced its note:
  the JSONC report, the sanitiser's attribute census, the big-int rounding
  note, the absent-column note, the LF-terminator note and the stream note all
  fire. The two that do not are the two above.
- **A fifth colour finding.** The four notations, hex doubling at 3/4/6/8
  digits, slash-alpha and the oklch round trip at five places were re-measured
  and are as the write-up found them.

---

## Candidates for the two rounds after this one

Written down rather than acted on, as asked.

### For the complexity pass

- **`inGamut` is scaffolding nobody removed** — computed on every oklch parse,
  read by one test. Either wire it (round nine above) or delete it; what it
  must not stay is a correct answer nothing consumes.
- **`truncatedToken`** is built for every entry in `JWS_UI_EXAMPLES` in the
  harness and used by exactly one check, on one example.
- **`untriedDelimiter`** re-runs `looksDelimited` over the whole source after
  detection has already run it over a bounded prefix, on a path reached only
  when everything else has failed. Worth checking whether the second, unbounded
  pass is needed.
- **Two `jwtVerdict`-shaped helpers**: the harness's `jwtVerdict` and the unit
  suite's `decode` both build a token and read a verdict, with different
  fixtures and different controls. Probably right to keep both; worth stating
  why once rather than leaving it to be rediscovered.

### For the documentation audit

Beyond the mismatches listed in the report, these were noticed in passing and
not chased:

- `src/lib/markup/changes.ts` — _"The one case in this app is `id`"_. `class`
  is a second case. See TC-9.
- `src/lib/markup/sanitise.ts` — classes are said to be allowed on
  _"`li`, `ol`, `code`, `div`, `span`"_. In the schema actually inherited,
  `div` and `span` have no `className` entry and `a`, `h2`, `section` and `ul`
  do. The comment also names no version of the dependency it describes, which
  is the part that makes it un-maintainable rather than merely wrong.
- `README.md` — the Lighthouse table's `/` row is already flagged as
  predating the cold open. The test count in the same section reads
  "5,012 tests across 125 files"; it is 5,032 across 125 as of this round, and
  a number that has to be hand-edited will be wrong again by the next one.
- `README.md` and `src/tools/text-convert/index.ts` — _"Convert between
  Markdown, HTML and plain text"_. See TC-14.
- `docs/conversion-matrix.md` §"Still unverified", item 4 — the claim that an
  attribute whose value changed was resolved in round four. True of `id` only.

---

## The report

### Confirmed, refuted, reclassified

Forty numbered findings.

| Outcome                                    | Count  | Which                                                                                             |
| ------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------- |
| **Confirmed exactly as described**         | 15     | SD-6, SD-9, SD-10, SD-12, SD-13, SD-15, TC-3, TC-5, TC-10, TC-11, TC-12, TC-14, JWT-3, CC-2, CC-4 |
| **Confirmed, cause or scope differs**      | 11     | SD-4, SD-5, SD-8, SD-14, SD-16, TC-4, TC-6, TC-9, JWT-1, CC-3, CC-5                               |
| **Confirmed, and worse than reported**     | 3      | TC-1, CC-1, RX-1                                                                                  |
| **Not reproducible as described**          | 6      | SD-1, SD-7, TC-2, TC-7, TC-8, JWT-2                                                               |
| **Working as designed, decision recorded** | 5      | SD-2, SD-3, SD-11, TC-13, CC-6                                                                    |
| **Total**                                  | **40** |                                                                                                   |

So **29 of 40 describe behaviour that is wrong and still open**, 5 describe
behaviour that is right and already recorded, and 6 do not reproduce. For a
pass conducted entirely through the UI with no sight of the code, that is a
high hit rate, and it is the reason this round is worth the shape it has.

**The three that are worse than reported are worse in the same direction**, and
it is the direction that matters: in each case the tool has more of the answer
than the write-up credits and does less with it. RX-1 does not merely withhold
a hint — it produces no diagnosis at all for a pattern it diagnoses six other
ways. CC-1 does not merely fail to detect the clipping — it computes the
verdict correctly and throws it away. TC-1 ignores the policy under all three
values rather than two.

**The six that do not reproduce share a cause** worth naming, because it is
about method rather than about any of them: each is a correct observation with
the wrong variable named, and in five of the six the thing observed looks one
way on a screen and another way in bytes — SD-7's trailing tabs, TC-2's
digest, TC-7's and TC-8's escape rules, JWT-2's strip. SD-1 is the sixth and the costliest, because the variable it names (quoting) is one the fixture varied alongside the
one that mattered (ragged rows). None of this is a criticism of stacking edge
cases into a fixture, which is what found the other thirty-five. It is the
cost of that technique, and it is removed cheaply by re-running the smallest
document that still fails before writing the cause down.

**And one of the six still found something.** SD-1 does not reproduce, and
looking for it found that a single-column CSV cannot be auto-detected at all —
a real gap, undocumented, that nothing in the write-up names.

### Where a check existed and passed anyway

Five, and they are five different mechanisms.

1. **`color.test.ts` asserts `inGamut` is `false` for an out-of-gamut
   colour — and nothing asserts a caller.** The function is correct; the
   feature does not exist. A unit test of a pure function cannot see that its
   only consumer destructures the answer away. (CC-1)
2. **Nothing enforces `lossy, told`, and the test that looks as though it does
   was built for something else.** `notePorts.test.ts` runs one lossy input
   per reporting tool — but its subject is `ToolNote.reaches`, which port a
   loss travels to. `color-convert` cannot be in its list at all, because a
   tool with no report port fails the list's own "this input loses something"
   guard rather than being covered by it. **The claim escaped by belonging to
   the tool the subject list defines away.** (CC-1)
3. **The same test passes for `structured-data` three times while four of its
   named losses are silent.** Its three inputs are three losses that are
   reported; nothing asks about the others, and one good note satisfies it for
   every row the tool owns. (The `YAML → JSON` cell.)
4. **"WCAG ratios internally consistent — black × white ≈ 21" is satisfied by
   a luminance function that ignores alpha**, because both controls are
   opaque. The assertion is true of the correct code and equally true of the
   broken code. (CC-2)
5. **`compareMarkup` is a census of names, so `class="btn"` → `class=""` is
   `class` on both sides.** The matrix records this half as resolved in round
   four; it was resolved for `id` and `name` only. (TC-9)

And one that is the opposite, reported because the brief suspected it:
**round three's detection control tests exactly what it claims and passes
correctly.** It drives the whole tool and reads the report rather than
asserting on the detector, so it could not pass while the tool refused the
document. SD-1 is not a regression.

One near-miss worth a line: **`JwtView.test.tsx` asserts the expired strip's
text and the not-yet strip's attribute only.** Nothing is wrong today, but the
two claims are not the same strength, and the weaker one is on the case the
write-up suspected.

### Every doc mismatch, classified

| Mismatch                                                                                            | Where                                                   | Classification                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Out-of-gamut OKLCH "clipped and **reported**", `lossy, told`                                        | `docs/conversion-matrix.md` §Colour                     | **Aspirational.** `inGamut` has never been read by anything but a test, in any commit. A feature is missing, not a sentence.                                        |
| `YAML → JSON` `lossy, told` — "comments, anchors, tags and the choice of block style … are dropped" | `docs/conversion-matrix.md` §Between formats            | **Aspirational.** No note for any of the four has ever been written; there is no builder for one and no commit removed one. Four missing notes, not one wrong word. |
| "an attribute whose VALUE changed, was resolved in round four"                                      | `docs/conversion-matrix.md` §Still unverified, item 4   | **Aspirational.** Resolved for `id`/`name` via `renamedIdentifiers`; `class` was never covered and is live.                                                         |
| "`lossy, silent` … It is empty" / "It is **zero**"                                                  | `docs/conversion-matrix.md` §What the count was, and is | **Drift**, and structural — see the count section. Seventeen are silent, five of them in cells the same document calls told.                                        |
| The headerless-table invention is "reported"                                                        | `docs/conversion-matrix.md` §Text convert               | **Not a mismatch.** The cell is about `HTML → HTML`, where it is reported. Incomplete rather than wrong: the Markdown target invents the same row silently.         |
| "The one case in this app is `id`"                                                                  | `src/lib/markup/changes.ts`                             | **Never true** — see below.                                                                                                                                         |
| Classes allowed "on `li`, `ol`, `code`, `div`, `span`"                                              | `src/lib/markup/sanitise.ts`                            | **Never true, or drifted with a dependency that the comment does not name** — which is itself the defect.                                                           |
| "Convert between Markdown, HTML and plain text"                                                     | `README.md` tool table, `text-convert`'s `summary`      | **None of the three.** An ambiguous sentence, not a claim about a feature.                                                                                          |
| "5,012 tests across 125 files"                                                                      | `README.md` §Testing                                    | **Drift.** 5,032 as of this round - and it read 5,031 on an earlier run of the same tree, which is the argument against hand-editing it at all.                     |

**One place the three-way classification does not reach, and I think it needs
a fourth.** _Aspirational / drift / deliberate_ all assume the doc was once
aligned with an intention or with the code. Two of the mismatches above were
**never true of anything** — nobody intended `class` to be the only rewritten
attribute, and nobody ever made `div` a class-bearing element; somebody wrote
down what they believed while reading an inherited object. That is a different
failure with a different remedy: an aspirational claim means build the
feature, a drifted claim means update the sentence, and a never-true claim
means **the sentence was not checkable when it was written and should be
replaced by something that is** — in both these cases, an assertion against
the schema rather than a description of it.

### Anything in the findings or the framing I think is wrong

Six things, in descending order of how much they would have cost.

1. **Theme 2's counter-example proves something adjacent to what it is read as
   proving.** The CSV→YAML quoting decision is in the writer and the check is
   in the reader, with a compile-time type between them. Building on "SD-2,
   SD-5 and SD-13 are a misplaced check" would have produced a round that
   started by moving a check and discovered halfway through that it was
   changing `JsonValue`. SD-13 really is misplaced; the other two are the
   value model.
2. **Theme 1 is three jobs wearing one name** — no channel, a channel this
   path does not reach, and a channel whose instrument cannot see the change.
   Sized as one theme it would have been one round and come out a third done.
3. **SD-1 is not a regression and the control is sound.** The brief's
   hypothesis — "either that control does not test what it claims, or
   something else narrowed detection" — has a third answer, which is that the
   finding's document converts and the one that does not is ragged. Spending a
   round bisecting detection would have found nothing.
4. **The crash B mechanism in the brief is probably not the one.** Accumulated
   browser state is a story that fits; exposure inside the JWT block tripling
   at `326a057` is a measurement, and it accounts for the observations on its
   own. The brief's _conclusion_ — that the rate is rising and this stops
   being parkable — is right, and is righter than the reasoning behind it,
   because the thing that drives it up is a number the project means to
   increase.
5. **The silent-loss count cannot be fixed by counting better.** It has been
   wrong twice because it is an absolute over a hand-written list, and the
   third attempt would fail the same way. The fix is a denominator and a
   derived verdict.
6. **"Some will be misdiagnosed, some will be decisions already taken."** Both
   true, and the proportion is worth knowing for the next pass: 5 of 40 are
   recorded decisions and 6 of 40 do not reproduce, so **29 of 40 findings
   from a UI-only pass with no sight of the code were real and are still
   open.** That is a high hit rate, and all six mis-attributions came from
   one step of the method rather than from the method being weak. The next
   pass should keep the stacked fixtures and add the minimal re-run.

### What is not in this document

The write-up's own _Not yet tested_ list is answered above. Two things this
round did not settle and did not pretend to:

- **Whether a browser normalises U+00A0 somewhere between the tool and the
  clipboard.** No code in this app does. That is a negative assertion whose
  subject is an engine, which is the shape this repository already knows not
  to trust: the minimal check is in the plan.
- **Whether crash B occurs at `825d50a`.** Not run. The structural answer
  makes it a much less interesting question than it looked, and the run budget
  it needs is stated rather than spent.

---

## Round nine, done

2026-09-20, against `8a5f8ae`. Two pieces of work: the first item of the plan
above, and the instrument the count section above recommends. They are one
round on purpose — the second is what stops the first from being a verdict
somebody typed.

### Part one — the tool that can speak

| Built                                                          | Where                                             |
| -------------------------------------------------------------- | ------------------------------------------------- |
| A `report` output, `presentation: 'report'`, additive          | `src/tools/color-convert/index.ts`                |
| `inGamut` carried out of `parseColor` rather than destructured | `src/tools/color-convert/color.ts`, `ParsedColor` |
| The same for the `hsl()`, `rgb()`, `oklch()` and alpha clamps  | the same, `outOfRange`                            |
| `color-convert` in `notePorts.test.ts`'s `LOSSY_RUNS`          | two entries: the gamut case and a clamp case      |
| The contrast table composites alpha, and says so               | `src/lib/wcag.ts`, `ColorView.tsx`                |
| The matrix cells, corrected after the port existed             | `docs/conversion-matrix.md`                       |

**The note names the input and the nearest sRGB colour**, which is the sentence
a node prints on its own face: `oklch(0.7 0.4 150) is outside sRGB; the nearest
is #00d600`, and `hsl(361 110% -5%) was clamped to #000000` with the body naming
`saturation 110%` and `lightness -5%`.

**The hue is deliberately not on that list.** `hsl(361 …)` is `hsl(1 …)` exactly
— CSS wraps a hue and `hslToRgb` wraps it the same way — so naming it would be
a note about a loss that did not happen, which is the one failure mode a
reporting channel cannot afford. Three inputs assert the wrap is not reported.

**Two clamps the plan did not name are reported too**, because they are the same
sentence with different numbers and leaving them out would have been a decision
rather than a scope: an `oklch()` lightness outside 0–1 or a negative chroma,
and an alpha outside 0–1 in any of the three function notations. A chroma too
LARGE is not a clamp — OKLCH has no upper bound on it — it is the gamut
question, and it is reported as that.

**`parseColor` returns the adjustments to every caller rather than to a second
function.** The five call sites in the theme editor read `.value.color` and
discard them, which is right for a theme token, but there is now no
lower-fidelity entry point for a future caller to pick by accident. That is the
whole of the change that closes CC-1: the value was always computed.

#### The decision inside it, taken

**The contrast table composites alpha.** `#aabbccdd` reported 10.69:1 and
1.96:1, byte-identical to opaque `#aabbcc`; it now reports the ratios for
`#93a2b1` on black and `#b5c4d3` on white. Source-over on the gamma-encoded
channels, because that is what the platform's compositor does and the platform
is available to ask: `check:browsers` paints the same colour over the same
backdrop on a real 2D canvas in Firefox and WebKit and reads the pixel back, so
the formula rests on an oracle rather than on being the obvious one.

**It is said on screen rather than improved quietly**, which is what the brief
asked for and is the right call for a number people write into a ticket: the
caption becomes _Contrast, WCAG 2.1, composited onto each background_ and the
line under the table names both composited colours and says that ratios here
used to ignore alpha. Opaque colours are untouched — at `a === 1` the composite
is the identity — so no number anybody recorded for an opaque colour has moved,
and that is asserted in both directions.

#### Proving test and negative control, per item

| Fix                    | Proving test                                                                   | Negative control                                                       | Watched failing against                                                      |
| ---------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Out-of-gamut note      | `color.test.ts` — the parser, and the note naming input and `#00d600`          | four in-gamut colours, plus five notations that produce no note at all | `if (false && outOfGamut)`: ratio 3→2, `lossCorpus` and `notePorts` both red |
| Clamp note             | `color.test.ts` — five inputs, each component named                            | six colours that clamp nothing, including `rgb(50% 50% 50%)`           | the note made unconditional: the corpus control caught it, once strengthened |
| The hue is not a clamp | three wrapping hues assert `clamped` is empty                                  | is itself the control                                                  | naming the hue in `outOfRange`                                               |
| `reaches`              | `color.test.ts` asserts `['output', 'swatch', 'all']`                          | `notePorts.test.ts` holds it to the manifest                           | the list emptied                                                             |
| A wired-in colour      | `color.test.ts` — a `color`-port input reports nothing                         | is itself the control                                                  | —                                                                            |
| Composited contrast    | `ColorView.test.tsx` — translucent ratios must differ from the opaque twin     | black, white and the opaque twin must be exactly where they were       | the composite removed, and separately its weights swapped                    |
| Drawn, in two engines  | `checkColourReports` — `/tools` and a canvas node face, boxes of non-zero size | `#aabbcc` draws no note and its node says nothing about loss           | see below                                                                    |

**The negative control was wrong on its first run, and that is the finding
inside the finding.** The corpus's control matched a note by title AND by the
strings the note had to name — so when the clamp note was made unconditional
to test the control, it passed: the note it wrote on the clean document named
the CLEAN colour, and the control was looking for the dirty one. A note that
cries wolf is a note about the right subject on the wrong document, so the
control now matches on the subject alone. It was found by breaking the code
rather than by reading the test, which is the only way it could have been.

### Part two — the count is an instrument

`spec/loss-corpus.json`, `lossCorpus.test.ts`, and a generated block in the
conversion matrix.

1. **One document per row of the seventeen**, each with the note it must
   produce and a second document of the same shape that must produce nothing.
   For the fourteen silent rows the expectation is a SPECIFICATION rather than
   a description — it says what the note has to name when somebody writes it,
   so rounds ten to twelve have a target rather than a sentence.
2. **`lossy, told` is derived.** Every case is run, its `report` ports are read
   the way the canvas reads them, and the verdict falls out. A row with no
   runnable case reads `not verified`; the shape supports it and no row needs
   it yet.
3. **The matrix prints the ratio and the block is generated.** The test builds
   the table and compares it with what is between the `loss-corpus` markers,
   normalised for Prettier's column padding. The failure message IS the
   replacement text, so the document is updated by pasting rather than by
   counting — which is the step both wrong counts came from.
4. **Extending it is appending an object.** Nothing else changes: the row
   count, the ratio, the table and the sentence are all derived.

**The ratio before and after.** Before: there was no ratio, and the last
absolute this document carried was zero, from round seven. After:

|                                                |             |
| ---------------------------------------------- | ----------- |
| Before round nine, measured by the same corpus | **0 of 17** |
| After round nine                               | **3 of 17** |

**Shown failing.** Removing the out-of-gamut note with `if (false && …)` drops
the ratio to **2 of 17** and turns two gates red at once — `lossCorpus.test.ts`,
whose generated block no longer matches the document, and
`notePorts.test.ts`, whose `toBeGreaterThan(0)` guard catches the same run. The
diff vitest prints names the row that stopped being told.

### What the framing got wrong

**The brief expects four of seventeen. It is three.** The number four comes
from the plan above, which says round nine closes _"CC-1, CC-2, CC-3 and
CC-5a"_ — four FINDINGS, not four rows of the seventeen-row table. Mapping
them:

| Finding | Corpus row                                  |
| ------- | ------------------------------------------- |
| CC-1    | row 1, out-of-gamut OKLCH                   |
| CC-3    | rows 2 AND 3 — `hsl()` and `rgb()`          |
| CC-2    | **not a row.** Contrast is not a conversion |
| CC-5a   | **not a row, and not done** — see below     |

CC-2 is fixed this round and is not in the corpus because the corpus measures
documented LOSSES that are told, and a ratio computed from the wrong luminance
is not a loss — it is an answer that was wrong and is now right. Putting it in
would inflate the denominator with a row that can never go red for the reason
the file exists.

CC-5a is not done, and the plan is right that it should not be: 359.98 is a
different number from 360 and no formatter can tell a hue that drifted from a
hue somebody meant, so snapping it needs a tolerance and a tolerance is a
decision. It stays in round thirteen.

So **three is the true number**, and it is exactly the kind of number this
round exists to produce rather than argue about. The corpus says three because
three cases proved it.

### What was looked for and not found

- **A fourth colour loss among the seventeen.** There is none: rows 4 to 17 are
  `structured-data` and `text-convert`, and they are rounds ten to twelve.
- **A row that was already told and recorded as silent.** Every one of the
  fourteen was run and every one is silent, so round eight's hand measurement
  reproduces exactly. Row 16 needed its input corrected first: `class="btn"` is
  emptied rather than removed only on the elements whose schema entry allows
  `className` with a value filter, so `<p class="btn">` reports a removal and
  `<a class="btn">` reports nothing. The corpus carries the `<a>` case.
- **An existing note that the corpus could match by accident**, which would
  make a row read told for the wrong reason. Each of the fourteen silent rows
  was run and produces no `warn` note at all, so there is nothing for a title
  match to collide with today; the mentions list is what keeps that true as
  notes are added.
- **A place the seventeen-row table and the corpus could disagree.** The
  `Told?` column in that table is now frozen at round eight's hand measurement
  and says so, because two live answers to one question is how a count goes
  wrong a third time.

### Still open, and unchanged by this round

Rounds ten to thirteen exactly as the plan above sets them out. The one line
worth repeating: **fourteen of the seventeen are red, and the ratio is the
point.** A denominator somebody can add to is the thing the previous two counts
did not have.

## Round ten, done

2026-09-20, against `17349a3`. Two pieces of work, and they are two jobs rather
than one: the census the Markdown target never had, and TC-1's newline, which
is a correctness bug and not a reporting gap. The plan above says to keep them
apart and it is right — one of them stops a document rendering wrongly, the
other says what the conversion cost. It also found two sentences that were
false, one of them shipped since round four, and both were found by a negative
control rather than by reading anything.

### Part one — the census the Markdown target never had

| Built                                                                   | Where                                     |
| ----------------------------------------------------------------------- | ----------------------------------------- |
| The Markdown target routed into the three-document comparison           | `src/tools/text-convert/normalisation.ts` |
| The third document passed along rather than recomputed                  | `src/tools/text-convert/index.ts`         |
| Target-aware wording, because the reader is not holding that document   | the three round-trip notes                |
| `<thead>` and `<tbody>` filtered out of the reported names              | `SERIALISER_WRAPPERS`, `normalisation.ts` |
| The header-row explanation made conditional on a header row             | `tableRow`, `normalisation.ts`            |
| A `text-convert` Markdown run in `notePorts.test.ts`'s `LOSSY_RUNS`     | the caption case                          |
| `checkMarkdownCensus` — `/tools` and a canvas node face, in two engines | `scripts/cross-browser-check.mjs`         |
| Corpus rows 13, 14 and 15                                               | `spec/loss-corpus.json`                   |

**It cost no conversion at all, which is worth stating because the plan
predicted one.** The plan says `HTML → HTML (normalised)` is "one further
`markdownToHtml` call away from what the Markdown target already computes". It
is not one call away — it is the call the Markdown target was **already
making**, for the `rendered` port: `rendered` is `markdownToHtml(output)` and
`normalised` is `markdownToHtml(htmlToMarkdown(sanitised))`, and for this
target those are the same expression. The change is that the value is now
handed to `normalisationNotes` instead of being computed, used once and
dropped. `index.ts` computes it once in a branch and gives it to both
consumers, so there is no way for the port and the report to disagree about
what the output renders to.

**The boundary the plan asks for is held, and is now two tests.** A plain-text
target gets no census — it has no markup to take one of, which is the same
absence a Markdown SOURCE has and the one place the reasoning recorded in
`normalisation.ts` still applies. `takes no census of a plain-text target` and
`leaves a Markdown source with a Markdown target on its own instrument` are
what stop the next round reading this change as "compare everything".

**Three of the five note bodies had to be branched on the target**, because
they named a document the reader of a Markdown output is not holding:

| Note                                        | What it used to say, and why that was wrong here                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| N attributes removed by the sanitiser       | "removed from every HTML this tool produces" — the output is not HTML                     |
| N elements removed by the sanitiser         | "because an HTML output is something people paste into a page" — same                     |
| N attributes the round trip could not carry | "Normalising takes the document out to Markdown and back" — the conversion IS to Markdown |
| N elements the round trip could not carry   | nothing; it gained the sentence saying where the count was taken                          |
| N elements were invented                    | the same, plus the header-row correction below                                            |

The two sanitiser sentences were made target-neutral rather than branched,
because the fact is the same on every target and only the noun was wrong.

### Part two — TC-1, the newline

`<td><ul><li>one</li><li>two</li></ul></td>` emitted a literal U+000A inside
the row. A newline ends a GFM row, so the table stopped at that cell and
everything after it re-parsed as prose — a document that renders wrongly, with
nothing to say so, under all three policy values.

**The fix is the one the cell path already made for `<br>`, and the finding is
what bounded it.** A hard break in a cell comes out as a space because
mdast-util-to-markdown's break handler asks `patternInScope` whether a newline
is legal in the construct it is in and substitutes one when it is not. The
block handlers never ask. Rather than teaching each of them to, the cell is
flattened to real phrasing before any of them is reached — so there is no
newline left to guard, the content survives joined by a space, and the
STRUCTURE is what goes. See `cellPhrasing` in `pipelines.ts`.

**The root cause is a cast, and it is upstream's, stated in upstream's own
comment.** `hast-util-to-mdast`'s cell handler is `state.all(node)` cast to
`PhrasingContent[]`, with the comment _"Allow potentially 'invalid' nodes, they
might be unknown."_ So a `<td>` containing a `<ul>` really does produce a
`tableCell` with a `list` inside it, and the serialiser writes a list the only
way it can. Registering a `tableCell` handler on the serialiser would not have
worked and it is worth writing down why: mdast-util-gfm-table's table handler
calls its own `handleTableCell` directly rather than through `state.handle`, so
an override is consulted for a stray `tableCell` and never for a cell in a
table.

**Measured, before and after**, on a two-row table with one cell:

| Cell content                        | Was                                                         | Is          |
| ----------------------------------- | ----------------------------------------------------------- | ----------- |
| `<ul><li>one</li><li>two</li></ul>` | `- one` ⏎ `- two` — the row ends at the newline             | `one two`   |
| `<ol><li>one</li><li>two</li></ol>` | `1. one` ⏎ `2. two` — the same                              | `one two`   |
| `<pre>a` ⏎ `b</pre>`                | a fence — **three** extra rows and a code block tagged `\|` | `` `a b` `` |
| `<p>one</p><p>two</p>`              | `onetwo` — one word                                         | `one two`   |
| `<blockquote>q</blockquote>`        | `> q` — a block marker inside a cell                        | `q`         |
| `a<hr>b`                            | `a---b` — three characters the document never had           | `a b`       |
| `a<br>b`                            | `a b`                                                       | `a b`       |

The last row is the control on the fix rather than a result: it was already
right, it is what said the answer is a space, and a fix that moved it would
have replaced one wrong cell with another.

**The bullets are what the flattening costs, and that is the census's job.**
`<ul>` and `<li>` are in the sanitised document and in neither the Markdown nor
the HTML it re-renders to, so `compareMarkup` reports them. That sentence is
the only join between the two halves of this round, and it is why they are
still two halves.

**What the fix does NOT do is consult `unsupported`.** TC-1 names that as a
second fault and this round leaves it, deliberately rather than by omission:
`unsupported` governs elements with **no Markdown spelling at all**, and a list
has one — it is just not one that fits in a cell. Making `keep` mean raw `<ul>`
markup inside a cell is a product decision about a construct GFM does not
define and only some renderers accept. Recorded in `pipelines.ts` and in the
matrix rather than taken quietly. The sharper form of the finding — that all
three policy values produce byte-identical output — is now an assertion, so the
day somebody does take that decision, the test that says the option is ignored
is the one that falls due.

### The two false sentences this round found

Neither was on the list, both were found by a control, and one had been shipped
for six rounds.

**1. `1 element was invented` on a table where nothing was invented.**

`<table><tr><th>h</th></tr><tr><td>x</td></tr></table>` parses with the row
inside an implied `<tbody>` and no `<thead>` at all, and every table
`markdownToHtml` writes has a `<thead>`. So the census saw one element appear
and the note said:

> 1 element was invented by the round trip — `<thead>` is in the output and was
> not in the input. A Markdown table always has a header row, so a `<table>`
> written without one gains an empty one on the way back.

The document had a header row. Nothing was invented. The note was a fact about
the HTML serialiser presented as a fact about the reader's table, on the
commonest shape of hand-written table there is, and it has been on
`HTML → HTML (normalised)` since round four.

`<thead>` and `<tbody>` are filtered out of the reported element names now, in
`normalisation.ts` where the sentence is written rather than in `changes.ts`
where the census is taken. The census is a question with one answer and those
elements really are in one document and not the other; what is wrong is saying
so to a person. `compareMarkup`'s own tests still assert the unfiltered truth.

**It changes a shipped sentence on the other target**, which is worth saying
plainly: TC-13's report on `HTML → HTML (normalised)` was `3 elements were
invented` and is now `2 elements were invented: <tr>, <th>` — the two a reader
can point at, which are an extra row of empty header cells. That is the only
existing assertion in the repository this round had to rewrite.

**2. The header-row explanation attached to every invention there is.**

The body of the invention note recited the table explanation whatever had been
invented. That was merely irrelevant while the only target with inventions was
`HTML → HTML`; on the Markdown target it is false and common. `<mark>hi</mark>`
becomes `_hi_`, which invents an `<em>`, and the note read:

> 2 elements were invented by the round trip — `<em>`, `<code>` are in the
> result and were not in the input. A Markdown table always has a header row,
> so a `<table>` written without one gains an empty header row that nobody
> wrote.

The count is right and the reason under it is about somebody else's document.
The sentence is now conditional on `<tr>` or `<th>` being among the invented
elements, which is what an invented header row IS. The same clause in the
dropped-elements note — an illustration naming a caption and a cell's list —
was removed rather than made conditional: a note that names what went does not
need an example of something else that goes the same way.

### Proving test and negative control, per item

| Fix                          | Proving test                                                                     | Negative control                                                                    | Watched failing against                                                             |
| ---------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| The cell newline             | `constructs.test.ts` — the list case, the `<pre>` case, and a 156-document sweep | a cell of ordinary inline content must come out unchanged; `a<br>b` must stay `a b` | the `td`/`th` handlers removed: **5 red**. The code-span squash removed: **2 red**. |
| The block separator          | two paragraphs in a cell are `one two`                                           | the inline-content case, which must not gain a space                                | `if (false && …)` on the separator: **3 red**, and the newline sweep stays green    |
| Flattening only what is flow | the inline-content case keeps `**b**`, `[c](/x)` and `` `d` ``                   | is itself the control                                                               | `link` and `strong` dropped from the phrasing set: **1 red**                        |
| The census, caption          | `normalisation.test.ts` — the note names `<caption>`                             | nine clean documents, four of them tables, must produce **no note at all**          | the Markdown target excluded from the branch: **6 red**                             |
| The census, cell list        | the note names `<ul>` and `<li>`                                                 | the same nine                                                                       | the same                                                                            |
| The census, invented header  | the note names `<th>` and says "header row"                                      | a table whose header row is a plain `<tr>` of `<th>` must say nothing               | the same                                                                            |
| The wrapper filter           | the invention note must **not** contain `<thead>`                                | the plain-`<tr>` table must produce no note                                         | `SERIALISER_WRAPPERS` emptied: **4 red**, two of them controls                      |
| The conditional explanation  | a `<mark>` substitution must not mention a header row                            | the headerless table must still mention one                                         | made unconditional: **1 red**. Made never to fire: **2 red**.                       |
| `reaches`                    | every warn note on this target is `['output', 'rendered']`                       | `notePorts.test.ts` holds it to the manifest                                        | —                                                                                   |
| Drawn, in two engines        | `checkMarkdownCensus` — `/tools` and a node face, boxes of non-zero size         | an ordinary table draws no note, and its node says nothing about loss               | the log: eight assertions, Firefox and WebKit                                       |

**The controls match on subject, not on wording.** Each is a table converted by
the same pass that loses nothing, and the assertion is that the notes list is
**not drawn at all** — so a note that fired on every table would fail it
whatever that note said. That is last round's lesson applied, and it is the
lesson that paid twice: both false sentences named the clean document's own
elements, which a wording match would have missed exactly the way round nine's
clamp control missed a note that cried wolf.

### The ratio, before and after

|                  |             |
| ---------------- | ----------- |
| Before round ten | **3 of 17** |
| After round ten  | **6 of 17** |

Rows 13, 14 and 15 — the three the brief named. All three turned.

**Shown failing.** Excluding the Markdown target from the census branch drops
the ratio back to **3 of 17** and turns two gates red at once:
`lossCorpus.test.ts`, whose generated block no longer matches the document, and
`normalisation.test.ts`. The diff vitest prints names the three rows that
stopped being told.

### Where the plan was wrong, and three rows re-specified

**Row 13's expectation asked a census of names for a fact about content, and
cannot be met as written.** Round nine specified
`mentions: ["Quarterly sales"]` — the caption's TEXT. `compareMarkup` is a
census of NAMES: it can say that a `<caption>` went in and did not come out,
and it cannot say what was inside it. Naming the content needs a text dimension
on the census, which is **the same instrument change row 16 is excluded for**,
for the same reason, in the same sentence of the plan. So the row is
re-specified to `mentions: ["<caption>"]` and the corpus carries a
`whyThisExpectation` field saying so at the point somebody would look. The
field is declared in `lossCorpus.test.ts` rather than left as an unread key,
because a re-specified expectation is the one edit to that file that can
quietly turn a row green.

**This is a weakening, and it is recorded as one.** A reader learns that a
`<caption>` was dropped and that Markdown has nowhere to put one. They are not
told the three words that were in it.

**Rows 14 and 15 needed the same kind of change for a smaller reason, and it
matters more than it looks.** Their `titleContains` values were `list` and
`header` — the subject as a person writes it. The census's titles are generic
(`N elements the round trip could not carry`, `N elements were invented by the
round trip`) with the element names in the body. A `titleContains` that matches
**no note the tool can ever write** does not merely fail the positive
assertion: it makes that row's NEGATIVE CONTROL vacuous, because the control
asks whether the clean document produced a note with that title and the answer
is trivially no. Both were changed to a string the title really contains, and
row 15's clean document was changed too — it was a table whose header row is a
plain `<tr>` of `<th>`, which is the document that fired the false `<thead>`
note, so the control it was meant to be was the thing that found the bug.

### What was looked for and not found

- **A fourth Markdown-target row among the seventeen.** Row 17 — `<mark>` and
  `<kbd>` given formatting they never had — is on this target and does **not**
  turn, and the reason is not that the census is silent there. It is not
  silent: the document now produces two notes, `2 elements the round trip could
not carry: <mark>, <kbd>` and `2 elements were invented: <em>, <code>`. What
  no single note says is the row's own claim — that one was SUBSTITUTED for the
  other. The census reports a departure and an arrival; joining them into a
  substitution is a sentence neither note makes, and `matchingNote` looks for
  one note. So the row is correctly red, and it is red about a narrower thing
  than round nine's measurement implies. That is TC-4 and it wants a report of
  a different kind.
- **A row round nine said nothing could collide with.** Round nine recorded
  that "each of the fourteen silent rows was run and produces no `warn` note at
  all, so there is nothing for a title match to collide with today". After this
  round that is no longer true of row 17, whose document produces two notes.
  Nothing collides yet — neither title contains `mark` — but the sentence has
  stopped being a fact about the file and become a fact about two strings, and
  the next round should not inherit it as a guarantee.
- **Whether row 16 rides along after all.** It does not, and this round is the
  evidence rather than an assertion of it: the census was added to the target
  row 16's finding was first reported on, and row 16 stayed silent. Measured:
  on the **Markdown** target `class` IS reported, because the attribute is gone
  from the round-tripped HTML entirely; on `HTML → HTML (sanitised)`, which is
  the target row 16 is pinned to, `class=""` is present on both sides and a
  census of names cannot tell it from `class="btn"`. Exactly the reason the
  plan gives, now with a run behind it.
- **A cry-wolf note on ordinary input.** Nine documents were put through the
  new census — a paragraph with a link and emphasis, a heading and a list, a
  fenced code block, a blockquote, a nested list, a task list, a table with a
  `<thead>`, a table whose header row is a plain `<tr>` of `<th>`, and a table
  cell of inline content — and all nine produce nothing. The eighth is the one
  that did not, and it is why `SERIALISER_WRAPPERS` exists.
- **A second false invention of the same shape.** `<img src width alt>` at the
  top level reports `<p>` as invented, on both targets, because a bare inline
  element becomes a paragraph. That one is TRUE — a block-level paragraph
  really is created — and it is left alone. Looked at because it is the same
  shape as the `<thead>` case and it turned out not to be the same fact.
- **A newline the flattening still lets through.** Swept: 156 cell documents —
  twelve fragments and every ordered pair of them — and none produces a line
  inside a row, a table with the wrong number of rows, or more than one table.
  The three places a value is written out verbatim rather than through
  `state.safe()` are each squashed: a code span, a raw `html` node, and the
  code block this round turns into a span. A `text` node is deliberately NOT,
  because `safe()` already consults the same unsafe patterns the break handler
  does and encodes a newline in a cell as `&#xa;`.
- **A place the fix could change a document with no table in it.** Every
  non-cell case measured before and after is byte-identical: a paragraph, a
  heading and a list, a fenced block, a blockquote, an image, a nested list, an
  `<hr>`, a task list, `<del>`, a `class` attribute, `<img width>`, a `<div>`
  wrapper. The handlers are registered for `td` and `th` and reach nothing
  else.

### Still open, and unchanged by this round

Rounds eleven to thirteen as the plan sets them out, with three items sharpened:

- **TC-9 / corpus row 16 stays out**, and round eleven's instrument question
  now has a second customer: row 13's caption CONTENTS want the same third
  dimension that row 16's attribute VALUE wants. One change serving two rows is
  a better-shaped round than either alone, and it has a name — a census of
  names, plus the values this app rewrites, plus the TEXT that went in and came
  out nowhere.
- **TC-3 is not in the group the plan puts it in.** The plan groups it with
  TC-1, TC-5 and TC-13 as one silence. It is not: `<ol reversed>` loses the
  `reversed` attribute and that IS reported, on every target, by the sanitiser
  half — `reversed` is not on the allow-list, and the note names it. What is
  silent is that the numbers emitted ascend where a reversed list displays
  descending, which is wrong CONTENT and not a missing name. No census can see
  it. It belongs with round thirteen's one-line decisions.
- **The `unsupported` half of TC-1**, as set out above, with the test that
  falls due when somebody takes it.
