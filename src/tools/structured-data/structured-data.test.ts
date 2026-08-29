import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { JsonValue, ToolRunContext } from '@/features/registry/types';

import {
  DELIMITERS,
  detectFormat,
  parseSource,
  serialise,
  sortKeysDeep,
  toJsonValue,
} from './convert';
import { parseCsvRows, recordsToCsv, rowsToRecords } from './csv';
import structuredDataTool from './index';

const context: ToolRunContext = {
  signal: new AbortController().signal,
  reportProgress: () => undefined,
};

function parsed(source: string, format: Parameters<typeof parseSource>[1] = 'json'): JsonValue {
  const result = parseSource(source, format, ',');
  if (!result.ok) throw new Error(`expected success, got ${result.error.message}`);
  return result.value;
}

function rendered(data: JsonValue, format: Parameters<typeof serialise>[1], indent = 2): string {
  const result = serialise(data, format, { indent, delimiter: ',' });
  if (!result.ok) throw new Error(`expected success, got ${result.error.message}`);
  return result.value;
}

/* ========================================================================== *
 * Detection
 * ========================================================================== */

describe('format detection', () => {
  it('spots JSON by its opening bracket', () => {
    expect(detectFormat('{"a":1}')).toBe('json');
    expect(detectFormat('  [1, 2, 3]  ')).toBe('json');
  });

  it('spots a YAML document marker', () => {
    expect(detectFormat('---\na: 1\n')).toBe('yaml');
  });

  it('spots CSV by consistent field counts', () => {
    expect(detectFormat('name,age\nada,36\ngrace,45')).toBe('csv');
  });

  it('spots TSV before CSV', () => {
    expect(detectFormat('name\tage\nada\t36')).toBe('tsv');
  });

  it('falls back to YAML for key/value text', () => {
    expect(detectFormat('name: ada\nage: 36')).toBe('yaml');
  });

  it('is not fooled by a comma inside a quoted CSV field', () => {
    expect(detectFormat('name,note\nada,"one, two"\ngrace,"three, four"')).toBe('csv');
  });

  it('does not call a YAML list CSV just because it has commas', () => {
    expect(detectFormat('items: [a, b, c]\nother: 1')).toBe('yaml');
  });
});

/* ========================================================================== *
 * Parsing and errors
 * ========================================================================== */

describe('JSON parsing', () => {
  it('parses and reports a position for a syntax error', () => {
    const result = parseSource('{\n  "a": 1,\n  "b" 2\n}', 'json', ',');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('parse-error');
      expect(result.error.position).toBeDefined();
      expect(result.error.position?.line).toBeGreaterThan(1);
    }
  });

  it('strips a BOM rather than choking on it', () => {
    expect(parsed('﻿{"a":1}')).toEqual({ a: 1 });
  });

  it('rejects an empty document with a clear message', () => {
    const result = parseSource('   ', 'json', ',');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-input');
  });

  it('handles deep nesting', () => {
    let value: JsonValue = 'leaf';
    for (let depth = 0; depth < 200; depth += 1) value = { nested: value };
    const text = JSON.stringify(value);
    expect(parsed(text)).toEqual(value);
  });
});

describe('YAML parsing', () => {
  it('parses a mapping', () => {
    expect(parsed('name: ada\nage: 36\n', 'yaml')).toEqual({ name: 'ada', age: 36 });
  });

  it('reports line and column for a syntax error', () => {
    const result = parseSource('a: 1\nb: [1, 2\nc: 3\n', 'yaml', ',');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('parse-error');
      expect(result.error.position?.line).toBe(3);
      expect(result.error.position?.column).toBe(1);
    }
  });

  it('does not construct arbitrary types from tags', () => {
    // The tag is unresolved and the value stays an inert string. No function is
    // ever built, which is the whole reason this parser was chosen.
    expect(parsed('a: !!js/function "function(){return 1}"', 'yaml')).toEqual({
      a: 'function(){return 1}',
    });
  });

  it('does not pollute Object.prototype through a __proto__ key', () => {
    const value = parsed('__proto__:\n  polluted: true\n', 'yaml');
    expect(Object.hasOwn(value as object, '__proto__')).toBe(true);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('refuses a value JSON cannot represent, naming the path', () => {
    // !!binary yields a byte array, which has no JSON form.
    const result = parseSource('blob: !!binary "aGk="', 'yaml', ',');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unsupported-type');
      expect(result.error.message).toContain('$.blob');
    }
  });

  it('keeps timestamps as strings rather than Date objects', () => {
    expect(parsed('when: 2001-12-14t21:59:43.10-05:00', 'yaml')).toEqual({
      when: '2001-12-14t21:59:43.10-05:00',
    });
  });
});

/* ========================================================================== *
 * CSV
 * ========================================================================== */

