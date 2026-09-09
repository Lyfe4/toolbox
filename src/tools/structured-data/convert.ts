import {
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  stringify as stringifyYaml,
  visit,
  type Document,
  type ParsedNode,
  type YAMLError,
} from 'yaml';

import { fail, isJsonArray, ok, type JsonValue, type ToolResult } from '@/features/registry/types';
import { setOwnProperty } from '@/lib/safeObject';
import { positionFromLineColumn, positionFromOffset, stripBom } from '@/lib/textPosition';

import { parseCsvRows, readSepDirective, recordsToCsv, rowsToRecords } from './csv';

export const FORMATS = ['json', 'yaml', 'csv', 'tsv'] as const;
export type Format = (typeof FORMATS)[number];

export const DELIMITERS = {
  comma: ',',
  semicolon: ';',
  tab: '\t',
  pipe: '|',
} as const;

export type DelimiterName = keyof typeof DELIMITERS;

/**
 * How deeply a document may nest before it is refused.
 *
 * Every walk in this file is recursive, and so are `JSON.parse`,
 * `JSON.stringify` and the YAML composer. Past roughly 2,000 levels one of them
 * overflows the stack, and the failure surfaces as `RangeError: Maximum call
 * stack size exceeded` attributed to whatever happened to be on the stack -
 * "That is not valid JSON" for a document that is perfectly valid JSON, or a
 * thrown error crossing the execution boundary, which tools are forbidden to do.
 *
 * 512 is far below where anything breaks and far above anything a person or an
 * API produces; the deepest thing in this repo's own fixtures is single digits.
 * The point of the number is that the refusal is OURS, states the real reason,
 * and happens at the same depth on every route in.
 */
export const MAX_DEPTH = 512;

/**
 * How many aliases a YAML document may expand to.
 *
 * This is the `yaml` package's own default, restated here because it is a
 * security control rather than a tuning knob: it is what stops a billion-laughs
 * document - six lines of anchors that expand to millions of nodes - from
 * exhausting memory. `toJS` is where expansion happens, so it is passed there
 * as well as to the parser.
 */
const MAX_ALIAS_COUNT = 100;

const TOO_DEEP_MESSAGE = `That document is nested more than ${MAX_DEPTH.toString()} levels deep.`;

function tooDeep<T = never>(path?: string): ToolResult<T> {
  return fail('limit-exceeded', TOO_DEEP_MESSAGE, {
    detail:
      path === undefined
        ? 'Deeply nested documents are refused rather than risking a crash part-way through.'
        : `First seen at ${path}.`,
  });
}

/* ========================================================================== *
 * Guarding the JSON boundary
 * ========================================================================== */

/**
 * Confirms a parsed document really is JSON-representable.
 *
 * YAML can produce values JSON cannot hold. `!!binary` yields a byte array,
 * `!!set` a Set, `!!omap` a Map, and a document declaring `%YAML 1.1` gets the
 * 1.1 schema's timestamps as `Date`s. Rather than discovering that at
 * serialisation time as a mangled `{}`, the whole tree is checked up front and
 * the offending path is named.
 */
export function toJsonValue(value: unknown, path = '$', depth = 0): ToolResult<JsonValue> {
  if (value === null) return ok(null);

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return ok(value);
    case 'number':
      // NaN and Infinity have no JSON representation.
      return Number.isFinite(value)
        ? ok(value)
        : fail('unsupported-type', `${path} is ${String(value)}, which JSON cannot represent.`);
    case 'undefined':
      return fail('unsupported-type', `${path} is undefined, which JSON cannot represent.`);
    case 'bigint':
      return fail('unsupported-type', `${path} is a BigInt, which JSON cannot represent.`);
    case 'function':
    case 'symbol':
      return fail('unsupported-type', `${path} is a ${typeof value}, which JSON cannot represent.`);
    default:
      break;
  }

  if (depth >= MAX_DEPTH) return tooDeep(path);

  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = toJsonValue(value[index], `${path}[${index.toString()}]`, depth + 1);
      if (!item.ok) return item;
      items.push(item.value);
    }
    return ok(items);
  }

  // Anything with an exotic prototype (Date, Uint8Array, Map, ...) is refused
  // rather than quietly stringified into something meaningless.
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(
      'unsupported-type',
      `${path} is ${describeExotic(value)}, which JSON cannot represent.`,
      {
        detail: 'Only strings, numbers, booleans, null, arrays and plain objects convert.',
      },
    );
  }

  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const converted = toJsonValue(item, `${path}.${key}`, depth + 1);
    if (!converted.ok) return converted;
    setOwnProperty(result, key, converted.value);
  }
  return ok(result);
}

