import { parse as parseYaml, stringify as stringifyYaml, YAMLParseError } from 'yaml';

import { fail, isJsonArray, ok, type JsonValue, type ToolResult } from '@/features/registry/types';
import { setOwnProperty } from '@/lib/safeObject';
import { positionFromLineColumn, positionFromOffset, stripBom } from '@/lib/textPosition';

import { parseCsvRows, recordsToCsv, rowsToRecords } from './csv';

export const FORMATS = ['json', 'yaml', 'csv', 'tsv'] as const;
export type Format = (typeof FORMATS)[number];

export const DELIMITERS = {
  comma: ',',
  semicolon: ';',
  tab: '\t',
  pipe: '|',
} as const;

export type DelimiterName = keyof typeof DELIMITERS;

/* ========================================================================== *
 * Guarding the JSON boundary
 * ========================================================================== */

/**
 * Confirms a parsed document really is JSON-representable.
 *
 * YAML can produce values JSON cannot hold. `!!binary` yields a byte array,
 * and a non-core schema could yield dates. Rather than discovering that at
 * serialisation time as a mangled `{}`, the whole tree is checked up front and
 * the offending path is named.
 */
export function toJsonValue(value: unknown, path = '$'): ToolResult<JsonValue> {
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

  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = toJsonValue(value[index], `${path}[${index.toString()}]`);
      if (!item.ok) return item;
      items.push(item.value);
    }
    return ok(items);
  }

  // Anything with an exotic prototype (Date, Uint8Array, Map, ...) is refused
  // rather than quietly stringified into something meaningless.
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    const name = value.constructor.name;
    return fail('unsupported-type', `${path} is a ${name}, which JSON cannot represent.`, {
      detail: 'Only strings, numbers, booleans, null, arrays and plain objects convert.',
    });
  }

  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const converted = toJsonValue(item, `${path}.${key}`);
    if (!converted.ok) return converted;
    setOwnProperty(result, key, converted.value);
  }
  return ok(result);
}

/** Recursively sorts object keys. Arrays keep their order - that is data. */
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
 * Detection
 * ========================================================================== */

/**
 * Guesses the source format.
 *
 * Order matters. YAML 1.2 is a superset of JSON, and a CSV line is a perfectly
 * valid YAML string, so the most specific test has to run first and the most
 * permissive one last: JSON, then delimited, then YAML as the fallback.
 */
export function detectFormat(source: string): Format {
  const text = stripBom(source).trim();
  if (text === '') return 'json';

  if (text.startsWith('{') || text.startsWith('[')) return 'json';

  // A YAML document marker or an explicit tag settles it immediately.
  if (text.startsWith('---') || text.startsWith('%YAML')) return 'yaml';

  const lines = text.split(/\r\n|\r|\n/).filter((line) => line.trim() !== '');
  if (lines.length > 0) {
    for (const [name, delimiter] of [
      ['tsv', DELIMITERS.tab],
      ['csv', DELIMITERS.comma],
    ] as const) {
      const counts = lines.slice(0, 20).map((line) => countOutsideQuotes(line, delimiter));
      const first = counts[0] ?? 0;
      // Every sampled line agreeing on a field count above one is a strong
      // signal; a YAML or JSON document almost never does that.
      if (first > 0 && counts.every((count) => count === first)) return name;
    }
  }

  return 'yaml';
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && char === delimiter) count += 1;
  }

  return count;
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
      try {
        // JSON.parse for strictness. The YAML parser would happily accept
        // things that are not JSON, which would make "source: JSON" a lie.
        return toJsonValue(JSON.parse(text));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid JSON.';
        const position = jsonErrorPosition(text, message);
        return fail('parse-error', 'That is not valid JSON.', {
          ...(position ? { position } : {}),
          detail: message,
        });
      }
    }

    case 'yaml': {
      try {
        // logLevel 'error', NOT 'silent'. Silent suppresses genuine parse
        // errors too, which would hand back a half-parsed document instead of
        // reporting the fault. 'error' quiets the unresolved-tag warnings and
        // still throws on real syntax errors.
        const parsed: unknown = parseYaml(text, { logLevel: 'error' });
        if (parsed === undefined) {
          return fail('invalid-input', 'Nothing to parse: the input is empty.');
        }
        return toJsonValue(parsed);
      } catch (error) {
        if (error instanceof YAMLParseError) {
          const start = error.linePos?.[0];
          return fail('parse-error', 'That is not valid YAML.', {
            ...(start ? { position: positionFromLineColumn(start.line, start.col) } : {}),
            detail: error.message.split('\n')[0] ?? error.message,
          });
        }
        return fail('parse-error', 'That is not valid YAML.', {
          detail: error instanceof Error ? error.message : undefined,
        });
      }
    }

    case 'csv':
    case 'tsv': {
      const rows = parseCsvRows(text, format === 'tsv' ? DELIMITERS.tab : delimiter);
      if (!rows.ok) return rows;
      return rowsToRecords(rows.value);
    }
  }
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
      return ok(JSON.stringify(data, null, options.indent));

    case 'yaml':
      try {
        return ok(stringifyYaml(data, { indent: Math.max(1, options.indent), lineWidth: 0 }));
      } catch (error) {
        return fail('internal', 'Could not write that value as YAML.', {
          detail: error instanceof Error ? error.message : undefined,
        });
      }

    case 'csv':
      return recordsToCsv(data, options.delimiter);

    case 'tsv':
      return recordsToCsv(data, DELIMITERS.tab);
  }
}