describe('CSV parsing', () => {
  it('handles quotes, delimiters and newlines inside fields', () => {
    const source = 'name,note\nada,"contains, a comma"\ngrace,"says ""hi"""\nalan,"two\nlines"';
    expect(parsed(source, 'csv')).toEqual([
      { name: 'ada', note: 'contains, a comma' },
      { name: 'grace', note: 'says "hi"' },
      { name: 'alan', note: 'two\nlines' },
    ]);
  });

  it('treats CRLF and LF the same', () => {
    expect(parsed('a,b\r\n1,2\r\n', 'csv')).toEqual([{ a: '1', b: '2' }]);
    expect(parsed('a,b\n1,2\n', 'csv')).toEqual([{ a: '1', b: '2' }]);
    expect(parsed('a,b\r1,2', 'csv')).toEqual([{ a: '1', b: '2' }]);
  });

  it('does not invent a row for a trailing newline', () => {
    expect(parsed('a,b\n1,2\n', 'csv')).toHaveLength(1);
  });

  it('pads short rows and rejects long ones', () => {
    expect(parsed('a,b,c\n1,2', 'csv')).toEqual([{ a: '1', b: '2', c: '' }]);

    const result = parseSource('a,b\n1,2,3', 'csv', ',');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Row 2');
      expect(result.error.position?.line).toBe(2);
    }
  });

  it('reports an unterminated quoted field with its position', () => {
    const result = parseSource('a,b\n1,"never closed', 'csv', ',');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Unterminated');
      expect(result.error.position?.line).toBe(2);
    }
  });

  it('rejects duplicate column names', () => {
    const result = parseSource('a,a\n1,2', 'csv', ',');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('Duplicate column');
  });

  it('names empty header cells', () => {
    expect(parsed('a,,c\n1,2,3', 'csv')).toEqual([{ a: '1', column_2: '2', c: '3' }]);
  });

  it('parses an empty document to an empty list', () => {
    expect(parseCsvRows('', ',')).toEqual({ ok: true, value: [] });
    expect(rowsToRecords([])).toEqual({ ok: true, value: [] });
  });

  it('supports alternative delimiters', () => {
    const result = parseSource('a;b\n1;2', 'csv', DELIMITERS.semicolon);
    expect(result).toEqual({ ok: true, value: [{ a: '1', b: '2' }] });
  });
});

describe('CSV writing', () => {
  it('quotes only the fields that need it', () => {
    const csv = recordsToCsv(
      [{ plain: 'ok', comma: 'a,b', quote: 'say "hi"', newline: 'x\ny', spaced: ' pad ' }],
      ',',
    );
    expect(csv.ok).toBe(true);
    if (csv.ok) {
      // The newline inside a quoted field means this record legitimately spans
      // two lines of output, which is what RFC 4180 requires.
      expect(csv.value).toBe(
        'plain,comma,quote,newline,spaced\nok,"a,b","say ""hi""","x\ny"," pad "',
      );
    }
  });

  it('unions keys across rows, in first-seen order', () => {
    const csv = recordsToCsv([{ a: 1 }, { b: 2 }], ',');
    expect(csv.ok).toBe(true);
    if (csv.ok) expect(csv.value.split('\n')[0]).toBe('a,b');
  });

  it('refuses a shape that is not a table, and says why', () => {
    const notArray = recordsToCsv({ a: 1 }, ',');
    expect(notArray.ok).toBe(false);
    if (!notArray.ok) expect(notArray.error.code).toBe('unsupported-type');

    const notObjects = recordsToCsv([1, 2, 3], ',');
    expect(notObjects.ok).toBe(false);
    if (!notObjects.ok) expect(notObjects.error.message).toContain('must be an object');
  });

  it('writes an empty array as an empty document', () => {
    expect(recordsToCsv([], ',')).toEqual({ ok: true, value: '' });
  });
});

/* ========================================================================== *
 * Transformations
 * ========================================================================== */

describe('sortKeysDeep', () => {
  it('sorts nested object keys but leaves array order alone', () => {
    const sorted = sortKeysDeep({ b: 1, a: { d: 2, c: [3, 1, 2] } });
    expect(JSON.stringify(sorted)).toBe('{"a":{"c":[3,1,2],"d":2},"b":1}');
  });
});