/**
 * Names a value with an unexpected prototype.
 *
 * `value.constructor.name` on its own throws for an object whose prototype
 * chain has no `constructor` - `Object.create(Object.create(null))` reaches
 * this branch - which would turn a clear "we cannot represent this" into an
 * unexplained crash.
 */
function describeExotic(value: object): string {
  const constructor: unknown = (value as { constructor?: unknown }).constructor;
  const name =
    typeof constructor === 'function' && typeof constructor.name === 'string'
      ? constructor.name
      : '';
  return name === '' ? 'an object with an unusual prototype' : `a ${name}`;
}

/**
 * True when a value nests deeper than `max`.
 *
 * Iterative, with its own stack, because the thing it is protecting against is
 * exactly a recursive walk running out of stack. Only containers are pushed, so
 * a wide-but-shallow document costs one entry per container rather than one per
 * value.
 *
 * This is the guard for the `json` INPUT PORT, where a value arrives already
 * parsed from another tool and so never passes through `toJsonValue`. Without
 * it, `sortKeysDeep` and `JSON.stringify` threw `RangeError` straight out of
 * `run` - the one thing the execution contract says cannot happen.
 */
export function exceedsDepth(value: JsonValue, max: number): boolean {
  type Container = readonly JsonValue[] | Readonly<Record<string, JsonValue>>;
  if (value === null || typeof value !== 'object') return false;

  const stack: { readonly value: Container; readonly depth: number }[] = [{ value, depth: 0 }];

  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) break;
    if (entry.depth >= max) return true;

    const children = isJsonArray(entry.value) ? entry.value : Object.values(entry.value);
    for (const child of children) {
      if (child !== null && typeof child === 'object') {
        stack.push({ value: child, depth: entry.depth + 1 });
      }
    }
  }

  return false;
}

/** Refuses a value that arrived pre-parsed on the `json` port and is too deep. */
export function checkJsonInput(value: JsonValue): ToolResult<JsonValue> {
  if (value !== null && typeof value === 'object' && exceedsDepth(value, MAX_DEPTH)) {
    return tooDeep();
  }
  return ok(value);
}

/**
 * Recursively sorts object keys. Arrays keep their order - that is data.
 *
 * Recursive, and safe to be: every route into this function has already had its
 * depth bounded by `MAX_DEPTH`, which is a small fraction of the stack.
 *
 * The comparison is JavaScript's own `<` on strings, which orders by UTF-16
 * code unit. That is deterministic and matches `Array.prototype.sort`, and it
 * is not code-point order: an astral character sorts below U+FFFF because its
 * first surrogate does. Locale-aware collation was rejected deliberately - it
 * would make the output depend on the machine that produced it.
 */
export function sortKeysDeep(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (isJsonArray(value)) return value.map((item) => sortKeysDeep(item));

  // Object.entries rather than Object.keys plus indexing: Array.isArray does
  // not narrow a `readonly T[]` out of the union, so indexing would be untyped.
  const sorted: Record<string, JsonValue> = {};
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, item] of entries) setOwnProperty(sorted, key, sortKeysDeep(item));
  return sorted;
}

/* ========================================================================== *
 * Decoding
 * ========================================================================== */

