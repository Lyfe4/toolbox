import {
  Document as YamlDocument,
  isMap,
  isPair,
  isScalar,
  isSeq,
  parseAllDocuments,
  visit,
  type Document,
  type DocumentOptions,
  type ParsedNode,
  type SchemaOptions,
  type ToStringOptions,
  type YAMLError,
} from 'yaml';

import { fail, isJsonArray, ok, type JsonValue, type ToolResult } from '@/features/registry/types';
import { isRounded, roundedNumbersInJson, type RoundedNumber } from '@/lib/jsonNumbers';
import { lost, noted, type ToolNote } from '@/lib/notes';
import { setOwnProperty } from '@/lib/safeObject';
import { positionFromLineColumn, positionFromOffset, stripBom } from '@/lib/textPosition';

import { parseCsvRows, readSepDirective, rowsToRecords, writeCsv, type Written } from './csv';
import { describeJsonc, stripJsonc } from './jsonc';

/**
 * WHAT A READ PRODUCED, AND WHAT IT COST.
 *
 * `parseSource` returned a value, which is everything a caller needs to convert
 * and nothing it needs to be honest. Three of this tool's losses happen during
 * the read - a rounded integer, a stream flattened to an array, a byte order
 * mark removed - and a `ToolResult` is a value or an error, so there was
 * nowhere for any of them to go.
 *
 * `readSource`/`readAuto` return this; `parseSource`/`parseAuto` stay as
 * value-only wrappers over them, because the oracle suites compare VALUES
 * against external references and should not have to learn a new shape to keep
 * doing it.
 */
export interface Reading {
  readonly data: JsonValue;
  /** The format actually read, whether chosen or detected. */
  readonly format: Format;
  /** The delimiter used. Null for JSON and YAML, which have none. */
  readonly delimiter: string | null;
  /** Documents in the source: more than one for a YAML stream or JSON Lines. */
  readonly documents: number;
  readonly notes: readonly ToolNote[];
}

/**
 * The gate in front of every rounded-integer scan.
 *
 * 2^53 is 9007199254740992 - sixteen digits - so a document with no run of
 * sixteen digits cannot contain an integer literal that a double rounds. One
 * regular expression over the source keeps a 16 MB document that has no such
 * number from being walked a second time for nothing.
 */
const LONG_DIGIT_RUN = /\d{16,}/;

/**
 * Rounded integers as notes: ONE note, with a count and every path.
 *
 * Not one note per number. A log export with four hundred snowflake ids in it
 * would otherwise produce four hundred notes, and a list nobody can read is a
 * list nobody reads. The count is the fact; the paths are how you find them.
 */
function roundedNumberNotes(rounded: readonly RoundedNumber[]): ToolNote[] {
  if (rounded.length === 0) return [];

  const shown = rounded.slice(0, 5);
  const paths = shown.map((entry) => entry.path).join(', ');
  const rest = rounded.length - shown.length;
  const first = rounded[0];

  return [
    lost(
      rounded.length === 1
        ? `The number at ${rounded[0]?.path ?? '$'} was rounded`
        : `${rounded.length.toString()} numbers were rounded`,
      `JavaScript has one numeric type and it is a double, so an integer past 2^53 cannot be held exactly.${
        first === undefined ? '' : ` ${first.source} became ${first.value.toString()}.`
      } At ${paths}${rest > 0 ? `, and ${rest.toString()} more` : ''}. Convert to CSV or TSV to keep the digits, where every cell stays a string.`,
      /*
       * BOTH DATA PORTS, because this one happens in the READ half. The parser
       * produced the rounded number, so it is in the parsed structure as well
       * as in whatever gets written out of it - unlike the write-half losses
       * in csv.ts, which `data` escapes.
       */
      ['output', 'data'],
    ),
  ];
}

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
  /**
   * True when YAML was reached by running out of other options rather than by
   * finding YAML. `parseAuto` needs the distinction: a document that announced
   * itself with `---` and then failed to parse has a YAML problem, and one that
   * merely fell through here may not be YAML at all.
   */
  readonly fellBack: boolean;
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

  if (text === '') return { format: 'json', delimiter: configuredDelimiter, fellBack: false };

  if (text.startsWith('{') || text.startsWith('[')) {
    return { format: 'json', delimiter: configuredDelimiter, fellBack: false };
  }

  // A YAML document marker or a directive settles it immediately.
  if (text.startsWith('---') || text.startsWith('%YAML')) {
    return { format: 'yaml', delimiter: configuredDelimiter, fellBack: false };
  }

  // A block sequence item. `- a, b` has one comma on every line and used to be
  // read as a two-column CSV whose header was `- a`, which is nonsense that
  // looks like a table. The trailing space is required, so `-1,2` is unaffected.
  if (text.startsWith('- ') || text === '-' || text.startsWith('-\n') || text.startsWith('-\r')) {
    return { format: 'yaml', delimiter: configuredDelimiter, fellBack: false };
  }

  // The file said what its delimiter is. Believe it.
  if (declared !== null) {
    return {
      format: declared === DELIMITERS.tab ? 'tsv' : 'csv',
      delimiter: declared,
      fellBack: false,
    };
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
      /*
       * VERIFY, RATHER THAN GUESS, BEFORE CALLING TWO LINES A TABLE.
       *
       * `tags: a, b` over `names: c, d` is two lines of ordinary YAML with one
       * comma each, and the test above is satisfied by exactly that: two
       * records, consistent field count. It came back as a one-row table whose
       * columns were `tags: a` and `b` - nonsense that looks like data, with no
       * error anywhere. A two-line log with one comma per line went the same
       * way.
       *
       * The fix is not a higher bar - "three records or it is not a table"
       * refuses a header and one row, which is a real file. It is a different
       * question, and one that has an answer: does this document ALSO parse as
       * a YAML mapping? A genuine CSV does not. `name,age` over `ada,36` folds
       * to a plain scalar, and every delimited export in the round-one corpus
       * does the same, so nothing that is really a table is affected. A CSV
       * every one of whose cells is `key: value` would flip; that is the
       * contrived end of the trade, and it is stated in the matrix.
       *
       * Asked of the SAME 64 kB `looksDelimited` reads, so detection remains a
       * bounded read of the head of the document rather than a full parse of a
       * 16 MB one. A mapping that only starts looking like a mapping past 64 kB
       * is not a document this can help.
       */
      if (parsesAsYamlMapping(body.slice(0, DETECTION_BUDGET))) {
        return { format: 'yaml', delimiter: configuredDelimiter, fellBack: false };
      }
      return { format: delimiter === DELIMITERS.tab ? 'tsv' : 'csv', delimiter, fellBack: false };
    }
  }

  return { format: 'yaml', delimiter: configuredDelimiter, fellBack: true };
}