describe('toJsonValue', () => {
  it('rejects values with no JSON form, naming the path', () => {
    // Asserted by narrowing rather than with expect.stringContaining, which
    // returns `any` and would defeat the no-unsafe-assignment rule.
    const dated = toJsonValue({ a: { b: new Date() } });
    expect(dated.ok).toBe(false);
    if (!dated.ok) expect(dated.error.message).toContain('$.a.b');
    expect(toJsonValue(Number.NaN).ok).toBe(false);
    expect(toJsonValue(Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(toJsonValue(10n).ok).toBe(false);
  });

  it('accepts ordinary JSON shapes', () => {
    expect(toJsonValue({ a: [1, 'two', true, null] })).toEqual({
      ok: true,
      value: { a: [1, 'two', true, null] },
    });
  });
});

/* ========================================================================== *
 * Property-based round trips
 *
 * See the note in base64.test.ts: these state a rule and let fast-check hunt
 * for a counterexample, rather than checking the handful of cases a person
 * happened to imagine.
 * ========================================================================== */

/**
 * JSON values, constrained to what all four formats can actually carry.
 *
 * Written as explicit bounded recursion rather than fc.letrec, because letrec's
 * `tie` is loosely typed and would leak `any` into the property bodies.
 */
function jsonArbitraryOfDepth(depth: number): fc.Arbitrary<JsonValue> {
  const leaf: fc.Arbitrary<JsonValue> = fc.oneof(
    fc.string({ unit: 'grapheme' }),
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.boolean(),
    fc.constant(null),
  );

  if (depth <= 0) return leaf;

  const inner = jsonArbitraryOfDepth(depth - 1);
  return fc.oneof(
    leaf,
    fc.array(inner, { maxLength: 5 }),
    fc.dictionary(fc.string({ unit: 'grapheme', minLength: 1 }), inner, { maxKeys: 5 }),
  );
}

const jsonArbitrary = jsonArbitraryOfDepth(4);

describe('round-trip properties', () => {
  it('fromYaml(toYaml(x)) deep-equals x, for any JSON value', () => {
    fc.assert(
      fc.property(jsonArbitrary, (value) => {
        const text = rendered(value, 'yaml');
        expect(parsed(text, 'yaml')).toEqual(value);
      }),
      { numRuns: 250 },
    );
  });

  it('fromJson(toJson(x)) deep-equals x, for any JSON value', () => {
    fc.assert(
      fc.property(jsonArbitrary, fc.integer({ min: 0, max: 8 }), (value, indent) => {
        expect(parsed(rendered(value, 'json', indent), 'json')).toEqual(value);
      }),
      { numRuns: 250 },
    );
  });

  it('CSV survives a round trip for tables of strings', () => {
    const rowArbitrary = fc.dictionary(
      fc
        .string({ unit: 'grapheme-ascii', minLength: 1 })
        .filter((key) => key.trim() === key && key.trim() !== ''),
      fc.string({ unit: 'grapheme' }),
      { minKeys: 1, maxKeys: 4 },
    );

    fc.assert(
      fc.property(
        fc
          .array(rowArbitrary, { minLength: 1, maxLength: 6 })
          // CSV cannot distinguish a final record of all-empty fields from a
          // terminating newline - "a\n" is one header row, not a header plus an
          // empty record. That ambiguity is in the format, not in the parser,
          // so the property excludes it and the README documents it.
          .filter((rows) => Object.values(rows[rows.length - 1] ?? {}).some((v) => v !== '')),
        (rows) => {
          const csv = recordsToCsv(rows, ',');
          expect(csv.ok).toBe(true);
          if (!csv.ok) return;

          const back = parseSource(csv.value, 'csv', ',');
          expect(back.ok).toBe(true);
          if (!back.ok) return;

          // Every row gains the union of all keys, with '' for absent ones, so
          // the comparison is against that normalised shape rather than the input.
          const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
          const expected = rows.map((row) =>
            Object.fromEntries(
              // Object.hasOwn for the same reason the writer needs it: a column
              // named "valueOf" would otherwise read Object.prototype.valueOf,
              // and `?? ''` does not catch it because a function is not nullish.
              columns.map((column) => [column, Object.hasOwn(row, column) ? row[column] : '']),
            ),
          );
          expect(back.value).toEqual(expected);
        },
      ),
      { numRuns: 150 },
    );
  });
});

/* ========================================================================== *
 * Tool surface
 * ========================================================================== */

describe('tool definition', () => {
  it('converts JSON to YAML with auto-detection', async () => {
    const result = await structuredDataTool.run({
      inputs: { input: { type: 'text', text: '{"name":"ada","tags":["x","y"]}' } },
      options: { target: 'yaml' },
      context,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const output = result.value.output;
      expect(output?.type).toBe('text');
      if (output?.type === 'text') {
        expect(output.text).toContain('name: ada');
        expect(output.text).toContain('- x');
      }
    }
  });

  it('emits the parsed structure on its second port', async () => {
    const result = await structuredDataTool.run({
      inputs: { input: { type: 'text', text: 'a: 1' } },
      options: { target: 'json' },
      context,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.data).toEqual({ type: 'json', data: { a: 1 } });
  });

  it('accepts a wired-in json value without re-parsing it', async () => {
    const result = await structuredDataTool.run({
      inputs: { input: { type: 'json', data: { b: 2, a: 1 } } },
      options: { target: 'json', sortKeys: true, indent: 0 },
      context,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const output = result.value.output;
      if (output?.type === 'text') expect(output.text).toBe('{"a":1,"b":2}');
    }
  });

  it('surfaces a parse error with its position instead of throwing', async () => {
    const result = await structuredDataTool.run({
      inputs: { input: { type: 'text', text: '{"a": }' } },
      options: { source: 'json' },
      context,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('parse-error');
      expect(result.error.detail).toBeDefined();
    }
  });

  it('converts CSV to JSON', async () => {
    const result = await structuredDataTool.run({
      inputs: { input: { type: 'text', text: 'a,b\n1,2' } },
      options: { target: 'json', indent: 0 },
      context,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const output = result.value.output;
      if (output?.type === 'text') expect(output.text).toBe('[{"a":"1","b":"2"}]');
    }
  });
});
