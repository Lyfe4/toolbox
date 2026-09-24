import {
  Document as YamlDocument,
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  parseAllDocuments,
  visit,
  type Document,
  type DocumentOptions,
  type ParsedNode,
  type ScalarTag,
  type SchemaOptions,
  type ToStringOptions,
  type YAMLError,
} from 'yaml';

import {
  fail,
  isJsonArray,
  ok,
  type JsonValue,
  type SourcePosition,
  type ToolResult,
} from '@/features/registry/types';
import {
  duplicateJsonKeys,
  isRounded,
  roundedNumbersInJson,
  scanJsonSource,
  type DuplicateKey,
  type RoundedNumber,
} from '@/lib/jsonNumbers';
import { pathStep } from '@/lib/jsonNumbers';
import { locateJsonSyntaxError } from '@/lib/jsonSyntax';
import { lost, noted, type ToolNote } from '@/lib/notes';
import { counted } from '@/lib/plural';
import { setOwnProperty } from '@/lib/safeObject';
import { positionFromLineColumn, positionFromOffset, stripBom } from '@/lib/textPosition';

import { parseCsvRows, readRecords, readSepDirective, writeCsv, type Written } from './csv';
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
 * WHAT TO DO ABOUT A ROUNDED INTEGER, FITTED TO THE TARGET THAT WAS CHOSEN.
 *
 * This sentence used to be `Convert to CSV or TSV to keep the digits, where
 * every cell stays a string`, appended whatever the target was. SD-13 filed it
 * as JSON-specific advice showing up on a non-JSON target. It is worse than
 * that: it is **wrong on every target, including the two it names**. The
 * rounding happens in the READER - `JSON.parse` and the YAML composer both
 * produce a double - so by the time any writer runs the digits are already
 * gone, and `{"id": 12345678901234567890}` converted to CSV really does come
 * out as `12345678901234567000`. Measured, and pinned by a test.
 *
 * What DOES keep the digits is quoting the number in the source, which makes it
 * text before the parser can round it. That is true of every target; what
 * changes with the target is what the output then looks like, and that is the
 * half the target is threaded through the read for.
 *
 * `target` is optional because `parseSource` and `parseAuto` throw the notes
 * away and genuinely have no target to name. The sentence is complete and true
 * without one - it just cannot say what the output will look like.
 */
function keepTheDigits(source: string, target: Format | undefined): string {
  const quoted = `Quoting it in the source - \`"${source}"\` - keeps every digit, because a quoted scalar is read as text`;

  if (target === 'csv' || target === 'tsv') {
    return `${quoted}, and a ${target.toUpperCase()} cell has no type, so the output is the same either way.`;
  }
  if (target === undefined) return `${quoted}.`;
  return `${quoted}, and the ${target === 'json' ? 'JSON' : 'YAML'} output then holds it as a string.`;
}

/**
 * Rounded integers as notes: ONE note, with a count and every path.
 *
 * Not one note per number. A log export with four hundred snowflake ids in it
 * would otherwise produce four hundred notes, and a list nobody can read is a
 * list nobody reads. The count is the fact; the paths are how you find them.
 */