/**
 * Turns dropped or wired-in bytes into text.
 *
 * Re-exported rather than implemented here. It moved to
 * [`lib/text.ts`](../../lib/text.ts) when three more tools grew a `bytes`
 * document port and needed exactly this answer; the export stays so this
 * tool's own README and tests keep one import for everything conversion.
 */
export { decodeDocument } from '@/lib/text';

/* ========================================================================== *
 * Detection
 * ========================================================================== */

export interface Detected {
  readonly format: Format;
  /** The delimiter to parse with. Meaningless unless `format` is csv or tsv. */
  readonly delimiter: string;
}

/** How many records the delimited-text test looks at before deciding. */
const DETECTION_RECORDS = 50;

/**
 * How much of the document the delimited-text test reads.
 *
 * Detection has to be cheap at the tool's 16 MB input ceiling, and the evidence
 * it needs is all in the first few records. Scanning the whole document to look
 * at fifty lines of it cost 119 ms on a 4 MB input, for nothing.
 */
const DETECTION_BUDGET = 64 * 1024;

/**
 * Guesses the source format, and for delimited text which delimiter.
 *
 * Order matters. YAML 1.2 is a superset of JSON, and a CSV line is a perfectly
 * valid YAML string, so the most specific test has to run first and the most
 * permissive one last: JSON, then explicit YAML markers, then delimited text,
 * then YAML as the fallback.
 *
 * It returns the DELIMITER as well as the format. It used to return only the
 * format, and the caller then parsed with whatever the delimiter option
 * happened to say - so a semicolon-separated export (which is what Excel writes
 * in most of Europe) was detected as neither CSV nor TSV, fell through to YAML,
 * and came back as one long string. No error, no clue, just the wrong answer.
 */
export function detectSource(source: string, configuredDelimiter: string): Detected {
  const stripped = stripBom(source);
  const { delimiter: declared, body } = readSepDirective(stripped);
  const text = body.trim();

  if (text === '') return { format: 'json', delimiter: configuredDelimiter };

  if (text.startsWith('{') || text.startsWith('[')) {
    return { format: 'json', delimiter: configuredDelimiter };
  }

  // A YAML document marker or a directive settles it immediately.
  if (text.startsWith('---') || text.startsWith('%YAML')) {
    return { format: 'yaml', delimiter: configuredDelimiter };
  }

  // A block sequence item. `- a, b` has one comma on every line and used to be
  // read as a two-column CSV whose header was `- a`, which is nonsense that
  // looks like a table. The trailing space is required, so `-1,2` is unaffected.
  if (text.startsWith('- ') || text === '-' || text.startsWith('-\n') || text.startsWith('-\r')) {
    return { format: 'yaml', delimiter: configuredDelimiter };
  }

  // The file said what its delimiter is. Believe it.
  if (declared !== null) {
    return { format: declared === DELIMITERS.tab ? 'tsv' : 'csv', delimiter: declared };
  }

  /*
   * Candidate delimiters, most to least distinctive.
   *
   * Tab first: a file with a consistent number of tabs is TSV and essentially
   * nothing else. The configured delimiter comes next so that choosing Pipe in
   * the options is enough to have pipes detected, without pipes being tried on
   * every input - `| a | b |` markdown tables have perfectly consistent pipe
   * counts and would be read as five-column CSV.
   */
  const candidates = [DELIMITERS.tab, configuredDelimiter, DELIMITERS.comma, DELIMITERS.semicolon];

  for (const delimiter of new Set(candidates)) {
    if (looksDelimited(body, delimiter)) {
      return { format: delimiter === DELIMITERS.tab ? 'tsv' : 'csv', delimiter };
    }
  }

  return { format: 'yaml', delimiter: configuredDelimiter };
}