/**
 * True when a document reads as a YAML MAPPING, with no errors.
 *
 * A mapping specifically, not "valid YAML": every CSV in the world is valid
 * YAML, because a plain scalar swallows anything. What separates
 * `tags: a, b` from `name,age` is that only one of them has keys.
 */
function parsesAsYamlMapping(text: string): boolean {
  let documents: Document.Parsed[];

  try {
    documents = parseAllDocuments(text, { logLevel: 'silent' });
  } catch {
    return false;
  }

  if (documents.length !== 1) return false;
  const only = documents[0];
  if (only === undefined || only.errors.length > 0) return false;
  return isMap(only.contents);
}

/**
 * A delimiter this tool offers that detection never tried on this document.
 *
 * Only ever pipe, in practice, and deliberately so: `| a | b |` is a Markdown
 * table with a perfectly consistent pipe count, so trying pipe on every input
 * would read ordinary prose as a five-column table. Choosing Pipe in the
 * options puts it in the candidate list above, which is the intended way in.
 *
 * The whole cost of that trade was being paid by the user, though. A
 * pipe-separated export pasted with the options untouched fell through to YAML
 * and came back as "That is not valid YAML - implicit keys need to be on a
 * single line", which names a construct that is not in the document and a
 * format nobody mentioned. Neither the file nor the tool is broken; one control
 * is set wrong. So when the fallback fails, say which one.
 */