function roundedNumberNotes(
  rounded: readonly RoundedNumber[],
  target: Format | undefined,
): ToolNote[] {
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
      } At ${paths}${rest > 0 ? `, and ${rest.toString()} more` : ''}.${
        first === undefined ? '' : ` ${keepTheDigits(first.source, target)}`
      }`,
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

/**
 * A KEY WRITTEN TWICE, AND THE VALUE THAT LOST - CORPUS ROW 12.
 *
 * `{"retries": 3, "retries": 5}` is valid JSON. RFC 8259 permits it, says the
 * behaviour is undefined, and every reader anybody uses - `JSON.parse`
 * included - keeps the LAST one. So the 3 is gone before this tool has been
 * handed anything, and until round twelve nothing said so: the conversion was
 * correct about a document that was not the document in the box.
 *
 * WHY IT IS A LOSS AND NOT A REFUSAL, which is the opposite of what the YAML
 * reader does with the same shape. YAML 1.2 makes a duplicate key an ERROR, so
 * `uniqueKeys` refuses one and names both positions; RFC 8259 does not, and
 * refusing a document every other reader accepts would make this tool the odd
 * one out on a file that works everywhere else.
 *
 * ONE NOTE, capped at five named, for the reason `roundedNumberNotes` gives: a
 * generated document with the same stray key on four hundred records would
 * otherwise produce four hundred notes.
 */
function duplicateKeyNotes(duplicates: readonly DuplicateKey[]): ToolNote[] {
  if (duplicates.length === 0) return [];

  const shown = duplicates.slice(0, 5);
  const rest = duplicates.length - shown.length;
  const where = shown.map((entry) => `${entry.path} discarded \`${entry.discarded}\``).join(', ');

  return [
    lost(
      duplicates.length === 1
        ? '1 duplicate key was discarded'
        : `${duplicates.length.toString()} duplicate keys were discarded`,
      `JSON allows the same key twice in one object and leaves the behaviour undefined; every reader in use keeps the LAST one, so the earlier value is gone before this tool sees the document. ${where}${
        rest > 0 ? `, and ${rest.toString()} more` : ''
      }. Rename one of them to keep both.`,
      /*
       * BOTH DATA PORTS. `JSON.parse` resolved the duplicate, so the parsed
       * structure on `data` holds the surviving value and nothing else -
       * exactly like the written document. A read-half loss, not a write-half
       * one.
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
 * The value model, and its boundary
 * ========================================================================== */

/**
 * WHAT THIS TOOL CONVERTS THROUGH, AND WHY THE REFUSAL NAMES IT RATHER THAN
 * NAMING JSON.
 *
 * Every conversion here is READ INTO ONE VALUE MODEL and WRITTEN OUT OF IT.
 * That model is `JsonValue` - a compile-time type, and the payload of the
 * `json` data type every port in the app is typed against - so it is also what
 * the `data` port carries, what a wire carries and what the cache key is built
 * from. There is one route through this tool and YAML to YAML takes it too.
 *
 * The refusals used to say `which JSON cannot represent`. That is true of the
 * type and confusing on a run where the user chose neither JSON as the source
 * nor JSON as the target: it names a format that is not in the conversion and
 * invites the reading that a YAML to YAML path would be exempt. It would not
 * be. A YAML to YAML path that preserved `.nan` would need a second value
 * model or a wider `JsonValue`, and both reach the canvas, the cache key and
 * `checkConnection` for a case that only arises when the two formats are the
 * same. The decision is recorded in the tool README under
 * "The value model, and what it cannot hold"; what is fixed here is the
 * sentence, which named the wrong constraint.
 */
const VALUE_MODEL =
  'Every format here is read into one value model - text, finite numbers, true, false, null, lists and maps - and the target is written out of it, so YAML to YAML takes the same route as YAML to CSV. NaN, infinity, dates, binary, sets and ordered maps are outside it.';

/** Said after `VALUE_MODEL`, so the refusal reads as a boundary, not a bug. */
const KNOWN_LIMITATION =
  'This is a stated limitation of the tool rather than a fault in that document - see "The value model, and what it cannot hold" in the tool README.';

/** The ones a pair of quotes in the source carries through unchanged. */
const QUOTABLE = new Set(['NaN', 'Infinity', '-Infinity']);

/**
 * How many offenders a refusal names before it stops listing them.
 *
 * SD-12: six `.nan` values needed six runs, because the walk returned on the
 * first one. It collects now - but a 16 MB document of nothing but `.nan` must
 * not build a list of three million objects to describe itself, so the COUNT is
 * of everything and the LIST stops here.
 */
const MAX_NAMED_UNSUPPORTED = 10;

/** One value the model cannot hold. `what` reads straight after the path. */
interface UnsupportedValue {
  readonly path: string;
  readonly what: string;
}

/** The state one walk of a document accumulates. */
interface ModelWalk {
  /** Offenders in document order, capped at `MAX_NAMED_UNSUPPORTED`. */
  readonly named: UnsupportedValue[];
  /** Every offender, including the ones past the cap. */
  total: number;
  /** The first path past `MAX_DEPTH`, which stops the walk where it is. */
  tooDeepAt: string | null;
}

/** Records one value outside the model, and stands a null in its place. */
function outsideTheModel(walk: ModelWalk, path: string, what: string): JsonValue {
  walk.total += 1;
  if (walk.named.length < MAX_NAMED_UNSUPPORTED) walk.named.push({ path, what });
  return null;
}

/**
 * Walks a parsed document into the value model, COLLECTING every value that
 * does not fit rather than stopping at the first.
 *
 * The returned tree is only meaningful when nothing was collected; on a
 * refusal it is thrown away, and the nulls standing in for the offenders exist
 * so the walk can carry on past one.
 */
function intoValueModel(value: unknown, path: string, depth: number, walk: ModelWalk): JsonValue {
  if (value === null) return null;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      // NaN and the infinities are the only numbers outside the model.
      return Number.isFinite(value) ? value : outsideTheModel(walk, path, String(value));
    case 'undefined':
      return outsideTheModel(walk, path, 'undefined');
    case 'bigint':
      return outsideTheModel(walk, path, 'a BigInt');
    case 'function':
    case 'symbol':
      return outsideTheModel(walk, path, `a ${typeof value}`);
    default:
      break;
  }

  if (depth >= MAX_DEPTH) {
    walk.tooDeepAt ??= path;
    return null;
  }

  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      // Depth is the one finding that stops the walk: past it the recursion is
      // what is at risk, so there is nothing to be gained by seeing the rest.
      if (walk.tooDeepAt !== null) break;
      items.push(intoValueModel(value[index], `${path}[${index.toString()}]`, depth + 1, walk));
    }
    return items;
  }

  // Anything with an exotic prototype (Date, Uint8Array, Map, ...) is refused
  // rather than quietly stringified into something meaningless.
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return outsideTheModel(walk, path, describeExotic(value));
  }

  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (walk.tooDeepAt !== null) break;
    setOwnProperty(result, key, intoValueModel(item, `${path}${pathStep(key)}`, depth + 1, walk));
  }
  return result;
}

/** Builds the refusal from everything one walk found. */
function outsideTheModelFailure<T = never>(
  walk: ModelWalk,
  locate: ((path: string) => SourcePosition | null) | undefined,
): ToolResult<T> {
  const positions = walk.named.map((entry) => locate?.(entry.path) ?? null);
  const only = walk.named[0];

  /*
   * THE FIRST POSITION THERE IS, not the first entry's. Not every offender has
   * one: an expanded alias puts a second copy of a value in the tree at a path
   * no node in the document sits at, so `$.copy.n` is a real entry with nothing
   * to point at. Taking `positions[0]` would hand back a refusal with no caret
   * the moment the unlocatable one happened to come first - which today it
   * cannot, because an anchor is written before its alias, and which is not a
   * property worth depending on for the sake of one array index.
   */
  const first = positions.find((position) => position !== null) ?? undefined;

  const message =
    walk.total === 1 && only !== undefined
      ? `${only.path} is ${only.what}, which this tool's value model cannot hold.`
      : `${walk.total.toString()} values in that document are outside this tool's value model.`;

  const rest = walk.total - walk.named.length;
  const listed = walk.named
    .map((entry, index) => {
      const at = positions[index];
      const where = at === null || at === undefined ? '' : ` (line ${at.line.toString()})`;
      return `${entry.path} is ${entry.what}${where}`;
    })
    .join(', ');

  const parts = [
    walk.total === 1 ? '' : `${listed}${rest > 0 ? `, and ${rest.toString()} more` : ''}.`,
    VALUE_MODEL,
    KNOWN_LIMITATION,
    // Only when every one of them really is quotable, which needs the list to
    // be complete: advice that fits nine of eleven values is advice that sends
    // somebody back for a second run, which is the finding above this one.
    rest === 0 && walk.named.every((entry) => QUOTABLE.has(entry.what))
      ? 'Quote the value in the source and it comes through as text instead.'
      : '',
  ].filter((part) => part !== '');

  return fail('unsupported-type', message, { position: first, detail: parts.join(' ') });
}

/**
 * Confirms a parsed document fits the value model, naming everything that does
 * not - and, where the caller can say, WHERE each one is.
 *
 * YAML produces values the model cannot hold. `!!binary` yields a byte array,
 * `!!set` a Set, `!!omap` a Map, `.nan` and `.inf` yield numbers no format here
 * writes, and a document declaring `%YAML 1.1` gets the 1.1 schema's timestamps
 * as `Date`s. Rather than discovering that at serialisation time as a mangled
 * `{}`, the whole tree is checked up front.
 *
 * `locate` is optional because only the YAML reader has anything to answer it
 * with: the library hands over a range per node, and `JSON.parse` hands over a
 * value with no source at all.
 */