/**
 * True when the start of the document parses as a consistent table.
 *
 * Two rules that the older per-line version got wrong:
 *
 *   1. Quoting is tracked ACROSS lines, not within one. A cell containing a
 *      newline - an address, a note field, anything a spreadsheet produced -
 *      made the counts disagree, so a real CSV was detected as YAML and came
 *      back as a single string.
 *   2. Two records are required. One line of `Hello, world` satisfies "every
 *      line agrees on its field count", and a one-line CSV is a header with no
 *      rows, so the tool confidently returned `[]` for non-empty input.
 */
function looksDelimited(source: string, delimiter: string): boolean {
  const counts: number[] = [];
  const limit = Math.min(source.length, DETECTION_BUDGET);

  let fields = 1;
  let inQuotes = false;
  // Mirrors the parser exactly: a quote only opens a quoted field at the START
  // of one, so `a"b` is a literal quote to both. A detector that disagreed with
  // the parser about where the fields are is a detector that can hand the
  // parser a delimiter it will then read differently.
  let fieldStarted = false;
  let recordStart = 0;
  let index = 0;

  const endRecord = (end: number): void => {
    // Blank lines are separators, exactly as the parser treats them.
    if (source.slice(recordStart, end).trim() !== '') counts.push(fields);
    fields = 1;
  };

  while (index < limit) {
    const char = source[index];

    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') index += 1;
        else inQuotes = false;
      }
      index += 1;
      continue;
    }

    if (char === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      index += 1;
      continue;
    }

    if (char === delimiter) {
      fields += 1;
      fieldStarted = false;
      index += 1;
      continue;
    }

    if (char === '\r' || char === '\n') {
      endRecord(index);
      index += char === '\r' && source[index + 1] === '\n' ? 2 : 1;
      recordStart = index;
      fieldStarted = false;
      if (counts.length >= DETECTION_RECORDS) break;
      continue;
    }

    fieldStarted = true;
    index += 1;
  }

  // Only count a final unterminated record when the whole document was read;
  // otherwise it is just where the budget ran out.
  if (limit === source.length && !inQuotes && counts.length < DETECTION_RECORDS) {
    endRecord(limit);
  }

  const first = counts[0];
  if (first === undefined || first < 2 || counts.length < 2) return false;
  return counts.every((count) => count === first);
}

/* ========================================================================== *
 * Parsing
 * ========================================================================== */

/** Pulls a position out of a native JSON.parse SyntaxError message. */
function jsonErrorPosition(
  source: string,
  message: string,
): ReturnType<typeof positionFromOffset> | null {
  const lineColumn = /line (\d+) column (\d+)/i.exec(message);
  if (lineColumn?.[1] !== undefined && lineColumn[2] !== undefined) {
    return positionFromLineColumn(Number(lineColumn[1]), Number(lineColumn[2]));
  }

  const offset = /position (\d+)/i.exec(message);
  if (offset?.[1] !== undefined) {
    return positionFromOffset(source, Number(offset[1]));
  }

  return null;
}

/**
 * The text a YAML key becomes when it is used as a JavaScript object key.
 *
 * It mirrors `stringifyKey` inside the `yaml` package exactly, including the
 * detail that a null key becomes the EMPTY STRING rather than `"null"`. Null is
 * returned for anything the library stringifies by another route, so those keys
 * fall back to identity comparison rather than being compared wrongly.
 */
function jsKeyText(node: ParsedNode): string | null {
  if (!isScalar(node)) return null;
  const value: unknown = node.value;
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return null;
}

/**
 * Whether two YAML keys collide once the document becomes JSON.
 *
 * The library's own uniqueness test compares scalar VALUES, so `true:` and
 * `"true":` are two different keys to YAML - and one key to JavaScript, because
 * both become the string `"true"`. The first pair's value was silently
 * discarded and the document came back a field short, with nothing to say so.
 * The same collapse hits `1:` against `"1":`, and `~:` against `"":`.
 *
 * Comparing the JS key text instead turns silent loss into a duplicate-key
 * error that names the line. A document that means both is not representable as
 * JSON, so refusing it is the honest answer.
 */
