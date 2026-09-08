# Structured data

Convert between JSON, YAML, CSV and TSV, with auto-detection.

This is the tool with the worst failure mode in the set. Everything else here
fails visibly — a hash is wrong, an image is blank, a regex does not match. A
converter fails by handing back a document that looks exactly like the one you
wanted and is not, and nobody files a bug about an answer they believed. Most
of what follows is about that.

- [What it will and will not decide for you](#what-it-will-and-will-not-decide-for-you)
- [Auto-detection](#auto-detection)
- [Type coercion](#type-coercion)
- [What happens to data that cannot survive the conversion](#what-happens-to-data-that-cannot-survive-the-conversion)
- [YAML: which library, and why](#yaml-which-library-and-why)
- [CSV: hand-written, deliberately](#csv-hand-written-deliberately)
- [The JSON boundary](#the-json-boundary)
- [Limits](#limits)
- [Options](#options)
- [Known limitations](#known-limitations)
- [Tests](#tests)

## What it will and will not decide for you

One rule sits above the rest, and every decision below is an application of it:

> **Where the tool cannot be sure, it says so. It never guesses quietly.**

Concretely, in decreasing order of preference:

1. **Convert it losslessly**, when the target can hold it.
2. **Refuse it, naming the value and where it is**, when the target cannot.
3. **Convert it lossily and say so here**, when refusing would be worse than the
   loss — nested values inside a CSV cell, `null` becoming an empty field.
4. **Never** produce a plausible document that quietly means something else.

Rule 4 is the one that motivated this file. Several of the things fixed here
were cases of it: a semicolon-separated export read as one long YAML string, a
one-line paste confidently reported as an empty table, a YAML mapping that
silently lost a key on the way to becoming an object.

## Auto-detection

Formats overlap. YAML 1.2 is a superset of JSON, a line of CSV is a perfectly
valid YAML string, and a Markdown table is a consistent grid of pipes. So the
tests run from most specific to least, and the last one is the most permissive:

1. Empty input → **JSON**, so the error says "nothing to parse".
2. A leading `{` or `[` → **JSON** (with two fallbacks; see below).
3. A leading `---` or `%YAML` → **YAML**.
4. A leading `- ` (a block sequence item) → **YAML**.
5. **Delimited text**, if at least **two** records agree on a field count above
   one. Delimiters are tried in the order tab, the configured delimiter, comma,
   semicolon. Tab wins the format name **TSV**; anything else is **CSV**.
6. Otherwise → **YAML**.

Four things about step 5 are load-bearing:

- **Quoting is tracked across the whole document, not within a line.** A cell
  containing a newline — an address, a note field, anything a spreadsheet
  exported — otherwise makes the field counts disagree and the file is read as
  YAML, which turns a table into a single string.
- **Two records, not one.** A single line of `Hello, world` satisfies "every
  line agrees", and a one-line CSV is a header with no rows, so the tool used to
  answer a non-empty document with `[]`.
- **Detection returns the delimiter, not just the format.** It used to return
  only the format and the parser then used whatever the delimiter option said,
  so a semicolon export — which is what Excel writes wherever the comma is a
  decimal separator — matched nothing and fell through to YAML.
- **Pipe is only tried when it is the configured delimiter.** A Markdown table
  has perfectly consistent pipe counts and would be read as a table with a
  `---` row in it. Choosing Pipe in the options is how you ask.

Excel's **`sep=;` first line** is consumed and obeyed, for CSV, whether or not
the format was auto-detected. Without that the directive becomes the header and
the result has a column literally named `sep=`.

### The two fallbacks after a leading bracket

A document opening with `{` or `[` is committed to JSON, and two very common
things open with a bracket without being one JSON document. Under **Auto-detect
only**, if the JSON parse fails on syntax:

- **JSON Lines** — one JSON value per line, which is what a log export or a
  streaming API response is — becomes an array of documents. This is the same
  call the YAML reader makes for a `---`-separated stream, for the same reason:
  it is what the file says, and an array is its only JSON-representable form.
- **YAML** gets a turn, because YAML 1.2 reads flow style, trailing commas,
  single quotes and unquoted keys — between them, every object literal ever
  copied out of source code.

If neither works, the **JSON** error is reported: it is the more specific of the
two and names the real problem.

**The cost, stated.** `{"a": }` is broken JSON and legal YAML, where it means
`{ "a": null }`, so under Auto-detect it parses instead of being reported. That
is the honest answer for a user who never claimed the document was JSON — and
setting **Source** to JSON is how you say there is no ambiguity to resolve.
Neither fallback runs when a source format was chosen explicitly.

**Rejected: reporting ambiguity instead of choosing.** There is nowhere to
report it to. A tool result is a value or an error, so "probably CSV" would have
to be an error — which refuses a document the tool can read perfectly well. The
answer instead is to make the tests strict enough that a confident answer is
usually right, and to make the source format an explicit override when it is
not.

## Type coercion

**Nothing read out of CSV or TSV is ever coerced. Every cell becomes a string.**

```
zip,id,phone,when,flag          [{ "zip": "01234",
01234,1234567890123456789,...    "id": "1234567890123456789",
                                 "phone": "+1-555", ... }]
```

CSV is untyped text and the tool has one piece of evidence per cell, so any rule
for turning some cells into numbers is a guess applied to data that cannot
answer back. The specific damage:

| Input                 | A "sensible" guess gives | Which is           |
| --------------------- | ------------------------ | ------------------ |
| `01234`               | `1234`                   | a different US ZIP |
| `1234567890123456789` | `1234567890123456800`    | a different id     |
| `+1-555`              | `NaN`, or a string       | inconsistent       |
| `2024-01-01`          | a date, or a string      | ambiguous          |
| `NO`                  | `false`                  | not Norway         |

**The argument that settles it is not any single row — it is that a column's
type would depend on its contents.** `id` would be a number in the rows that
happen to look numeric and a string in the rest, and every consumer downstream
of that has to handle both. A column of strings is at worst inconvenient, and
it is inconvenient _visibly_, in the output, where you can see it.

**Rejected: coercing only when it round-trips** (`String(Number(cell)) === cell`,
which does protect leading zeros and long ids). It is a good rule and it still
produces mixed types within one column, which is the actual problem.

**Rejected: an opt-in "coerce numbers" option.** Same mixed-column outcome, plus
a setting that sounds safe. If you need typed values, the conversion that knows
the types is the one that made the file.

YAML and JSON, by contrast, are typed formats, and their own rules apply
unchanged — see the schema notes below.

## What happens to data that cannot survive the conversion

| Case                                                | What happens                                               |
| --------------------------------------------------- | ---------------------------------------------------------- |
| Nested value in a CSV cell                          | Written as compact JSON in the cell. **Lossy**, on purpose |
| `null` in a CSV cell                                | Written as an empty field, indistinguishable from `""`     |
| CSV target, top level is not an array               | Refused, naming what was found                             |
| CSV target, a row is not an object                  | Refused, naming the row                                    |
| CSV target, every row is `{}`                       | Refused: there are no columns to write                     |
| YAML `!!binary`, `!!set`, `!!omap`, a 1.1 timestamp | Refused, naming the path (`$.blob is a Uint8Array…`)       |
| `NaN`, `Infinity`, `undefined`, `BigInt`            | Refused, naming the path                                   |
| YAML keys that become the same object key           | Refused as a duplicate key, naming the line                |
| A YAML key that is itself a collection              | Refused                                                    |
| Anything nested deeper than 512                     | Refused as too deep                                        |
| Multi-document YAML                                 | An array of documents                                      |
| An integer beyond 2^53                              | **Silently rounded.** See below                            |

The one entry in that table that breaks the rule at the top of this file is the
last one, and it is not fixable inside this tool.

### Integers beyond 2^53 lose precision, silently

```
{"id": 1234567890123456789}   ->   {"id": 1234567890123456800}
```

A `JsonValue` number is an IEEE-754 double, in a language with no other number
type, and the JSON port that carries the parsed document onward is typed as
`JsonValue`. So a Discord snowflake, an X status id or a Postgres `bigint`
cannot survive being parsed — by this tool or by `JSON.parse` in any other
JavaScript program.

Categorised honestly: **upstream, no viable workaround.** The reproduction above
is a named regression test, so the exact behaviour is pinned rather than assumed.

**Rejected: refusing the document.** API responses with snowflake ids are among
the most common things anybody would paste here, and most of the time the id is
being carried through rather than computed with. Refusing would block a
routine, useful conversion over a loss the user may not care about.

**Rejected: re-printing the original text when source and target are both JSON.**
It would be exactly lossless for the single most common conversion — reindenting
a document — and it would make the two output ports disagree, because the parsed
structure on the `data` port would still hold the rounded number. One value with
two meanings depending on which socket you read is a worse bug than the one it
fixes.

**Rejected: a warnings channel on `ToolResult`.** This is the right general
answer and it is not a change to this tool: it means a new field on the result
type every tool returns, carried across the worker protocol and rendered in two
UIs. Out of scope for a hardening pass on one tool, and worth doing properly.

### Spreadsheet formulas are written out exactly as given

A CSV cell beginning `=`, `+`, `-` or `@` is executed by Excel and Google Sheets
when the file is opened, which is a real way to attack whoever opens an export
of data you did not write. **This tool does not escape them.**

That is a decision, not an oversight. The usual mitigation is to prefix an
apostrophe, and that is itself silent corruption: it rewrites `-1,2` and any
formula somebody meant to keep, on the way through a tool whose entire job is
fidelity. It would also imply Patchbay can make a spreadsheet safe, which it
cannot. **If you are converting untrusted data and someone will open the result
in a spreadsheet, sanitise it where it is consumed.**

## YAML: which library, and why

[`yaml`](https://www.npmjs.com/package/yaml) (eemeli's, v2).

1. **It does not evaluate arbitrary types on parse.** Verified rather than
   assumed — see the tests. `!!js/function "function(){return 1}"` parses to the
   inert _string_ `function(){return 1}`; no function is constructed.
   `!!python/object/apply:os.system [echo hi]` parses to a plain array. Both emit
   an "unresolved tag" warning and produce data, never behaviour.
2. **It reports positions.** A parse error carries `linePos`, which is what the
   error panel needs.
3. **It bounds alias expansion.** A billion-laughs document — six lines of
   anchors that expand to millions of nodes — is refused rather than expanded.
   The limit is the library's own default of 100 and is passed explicitly at both
   the parse and the `toJS` call, because it is a security control rather than a
   tuning knob.

### Schema and version

The **1.2 core schema** is what a document gets unless it says otherwise. That
means `no`, `yes`, `on` and `off` stay strings (the Norway problem does not
apply), `017` is seventeen rather than fifteen, timestamps stay strings, and
`<<` is an ordinary key rather than a merge.

A document that declares **`%YAML 1.1`** gets the 1.1 reading instead: `yes`
becomes `true`, `017` becomes fifteen, `<<` merges, and timestamps become `Date`
objects — which JSON cannot hold, so those are refused by path. Following the
version the document declares is the only rule that does not require guessing
what its author meant.

### Two silent-loss classes closed here

- **Keys that collapse.** `true:` and `"true":` are different keys to YAML and
  the same key to JavaScript, because both stringify to `"true"`. The library's
  uniqueness check compares scalar values, so it saw two keys and the object it
  built had one — the first value vanished with nothing said. `1:` against
  `"1":`, and `~:` against `"":`, collapse the same way. The parser is now given
  a uniqueness comparator that compares the JS key text, so these are reported as
  duplicate keys with a line number.
- **Collection keys.** `? [a, b] : v` is legal YAML, and the library stringifies
  the key to `"[ a, b ]"` to make it usable as an object key — so two different
  collection keys can flatten onto each other. Refused, consistently with
  `!!set`, `!!omap` and `!!binary`.

### Streams

`---`-separated documents are read as an **array**, one element per document. A
trailing `---` does not add a `null`, and a single-document stream stays an
object rather than becoming a one-element array. Kubernetes manifests are the
reason: previously a stream was refused with the library's own message, which
named an API the person reading it has no access to, about a file that is not
wrong.

The asymmetry is documented rather than hidden: converting that array **to**
YAML writes a sequence, not a stream. Emitting documents instead would mean any
array became a multi-document file, which is worse.

## CSV: hand-written, deliberately

CSV is the one parser here that is not delegated. It is short, the interesting
requirement is precise error positions, and an adapter around a library would
have been longer than the parser. It implements RFC 4180 plus the tolerances
real files need.

Handled:

- Quoted fields containing the delimiter, `""` escapes and newlines.
- CRLF, LF and lone CR line endings, counted correctly **inside** quoted fields —
  which is what makes a ragged-row error point at the line the row is really on
  rather than at its index.
- A trailing newline, which does not produce a phantom record.
- **A blank line, which is a separator rather than a record.** The distinction
  from a genuinely empty record is quoting: a bare line break carries no data,
  and `""` is a record holding one empty field.
- Short rows are padded (extremely common in hand-edited files); long rows are an
  error naming the row and its line.
- Duplicate column names are an error, since columns become object keys.
- **Unquoted header cells are trimmed; quoted ones are not.** ` name, age` is how
  hand-typed CSV looks, and a key of `" age"` helps nobody — but trimming a cell
  its author quoted is a silent edit, and it also made `a` and `" a "` collide as
  duplicate columns when they are different names.
- Empty header cells get stable `column_N` names, unless they were quoted empty,
  which is the author saying the name really is empty.
- `__proto__` as a column name creates a real own property. Plain assignment
  would replace the object's prototype instead, silently losing the key.
- **A line that would be written empty is written `""`.** A one-column table with
  an empty row otherwise produced an empty line — a blank line — and the row
  disappeared on the way back.

Output is **LF, with no trailing newline**, whatever the delimiter. It goes into
a text box and a clipboard; RFC 4180's CRLF would put a stray carriage return at
the end of every line of it.

## The JSON boundary

Everything parsed is normalised through a `JsonValue` check before it is
serialised. YAML can produce values JSON cannot hold, so the whole tree is
walked up front and the offending path is named
(`$.blob is a Uint8Array, which JSON cannot represent`). Discovering that at
serialisation time as a mangled `{}` would be much worse.

The `json` **input** port is the one route in that never meets a parser, because
the value arrives already parsed from another tool. It gets its own guard: see
the depth limit below, which exists because that route had none.

## Limits

| Limit                | Value | Why                                           |
| -------------------- | ----- | --------------------------------------------- |
| Nesting depth        | 512   | Below where any recursion here breaks         |
| YAML alias expansion | 100   | The library's default; stops a billion-laughs |
| Input                | 16 MB | Declared on the tool, enforced by the engine  |
| Time                 | 15 s  | Declared on the tool, enforced by the engine  |

**On the depth limit.** `JSON.parse`, `JSON.stringify`, the YAML composer and
this file's own tree walks are all recursive, and past roughly 2,000 levels one
of them overflows the stack. Which one depended on the options, and the reported
reason was whatever happened to be on the stack: "That is not valid JSON" for a
document that is valid JSON, or — through the `json` input port, which reached
`sortKeysDeep` and `JSON.stringify` without passing a parser — a `RangeError`
thrown clean out of `run`, which the execution contract forbids. 512 is far
below where anything breaks and far above anything a person or an API produces.
The point of the number is that the refusal is ours, states the real reason, and
happens at the same depth on every route in.

**Measured**, for a sense of the headroom, on a 4 MB CSV with quoted fields:
detection under 1 ms, parse 135 ms, JSON out 39 ms, CSV out 50 ms, YAML out
1.15 s — YAML is the slow one by a factor of twenty, and still well inside the
timeout at four times that size. An 8 MB single quoted field parses in 305 ms;
the same 8 MB with the quote never closed is refused in 389 ms rather than
scanning forever.

## Options

| Option        | Effect                                                                      |
| ------------- | --------------------------------------------------------------------------- |
| Source format | Auto-detect, or force JSON / YAML / CSV / TSV. Forcing disables fallbacks.  |
| Target format | JSON, YAML, CSV or TSV.                                                     |
| CSV delimiter | Comma, semicolon, tab or pipe. Also the delimiter auto-detection prefers.   |
| Indent        | Spaces per level for JSON and YAML. 0 makes JSON compact; YAML clamps to 1. |
| Sort keys     | Sort object keys, recursively. Arrays keep their order — that is data.      |

Sorting compares with JavaScript's `<`, which orders by **UTF-16 code unit**.
That is not code-point order — an astral character sorts below U+FFFF because
its lead surrogate does — and it is deterministic, which is the property that
matters. Locale-aware collation was rejected: it would make the output depend on
the machine that produced it.

Bytes arriving on the input port are decoded as **UTF-8, strictly**, so a
dropped PNG says it is not text rather than being parsed as mojibake and failing
later with a syntax error about a character nobody typed. The one exception is a
**UTF-16 byte order mark**, which Excel's "Unicode Text (\*.txt)" export writes:
that is not a guess, it is the file stating its own encoding in its first two
bytes. Nothing without a BOM is decoded as anything but UTF-8.

That decoder now lives in [`lib/text.ts`](../../lib/text.ts) rather than in
`convert.ts`, and `decodeDocument` is re-exported from here so this tool's own
imports are unchanged. It moved because the
[port audit](../../../docs/architecture.md#the-port-set) widened three more
document ports to accept `bytes` — `regex-tester`, `text-convert` and both of
`diff`'s — and all four tools need the same answer to the same question. This
tool's note about the pipeline that refusing bytes made impossible is what the
other three were measured against.

## Known limitations

Things that are true, that we have decided not to change, and that will not be
fixed by a patch to this tool:

1. **Integers beyond 2^53 round.** Described above. Upstream, no workaround.
2. **CSV formula injection is not escaped.** Described above. Deliberate.
3. **`null` and `""` are the same cell.** CSV has no null. Round-tripping JSON
   through CSV turns every null into an empty string.
4. **Nested values in CSV cells do not come back.** They are written as compact
   JSON and read back as the string containing that JSON. Keeping them beats
   refusing a whole document over one nested field, and it is one-way.
5. **A YAML stream becomes an array, and an array does not become a stream.**
6. **A JSON `1.0` comes back as `1`.** A double has no memory of its notation.
7. **`sep=` in a first line is always the Excel directive**, so a genuine CSV
   whose first cell is literally `sep=;` cannot be read as data. That convention
   is worth more than that file.
8. **Two lines of prose with one comma each are read as a table.** `Hello,
world\nGoodbye, world` satisfies every test for delimited text, because it is
   indistinguishable from a two-column CSV. Set Source explicitly.
9. **A YAML document too deep for the composer** is reported with our depth
   message rather than the library's, which is V8's stack-overflow text pointed
   at an arbitrary column. The mapping is against the library's declared
   `RESOURCE_EXHAUSTION` error code, not against the wording of a message, and a
   test asserts that code still arrives.

## Tests

`structured-data.test.ts` covers detection, each format pair, every edge case
above, the security properties of the YAML parser, and seven property-based
invariants: YAML and JSON round trips for arbitrary JSON values; a round trip
over control characters, lone surrogates and astral text; CSV round trips for
tables of strings, across all four delimiters; that sorting keys is idempotent
and changes nothing else; that a document detected as delimited always parses to
at least one record; and that no combination of arbitrary input and target
format can make anything throw.

Two things are checked in real browsers by `pnpm check:browsers` instead,
because jsdom cannot answer them: that a `__proto__` column survives the
engine's structured clone across the worker boundary as data, and that nothing
reaches `Object.prototype` on the main thread on the way through.