export function toJsonValue(
  value: unknown,
  path = '$',
  locate?: (path: string) => SourcePosition | null,
): ToolResult<JsonValue> {
  const walk: ModelWalk = { named: [], total: 0, tooDeepAt: null };
  const converted = intoValueModel(value, path, 0, walk);

  // Depth first: it is the finding that stopped the walk, so the list of
  // offenders behind it is whatever happened to be in front of the limit.
  if (walk.tooDeepAt !== null) return tooDeep(walk.tooDeepAt);
  return walk.total === 0 ? ok(converted) : outsideTheModelFailure(walk, locate);
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
  /*
   * A TYPED ARRAY IS NAMED BY WHAT IT IS, because its class name is not the
   * same in both engines this app ships to. The `yaml` package resolves
   * `!!binary` to a `Buffer` where one exists and to a `Uint8Array` where one
   * does not, so the refusal for one document read `$.blob is a Buffer` under
   * Node and `$.blob is a Uint8Array` in a browser - two sentences for one
   * fault, neither of them a word the person who wrote `!!binary` used.
   */
  if (ArrayBuffer.isView(value)) return 'binary data';

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
 *
 * THE OUTPUT IS NOT QUITE THAT ORDER, AND THE COMPARISON IS NOT WHY. SD-15
 * filed `"2"` before `"10"` as "natural sort" beside `Mango` before `apple` as
 * code-point order, and asked which collation this was. It is one collation
 * and one object model: `<` puts `"10"` before `"2"`, and then the object the
 * sorted entries are written into puts them back. Every JavaScript object
 * lists keys that are canonical array indices - `0` to 2^32 - 2, written
 * without a sign or a leading zero - FIRST, in numeric order, whatever order
 * they were inserted in (ECMA-262, OrdinaryOwnPropertyKeys). So `"01"` sorts
 * with the text and `"1"` does not. No sort written here can change it while
 * the value model is a plain object, and changing the order anybody has saved
 * would be worse than documenting it - which is what round thirteen did,
 * on screen in the option's own description and in the tool README.
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
  for (const delimiter of detectionCandidates(configuredDelimiter)) {
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
 * The delimiters detection tries, in order. One list, because
 * `untriedDelimiter` asks which of the offered delimiters are NOT on it, and
 * two copies could disagree about which one to suggest.
 */
function detectionCandidates(configuredDelimiter: string): ReadonlySet<string> {
  return new Set([DELIMITERS.tab, configuredDelimiter, DELIMITERS.comma, DELIMITERS.semicolon]);
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
  const tried = detectionCandidates(configuredDelimiter);

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
 * both of those become `"true"` - the same value-model boundary that refuses a `!!set`
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
 * this is the value-model boundary, and it is stated rather than papered over.
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

/**
 * SD-8: `!!float 1` IS THE NUMBER ONE, and it was read as the string "1".
 *
 * An explicit tag is resolved by the `yaml` package with the same tests it
 * uses to GUESS a plain scalar's type (yaml@2.9.0,
 * compose/compose-scalar.js, `findScalarTagByName`). Those tests split
 * numbers between `int` and `float` - the float test wants a dot, the
 * exponent test an exponent - so `1`, `-3`, `+12` and `01` satisfy none of
 * the three float tags, the library warns "Unresolved tag", and the value
 * comes back as TEXT. The warning is silenced here for a sound reason
 * (custom tags raise it too), so it was a silent type change.
 *
 * YAML 1.2.2 §10.3.2 gives the core schema's float as
 * `[-+]? ( \. [0-9]+ | [0-9]+ ( \. [0-9]* )? ) ( [eE] [-+]? [0-9]+ )?` - the
 * dot is optional, which is what makes an integer spelling a valid float when
 * the tag says so. That regular expression, verbatim, is this tag's test.
 *
 * It can never change what an UNTAGGED scalar means. Implicit resolution
 * tries the built-in tags first, in order, and every string this pattern
 * matches is already matched by the core `int`, `float` or exponent test
 * ahead of it - so it is only ever reached by name.
 */
const EXPLICIT_FLOAT: ScalarTag = {
  tag: 'tag:yaml.org,2002:float',
  default: true,
  test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/,
  resolve: (source) => Number.parseFloat(source),
};

/** What each standard scalar tag promises about the value it resolves to. */
const STANDARD_SCALAR_TYPES: Readonly<Record<string, (value: unknown) => boolean>> = {
  'tag:yaml.org,2002:int': (value) => typeof value === 'number' || typeof value === 'bigint',
  'tag:yaml.org,2002:float': (value) => typeof value === 'number',
  'tag:yaml.org,2002:bool': (value) => typeof value === 'boolean',
  'tag:yaml.org,2002:null': (value) => value === null,
};

interface MistypedScalar {
  readonly tag: string;
  readonly source: string;
  readonly offset: number;
}

/**
 * A scalar whose author said what type it is, and whose text is not that type.
 *
 * `!!float abc`, `!!int 1.5`, `!!bool yes` (1.2 has only `true` and `false`)
 * all resolved to a string with nothing said - the same silent type change as
 * SD-8, for values no grammar can rescue. Asked directly: js-yaml 5.4.2 refuses
 * all three; PyYAML 6.0.3 refuses the first two and reads `!!bool yes` as
 * True, because PyYAML reads YAML 1.1, where `yes` IS a boolean - and a
 * document that declares `%YAML 1.1` gets the same answer here.
 *
 * ASKED OF THE DOCUMENT, not of the warning: the warning carries its tag only
 * inside a sentence, and this repository has written down why a message's
 * wording is the wrong thing to match (known limitation 9 in the README). The
 * resolved node keeps its tag and its value, and a `float` holding a string is
 * the fact itself. Custom tags are left alone - they are SD-9's, dropped and
 * said - because only the standard ones make a promise this can check.
 */
function firstMistypedScalar(document: Document.Parsed): MistypedScalar | null {
  let found: MistypedScalar | null = null;
  visit(document, {
    Scalar(_key, node) {
      const promise = node.tag === undefined ? undefined : STANDARD_SCALAR_TYPES[node.tag];
      if (promise === undefined || promise(node.value)) return undefined;
      found = {
        tag: node.tag ?? '',
        source: String(node.source ?? node.value),
        offset: node.range?.[0] ?? 0,
      };
      return visit.BREAK;
    },
  });
  return found;
}

function mistypedScalarFailure<T = never>(text: string, mistyped: MistypedScalar): ToolResult<T> {
  const short = mistyped.tag.replace('tag:yaml.org,2002:', '!!');
  return fail(
    'parse-error',
    `${JSON.stringify(mistyped.source)} is tagged ${short} and is not one.`,
    {
      position: positionFromOffset(text, mistyped.offset),
      detail: `The tag says what type the value is, and this text cannot be read as that type, so reading it as something else would change the value without saying so. Correct the value, or remove the tag to let the value speak for itself.`,
    },
  );
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
 * The `same-json-key` half is this tool's value-model boundary, which is why it is
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
    : fail('unsupported-type', 'Two different YAML keys become one key in this tool.', {
        position,
        detail:
          'This is valid YAML - `true:` and `"true":` are two keys, and so are `1:` and `"1":`, ' +
          'and `~:` and `"":`. Keys in the value model every conversion here goes through are ' +
          'text, so both become one and one value would be lost with nothing to say so. ' +
          KNOWN_LIMITATION,
      });
}

/**
 * The first alias in a document whose anchor was never set before it.
 *
 * Asked of the DOCUMENT rather than of the error, which is the whole point.
 * `toJS` throws a bare `ReferenceError` for two completely different faults -
 * an alias with no anchor, and the alias-expansion limit - and neither carries
 * a code, so the only thing separating them in the error itself is the wording
 * of a message, which is one release away from silently reverting. The
 * document knows: `visit` walks in document order, so the anchors seen so far
 * at the moment an alias is met are exactly the ones the library would have
 * resolved it against ("the last instance of the source anchor BEFORE this
 * node").
 *
 * Returns the alias node so the caller can name it and point at it.
 */
function firstUnresolvedAlias(document: Document.Parsed): {
  readonly source: string;
  readonly offset: number;
} | null {
  const seen = new Set<string>();
  let found: { source: string; offset: number } | null = null;

  visit(document, (_key, node) => {
    if (node === null || typeof node !== 'object') return undefined;
    if (isAlias(node)) {
      if (!seen.has(node.source)) {
        found = { source: node.source, offset: node.range?.[0] ?? 0 };
        return visit.BREAK;
      }
      return undefined;
    }
    const anchor: unknown = (node as { anchor?: unknown }).anchor;
    if (typeof anchor === 'string' && anchor !== '') seen.add(anchor);
    return undefined;
  });

  return found;
}

function yamlThrownFailure<T = never>(
  error: unknown,
  document?: Document.Parsed,
  text?: string,
): ToolResult<T> {
  if (error instanceof RangeError) return tooDeep();

  /*
   * A ReferenceError out of `toJS` is one of TWO faults, and reporting both as
   * the second one was a confident wrong answer.
   *
   *   - `*base` with no `&base` anywhere before it. That is a broken document,
   *     and it is what `{<<: *base}` pasted out of the middle of somebody
   *     else's file looks like.
   *   - the alias-expansion limit, which is the billion-laughs guard.
   *
   * Both arrived as "That YAML expands to too much data to convert", so a
   * six-byte document with one missing anchor was described as a resource
   * problem, and the detail underneath it named a construct the message did
   * not mention. The document is asked which one happened; only if no alias is
   * unresolved is this really the limit.
   */
  if (error instanceof ReferenceError) {
    const unresolved = document === undefined ? null : firstUnresolvedAlias(document);
    if (unresolved !== null) {
      return fail('parse-error', `The alias *${unresolved.source} has no anchor before it.`, {
        ...(text === undefined ? {} : { position: positionFromOffset(text, unresolved.offset) }),
        detail: `An alias refers back to an anchor written earlier in the same document. Add \`&${unresolved.source}\` to the value this is meant to point at, or remove the alias.`,
      });
    }
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
      if (name !== null) parts.push(pathStep(name));
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

/**
 * Where each VALUE in a YAML stream sits in the source, by the path the value
 * model names it with.
 *
 * Theme three's fourth member. Every `unsupported-type` refusal carried a path
 * and no position: a `.nan` on line 400 of a 900-line document said what it was
 * called and left the reader to find it. The reader has always known - the
 * library hands over a range per node - and the boundary check simply was not
 * given it, because `toJS` returns a plain JavaScript value with no source on
 * it at all. This rebuilds the association from the document tree.
 *
 * ONLY BUILT ON A REFUSAL. A whole second walk of a 16 MB document is a real
 * cost, and the happy path has nothing to look up.
 *
 * KEY SCALARS ARE SKIPPED. `visit` reaches a Pair's key and its value, and
 * `yamlPath` gives both of them the same path - so without this the caret for
 * `a_nan: .nan` would land on `a_nan` rather than on the `.nan` that is the
 * problem, which is exactly the "at the construct start" complaint this is
 * here to answer.
 */
function yamlValuePositions(
  documents: readonly Document.Parsed[],
  text: string,
): ReadonlyMap<string, SourcePosition> {
  const found = new Map<string, SourcePosition>();

  documents.forEach((document, position) => {
    const prefix = documentPrefix(documents, position);

    const record = (key: unknown, node: unknown, ancestors: readonly unknown[]): undefined => {
      if (key === 'key') return undefined;
      const range: unknown = (node as { range?: unknown }).range;
      if (!Array.isArray(range) || typeof range[0] !== 'number') return undefined;
      const path = `${prefix}${yamlPath(ancestors, node)}`;
      // First wins: an expanded alias can put a second node at one path, and
      // the first is the one the reader scrolled past.
      if (!found.has(path)) found.set(path, positionFromOffset(text, range[0]));
      return undefined;
    };

    visit(document, {
      Map: (key, node, ancestors) => record(key, node, ancestors),
      Seq: (key, node, ancestors) => record(key, node, ancestors),
      Scalar: (key, node, ancestors) => record(key, node, ancestors),
    });
  });

  return found;
}

/** `$` for one document, `$[2]` for the third of a stream. */
function documentPrefix(documents: readonly unknown[], index: number): string {
  return documents.length > 1 ? `$[${index.toString()}]` : '$';
}

/**
 * Keys the source wrote as something other than text, which the model made
 * text - corpus row 10, and the half of SD-5 that survives the decision.
 *
 * YAML allows a number, a boolean, null or a 1.1 timestamp as a mapping key.
 * The value model this tool converts through has text keys, so `2024:` becomes
 * `"2024":` and the document that comes out is not the document that went in.
 *
 * THE DECISION WAS TAKEN NOT TO WIDEN THE MODEL - see `VALUE_MODEL` - so the
 * remaining honest thing is to SAY SO, which nothing did. This is a read-half
 * loss, so it reaches `data` as well as `output`: the parsed structure has the
 * text key too.
 *
 * A key that is a COLLECTION is refused rather than noted, above, because two
 * of those can collapse onto each other; a scalar key cannot collide silently,
 * since `collidesAsJsKey` already refuses `1:` beside `"1":`.
 */
function nonStringKeyNotes(documents: readonly Document.Parsed[]): ToolNote[] {
  const found: { readonly key: string; readonly at: string }[] = [];

  documents.forEach((document, position) => {
    const prefix = documentPrefix(documents, position);

    visit(document, {
      Pair: (_index, pair, ancestors) => {
        const key: unknown = pair.key;
        if (!isScalar(key) || typeof key.value === 'string') return undefined;
        /*
         * `source` is what the AUTHOR WROTE - `0x10` rather than `16` - which
         * is the spelling they will search their own document for. An empty
         * key (`: a`, which YAML reads as null) has no source to quote, and
         * printing it as an empty pair of backticks would name nothing.
         */
        const written: unknown = key.source;
        found.push({
          key:
            typeof written === 'string' && written !== ''
              ? `\`${written}\``
              : 'an empty key, which YAML reads as null,',
          at: `${prefix}${yamlPath(ancestors, pair)}`,
        });
        return undefined;
      },
    });
  });

  if (found.length === 0) return [];

  const one = found.length === 1;
  const shown = found.slice(0, 5);
  const rest = found.length - shown.length;
  const where = shown.map((entry) => `${entry.key} at ${entry.at}`).join(', ');

  return [
    lost(
      one ? '1 key became text' : `${found.length.toString()} keys became text`,
      `YAML allows a number, a boolean or null as a mapping key, and the value model every conversion here goes through has text keys only. So ${where}${
        rest > 0 ? `, and ${rest.toString()} more` : ''
      } ${one ? 'is' : 'are'} text from here on, and a YAML target writes ${
        one ? 'it' : 'them'
      } back quoted. ${KNOWN_LIMITATION}`,
      // Both, because the stringifying happened in the READ half: the parsed
      // structure on `data` carries the text key as well as the document does.
      ['output', 'data'],
    ),
  ];
}

/**
 * `tag:yaml.org,2002:str` as the person who typed it would recognise it.
 *
 * The library resolves a standard tag to its full URI, which is correct and is
 * not what is in the document. `!!str` is what was written and is what the
 * reader will search their own file for.
 */
const STANDARD_TAG = /^tag:yaml\.org,2002:(.+)$/u;

function tagAsWritten(tag: string): string {
  const standard = STANDARD_TAG.exec(tag);
  return standard === null ? tag : `!!${standard[1] ?? ''}`;
}

/** Up to `limit` of them named, and the rest counted. The bargain every note here strikes. */
function someOf(items: readonly string[], limit: number): string {
  const shown = items.slice(0, limit);
  const rest = items.length - shown.length;
  return `${shown.join(', ')}${rest > 0 ? `, and ${rest.toString()} more` : ''}`;
}

interface Presentation {
  /** Comment text, as written, without the `#`. */
  readonly comments: string[];
  /** Anchor names, as written, without the `&`. */
  readonly anchors: string[];
  /** How many aliases pointed at one of them. */
  aliases: number;
  /** Tags, spelled as the author spelled them. */
  readonly tags: string[];
  /** Paths of block scalars whose style cannot come back. */
  readonly styles: string[];
  /**
   * Whether any of those was a FOLDED one.
   *
   * The body explains folding, and folding is a fact about `>` - so on a
   * document whose only reported block is a literal `|-` that sentence would
   * be a true statement about something the reader did not write, which is the
   * smaller cousin of the note that cries wolf.
   */
  folded: boolean;
  /** Paths of non-empty flow collections, which a YAML target writes as blocks. */
  readonly flows: string[];
}

/**
 * WHETHER A BLOCK SCALAR'S STYLE SURVIVES, WHICH DEPENDS ON THE TARGET AND ON
 * WHICH BLOCK STYLE IT IS. Measured against the writer rather than predicted.
 *
 * A LITERAL block - `|`, `|-`, `|+` - keeps every line break IN THE VALUE, so
 * a YAML target writes it back as a literal block with the same chomping and
 * the document is unchanged. Measured: `lit: |` in, `lit: |` out; `|-` and
 * `|+` likewise. Reporting that as a loss would be a note about a document
 * that did not change, which is the one thing `lib/notes.ts` says a `warn` may
 * never be.
 *
 * A FOLDED block - `>` - is different in kind, and the difference is not the
 * writer's taste. FOLDING HAPPENS IN THE READER: `three\nfour` is already
 * `three four` by the time any writer sees it, so there is nothing left for a
 * writer to put back. `fold: >` comes out as `fold: |`, or as a plain scalar
 * when the chomping removed the last break.
 *
 * And on JSON, CSV or TSV neither survives, because none of the three has a
 * scalar style at all.
 *
 * THE TWO PLACES A LITERAL BLOCK DOES NOT SURVIVE EITHER, BOTH FOUND BY
 * SWEEPING THE yaml-test-suite RATHER THAN BY READING THIS FUNCTION. The first
 * version of it said "a literal survives a YAML target" flatly and was silent
 * about eight documents in 284 that a literal went into and did not come out
 * of:
 *
 *   - A VALUE WITH NO LINE BREAK LEFT IN IT. `--- |-\n ab\n` reads to `ab`,
 *     and a writer handed `ab` has nothing to tell it that a block was ever
 *     involved, so it writes a plain scalar. Same for the empty value an
 *     indent indicator with no content produces (`--- |1-`), and same for
 *     `|-\n \tbar`, where the tab rule in `writeYamlDocument` quotes what is
 *     left. The newline IS the thing that carries the style, which is why
 *     testing for it is the rule rather than a list of cases.
 *   - A BLOCK USED AS A KEY. `? |\n  block key\n` is a mapping key, and keys
 *     are written plain or quoted whatever their value looks like.
 *
 * With both, the sweep's misses go to zero and its false positives stay at
 * zero. See docs/test-findings.md for the numbers.
 */
function styleIsLost(node: unknown, asKey: boolean, target: Format | undefined): boolean {
  if (!isScalar(node)) return false;
  const style: unknown = node.type;
  if (style === 'BLOCK_FOLDED') return true;
  if (style !== 'BLOCK_LITERAL') return false;
  if (target !== 'yaml') return true;
  if (asKey) return true;

  const value: unknown = node.value;
  return typeof value !== 'string' || !value.includes('\n');
}

/**
 * FLOW STYLE, THE FIFTH KIND - taken in round thirteen, having been named and
 * left in round twelve.
 *
 * `a: {b: 1}` comes back from a YAML target as a block mapping, and nothing
 * said so. It was left out of this note on the ground that it would fire on a
 * large share of ordinary YAML for a difference few people would call a loss.
 * Measured, that ground is narrower than it looked: the note is ONE line on a
 * node whichever kinds it holds, so adding a kind adds a word to a census that
 * is already printing for any document with a comment in it, and it only
 * starts a note on a document that had no comment, anchor, tag or block
 * scalar to begin with. The numbers are in docs/test-findings.md.
 *
 * TWO THINGS ARE NOT COUNTED, both because the sweep said so. A document
 * whose ROOT is a flow collection is JSON-shaped - `{a: 1}` pasted and turned
 * into YAML is somebody asking for blocks, and three documents in the
 * detection corpus drew the note for exactly that. And a flow collection
 * inside another is part of the same run, so it is counted once.
 *
 * YAML TARGET ONLY. JSON's syntax IS YAML's flow syntax, so there is nothing
 * about a flow collection a JSON target fails to carry; CSV and TSV have no
 * collection syntax to speak of. An EMPTY collection is exempt because the
 * writer keeps it: `[]` and `{}` have no block spelling and come back as
 * themselves - measured, and held by the sweep.
 */
function flowIsLost(
  node: unknown,
  ancestors: readonly unknown[],
  document: Document.Parsed,
  target: Format | undefined,
): boolean {
  if (target !== 'yaml') return false;
  if (!(isMap(node) || isSeq(node)) || node.flow !== true || node.items.length === 0) return false;
  // A document written entirely in flow is JSON-shaped, and converting it to
  // YAML is asking for blocks. Found by the cry-wolf sweep: the detection
  // corpus's single-quoted JSON, unquoted-key JSON and JavaScript object
  // literal are all read through the YAML fallback, so without this they drew
  // the note while real JSON - which never reaches this reader - did not.
  if (isFlowCollection(document.contents)) return false;
  // One run of flow is one choice, however deeply it nests: `[{port: 80}]`
  // is one flow collection an author wrote, not two.
  return !ancestors.some((ancestor) => isFlowCollection(ancestor));
}

function isFlowCollection(node: unknown): boolean {
  return (isMap(node) || isSeq(node)) && node.flow === true;
}

/**
 * COMMENTS, ANCHORS, TAGS AND SCALAR STYLES - CORPUS ROWS 4 TO 9, AS ONE NOTE.
 *
 * Four rows of the loss table, and the matrix carried `YAML → JSON` as
 * `lossy, told` from round three to round eight for all four of them while no
 * builder for any such note existed anywhere in this tool. This is that note.
 *
 * ONE NOTE RATHER THAN FOUR, AND THAT IS THE ROUND'S ONE DESIGN DECISION.
 * A realistic Kubernetes manifest or CI config has a comment, an anchor, a tag
 * and a block scalar in it, so one note per kind is FOUR warnings on an
 * ordinary document - and a node's face shows one line, so three of the four
 * would be a `+3 more` nobody opens. The four have one cause (the value model
 * has no presentation layer) and one remedy (there is none), so they are one
 * fact with a census, which is the shape `roundedNumberNotes` and
 * `nonStringKeyNotes` already use for the same reason.
 *
 * The title is the census and NAMES EACH KIND PRESENT, which is what keeps the
 * corpus's negative controls working: a document with no anchor must produce
 * no note about anchors, and a title that said `YAML formatting was dropped`
 * for everything would match a control it should fail.
 *
 * AN ANCHOR IS EXPANDED, NOT DROPPED. Round eight corrected the write-up that
 * said otherwise and the correction is the body's job: an alias becomes a
 * second copy of the value, so the output is BIGGER than the source and the
 * reference is what went. Saying "dropped" would describe a smaller document
 * than the one the reader is holding.
 *
 * READ-HALF, SO BOTH DATA PORTS. `toJS` is where all of this is left behind,
 * and the parsed structure on `data` has no comments and no aliases in it
 * either - unlike the write-half losses in csv.ts, which `data` escapes.
 */
function yamlPresentationNotes(
  documents: readonly Document.Parsed[],
  /*
   * EVERY document the parser produced, including the empty ones `filled`
   * drops. The suite's M7A3 puts a comment between two `...` markers, on a
   * document with nothing in it - and a comment on a document nobody kept is
   * about as gone as a comment can be, so scanning only the kept documents
   * missed it. Nothing else is read from these: a dropped document has no
   * path, and everything else here names one.
   */
  all: readonly Document.Parsed[],
  target: Format | undefined,
): ToolNote[] {
  const found: Presentation = {
    comments: [],
    anchors: [],
    aliases: 0,
    tags: [],
    styles: [],
    folded: false,
    flows: [],
  };

  const comment = (value: unknown): void => {
    if (typeof value !== 'string') return;
    for (const line of value.split('\n')) {
      const tidy = line.trim();
      if (tidy !== '') found.comments.push(tidy);
    }
  };

  /*
   * COMMENTS OVER EVERY DOCUMENT, IN A PASS OF THEIR OWN.
   *
   * Separate from the walk below because the two want different documents. A
   * comment needs no path, so it can be collected from the documents the
   * reader DROPS as well as the ones it keeps - and the suite's M7A3 is
   * exactly that: `# No document` between two `...` markers, which the library
   * hangs on the contents of an empty document. Everything below names a path,
   * and a dropped document has none.
   */
  for (const document of all) {
    comment(document.commentBefore);
    comment(document.comment);
    visit(document, {
      Node: (_index, node) => {
        comment(node.commentBefore);
        comment(node.comment);
        return undefined;
      },
    });
  }

  documents.forEach((document, position) => {
    const prefix = documentPrefix(documents, position);

    visit(document, {
      Node: (index, node, ancestors) => {
        if (isAlias(node)) {
          found.aliases += 1;
          return undefined;
        }

        const anchor: unknown = node.anchor;
        if (typeof anchor === 'string' && anchor !== '') found.anchors.push(`&${anchor}`);

        const tag: unknown = node.tag;
        if (typeof tag === 'string' && tag !== '') found.tags.push(tagAsWritten(tag));

        if (styleIsLost(node, index === 'key', target)) {
          found.styles.push(`${prefix}${yamlPath(ancestors, node)}`);
          if (isScalar(node) && node.type === 'BLOCK_FOLDED') found.folded = true;
        }

        if (flowIsLost(node, ancestors, document, target)) {
          found.flows.push(`${prefix}${yamlPath(ancestors, node) || '$'}`);
        }

        return undefined;
      },
    });
  });

  const census: string[] = [];
  if (found.comments.length > 0) census.push(counted(found.comments.length, 'comment'));
  if (found.anchors.length > 0) census.push(counted(found.anchors.length, 'anchor'));
  if (found.tags.length > 0) census.push(counted(found.tags.length, 'tag'));
  if (found.styles.length > 0) census.push(counted(found.styles.length, 'block style'));
  if (found.flows.length > 0) census.push(counted(found.flows.length, 'flow collection'));
  if (census.length === 0) return [];

  const because: string[] = [];
  if (found.comments.length > 0) {
    because.push(
      `A comment is not part of any value, so no target has anywhere to put one: ${someOf(
        found.comments.map((entry) => `\`# ${entry}\``),
        3,
      )}.`,
    );
  }
  if (found.anchors.length > 0) {
    because.push(
      found.aliases > 0
        ? `${someOf(
            found.anchors.map((entry) => `\`${entry}\``),
            3,
          )} ${found.anchors.length === 1 ? 'is' : 'are'} EXPANDED rather than dropped: the ${counted(
            found.aliases,
            'alias',
          )} using ${found.anchors.length === 1 ? 'it' : 'them'} ${
            found.aliases === 1 ? 'becomes a' : 'become'
          } full ${found.aliases === 1 ? 'copy' : 'copies'} of the value, so the output is larger than the source and holds no reference at all.`
        : `${someOf(
            found.anchors.map((entry) => `\`${entry}\``),
            3,
          )} ${found.anchors.length === 1 ? 'has' : 'have'} no alias pointing at ${
            found.anchors.length === 1 ? 'it' : 'them'
          }, so only the name goes and the value is unchanged.`,
    );
  }
  if (found.tags.length > 0) {
    because.push(
      `The value model has no place for a tag, so ${someOf(
        [...new Set(found.tags)].map((entry) => `\`${entry}\``),
        3,
      )} ${found.tags.length === 1 ? 'is' : 'are'} gone and the value under ${
        found.tags.length === 1 ? 'it' : 'them'
      } is kept.`,
    );
  }
  if (found.styles.length > 0) {
    because.push(
      `A scalar's style is not part of its value, so ${someOf(found.styles, 3)} ${
        found.styles.length === 1 ? 'comes' : 'come'
      } back however the target spells a string.${
        found.folded
          ? ' A folded scalar is folded by the READER, so its line breaks are already spaces before anything is written.'
          : ''
      }`,
    );
  }

  if (found.flows.length > 0) {
    because.push(
      `A collection's flow style - \`{a: 1}\` or \`[1, 2]\` on one line - is not part of its value either, and this writer spells every non-empty collection as a block, so ${someOf(found.flows, 3)} ${
        found.flows.length === 1 ? 'is' : 'are'
      } now written one entry to a line.`,
    );
  }

  /*
   * THE CLAIM FIRST, THE CENSUS AFTER, BECAUSE THE NODE CLIPS AT 60.
   *
   * `2 comments, 1 anchor, 1 tag and 2 block styles were not carried over` is
   * 68 characters, so a node's face drew `...were not car…` - the census
   * survived and the verb, which is the only part that says anything happened,
   * did not. Leading with it clips the tail of an enumeration instead, which
   * is the half a reader can afford to lose and the half the panel repeats in
   * full.
   */
  return [
    lost(
      `Not carried over: ${census.join(', ')}`,
      `${because.join(' ')} ${KNOWN_LIMITATION}`,
      // Both, for the reason the doc comment gives.
      ['output', 'data'],
    ),
  ];
}

function readYamlSource(text: string, target: Format | undefined): ToolResult<Reading> {
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
    documents = parseAllDocuments(text, {
      logLevel: 'error',
      uniqueKeys,
      customTags: [EXPLICIT_FLOAT],
    });
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
    const mistyped = firstMistypedScalar(document);
    if (mistyped !== null) return mistypedScalarFailure(text, mistyped);
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

  /*
   * Built once, and only if something is refused. See `yamlValuePositions`.
   */
  let positions: ReadonlyMap<string, SourcePosition> | null = null;
  const locate = (path: string): SourcePosition | null => {
    positions ??= yamlValuePositions(filled, text);
    return positions.get(path) ?? null;
  };

  for (let index = 0; index < filled.length; index += 1) {
    const document = filled[index];
    if (document === undefined) continue;

    const collectionKey = firstCollectionKey(document);
    if (collectionKey !== null) {
      return fail(
        'unsupported-type',
        "A YAML key is itself a collection, which this tool's value model cannot hold.",
        {
          position: positionFromOffset(text, collectionKey.range[0]),
          detail: `Keys in that model are text, so two collection keys could collapse onto each other. ${KNOWN_LIMITATION}`,
        },
      );
    }

    let raw: unknown;
    try {
      raw = document.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
    } catch (error) {
      return yamlThrownFailure(error, document, text);
    }

    // A multi-document stream is reported as an array, so the path says which
    // document a bad value came out of.
    const converted = toJsonValue(raw, documentPrefix(filled, index), locate);
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
    notes.push(...roundedNumberNotes(roundedNumbersInYaml(filled), target));
  }

  notes.push(...nonStringKeyNotes(filled));

  /*
   * LAST OF THE THREE, AND THE ORDER IS THE POINT. A node's face prints the
   * FIRST `warn` note and counts the rest, so the order these are pushed in is
   * the order of what a person standing at a canvas sees. A rounded integer
   * and a stringified key change the VALUE; a dropped comment changes how it
   * is written. When a document has both, the value loss is the one worth the
   * one line there is.
   */
  notes.push(...yamlPresentationNotes(filled, documents, target));

  const single = values.length === 1 ? values[0] : undefined;
  return ok({
    data: single === undefined ? values : single,
    format: 'yaml',
    delimiter: null,
    documents: filled.length,
    notes,
  });
}

/**
 * Reads and hands back the value alone, for callers with nothing to report to.
 *
 * No target, and that is not an omission: the notes go nowhere from here, so
 * there is nothing for a target to fit.
 */
export function parseSource(
  source: string,
  format: Format,
  delimiter: string,
): ToolResult<JsonValue> {
  const read = readSource(source, format, delimiter);
  return read.ok ? ok(read.value.data) : read;
}

/**
 * Reads a document, in the format named.
 *
 * `target` is what will be WRITTEN, and it is here because one of the notes
 * the read half produces is advice - what to do about an integer that was
 * rounded - and advice that does not fit the target the user chose is the
 * defect SD-13 filed. See `keepTheDigits`. It is optional because
 * `parseSource` genuinely has no target; the note is complete without one.
 */
export function readSource(
  source: string,
  format: Format,
  delimiter: string,
  target?: Format,
): ToolResult<Reading> {
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
        /*
         * THE POSITION IS OURS; THE WORDING IS THE ENGINE'S. It used to be read
         * out of `message`, and measured over 2,165 refused documents Gecko's
         * message has one every time, V8's 72% of the time and
         * JavaScriptCore's never - so Safari never showed where. The engine
         * still decides WHETHER this is JSON; `locateJsonSyntaxError` says
         * where, the same in every engine. The message stays as the detail,
         * because it is the only description of the fault there is, and it is
         * worded differently in each engine by nature.
         */
        const offset = locateJsonSyntaxError(text);
        const position = offset === null ? null : positionFromOffset(text, offset);
        return fail('parse-error', 'That is not valid JSON.', {
          ...(position ? { position } : {}),
          detail: message,
        });
      }

      const converted = toJsonValue(raw);
      if (!converted.ok) return converted;

      /*
       * ONE WALK FOR BOTH QUESTIONS. The rounded-integer gate is passed in
       * rather than run inside `scanJsonSource`, because this caller wants the
       * duplicate keys whatever the digits look like and a second
       * `LONG_DIGIT_RUN.test` would be the same decision written twice.
       */
      const scan = scanJsonSource(text, { numbers: LONG_DIGIT_RUN.test(text) });

      return ok({
        data: converted.value,
        format: 'json',
        delimiter: null,
        documents: 1,
        notes: [...roundedNumberNotes(scan.rounded, target), ...duplicateKeyNotes(scan.duplicates)],
      });
    }

    case 'yaml':
      return readYamlSource(text, target);

    case 'csv':
    case 'tsv': {
      // Excel's own delimiter announcement, honoured for CSV. TSV is tab by
      // definition, so there it is stripped but not obeyed.
      const directive = readSepDirective(text);
      const active = format === 'tsv' ? DELIMITERS.tab : (directive.delimiter ?? delimiter);

      const rows = parseCsvRows(directive.body, active, directive.firstLine);
      if (!rows.ok) return rows;
      const records = readRecords(rows.value);
      if (!records.ok) return records;

      return ok({
        data: records.value.data,
        format,
        delimiter: active,
        documents: 1,
        /*
         * No rounded-number note here, and that is not an omission: every cell
         * comes out of the CSV reader as a STRING - `01234` is a part number,
         * not the number 1234 - so a nineteen-digit key in a spreadsheet export
         * keeps every digit. It is the one reading path in this tool with no
         * numeric ceiling at all.
         *
         * What it does carry is the HEADER's own loss - an unquoted header cell
         * has its spaces removed - which `readRecords` measures while it is
         * building the columns. Corpus row 11.
         */
        notes: records.value.notes,
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
function parseJsonLines(text: string, target: Format | undefined): ToolResult<Reading> | null {
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
            target,
          )
        : []),
      /*
       * PER LINE, AND THE PATH SAYS WHICH ONE. Each line of a JSON Lines file
       * is its own document, so a key repeated across two lines is not a
       * duplicate and a key repeated inside one line is. Leaving this out
       * would have been a hole with a shape - "the note fires unless your JSON
       * arrived one record per line" - rather than a limitation anybody chose.
       */
      ...duplicateKeyNotes(
        lines.flatMap((line, position) =>
          duplicateJsonKeys(line).map((entry) => ({
            ...entry,
            path: entry.path.replace(/^\$/u, `$[${position.toString()}]`),
          })),
        ),
      ),
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
/** The value-only wrapper. No target, for the reason `parseSource` has none. */
export function parseAuto(source: string, configuredDelimiter: string): ToolResult<JsonValue> {
  const read = readAuto(source, configuredDelimiter);
  return read.ok ? ok(read.value.data) : read;
}

/** Detects and reads. `target` is threaded for the reason `readSource` states. */
export function readAuto(
  source: string,
  configuredDelimiter: string,
  target?: Format,
): ToolResult<Reading> {
  const detected = detectSource(source, configuredDelimiter);
  const first = readSource(source, detected.format, detected.delimiter, target);

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
    /*
     * SD-1's real gap, decided in round thirteen as a DOCUMENTED LIMITATION
     * rather than a new signal. A one-column CSV - a list of ids, a list of
     * emails - has no delimiter in it, and "several lines, one field each" is
     * also exactly what prose, a log and a word list are: every multi-line
     * text in the world is a valid one-column CSV. A detector that said yes to
     * it would say yes to everything that reaches this line, and a table of
     * one column read from a paragraph is the confident wrong answer round one
     * spent a round removing. So auto-detect refuses it, and says how to get
     * the table - which is the only part of the gap that was ever fixable.
     */
    if (first.ok && foldsLines(stripBom(source))) {
      return fail('invalid-input', NOT_A_FORMAT, {
        detail:
          'Read as YAML it is one long string with the line breaks turned into spaces, which is almost certainly not what it is. If it is a table with a single column, choose CSV as the source format: a file with one column has no delimiter in it for detection to find.',
      });
    }
  }

  if (first.ok || detected.format !== 'json' || first.error.code !== 'parse-error') return first;

  const asLines = parseJsonLines(stripBom(source), target);
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
    const asJsonc = readSource(stripped.text, 'json', detected.delimiter, target);
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
  const asYaml = readSource(source, 'yaml', detected.delimiter, target);
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