function collidesAsJsKey(a: ParsedNode, b: ParsedNode): boolean {
  if (a === b) return true;
  const first = jsKeyText(a);
  const second = jsKeyText(b);
  return first !== null && second !== null && first === second;
}

/**
 * Finds the first mapping key that is itself a collection.
 *
 * `? [a, b] : v` is legal YAML. JavaScript objects have string keys only, so
 * the library stringifies it to `"[ a, b ]"` - which means two different
 * collection keys can flatten onto each other and one value wins, silently.
 * Refusing is consistent with how `!!set`, `!!omap` and `!!binary` are handled:
 * this is the JSON boundary, and it is stated rather than papered over.
 */
function firstCollectionKey(document: Document.Parsed): ParsedNode | null {
  let found: ParsedNode | null = null;

  visit(document, {
    Pair(_index, pair) {
      const key: unknown = pair.key;
      if (isMap(key) || isSeq(key)) {
        found = key as ParsedNode;
        return visit.BREAK;
      }
      return undefined;
    },
  });

  return found;
}

function yamlParseFailure(error: YAMLError): ToolResult<JsonValue> {
  /*
   * A document too deep for the composer arrives as an ordinary parse error
   * whose message is V8's `Maximum call stack size exceeded`, pointed at an
   * arbitrary column of a document that is not malformed at all.
   *
   * The library codes it `RESOURCE_EXHAUSTION` - its own comment at the catch
   * site reads "Almost certainly here due to a stack overflow" - so the mapping
   * onto our depth limit is against a declared error code rather than against
   * the wording of a message, which would be a string comparison one release
   * away from silently reverting to the confusing answer.
   */
  if (error.code === 'RESOURCE_EXHAUSTION') return tooDeep();

  const detail = error.message.split('\n')[0] ?? error.message;
  const start = error.linePos?.[0];
  return fail('parse-error', 'That is not valid YAML.', {
    ...(start ? { position: positionFromLineColumn(start.line, start.col) } : {}),
    detail,
  });
}

function yamlThrownFailure(error: unknown): ToolResult<JsonValue> {
  if (error instanceof RangeError) return tooDeep();
  // The alias-expansion limit is reported as a ReferenceError by the library.
  if (error instanceof ReferenceError) {
    return fail('limit-exceeded', 'That YAML expands to too much data to convert.', {
      detail: error.message,
    });
  }
  return fail('parse-error', 'That is not valid YAML.', {
    detail: error instanceof Error ? error.message : undefined,
  });
}

/**
 * True for a document with nothing in it.
 *
 * A stream ending in `---` - which is how plenty of Kubernetes manifests are
 * written - has a final document the author did not intend, and reporting it
 * as a trailing `null` in the output would be an artefact of the punctuation
 * rather than the data.
 *
 * The library gives an implicit empty document a null scalar with a ZERO-WIDTH
 * range, where an explicit `--- null` or `--- ~` has a range covering the token
 * it was written with. That difference is the only thing separating "the author
 * wrote nothing" from "the author wrote null", so it is what this tests.
 */
function isEmptyDocument(document: Document.Parsed): boolean {
  const contents: unknown = document.contents;
  if (contents === null) return true;
  if (!isScalar(contents) || contents.value !== null) return false;
  const range = contents.range;
  return range !== null && range !== undefined && range[0] === range[1];
}