function untriedDelimiter(source: string, configuredDelimiter: string): DelimiterName | null {
  const tried = new Set([
    DELIMITERS.tab,
    configuredDelimiter,
    DELIMITERS.comma,
    DELIMITERS.semicolon,
  ]);

  for (const [name, delimiter] of Object.entries(DELIMITERS) as [DelimiterName, string][]) {
    if (tried.has(delimiter)) continue;
    if (looksDelimited(source, delimiter)) return name;
  }

  return null;
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
 * Whether two colliding keys are the SAME key, or only the same JSON key.
 *
 * THE DIFFERENCE IS THE WHOLE MESSAGE, and for a long time it was not made.
 * Both kinds arrived as the library's `DUPLICATE_KEY` and both came back as
 * "That is not valid YAML." - which is true of `a: 1 / a: 1` and is FALSE of
 * `true: / "true":`. That second document is valid YAML by every reference
 * there is: yaml-test-suite composes it, js-yaml reads it, PyYAML reads it. It
 * is THIS TOOL that cannot carry it, because JSON object keys are strings and
 * both of those become `"true"` - the same JSON boundary that refuses a `!!set`
 * or a collection key, and the only one of the three that was blaming the
 * document for it.
 *
 * Someone told their valid YAML is invalid goes looking for a syntax error
 * that is not there. Someone told two of their keys become one JSON key knows
 * both what happened and what to do about it.
 */
function isSameYamlKey(a: ParsedNode, b: ParsedNode): boolean {
  if (!isScalar(a) || !isScalar(b)) return a === b;
  // Object.is, not ===, so two NaN keys are the same key. The comparison is on
  // the RESOLVED value: `0x10:` and `16:` really are one key to YAML.
  return Object.is(a.value, b.value);
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

function yamlParseFailure<T = never>(error: YAMLError): ToolResult<T> {
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

/**
 * The two refusals a colliding key gets, and they say different things.
 *
 * Both are refusals - a document that means two things at one key has no JSON
 * form either way - but only one of them is about the document being wrong.
 * The `same-json-key` half is this tool's JSON boundary, which is why it is
 * worded like the other three (`!!set`, `!!binary`, a collection key) rather
 * than like a syntax error, and why the oracle test can now assert that no
 * document the yaml-test-suite marks invalid is refused by it.
 */
function duplicateKeyFailure<T = never>(
  text: string,
  error: YAMLError,
  kind: 'same-key' | 'same-json-key',
): ToolResult<T> {
  const position = positionFromOffset(text, error.pos[0]);

  return kind === 'same-key'
    ? fail('parse-error', 'That mapping has the same key twice.', {
        position,
        detail:
          'A mapping may name each key once. Two entries with one key have no single value, so ' +
          'which one survived would be a coin toss.',
      })
    : fail('unsupported-type', 'Two different YAML keys become the same JSON key.', {
        position,
        detail:
          'This is valid YAML - `true:` and `"true":` are two keys, and so are `1:` and `"1":`, ' +
          'and `~:` and `"":`. JSON object keys are strings, so both become one and one value ' +
          'would be lost with nothing to say so.',
      });
}

function yamlThrownFailure<T = never>(error: unknown): ToolResult<T> {
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
 * True for a document with nothing in it AND no `---` to say it is a document.
 *
 * THE SECOND HALF WAS MISSING, AND IT CHANGED THE LENGTH OF PEOPLE'S FILES.
 *
 * The rule used to be "empty contents means no document", justified as: a
 * stream ending in `---` is how plenty of Kubernetes manifests are written, and
 * a trailing `null` would be an artefact of the punctuation. That reasoning is
 * appealing and it is wrong, and three independent references say so about the
 * very same bytes:
 *
 *   `---\na: b\n---\n`   yaml-test-suite PUW8  [{a: b}, null]
 *                        js-yaml 5.4.2         [{a: b}, null]
 *                        PyYAML 6.0.3          [{a: b}, null]
 *
 * `---` STARTS A DOCUMENT. An empty one is `null`, and dropping it made a
 * five-document stream come back as a four-element array with no error - which
 * is the silent loss the matrix recorded and this fixes. Twelve of the
 * twenty-one yaml-test-suite divergences were this one rule.
 *
 * What survives is the case the old rule was really for: an EMPTY BOX. A
 * document with no marker and nothing in it is not a document, so an empty
 * input still says "nothing to parse" rather than producing `null`, and a
 * stream of nothing but comments still says the same.
 *
 * `directives.docStart` is the library's own record of whether a `---` was
 * seen. The previous test - a null scalar with a zero-width range - could not
 * tell `---` from nothing at all, because both produce exactly that.
 */
function isEmptyDocument(document: Document.Parsed): boolean {
  if (document.directives.docStart === true) return false;
  const contents: unknown = document.contents;
  if (contents === null) return true;
  if (!isScalar(contents) || contents.value !== null) return false;
  const range = contents.range;
  return range !== null && range !== undefined && range[0] === range[1];
}

/**
 * Every rounded integer in a YAML document, by path.
 *
 * The JSON side of this question is answered by a scanner over the source (see
 * `lib/jsonNumbers.ts`); YAML needs no scanner because the library already
 * hands over every scalar with the text the author wrote and the path it sits
 * at. `node.source` is that text - not `node.value`, which is the double and
 * therefore the thing being measured rather than the measurement.
 *
 * Only reached when the document has a run of sixteen digits in it, which is
 * what `roundedNumbersInJson`'s gate tests and what every caller checks first.
 */
function roundedNumbersInYaml(documents: readonly Document.Parsed[]): readonly RoundedNumber[] {
  const found: RoundedNumber[] = [];
  const stream = documents.length > 1;

  documents.forEach((document, position) => {
    visit(document, {
      Scalar(_key, node, ancestors) {
        const source: unknown = node.source;
        if (typeof source !== 'string' || !isRounded(source)) return undefined;
        found.push({
          path: `${stream ? `$[${position.toString()}]` : '$'}${yamlPath(ancestors, node)}`,
          source,
          value: Number(source),
        });
        return undefined;
      },
    });
  });

  return found;
}

/**
 * The path of the node `visit` is currently at, from the ancestors it passes.
 *
 * `ancestors` alternates collection, pair, collection, pair as it descends, and
 * each pair carries its own key - so the path is read off it rather than
 * tracked in a variable that a `visit.BREAK` could leave stale.
 *
 * THE VISITED NODE IS PASSED TOO, BECAUSE THE LAST STEP HAS NO ANCESTOR TO READ
 * IT FROM. Each step pairs an ancestor with the NEXT one, and the last ancestor
 * has no next - so the step into the node itself was silently dropped. For a
 * map that is invisible, since a scalar inside one always has a Pair between it
 * and the map; for a sequence the item IS the child, and the index went
 * missing. Measured, against a document with two rounded integers in a
 * sequence: `At $, $` - one path, twice, for two different numbers, in a report
 * whose whole claim is that it names WHICH. The same document read as JSON
 * answered `$[0], $[1]`, which is what a reader comparing the two would have
 * seen and what nothing here was asking.
 */
function yamlPath(ancestors: readonly unknown[], visited: unknown): string {
  const parts: string[] = [];

  for (let index = 0; index < ancestors.length; index += 1) {
    const node = ancestors[index];
    const child = ancestors[index + 1] ?? visited;

    if (isMap(node)) {
      const key: unknown = isPair(child) ? child.key : null;
      const name = isScalar(key) && typeof key.value === 'string' ? key.value : null;
      if (name !== null) {
        parts.push(/^[A-Za-z_$][\w$]*$/.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`);
      }
      continue;
    }

    if (isSeq(node)) {
      const at = node.items.indexOf(child);
      if (at >= 0) parts.push(`[${at.toString()}]`);
    }
  }

  return parts.join('');
}

/**
 * A second `%YAML` directive on one document, which the spec forbids.
 *
 * FOUND BY FIXING SOMETHING ELSE. The suite's SF5V is `%YAML 1.2` twice over a
 * bare `---`, marked as an error, and it was refused - by the rule that a
 * document with nothing in it is not a document. The message said "nothing to
 * parse: the input is empty", which is not what is wrong with it. So the
 * hundred-percent refusal rate on the suite's error cases included one case
 * refused for a reason that had nothing to do with its fault, and the moment
 * the empty-document rule was corrected the parser accepted a document the spec
 * says is invalid.
 *
 * The library does not flag it at any log level - `errors` and `warnings` are
 * both empty - so it is checked here. Everything else the suite calls an error
 * comes from the library itself; this is the only rule this file enforces on
 * its own, and it is here rather than in the library's issue tracker because a
 * silent acceptance is a wrong answer today.
 *
 * Returns the offset of the offending directive, or null.
 */
function duplicateYamlDirective(text: string): number | null {
  let offset = 0;
  let seen = false;

  for (const line of text.split('\n')) {
    // A document boundary ends the directive block: the directives that follow
    // one belong to the next document, and `%YAML` may appear once per
    // document rather than once per stream.
    if (line.startsWith('---') || line.startsWith('...')) seen = false;
    else if (line.startsWith('%YAML')) {
      if (seen) return offset;
      seen = true;
    }
    offset += line.length + 1;
  }

  return null;
}

/**
 * A directive introducing nothing, which is SF5V's finding one round later.
 *
 * Round four asked what every one of the suite's 94 error cases was refused
 * FOR, rather than only that it was refused, and found 9MMA in exactly the
 * state SF5V had been in: a bare `%YAML 1.2` with no document, refused by the
 * rule that an empty input is not a document, with the message "nothing to
 * parse: the input is empty". True of the bytes and not what is wrong with
 * them - a directive introduces a document, and this one introduces nothing.
 * The coincidence matters for the reason it did last time: correct the empty
 * rule again and the parser accepts a document the spec calls invalid, with
 * nothing to notice.
 *
 * ASKED OF THE LIBRARY, NOT OF THE TEXT, and the suite is why. The obvious
 * version scans for a line starting with `%YAML` that no `---` follows, and
 * the suite refused it on the first run: XLQ9 is a multi-line scalar one of
 * whose lines reads `%YAML 1.2`, which is content rather than a directive. The
 * parser already knows the difference - a directive with no document yields NO
 * DOCUMENTS AT ALL - so the only thing left to decide is which of the two
 * refusals a zero-document input gets, and a `%` at the start of a line
 * decides that safely: every document that is not empty produces a document,
 * so this is never reached for one.
 */
const DIRECTIVE_LINE = /^%/m;

function readYamlSource(text: string): ToolResult<Reading> {
  const duplicate = duplicateYamlDirective(text);
  if (duplicate !== null) {
    return fail('parse-error', 'That document has two %YAML directives.', {
      position: positionFromOffset(text, duplicate),
      detail: 'A document may declare its YAML version once. Remove one of them.',
    });
  }

  /*
   * Which kind of key collision happened where, keyed by the offset the library
   * reports the error at - which is the SECOND key's start, measured rather
   * than assumed. A side channel is needed because `uniqueKeys` answers a
   * yes/no question and the library keeps nothing but a position afterwards.
   */
  const collisions = new Map<number, 'same-key' | 'same-json-key'>();
  const uniqueKeys = (a: ParsedNode, b: ParsedNode): boolean => {
    if (!collidesAsJsKey(a, b)) return false;
    collisions.set(b.range[0], isSameYamlKey(a, b) ? 'same-key' : 'same-json-key');
    return true;
  };

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
    documents = parseAllDocuments(text, { logLevel: 'error', uniqueKeys });
  } catch (error) {
    return yamlThrownFailure(error);
  }

  for (const document of documents) {
    const error = document.errors[0];
    if (error !== undefined) {
      const collision = error.code === 'DUPLICATE_KEY' ? collisions.get(error.pos[0]) : undefined;
      if (collision !== undefined) return duplicateKeyFailure(text, error, collision);
      return yamlParseFailure(error);
    }
  }

  if (documents.length === 0 && DIRECTIVE_LINE.test(text)) {
    return fail('parse-error', 'That directive has no document after it.', {
      position: positionFromOffset(text, text.search(DIRECTIVE_LINE)),
      detail: 'A directive introduces a document, which begins with ---. Add one, or remove it.',
    });
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

  const notes: ToolNote[] = [];

  /*
   * THE STREAM NOTE IS NOT WRITTEN HERE, and that is deliberate.
   *
   * Whether "a stream of five documents" is a LOSS depends on the target: YAML
   * can hold a stream and writes one back, JSON, CSV and TSV cannot and flatten
   * it to an array. A note written at read time would have to guess, and the
   * first version of it guessed wrong - it told a YAML-to-YAML conversion that
   * its stream "became an array" while the output sitting beside it was a
   * stream. `Reading.documents` carries the count instead and the report says
   * what actually happened. See `buildReport`.
   */

  if (LONG_DIGIT_RUN.test(text)) {
    notes.push(...roundedNumberNotes(roundedNumbersInYaml(filled)));
  }

  const single = values.length === 1 ? values[0] : undefined;
  return ok({
    data: single === undefined ? values : single,
    format: 'yaml',
    delimiter: null,
    documents: filled.length,
    notes,
  });
}

export function parseSource(
  source: string,
  format: Format,
  delimiter: string,
): ToolResult<JsonValue> {
  const read = readSource(source, format, delimiter);
  return read.ok ? ok(read.value.data) : read;
}

export function readSource(source: string, format: Format, delimiter: string): ToolResult<Reading> {
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

      const converted = toJsonValue(raw);
      if (!converted.ok) return converted;

      return ok({
        data: converted.value,
        format: 'json',
        delimiter: null,
        documents: 1,
        notes: roundedNumberNotes(roundedNumbersInJson(text)),
      });
    }

    case 'yaml':
      return readYamlSource(text);

    case 'csv':
    case 'tsv': {
      // Excel's own delimiter announcement, honoured for CSV. TSV is tab by
      // definition, so there it is stripped but not obeyed.
      const directive = readSepDirective(text);
      const active = format === 'tsv' ? DELIMITERS.tab : (directive.delimiter ?? delimiter);

      const rows = parseCsvRows(directive.body, active, directive.firstLine);
      if (!rows.ok) return rows;
      const records = rowsToRecords(rows.value);
      if (!records.ok) return records;

      return ok({
        data: records.value,
        format,
        delimiter: active,
        documents: 1,
        /*
         * No rounded-number note here, and that is not an omission: every cell
         * comes out of the CSV reader as a STRING - `01234` is a part number,
         * not the number 1234 - so a nineteen-digit key in a spreadsheet export
         * keeps every digit. It is the one reading path in this tool with no
         * numeric ceiling at all.
         */
        notes: [],
      });
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
function parseJsonLines(text: string): ToolResult<Reading> | null {
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

  return ok({
    data: values,
    format: 'json',
    delimiter: null,
    documents: lines.length,
    notes: [
      // The stream note belongs to the report, which knows the target. See the
      // note in `readYamlSource` for why.
      ...(LONG_DIGIT_RUN.test(text)
        ? roundedNumberNotes(
            lines.flatMap((line, position) =>
              roundedNumbersInJson(line).map((entry) => ({
                ...entry,
                path: entry.path.replace(/^\$/, `$[${position.toString()}]`),
              })),
            ),
          )
        : []),
    ],
  });
}

/**
 * True when a YAML parse folded two of the document's lines into one scalar.
 *
 * A PLAIN scalar in YAML continues across line breaks and the breaks become
 * spaces, so any document YAML cannot read as structure it can still read as
 * one long string. That is correct YAML and a catastrophic answer for the two
 * places auto-detection reaches for YAML as a fallback, because both are
 * reached by a document that is probably not YAML at all:
 *
 *     {                          ->  { "// a comment \"a\"": 1 }
 *       // a comment
 *       "a": 1
 *     }
 *
 *     {"a":"line one             ->  { "a": "line one line two" }
 *     line two"}
 *
 *     a,b,c                      ->  "a,b,c 1,2"
 *     1,2
 *
 * Every one of those is a confident wrong answer with no error anywhere - the
 * first invents a key out of a comment, the second replaces a newline inside
 * a string with a space, and the third turns a ragged CSV into a sentence.
 *
 * BLOCK SCALARS ARE THE EXCEPTION AND THE ONLY ONE. `|` and `>` are the author
 * writing several lines on purpose - the library tags them `BLOCK_LITERAL` and
 * `BLOCK_FOLDED` - so a document that really is a top-level block scalar is
 * not caught by this. Everything else folds: a PLAIN scalar turns its line
 * breaks into spaces, and so does a double-quoted one, which is why
 * `{"a":"line one<LF>line two"}` came back with a space in place of the
 * newline rather than as the JSON syntax error it is.
 *
 * The range is the source span of the scalar's own value, so this asks what
 * the DOCUMENT looked like rather than what the value ended up being: a plain
 * scalar written across two lines is the fold, whether or not the text it
 * produced still contains a newline.
 */
export function foldsLines(text: string): boolean {
  let documents: Document.Parsed[];

  try {
    // 'silent': this is a question about shape, asked about a document whose
    // errors the caller has already decided what to do with.
    documents = parseAllDocuments(text, { logLevel: 'silent' });
  } catch {
    return false;
  }

  for (const document of documents) {
    /*
     * The offsets of the folded scalars, rather than a boolean. A `let`
     * assigned only inside a callback is narrowed to its initialiser by the
     * compiler, so the test below would read as always-false.
     */
    const folded: number[] = [];

    visit(document, {
      Scalar(_index, node) {
        if (node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED') return undefined;
        // The range is optional on the node type even though a PARSED scalar
        // always has one, so it is narrowed rather than asserted.
        const range = node.range;
        if (range === null || range === undefined) return undefined;
        if (!text.slice(range[0], range[1]).includes('\n')) return undefined;
        folded.push(range[0]);
        return visit.BREAK;
      },
    });

    if (folded.length > 0) return true;
  }

  return false;
}

const NOT_A_FORMAT = 'This is not JSON, YAML, CSV or TSV that this tool can read.';

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
  const read = readAuto(source, configuredDelimiter);
  return read.ok ? ok(read.value.data) : read;
}

export function readAuto(source: string, configuredDelimiter: string): ToolResult<Reading> {
  const detected = detectSource(source, configuredDelimiter);
  const first = readSource(source, detected.format, detected.delimiter);

  /*
   * YAML was the fallback rather than a finding, AND IT FOUND NOTHING - either
   * it failed outright, or it returned a scalar, which for a multi-line
   * document means it folded the whole thing into one string.
   *
   * The second case is the dangerous one and it is why this test is not simply
   * `!first.ok`. `name|age\nada|36\ngrace|45` parses as perfectly valid YAML:
   * a multi-line plain scalar, folded to "name|age ada|36 grace|45". No error,
   * no clue, and the newlines gone - which is word for word the failure the
   * semicolon work above was written to kill, still alive for the one
   * delimiter detection will not try on its own.
   *
   * A scalar result is the usable tell: YAML found no structure, so there is
   * nothing to second-guess. When YAML returns a mapping or a sequence it has
   * found real structure and this never fires.
   */
  const foundNothing =
    !first.ok || first.value.data === null || typeof first.value.data !== 'object';
  if (detected.fellBack && foundNothing) {
    const name = untriedDelimiter(stripBom(source), configuredDelimiter);
    if (name !== null) {
      return fail('invalid-input', `This looks like ${name}-separated text, not YAML.`, {
        detail: `Set the CSV delimiter option to ${name} to read it as a table.`,
      });
    }

    /*
     * No delimiter explains it either, and YAML got a scalar out of a document
     * whose lines it FOLDED TOGETHER - see `foldsLines`. A three-column header
     * over a two-column row came back as the string `"a,b,c 1,2"`: a ragged
     * CSV, or a log, or a paragraph of
     * prose, reported as a one-line string with the line breaks replaced by
     * spaces and nothing at all to say so.
     *
     * The old test stopped at "is it a scalar", which is true of the string
     * `hello` as well, and `hello` really is a YAML document meaning "hello".
     * Asking whether lines were folded is what separates the two.
     */
    if (first.ok && foldsLines(stripBom(source))) {
      return fail('invalid-input', NOT_A_FORMAT, {
        detail:
          'Read as YAML it is one long string with the line breaks turned into spaces, which is almost certainly not what it is.',
      });
    }
  }

  if (first.ok || detected.format !== 'json' || first.error.code !== 'parse-error') return first;

  const asLines = parseJsonLines(stripBom(source));
  if (asLines !== null) return asLines;

  /*
   * JSONC, AS A STEP OF ITS OWN, IN FRONT OF THE YAML FALLBACK.
   *
   * `//` comments, block comments and a comma before the closing brace are what
   * `tsconfig.json`, every VS Code settings file and most JSON an LLM writes
   * actually contain. Round two made all three report the JSON parser's own
   * error, which was right as far as it went; this reads the document the
   * author meant and says what it removed.
   *
   * IN FRONT OF YAML, NOT BEHIND IT, and that ordering is the whole safety
   * argument. The YAML fallback folds a comment and the key after it into one
   * key - `// a comment "a"` - and calls it success. `stripJsonc` is
   * string-aware and removes a comment AS A COMMENT or not at all, so by the
   * time YAML sees anything there is no comment left to fold. Nothing can be
   * folded into a key again.
   */
  const stripped = stripJsonc(stripBom(source));
  /*
   * The error from the STRIPPED document, when there is one.
   *
   * A document with a comment on line 2 and a real fault on line 4 reported the
   * comment, because the comment is the first thing `JSON.parse` trips over -
   * and the comment is not the problem, it is the thing this step exists to
   * allow. `stripJsonc` preserves every offset precisely so that this error can
   * be handed back with a position that still points into the document the user
   * is looking at.
   */
  let jsoncError: ToolResult<Reading> | null = null;

  if (stripped.changed) {
    const asJsonc = readSource(stripped.text, 'json', detected.delimiter);
    if (!asJsonc.ok) jsoncError = asJsonc;
    if (asJsonc.ok) {
      const removed = describeJsonc(stripped);
      return ok({
        ...asJsonc.value,
        notes: [
          ...(removed === null
            ? []
            : [
                noted(
                  'Read as JSONC',
                  `This is not JSON: ${removed} were removed before parsing. JSONC is what tsconfig.json and VS Code settings are; the output is plain JSON, so the comments are not in it.`,
                ),
              ]),
          ...asJsonc.value.notes,
        ],
      });
    }
  }

  /*
   * THE YAML FALLBACK FOR A DOCUMENT THAT OPENS WITH A BRACKET, AND THE GUARD
   * IT NEEDED.
   *
   * The fallback earns its place: YAML 1.2 is a superset of JSON, so it reads
   * the unquoted keys, single quotes and trailing commas that describe every
   * object literal ever copied out of source, and every one of those is the
   * document the user meant.
   *
   * What it must not do is ACCEPT A DIFFERENT DOCUMENT. A plain scalar in YAML
   * runs across line breaks, so two of the most ordinary things wrong with
   * pasted JSON turned into confident nonsense rather than into the JSON
   * parser's own error:
   *
   *   - a `//` or block comment, which is what an LLM writes and what JSONC
   *     and every tsconfig.json look like: the comment and the key after it
   *     became ONE KEY, `// a comment "a"`;
   *   - a literal newline inside a string, which is what hand-editing
   *     produces: a string written across two lines came back as one line,
   *     with the newline silently replaced by a space.
   *
   * Neither failed. Both produced a plausible object, which is the one shape
   * of wrongness nobody reports. When the YAML read folded lines the JSON
   * error is the honest answer, and it points at the character that is
   * actually the problem.
   */
  const asYaml = readSource(source, 'yaml', detected.delimiter);
  if (!asYaml.ok || foldsLines(stripBom(source))) return jsoncError ?? first;
  return ok({
    ...asYaml.value,
    // The FORMAT is what was read, and what was read is not JSON. Saying `yaml`
    // here is what makes the Detected report able to tell "this parsed as JSON"
    // from "this is near-JSON that YAML rescued", which is a distinction
    // somebody looking at a wrong answer needs.
    format: 'yaml',
    notes: [
      noted(
        'Read as YAML, not JSON',
        'It opens with a bracket but is not valid JSON - unquoted keys, single quotes or a trailing comma, say. YAML 1.2 is a superset of JSON and reads all of those, so that is what read it.',
      ),
      ...asYaml.value.notes,
    ],
  });
}

/* ========================================================================== *
 * Serialising
 * ========================================================================== */

export interface SerialiseOptions {
  readonly indent: number;
  readonly delimiter: string;
  /**
   * Documents the SOURCE held, so a stream can be written back as a stream.
   *
   * Defaults to one, which is what every caller that does not know means. See
   * `writeTarget`.
   */
  readonly documents?: number;
}

/**
 * WRITES A DOCUMENT RATHER THAN CALLING `stringify`, TO QUOTE ONE CHARACTER.
 *
 * A string with a TAB in it is written by the library as a plain scalar, tab
 * and all - `note: a\tb`. That is legal YAML by the 1.2 grammar, which allows
 * `s-white` inside a plain scalar. It is also a file CPython cannot open:
 * PyYAML 6.0.3 and ruamel.yaml 0.19.1 both stop at the scanner with "found
 * character '\t' that cannot start any token", and they stop on the whole
 * DOCUMENT, not on that one value. One tab anywhere in a converted file and
 * every Python reader refuses all of it.
 *
 * Measured, not assumed: eleven documents in the yaml-test-suite corpus came
 * out of this writer in a form both Python readers refused, and the fixture in
 * `spec/yaml-writer-pyyaml.json` is where that measurement lives. js-yaml reads
 * them, which is exactly why one independent reader was not enough.
 *
 * So a string containing a tab is written double-quoted, where the tab becomes
 * `\t` and all four implementations agree about it. Nothing else is restyled:
 * the library's choices are better than anything written here, and the block
 * scalar that makes a multi-line value readable is the reason to use YAML.
 */
function writeYamlDocument(
  data: JsonValue,
  options: DocumentOptions & SchemaOptions & ToStringOptions,
): string {
  const document = new YamlDocument(data, options);

  visit(document, {
    Scalar(_key, node) {
      // Keys as well as values: `visit` reaches both, and a key with a tab in
      // it takes the document down in exactly the same way.
      if (
        typeof node.value === 'string' &&
        node.value.includes('\t') &&
        // Only where a PLAIN scalar is what the library would write. A tab
        // inside a block scalar is read correctly by all four implementations,
        // and a Makefile or a snippet of indented code arriving as one long
        // double-quoted line with `\n` in it would be a worse document than
        // the one it replaced.
        !node.value.includes('\n')
      ) {
        node.type = 'QUOTE_DOUBLE';
      }
    },
  });

  return document.toString(options);
}

/** The value-only wrapper, for callers with nothing to report to. */
export function serialise(
  data: JsonValue,
  format: Format,
  options: SerialiseOptions,
): ToolResult<string> {
  const written = writeTarget(data, format, options);
  return written.ok ? ok(written.value.text) : written;
}

/**
 * Writes the value in the target format, and says what the target could not
 * hold.
 *
 * A YAML STREAM IS WRITTEN BACK AS A STREAM. A `---`-separated file has no JSON
 * spelling but an exact YAML one, and writing it as a sequence turned every
 * Kubernetes manifest that went through this tool into a file `kubectl` will
 * not read - with nothing on screen to say so. The source's document count is
 * carried through `Reading` for exactly this; when it is more than one and the
 * value is still the array that came out of it, the separators go back in.
 *
 * The guard is `data.length === documents`, not `documents > 1` alone, because
 * `sortKeys` and a value wired in on the `json` port can both put a different
 * array here. Writing `---` between the elements of an array that is not the
 * stream would be inventing a file.
 */
export function writeTarget(
  data: JsonValue,
  format: Format,
  options: SerialiseOptions,
): ToolResult<Written> {
  switch (format) {
    case 'json':
      try {
        return ok({ text: JSON.stringify(data, null, options.indent), notes: [], stream: false });
      } catch (error) {
        // JSON.stringify recurses, so it is the other end of the same depth
        // problem the parser has - and the `json` input port can deliver a
        // value that never went through a parser at all.
        if (error instanceof RangeError) return tooDeep();
        return fail('internal', 'Could not write that value as JSON.', {
          detail: error instanceof Error ? error.message : undefined,
        });
      }

    case 'yaml': {
      const yamlOptions = {
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
      } as const;

      try {
        const documents = options.documents ?? 1;
        if (documents > 1 && isJsonArray(data) && data.length === documents) {
          /*
           * `---` before EVERY document, including the first. That is what
           * `kubectl` writes, what `yq` writes, and what the yaml-test-suite's
           * own multi-document examples look like; leaving it off the first one
           * produces a file whose second document is explicit and whose first
           * is implicit, which is legal and asymmetric for no reason.
           */
          return ok({
            text: data.map((entry) => `---\n${writeYamlDocument(entry, yamlOptions)}`).join(''),
            notes: [],
            stream: true,
          });
        }

        return ok({ text: writeYamlDocument(data, yamlOptions), notes: [], stream: false });
      } catch (error) {
        if (error instanceof RangeError) return tooDeep();
        return fail('internal', 'Could not write that value as YAML.', {
          detail: error instanceof Error ? error.message : undefined,
        });
      }
    }

    case 'csv':
    case 'tsv':
      try {
        return writeCsv(data, format === 'tsv' ? DELIMITERS.tab : options.delimiter);
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
