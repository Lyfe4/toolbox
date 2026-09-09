import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { JsonValue, ToolRunContext } from '@/features/registry/types';

import {
  DELIMITERS,
  detectSource,
  MAX_DEPTH,
  parseAuto,
  parseSource,
  serialise,
  sortKeysDeep,
  toJsonValue,
} from './convert';
import { parseCsvRows, readSepDirective, recordsToCsv, rowsToRecords } from './csv';
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

/** The detected format alone, for the many cases where the delimiter is moot. */
function detect(source: string, delimiter = ','): string {
  return detectSource(source, delimiter).format;
}

/* ========================================================================== *
 * Detection
 * ========================================================================== */

describe('format detection', () => {
  it('spots JSON by its opening bracket', () => {
    expect(detect('{"a":1}')).toBe('json');
    expect(detect('  [1, 2, 3]  ')).toBe('json');
  });

  it('spots a YAML document marker', () => {
    expect(detect('---\na: 1\n')).toBe('yaml');
  });

  it('spots CSV by consistent field counts', () => {
    expect(detect('name,age\nada,36\ngrace,45')).toBe('csv');
  });

  it('spots TSV before CSV', () => {
    expect(detect('name\tage\nada\t36')).toBe('tsv');
  });

  it('falls back to YAML for key/value text', () => {
    expect(detect('name: ada\nage: 36')).toBe('yaml');
  });

  it('is not fooled by a comma inside a quoted CSV field', () => {
    expect(detect('name,note\nada,"one, two"\ngrace,"three, four"')).toBe('csv');
  });

  it('does not call a YAML list CSV just because it has commas', () => {
    expect(detect('items: [a, b, c]\nother: 1')).toBe('yaml');
  });

  it('needs two records before it will call something a table', () => {
    // `Hello, world` used to satisfy "every line agrees on its field count",
    // because there was only one line to agree. It was detected as CSV, and a
    // one-line CSV is a header with no rows - so a non-empty document produced
    // `[]`, with no error and nothing to suggest anything had gone wrong.
    expect(detect('Hello, world')).toBe('yaml');
    expect(detect('a,b,c')).toBe('yaml');

    const result = parseAuto('Hello, world', ',');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('Hello, world');
  });

  it('finds the delimiter a European spreadsheet actually used', () => {
    // Excel writes semicolons wherever the comma is a decimal separator. The
    // detector only ever tried tab and comma, so this fell through to YAML and
    // came back as the single string "a;b;c 1;2;3" - a confident wrong answer
    // for one of the most common files anybody would paste in here.
    const detected = detectSource('name;age\nada;36\ngrace;45', DELIMITERS.comma);
    expect(detected).toEqual({ format: 'csv', delimiter: ';' });

    expect(parseAuto('name;age\nada;36', DELIMITERS.comma)).toEqual({
      ok: true,
      value: [{ name: 'ada', age: '36' }],
    });
  });

  it('survives a newline inside a quoted cell', () => {
    // Detection counted delimiters line by line, so a cell containing a line
    // break - an address, a note, anything a spreadsheet exported - made the
    // counts disagree and the file was read as YAML instead. Quoting is now
    // tracked across the whole document, the way the parser tracks it.
    const source = 'name,note\nada,"first\nsecond"\ngrace,"third\nfourth"';
    expect(detect(source)).toBe('csv');
    expect(parseAuto(source, ',')).toEqual({
      ok: true,
      value: [
        { name: 'ada', note: 'first\nsecond' },
        { name: 'grace', note: 'third\nfourth' },
      ],
    });
  });

  it('reads a YAML block sequence as YAML even when its items contain commas', () => {
    // `- a, b` has exactly one comma on every line, which was enough to be read
    // as a two-column table whose header was `- a`.
    expect(detect('- a, b\n- c, d')).toBe('yaml');
    expect(parseAuto('- a, b\n- c, d', ',')).toEqual({ ok: true, value: ['a, b', 'c, d'] });
  });

  it('honours Excel’s sep= announcement', () => {
    // Without this the directive line becomes the header, and the table comes
    // back with a column literally named `sep=`.
    const detected = detectSource('sep=;\nname;age\nada;36', DELIMITERS.comma);
    expect(detected).toEqual({ format: 'csv', delimiter: ';' });
    expect(parseAuto('sep=;\nname;age\nada;36', DELIMITERS.comma)).toEqual({
      ok: true,
      value: [{ name: 'ada', age: '36' }],
    });
  });

  it('tries pipe only when pipe is the configured delimiter', () => {
    // A Markdown table has perfectly consistent pipe counts. Trying pipes on
    // every input would read one as a five-column table with a `---` row in it.
    const table = '| a | b |\n| - | - |\n| 1 | 2 |';
    expect(detect(table, DELIMITERS.comma)).toBe('yaml');
    expect(detect('a|b\n1|2', DELIMITERS.pipe)).toBe('csv');
  });

  it('agrees with the parser about where a quote opens a field', () => {
    // The detector treated any `"` outside quotes as opening a quoted field;
    // the parser only does so at the START of one. On `a"b,c` they disagreed
    // about where the fields were, so the detector could hand the parser a
    // delimiter the parser would then read differently.
    const source = 'a"b,c\nd"e,f';
    expect(detect(source)).toBe('csv');
    expect(parseAuto(source, ',')).toEqual({ ok: true, value: [{ 'a"b': 'd"e', c: 'f' }] });
  });

  it('ignores a sep= line that declares the quote character', () => {
    // Not a delimiter any writer produces, and unparseable as one: the quote
    // rule consumes it before the delimiter rule ever sees it.
    expect(readSepDirective('sep="\na,b\n')).toEqual({
      delimiter: null,
      body: 'sep="\na,b\n',
      firstLine: 1,
    });
  });

  it('decides from the start of a large document rather than reading all of it', () => {
    // Detection ran `split` over the whole input to look at twenty lines of it,
    // which cost 119 ms on a 4 MB paste before any work had begun.
    const rows = ['id,name'];
    for (let index = 0; index < 200_000; index += 1) rows.push(`${index.toString()},name`);
    const source = rows.join('\n');

    const started = performance.now();
    expect(detect(source)).toBe('csv');
    expect(performance.now() - started).toBeLessThan(250);
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

  it('refuses a document deeper than the limit, saying that is why', () => {
    // Past roughly 2,000 levels one of JSON.parse, the tree walk, sortKeysDeep
    // or JSON.stringify overflows the stack. Which one depended on the options,
    // and the message was whatever happened to be on the stack at the time -
    // "That is not valid JSON" for a document that is valid JSON, or a
    // RangeError thrown clean out of `run`, which the contract forbids.
    const justOver = '['.repeat(MAX_DEPTH + 1) + ']'.repeat(MAX_DEPTH + 1);
    const result = parseSource(justOver, 'json', ',');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('limit-exceeded');
      expect(result.error.message).toContain('nested more than');
    }
  });

  it('gives the same answer when the parser itself runs out of stack', () => {
    // 10,000 levels never reaches our own check: V8's JSON.parse recurses and
    // throws first. The reported reason has to be the same either way.
    const wayOver = '['.repeat(10_000) + ']'.repeat(10_000);
    const result = parseSource(wayOver, 'json', ',');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('limit-exceeded');
  });

  it('falls back to YAML for a document that opens like JSON but is not', () => {
    // Detection commits to JSON on a leading brace, so YAML flow style and a
    // trailing comma - both extremely common in things people paste - were
    // refused outright by a detector that had already made up its mind.
    expect(parseAuto('{a: 1, b: 2}', ',')).toEqual({ ok: true, value: { a: 1, b: 2 } });
    expect(parseAuto('{"a": 1,}', ',')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('reads a JavaScript object literal, which is what people actually paste', () => {
    // The reason the fallback is worth its cost: single quotes, unquoted keys
    // and trailing commas are how an object looks when it was copied out of
    // source code, and YAML reads all three correctly.
    expect(parseAuto("{ foo: 'bar', baz: [1, 2,] }", ',')).toEqual({
      ok: true,
      value: { foo: 'bar', baz: [1, 2] },
    });
  });

  it('reports the JSON error when neither parser can make sense of it', () => {
    // Truncated input is the common way JSON arrives broken, and it is broken
    // YAML too - so the fallback does not soften the message.
    const result = parseAuto('{"a": 1, "b": ', ',');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('That is not valid JSON.');
  });

  it('reads JSON Lines as an array of documents', () => {
    // A log export or a streaming API response. It opens with `{`, so detection
    // commits to JSON, and the second line was reported as "unexpected
    // non-whitespace character after JSON" - true, and no use to anybody.
    // A stream becoming an array is the same call the YAML reader makes for
    // `---`-separated documents.
    expect(parseAuto('{"ts":1}\n{"ts":2}\n{"ts":3}\n', ',')).toEqual({
      ok: true,
      value: [{ ts: 1 }, { ts: 2 }, { ts: 3 }],
    });

    // Not JSON Lines: one broken line is enough to fall back to the real error.
    const broken = parseAuto('{"ts":1}\n{"ts":\n', ',');
    expect(broken.ok).toBe(false);

    // And "Source: JSON" means one document, so it stays an error there.
    expect(parseSource('{"ts":1}\n{"ts":2}\n', 'json', ',').ok).toBe(false);
  });

  it('accepts YAML’s reading of malformed JSON under auto-detection', () => {
    /*
     * DECIDED, not accidental. `{"a": }` is broken JSON and legal YAML - a
     * mapping whose value is empty, which YAML says is null. Under Auto-detect
     * the user has not claimed the document is JSON, so the honest answer is
     * the one format that can read it, and `{ a: null }` is a true statement
     * about the text.
     *
     * The cost is that a JSON typo of this exact shape parses instead of being
     * reported. Setting Source to JSON is how you say there is no ambiguity to
     * resolve, and then it is an error again - which the tool-surface tests
     * assert directly.
     */
    expect(parseAuto('{"a": }', ',')).toEqual({ ok: true, value: { a: null } });
    expect(parseSource('{"a": }', 'json', ',').ok).toBe(false);
  });

  it('loses precision on integers beyond 2^53, and this is what that looks like', () => {
    /*
     * NOT a bug in this tool, and not fixable inside it: `JsonValue` numbers are
     * IEEE-754 doubles, so a Discord snowflake or a Postgres bigint cannot
     * survive being parsed. Pinned rather than left implicit, because it is the
     * one silent corruption here that nobody would notice - the output is a
     * plausible number of the right length. The tool README says so too.
     */
    const result = parseSource('{"id": 1234567890123456789}', 'json', ',');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ id: 1234567890123456800 });
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

  it('refuses !!set and !!omap by name rather than mangling them', () => {
    for (const source of ['!!set\n? a\n? b', '!!omap\n- a: 1\n- b: 2']) {
      const result = parseSource(source, 'yaml', ',');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('unsupported-type');
    }
  });

  it('keeps timestamps as strings rather than Date objects', () => {
    expect(parsed('when: 2001-12-14t21:59:43.10-05:00', 'yaml')).toEqual({
      when: '2001-12-14t21:59:43.10-05:00',
    });
  });

  it('reads a multi-document stream as an array', () => {
    // Every Kubernetes manifest is a stream. `parse` refused one with "please
    // use YAML.parseAllDocuments()" - an error that names an API the person
    // reading it cannot reach, about a file that is not wrong.
    expect(parsed('---\nkind: A\n---\nkind: B\n', 'yaml')).toEqual([{ kind: 'A' }, { kind: 'B' }]);
  });

  it('does not invent a document for a trailing separator', () => {
    // `a: 1\n---\n` is one document and a stray marker, not a document plus a
    // null one, and a single-document stream stays an object rather than
    // becoming a one-element array.
    expect(parsed('a: 1\n---\n', 'yaml')).toEqual({ a: 1 });
  });

  it('says there is nothing to parse for a document of only comments', () => {
    const result = parseSource('# nothing here\n# still nothing\n', 'yaml', ',');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-input');
  });

  it('refuses keys that would collide once they became object keys', () => {
    /*
     * `true:` and `"true":` are two different keys to YAML and one key to
     * JavaScript, because both stringify to "true". The library's uniqueness
     * check compares scalar values, so it saw two keys, and the object it built
     * had one - the first value vanished with nothing said. `1:` against `"1":`
     * and `~:` against `"":` collapse the same way.
     */
    for (const source of ['true: a\n"true": b', '1: a\n"1": b', '~: a\n"": b']) {
      const result = parseSource(source, 'yaml', ',');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('parse-error');
        expect(result.error.detail).toContain('unique');
        expect(result.error.position?.line).toBe(2);
      }
    }

    // And keys that merely look similar are still fine.
    expect(parsed('a: 1\nb: 2', 'yaml')).toEqual({ a: 1, b: 2 });
  });

  it('refuses a key that is itself a collection', () => {
    // `? [a, b] : v` is legal YAML. The library stringifies the key to
    // "[ a, b ]" to make it a JS key, so two different collection keys can
    // flatten onto each other and one value silently wins.
    const result = parseSource('? [a, b]\n: v\n? [a, c]\n: w', 'yaml', ',');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unsupported-type');
      expect(result.error.message).toContain('collection');
    }
  });

  it('refuses a billion-laughs document instead of expanding it', () => {
    const bomb = [
      'a: &a ["x","x","x","x","x","x","x","x","x"]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
      'e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]',
      'f: [*e,*e,*e,*e,*e,*e,*e,*e,*e]',
    ].join('\n');

    const result = parseSource(bomb, 'yaml', ',');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('limit-exceeded');
  });

  it('reports a stack overflow in the composer as depth, not as bad syntax', () => {
    /*
     * A document too deep for the composer comes back as an ordinary parse
     * error whose message is V8's, pointed at an arbitrary column of a document
     * that is not malformed. It is recognised by the library's own
     * `RESOURCE_EXHAUSTION` code rather than by that message, so the mapping is
     * against a declared contract rather than a string one release from
     * changing - and this asserts the code still arrives.
     */
    const result = parseSource('['.repeat(5_000) + ']'.repeat(5_000), 'yaml', ',');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('limit-exceeded');
      expect(result.error.message).toContain('nested more than');
    }
  });

  it('keeps the 1.2 core schema’s reading of ambiguous scalars', () => {
    // The Norway problem: under YAML 1.1 `no` is false, and a country list
    // loses Norway. Under 1.2 core - what this tool uses - it stays a string.
    expect(parsed('a: no\nb: yes\nc: on\nd: off\ne: true\nf: False', 'yaml')).toEqual({
      a: 'no',
      b: 'yes',
      c: 'on',
      d: 'off',
      e: true,
      f: false,
    });
    // And `017` is seventeen, not fifteen: 1.2 dropped bare-zero octals.
    expect(parsed('a: 017\nb: 0o17\nc: 0x1f', 'yaml')).toEqual({ a: 17, b: 15, c: 31 });
  });

  it('gives a document that declares %YAML 1.1 the 1.1 reading', () => {
    // Version-correct rather than uniform: a file that says which spec it is
    // written against gets that spec, including `y` as a boolean key.
    expect(parsed('%YAML 1.1\n---\na: yes\nb: 017', 'yaml')).toEqual({ a: true, b: 15 });
  });

  it('refuses a 1.1 timestamp by name instead of emitting a Date', () => {
    // The 1.1 schema resolves timestamps to Date objects, which JSON cannot
    // hold. The JSON boundary check catches it and names the path.
    const result = parseSource('%YAML 1.1\n---\nwhen: 2001-12-14', 'yaml', ',');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('$.when');
  });

  it('leaves a merge key alone under the core schema', () => {
    // `<<` is a 1.1 extension. Under 1.2 core it is an ordinary key, which is
    // what the spec says and what this documents; a file wanting the merge can
    // ask for it with a `%YAML 1.1` directive.
    expect(parsed('base: &b {x: 1}\nchild:\n  <<: *b\n  y: 2', 'yaml')).toEqual({
      base: { x: 1 },
      child: { '<<': { x: 1 }, y: 2 },
    });
    expect(parsed('%YAML 1.1\n---\nbase: &b {x: 1}\nchild:\n  <<: *b\n  z: 2', 'yaml')).toEqual({
      base: { x: 1 },
      child: { x: 1, z: 2 },
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

  it('keeps a record whose only field is a quoted empty string', () => {
    /*
     * The parser flushed a pending record only when it had a non-empty field or
     * a completed one, and an empty QUOTED field is neither - so `name\n""`
     * parsed to one row instead of two and a real record disappeared. Nothing
     * reported it, because from the outside it looked like a file with no rows.
     */
    expect(parseCsvRows('name\n""', ',')).toEqual({
      ok: true,
      value: [
        { fields: ['name'], quoted: [false], line: 1 },
        { fields: [''], quoted: [true], line: 2 },
      ],
    });
    expect(parsed('name\n""', 'csv')).toEqual([{ name: '' }]);
  });

  it('treats a blank line as a separator rather than a record', () => {
    // A blank line in the middle produced a record of empty strings, which is
    // the same phantom row the trailing-newline rule exists to prevent. The two
    // now agree, and quoting is what distinguishes a blank line from `""`.
    expect(parsed('a,b\n1,2\n\n3,4\n', 'csv')).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
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

  it('points a ragged-row error at the line the row is really on', () => {
    // The row index was used as the line number. A quoted field spanning three
    // lines put every later record's reported position several lines too high,
    // so the error sent the reader to a line that looked perfectly fine.
    const result = parseSource('a,b\n"x\ny\nz",1\n2,3,4', 'csv', ',');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Row 3');
      expect(result.error.position?.line).toBe(5);
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

  it('trims an unquoted header cell but not a quoted one', () => {
    /*
     * Header cells were trimmed unconditionally, which silently edited a name
     * whose author had quoted it precisely so it would keep its spaces - and
     * then reported `a` and `" a "` as duplicate columns, which they are not.
     * Quoting is the only signal available, so quoting is what decides.
     */
    expect(parsed(' a , b \n1,2', 'csv')).toEqual([{ a: '1', b: '2' }]);
    expect(parsed('" a ","b"\n1,2', 'csv')).toEqual([{ ' a ': '1', b: '2' }]);

    const bothNames = parseSource('a," a "\n1,2', 'csv', ',');
    expect(bothNames).toEqual({ ok: true, value: [{ a: '1', ' a ': '2' }] });
  });

  it('names an empty header cell, unless it was quoted empty on purpose', () => {
    expect(parsed('a,,c\n1,2,3', 'csv')).toEqual([{ a: '1', column_2: '2', c: '3' }]);
    expect(parsed('a,"",c\n1,2,3', 'csv')).toEqual([{ a: '1', '': '2', c: '3' }]);
  });

  it('parses an empty document to an empty list', () => {
    expect(parseCsvRows('', ',')).toEqual({ ok: true, value: [] });
    expect(rowsToRecords([])).toEqual({ ok: true, value: [] });
  });

  it('supports alternative delimiters', () => {
    const result = parseSource('a;b\n1;2', 'csv', DELIMITERS.semicolon);
    expect(result).toEqual({ ok: true, value: [{ a: '1', b: '2' }] });
  });

  it('consumes a sep= line without letting it shift the reported lines', () => {
    expect(readSepDirective('sep=;\na;b\n')).toEqual({
      delimiter: ';',
      body: 'a;b\n',
      firstLine: 2,
    });

    const result = parseSource('sep=;\na;b\n1;2;3', 'csv', DELIMITERS.comma);
    expect(result.ok).toBe(false);
    // The bad row is the third line of the file, not the second line of what
    // was left after the directive was stripped.
    if (!result.ok) expect(result.error.position?.line).toBe(3);
  });

  it('never guesses a type for a cell', () => {
    /*
     * The coercion policy, asserted rather than described: CSV is untyped text,
     * and every rule for turning some of it into numbers destroys something.
     * A leading-zero identifier, a long numeric id, a phone number and a value
     * a spreadsheet would have read as a date all stay exactly as written.
     */
    expect(
      parsed('zip,id,phone,when,flag\n01234,1234567890123456789,+1-555,2024-01-01,TRUE', 'csv'),
    ).toEqual([
      {
        zip: '01234',
        id: '1234567890123456789',
        phone: '+1-555',
        when: '2024-01-01',
        flag: 'TRUE',
      },
    ]);
  });

  it('reads a spreadsheet export with a BOM, CRLF and non-English text', () => {
    const source = '﻿name,note\r\nアダ,"あい\r\nう"\r\nzoë,café\r\n';
    expect(parsed(source, 'csv')).toEqual([
      { name: 'アダ', note: 'あい\r\nう' },
      { name: 'zoë', note: 'café' },
    ]);
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
    if (!notArray.ok) {
      expect(notArray.error.code).toBe('unsupported-type');
      // "Found a object" is what this said, in the error for the single most
      // likely mistake anybody makes with this tool.
      expect(notArray.error.detail).toContain('Found an object');
    }

    const notObjects = recordsToCsv([1, 2, 3], ',');
    expect(notObjects.ok).toBe(false);
    if (!notObjects.ok) expect(notObjects.error.message).toContain('must be an object');
  });

  it('writes an empty array as an empty document', () => {
    expect(recordsToCsv([], ',')).toEqual({ ok: true, value: '' });
  });

  it('refuses rows that have no fields at all', () => {
    // `[{}]` wrote a document of empty lines, which read back as no rows; `[{},
    // {}]` read back as one row of one invented column. Two different wrong
    // answers to a question whose real answer is that there is no table here.
    const result = recordsToCsv([{}, {}], ',');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('no fields');
  });

  it('quotes a line that would otherwise be blank', () => {
    /*
     * A one-column table with an empty row wrote an empty line, and an empty
     * line is a blank line, so the row vanished on the way back. This was
     * written down as a limitation of CSV, and it is not one: `""` is a record
     * holding one empty field and a bare line break is not.
     */
    const csv = recordsToCsv([{ a: 'x' }, { a: '' }], ',');
    expect(csv.ok).toBe(true);
    if (!csv.ok) return;
    expect(csv.value).toBe('a\nx\n""');
    expect(parsed(csv.value, 'csv')).toEqual([{ a: 'x' }, { a: '' }]);
  });

  it('writes a cell that looks like a spreadsheet formula exactly as given', () => {
    /*
     * DELIBERATE. `=cmd|...` in a cell is a real attack on whoever opens the
     * file in Excel, and the usual mitigation - prefixing an apostrophe - is
     * itself silent corruption: it would rewrite legitimate data like `-1,2` or
     * a formula somebody meant to keep. A converter's job is fidelity, so the
     * risk is documented in the tool README and the data is left alone.
     */
    const csv = recordsToCsv([{ a: '=1+1', b: '@SUM(1)', c: '+x', d: '-x' }], ',');
    expect(csv).toEqual({ ok: true, value: 'a,b,c,d\n=1+1,@SUM(1),+x,-x' });
  });

  it('writes LF and no trailing newline, whatever the target', () => {
    // Stated so it cannot drift: the output goes into a text box and a
    // clipboard, and RFC 4180's CRLF would put a stray carriage return in
    // every line of it. A file that needs CRLF gets it from the editor it
    // lands in, not from here.
    const csv = recordsToCsv([{ a: '1' }, { a: '2' }], ',');
    expect(csv).toEqual({ ok: true, value: 'a\n1\n2' });
  });

  it('clamps a zero indent to one for YAML, where indentation is the structure', () => {
    expect(rendered({ a: { b: 1 } }, 'yaml', 0)).toBe('a:\n b: 1\n');
    expect(rendered({ a: { b: 1 } }, 'json', 0)).toBe('{"a":{"b":1}}');
  });

  it('writes null and an empty string identically, which is lossy on the way back', () => {
    // Pinned because it is a real one-way door: CSV has no null.
    const csv = recordsToCsv([{ a: null, b: '' }], ',');
    expect(csv).toEqual({ ok: true, value: 'a,b\n,' });
    expect(parsed('a,b\n,', 'csv')).toEqual([{ a: '', b: '' }]);
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

  it('orders by UTF-16 code unit, which is not code-point order', () => {
    // Documented rather than fixed: `<` on strings compares code units, so an
    // astral character sorts below U+FFFF because its lead surrogate does. It
    // is deterministic, which is the property that actually matters here.
    const sorted = sortKeysDeep({ '�': 1, '\u{1F600}': 2, z: 3 });
    expect(Object.keys(sorted as object)).toEqual(['z', '\u{1F600}', '�']);
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

  it('names an object whose prototype chain has no constructor', () => {
    // `value.constructor.name` threw a TypeError here, turning "we cannot
    // represent this" into an unexplained crash.
    const exotic: unknown = Object.create(Object.create(null) as object);
    const result = toJsonValue({ a: exotic });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('$.a');
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

/**
 * Strings drawn from the whole of Unicode, control characters included.
 *
 * `grapheme` never produces a lone C0 control or a bare surrogate, and those
 * are exactly where a serialiser is most likely to drop something: the sweep
 * this replaced walked every code point below U+2100 through both formats.
 */
const hostileString = fc.string({ unit: 'binary' });

/**
 * The alphabet a delimited-text detector has to survive: separators, quotes,
 * line breaks and a little ordinary content, in any arrangement at all.
 */
const DELIMITED_UNIT = fc.constantFrom('a', 'b', ',', ';', '\t', '\n', '\r', '"', ' ');

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

  it('YAML and JSON both survive control characters and astral text', () => {
    fc.assert(
      fc.property(hostileString, hostileString, (key, value) => {
        // An empty key is legal and round-trips; skipping nothing keeps the
        // property honest about what it covers.
        const original = { [key]: value };
        expect(parsed(rendered(original, 'yaml'), 'yaml')).toEqual(original);
        expect(parsed(rendered(original, 'json'), 'json')).toEqual(original);
      }),
      { numRuns: 400 },
    );
  });

  it('CSV survives a round trip for tables of strings', () => {
    const rowArbitrary = fc.dictionary(
      fc
        .string({ unit: 'grapheme-ascii', minLength: 1 })
        .filter((key) => key.trim() === key && key.trim() !== ''),
      hostileString,
      { minKeys: 1, maxKeys: 4 },
    );

    fc.assert(
      fc.property(fc.array(rowArbitrary, { minLength: 1, maxLength: 6 }), (rows) => {
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
      }),
      { numRuns: 200 },
    );
  });

  it('survives a round trip through every delimiter, not just the comma', () => {
    // The comma is the only delimiter the older suite exercised in a property,
    // and it is the only one that cannot appear in a number, a date or a name.
    const rowArbitrary = fc.dictionary(
      fc
        .string({ unit: 'grapheme-ascii', minLength: 1 })
        .filter((key) => key.trim() === key && key.trim() !== ''),
      hostileString,
      { minKeys: 1, maxKeys: 3 },
    );

    fc.assert(
      fc.property(
        fc.array(rowArbitrary, { minLength: 1, maxLength: 4 }),
        fc.constantFrom(...Object.values(DELIMITERS)),
        (rows, delimiter) => {
          const csv = recordsToCsv(rows, delimiter);
          expect(csv.ok).toBe(true);
          if (!csv.ok) return;

          const back = parseSource(csv.value, 'csv', delimiter);
          expect(back.ok).toBe(true);
          if (!back.ok) return;

          const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
          expect(back.value).toEqual(
            rows.map((row) =>
              Object.fromEntries(
                columns.map((column) => [column, Object.hasOwn(row, column) ? row[column] : '']),
              ),
            ),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('sorting keys is idempotent and changes nothing but the order', () => {
    fc.assert(
      fc.property(jsonArbitrary, (value) => {
        const once = sortKeysDeep(value);
        expect(sortKeysDeep(once)).toEqual(once);
        // Sorting must not add, drop or alter a value, only reorder keys.
        expect(once).toEqual(value);
      }),
      { numRuns: 250 },
    );
  });

  it('a document detected as delimited always parses to at least one record', () => {
    /*
     * The invariant the `Hello, world` bug broke. Claiming a table and then
     * producing `[]` is the worst possible pair of answers: the tool sounds
     * certain and the result is empty, so there is nothing to notice.
     */
    fc.assert(
      fc.property(fc.string({ unit: DELIMITED_UNIT }), (source) => {
        const detected = detectSource(source, ',');
        if (detected.format !== 'csv' && detected.format !== 'tsv') return;

        const result = parseSource(source, detected.format, detected.delimiter);
        if (!result.ok) return;
        expect(Array.isArray(result.value) && result.value.length > 0).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('never throws, whatever the input and whichever conversion', () => {
    /*
     * The execution contract in one property: bad input is a result, not an
     * exception. Every earlier depth and prototype bug in this file surfaced as
     * a throw out of `run`, which the worker converts into "The tool failed
     * unexpectedly" - a message that tells the user nothing at all.
     */
    const formats = ['json', 'yaml', 'csv', 'tsv'] as const;

    fc.assert(
      fc.property(
        fc.string({ unit: 'binary' }),
        fc.constantFrom(...formats),
        fc.constantFrom(...Object.values(DELIMITERS)),
        (source, target, delimiter) => {
          const value = parseAuto(source, delimiter);
          if (!value.ok) return;
          expect(() => serialise(value.value, target, { indent: 2, delimiter })).not.toThrow();
        },
      ),
      { numRuns: 400 },
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

  it('refuses a too-deep value on the json port instead of throwing', async () => {
    /*
     * The `json` port is the one route in that never meets the parser, so it
     * used to meet no guard either. A value a few thousand levels deep threw
     * RangeError out of `run` - from JSON.stringify with sortKeys off, and from
     * sortKeysDeep with it on - which is precisely what the execution contract
     * says a tool may never do.
     */
    let deep: JsonValue = 'leaf';
    for (let index = 0; index < 6_000; index += 1) deep = [deep];

    for (const sortKeys of [false, true]) {
      const result = await structuredDataTool.run({
        inputs: { input: { type: 'json', data: deep } },
        options: { target: 'json', sortKeys },
        context,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('limit-exceeded');
    }
  });

  it('does not turn a repeated object into a YAML anchor', async () => {
    // Only reachable through the json port, because no parser here produces
    // shared references. Left as aliases, one value would render two different
    // ways depending on how the tool upstream happened to build it.
    const shared = { x: 1 };
    const result = await structuredDataTool.run({
      inputs: { input: { type: 'json', data: [shared, shared] } },
      options: { target: 'yaml' },
      context,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const output = result.value.output;
      if (output?.type === 'text') {
        expect(output.text).not.toContain('*');
        expect(output.text).toBe('- x: 1\n- x: 1\n');
      }
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

  it('does not fall back to YAML when JSON was chosen explicitly', () => {
    // The fallback is a property of auto-detection resolving an ambiguity it
    // created. "Source: JSON" is the user saying there is no ambiguity.
    expect(parseSource('{a: 1}', 'json', ',').ok).toBe(false);
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

  it('reads a UTF-16 export, because its first two bytes say so', async () => {
    /*
     * Excel's "Unicode Text (*.txt)" is UTF-16LE tab-separated, and it is one
     * of the two ways a spreadsheet leaves a Windows machine. A strict UTF-8
     * decoder refused it with a message about UTF-8 - a bad answer to a file
     * that states its own encoding in its first two bytes. Only a byte order
     * mark unlocks this; nothing is ever guessed.
     */
    const document = 'name\tage\r\nada\t36\r\n';
    const bytes = new Uint8Array((document.length + 1) * 2);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 0xfeff, true);
    for (let index = 0; index < document.length; index += 1) {
      view.setUint16((index + 1) * 2, document.charCodeAt(index), true);
    }

    const result = await structuredDataTool.run({
      inputs: { input: { type: 'bytes', bytes, mediaType: null, filename: null } },
      options: { target: 'json', indent: 0 },
      context,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const output = result.value.output;
      if (output?.type === 'text') expect(output.text).toBe('[{"name":"ada","age":"36"}]');
    }
  });

  it('rejects bytes that are not UTF-8 rather than parsing mojibake', async () => {
    // A dropped PNG should say it is not text, not fail later with a syntax
    // error about a character nobody typed.
    const result = await structuredDataTool.run({
      inputs: {
        input: {
          type: 'bytes',
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]),
          mediaType: null,
          filename: null,
        },
      },
      options: { target: 'json' },
      context,
    });

    expect(result.ok).toBe(false);
  });
});