function parseYamlSource(text: string): ToolResult<JsonValue> {
  let documents: Document.Parsed[];

  try {
    /*
     * logLevel 'error', NOT 'silent'. Silent suppresses genuine parse errors
     * too, which would hand back a half-parsed document instead of reporting
     * the fault. 'error' quiets the unresolved-tag warnings and still reports
     * real syntax errors.
     *
     * parseAllDocuments rather than parse: a YAML stream of several documents
     * is what every Kubernetes manifest is, and `parse` refuses one with
     * "please use YAML.parseAllDocuments()" - an error naming an API the user
     * has no access to, for a file that is not wrong.
     */
    documents = parseAllDocuments(text, { logLevel: 'error', uniqueKeys: collidesAsJsKey });
  } catch (error) {
    return yamlThrownFailure(error);
  }

  for (const document of documents) {
    const error = document.errors[0];
    if (error !== undefined) return yamlParseFailure(error);
  }

  const filled = documents.filter((document) => !isEmptyDocument(document));
  if (filled.length === 0) return fail('invalid-input', 'Nothing to parse: the input is empty.');

  const values: JsonValue[] = [];

  for (let index = 0; index < filled.length; index += 1) {
    const document = filled[index];
    if (document === undefined) continue;

    const collectionKey = firstCollectionKey(document);
    if (collectionKey !== null) {
      return fail(
        'unsupported-type',
        'A YAML key is itself a collection, which JSON cannot represent.',
        {
          position: positionFromOffset(text, collectionKey.range[0]),
          detail: 'Object keys are strings, so two collection keys could collapse onto each other.',
        },
      );
    }

    let raw: unknown;
    try {
      raw = document.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
    } catch (error) {
      return yamlThrownFailure(error);
    }

    // A multi-document stream is reported as an array, so the path says which
    // document a bad value came out of.
    const converted = toJsonValue(raw, filled.length > 1 ? `$[${index.toString()}]` : '$');
    if (!converted.ok) return converted;
    values.push(converted.value);
  }

  if (values.length === 1) {
    const only = values[0];
    if (only !== undefined) return ok(only);
  }

  return ok(values);
}

export function parseSource(
  source: string,
  format: Format,
  delimiter: string,
): ToolResult<JsonValue> {
  const text = stripBom(source);

  switch (format) {
    case 'json': {
      if (text.trim() === '') {
        return fail('invalid-input', 'Nothing to parse: the input is empty.');
      }

      let raw: unknown;
      try {
        // JSON.parse for strictness. The YAML parser would happily accept
        // things that are not JSON, which would make "source: JSON" a lie.
        raw = JSON.parse(text);
      } catch (error) {
        // V8's JSON.parse recurses, so a deep enough document overflows the
        // stack and lands here looking like a syntax error in valid JSON.
        if (error instanceof RangeError) return tooDeep();
        const message = error instanceof Error ? error.message : 'Invalid JSON.';
        const position = jsonErrorPosition(text, message);
        return fail('parse-error', 'That is not valid JSON.', {
          ...(position ? { position } : {}),
          detail: message,
        });
      }

      return toJsonValue(raw);
    }

    case 'yaml':
      return parseYamlSource(text);

    case 'csv':
    case 'tsv': {
      // Excel's own delimiter announcement, honoured for CSV. TSV is tab by
      // definition, so there it is stripped but not obeyed.
      const directive = readSepDirective(text);
      const active = format === 'tsv' ? DELIMITERS.tab : (directive.delimiter ?? delimiter);

      const rows = parseCsvRows(directive.body, active, directive.firstLine);
      if (!rows.ok) return rows;
      return rowsToRecords(rows.value);
    }
  }
}

/**
 * Reads a JSON Lines document: one JSON value per line.
 *
 * Returns null when the text is not that, so the caller can carry on with the
 * error it already has. Only reachable from auto-detection on a document that
 * opens with `{` or `[` and failed to parse as one JSON value, which is what
 * keeps it from claiming a file of bare numbers.
 *
 * A stream of documents becoming an array is the same decision the YAML reader
 * makes for `---`-separated documents, for the same reason: it is what the file
 * says, and it is the only JSON-representable form of it.
 */
function parseJsonLines(text: string): ToolResult<JsonValue> | null {
  const lines = text.split(/\r\n|\r|\n/).filter((line) => line.trim() !== '');
  if (lines.length < 2) return null;

  const values: JsonValue[] = [];

  for (const line of lines) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return null;
    }

    const converted = toJsonValue(raw, `$[${values.length.toString()}]`);
    if (!converted.ok) return converted;
    values.push(converted.value);
  }

  return ok(values);
}

