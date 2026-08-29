# Structured data

Convert between JSON, YAML, CSV and TSV, with auto-detection.

## Why this tool exists in the reference set

It stresses three parts of the design that base64 does not:

- **Options that genuinely change behaviour**, including auto-detection, a
  numeric control, and several enums.
- **Rich structured errors.** A parse failure returns a `ToolError` carrying a
  line and column. Nothing throws across the execution boundary.
- **Multiple outputs.** One run produces both the rendered document and the
  parsed structure, so the canvas can wire either onward.

## YAML: which library, and why

[`yaml`](https://www.npmjs.com/package/yaml) (eemeli's, v2).

Two reasons:

1. **It does not evaluate arbitrary types on parse.** This was verified rather
   than assumed — see the tests. `!!js/function "function(){return 1}"` parses
   to the inert _string_ `function(){return 1}`; no function is constructed.
   `!!python/object/apply:os.system [echo hi]` parses to a plain array. Both
   emit an "unresolved tag" warning and produce data, never behaviour. Only the
   core schema is enabled; custom tags would have to be passed in explicitly.
2. **It reports positions.** A `YAMLParseError` carries `linePos` with line and
   column, which is what the error panel needs. A parser that only gives a
   message could not satisfy the brief.

Timestamps stay strings under the core schema rather than becoming `Date`
objects, which keeps everything JSON-representable.

Note on configuration: the parser is called with `logLevel: 'error'`, **not**
`'silent'`. Silent suppresses genuine parse errors as well as warnings, which
would hand back a half-parsed document instead of reporting the fault. That was
caught by a test.

## CSV: hand-written, deliberately

CSV is the one parser here that is not delegated. It is short, the interesting
requirement is precise error positions, and an adapter around a library would
have been longer than the parser. It implements RFC 4180 plus the tolerances
real files need.

## The JSON boundary

Everything is normalised through a `JsonValue` check before it is serialised.
YAML can produce values JSON cannot hold — `!!binary` yields a byte array — so
the whole tree is walked up front and the offending path is named
(`$.blob is a Uint8Array, which JSON cannot represent`). Discovering that at
serialisation time as a mangled `{}` would be much worse.

## Options

| Option        | Effect                                                           |
| ------------- | ---------------------------------------------------------------- |
| Source format | Auto-detect, or force JSON / YAML / CSV / TSV.                   |
| Target format | JSON, YAML, CSV or TSV.                                          |
| CSV delimiter | Comma, semicolon, tab or pipe. TSV is always tab.                |
| Indent        | Spaces per level for JSON and YAML. 0 makes JSON compact.        |
| Sort keys     | Sort object keys alphabetically, recursively. Arrays keep order. |

## Auto-detection

Order matters, because the formats overlap. YAML 1.2 is a superset of JSON, and
a line of CSV is a perfectly valid YAML string, so the test runs from most to
least specific:

1. A leading `{` or `[` → **JSON**.
2. A `---` document marker or `%YAML` → **YAML**.
3. Every sampled line agreeing on a field count above one → **TSV**, then
   **CSV**. Delimiters inside quoted fields are not counted.
4. Otherwise → **YAML**.

## Edge cases handled

- **BOM** is stripped before parsing rather than being treated as content.
- **CRLF, LF and lone CR** line endings are all accepted.
- **A trailing newline** does not produce a phantom empty record.
- **CSV fields containing the delimiter, quotes (`""` escapes) or newlines**
  parse and re-serialise correctly; only fields that need quoting get quoted.
- **Short CSV rows** are padded (extremely common in hand-edited files);
  **long rows** are an error naming the row number.
- **Duplicate column names** are an error, since columns become object keys.
- **Empty header cells** get stable `column_N` names.
- **`__proto__` as a key** creates a real own property. Plain assignment would
  have replaced the object's prototype instead, silently losing the key — this
  is why every object is built with `Object.defineProperty`.
- **Deep nesting** (200 levels tested) round-trips.
- **NaN, Infinity, BigInt, Date, Uint8Array** are refused with the path named.
- **Nested values in CSV output** are serialised as compact JSON inside the
  cell. Lossy for round-tripping, but far more useful than refusing an entire
  document over one nested field.

## Known limitation

CSV cannot distinguish a final record of all-empty fields from a terminating
newline: `a\n` is one header row, not a header plus an empty record. That
ambiguity is in the format, not the parser. The round-trip property test
excludes that one case explicitly.

## Tests

`structured-data.test.ts` covers detection, each format pair, every edge case
above, the security properties of the YAML parser, and three property-based
invariants: YAML round-trip and JSON round-trip for arbitrary JSON values, and
CSV round-trip for arbitrary tables of strings.