/**
 * Detects the format and parses, with the fallbacks auto-detection owes.
 *
 * Detection commits to JSON on a leading bracket, and two very common things
 * open with one without being a single JSON document:
 *
 *   - YAML flow style, a trailing comma, single quotes, unquoted keys - which
 *     between them describe every object literal ever copied out of source.
 *     YAML 1.2 is a superset of JSON and reads all of them.
 *   - JSON Lines, which is what a log export or a streaming API response is.
 *
 * Neither fallback runs when the source format was chosen explicitly: picking
 * JSON is the user saying there is no ambiguity here to resolve, and then a
 * strict answer is the useful one.
 *
 * If nothing else parses, the JSON error is reported rather than the YAML one -
 * it is the more specific of the two and names the real problem.
 */
export function parseAuto(source: string, configuredDelimiter: string): ToolResult<JsonValue> {
  const detected = detectSource(source, configuredDelimiter);
  const first = parseSource(source, detected.format, detected.delimiter);

  if (first.ok || detected.format !== 'json' || first.error.code !== 'parse-error') return first;

  const asLines = parseJsonLines(stripBom(source));
  if (asLines !== null) return asLines;

  const asYaml = parseSource(source, 'yaml', detected.delimiter);
  return asYaml.ok ? asYaml : first;
}

/* ========================================================================== *
 * Serialising
 * ========================================================================== */

export interface SerialiseOptions {
  readonly indent: number;
  readonly delimiter: string;
}

export function serialise(
  data: JsonValue,
  format: Format,
  options: SerialiseOptions,
): ToolResult<string> {
  switch (format) {
    case 'json':
      try {
        return ok(JSON.stringify(data, null, options.indent));
      } catch (error) {
        // JSON.stringify recurses, so it is the other end of the same depth
        // problem the parser has - and the `json` input port can deliver a
        // value that never went through a parser at all.
        if (error instanceof RangeError) return tooDeep();
        return fail('internal', 'Could not write that value as JSON.', {
          detail: error instanceof Error ? error.message : undefined,
        });
      }

    case 'yaml':
      try {
        return ok(
          stringifyYaml(data, {
            // Indent 0 is meaningful for JSON (compact) and impossible for
            // YAML, where nesting IS indentation, so it is clamped to the
            // shallowest legal value.
            indent: Math.max(1, options.indent),
            // 0 disables wrapping. A wrapped string is the same string, but a
            // diff of two exports should not depend on where a line broke.
            lineWidth: 0,
            /*
             * No anchors in output.
             *
             * The library's default emits `&a1`/`*a1` when the same OBJECT is
             * reachable twice. Nothing that came through a parser here can be,
             * but a value wired in on the `json` port from another tool can -
             * and then the YAML output would carry aliases where the JSON
             * output of the same value expands them. One value, two shapes,
             * depending on how it happened to be built upstream.
             */
            aliasDuplicateObjects: false,
          }),
        );
      } catch (error) {
        if (error instanceof RangeError) return tooDeep();
        return fail('internal', 'Could not write that value as YAML.', {
          detail: error instanceof Error ? error.message : undefined,
        });
      }

    case 'csv':
    case 'tsv':
      try {
        return recordsToCsv(data, format === 'tsv' ? DELIMITERS.tab : options.delimiter);
      } catch (error) {
        // Unreachable while every route in is depth-bounded, and caught anyway:
        // "never throws across the execution boundary" is a contract, not a
        // best effort, and the nested-value cells go through JSON.stringify.
        if (error instanceof RangeError) return tooDeep();
        return fail('internal', 'Could not write that value as delimited text.', {
          detail: error instanceof Error ? error.message : undefined,
        });
      }
  }
}
