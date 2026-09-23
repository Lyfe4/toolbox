import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { JsonValue, ToolRunContext } from '@/features/registry/types';
import { bytesValue } from '@/features/registry/types';
import type { ToolNote } from '@/lib/notes';

import {
  DELIMITERS,
  detectSource,
  MAX_DEPTH,
  parseAuto,
  parseSource,
  readAuto,
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

/** Note titles, which is what a person sees and what a node prints. */
function titles(notes: readonly ToolNote[]): string[] {
  return notes.map((note) => note.title);
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

  it('does not call a YAML block sequence CSV either', () => {
    /*
     * ROUND ONE'S FIX, WHICH HAD NO TEST UNTIL ROUND FOUR. `- a, b` over
     * `- c, d` has one comma on every line and two consistent fields, so the
     * detector said CSV and the tool returned a two-column table whose header
     * was `- a`. Disabling the guard changed nothing any test noticed - and
     * decision 1's "does it also parse as a YAML MAPPING" rule does not rescue
     * it, because a block sequence is not a mapping.
     */
    expect(detect('- a, b\n- c, d\n')).toBe('yaml');
    expect(detect('-\n- x, y\n')).toBe('yaml');
    // The trailing space is what makes it a sequence: `-1,2` is a table row.
    expect(detect('-1,2\n-3,4\n')).toBe('csv');
  });

  it('spots a table whose very first character is a quote', () => {
    /*
     * The detector mirrors the parser's rule that a quote only opens a quoted
     * field at the START of one, and that rule is carried by a flag whose
     * INITIAL value nothing was testing. Set it the other way and the opening
     * quote of the first field is a literal: the commas inside it are counted
     * as separators, the first record disagrees with every other, and an
     * ordinary spreadsheet export - any file whose first column heading
     * contains a comma - falls through to YAML and comes back as one string.
     */
    expect(detect('"name, full",age\n"ada l",36\n')).toBe('csv');

    const parsed = parseAuto('"name, full",age\n"ada l",36\n', ',');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual([{ 'name, full': 'ada l', age: '36' }]);
    }
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
    expect(detected).toEqual({ format: 'csv', delimiter: ';', fellBack: false });

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
    expect(detected).toEqual({ format: 'csv', delimiter: ';', fellBack: false });
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

  /*
   * FOUND BY PASTING A PIPE-SEPARATED FILE PYTHON'S `csv` MODULE WROTE, AND
   * READING THE ANSWER INSTEAD OF ASSERTING ON IT.
   *
   * `name|age\nada|36\ngrace|45` came back as the STRING
   * "name|age ada|36 grace|45", successfully, with no error. That is valid
   * YAML - a multi-line plain scalar, folded to one line - and it is word for
   * word the failure the semicolon test above describes: "a confident wrong
   * answer for one of the most common files anybody would paste in here",
   * still alive for the one delimiter detection will not try on its own.
   *
   * Detection still will not TRY pipe unasked - see the test above, a Markdown
   * table has consistent pipe counts, so trying it would read prose as a
   * table. What changed is that falling back to YAML and finding NO STRUCTURE
   * is now reported rather than returned.
   */
  it('refuses a pipe table rather than folding it into one string', () => {
    const result = parseAuto('name|age\nada|36\ngrace|45', DELIMITERS.comma);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe('This looks like pipe-separated text, not YAML.');
    expect(result.error.detail).toContain('delimiter');
  });

  it('says the same thing when the YAML fallback fails outright', () => {
    // A colon in a cell, which is what the real file found this had - the YAML
    // parser reads the folded scalar as an implicit key and gives up. Both
    // branches have to reach the same message, or the advice depends on
    // whether the user's data happened to contain a colon.
    const source = 'id|text\n1|note: a thing\n2|other: thing';
    expect(parseSource(source, 'yaml', DELIMITERS.comma).ok).toBe(false);

    const result = parseAuto(source, DELIMITERS.comma);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('pipe-separated');
  });

  it('reads the pipe table happily once the option says pipe', () => {
    // The suggestion has to be actionable, so the thing it suggests must work.
    expect(parseAuto('name|age\nada|36\ngrace|45', DELIMITERS.pipe)).toEqual({
      ok: true,
      value: [
        { name: 'ada', age: '36' },
        { name: 'grace', age: '45' },
      ],
    });
  });

  it('still blames YAML when the document really is broken YAML', () => {
    // A document that fell back to YAML and is not a table in any delimiter
    // must keep its YAML error rather than gain a misleading suggestion.
    const result = parseAuto('a: 1\n b: [2\n', DELIMITERS.comma);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('YAML');
  });

  /*
   * THIS USED TO RETURN `'Hello there. This is prose. No structure.'`.
   *
   * Three lines of prose are a valid YAML document - a plain scalar folds
   * across line breaks - so the fallback produced a string with the line
   * breaks replaced by spaces and reported success. Nothing was wrong with the
   * input and nothing was wrong with YAML; what was wrong is that a document
   * which is not JSON, YAML, CSV or TSV came back as a JSON string that had
   * quietly lost its line structure.
   *
   * The old test asserted that folding, and its reasoning was about the half
   * of the behaviour that was right: no delimiter is suggested, because prose
   * has no consistent field count to suggest one from. Saying nothing about
   * the delimiter and still handing back the folded string was the other half.
   */
  it('refuses prose rather than folding it into one line', () => {
    const result = parseAuto('Hello there.\nThis is prose.\nNo structure.', DELIMITERS.comma);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('not JSON, YAML, CSV or TSV');
      // Not a delimiter suggestion: there is no table here to suggest one for.
      expect(result.error.detail).toContain('line breaks turned into spaces');
    }
  });

  it('still reads a one-line document that really is a YAML scalar', () => {
    // `hello` is a scalar too, and it is a YAML document meaning "hello".
    // Folding is what separates that from prose, not being a scalar.
    expect(parseAuto('hello', DELIMITERS.comma)).toEqual({ ok: true, value: 'hello' });
  });

  it('reads a deliberate block scalar, which is not a fold', () => {
    // `|` is the author writing several lines on purpose. The library tags it
    // BLOCK_LITERAL, and a block scalar is the one scalar the guard lets
    // through - every other kind turns its line breaks into spaces.
    expect(parseAuto('|\n  line one\n  line two\n', DELIMITERS.comma)).toEqual({
      ok: true,
      value: 'line one\nline two\n',
    });
  });

  /*
   * THE YAML FALLBACK FOR A DOCUMENT THAT OPENS WITH A BRACKET.
   *
   * It is there so that an object literal copied out of source - unquoted
   * keys, single quotes, a trailing comma - reads as the thing the user meant,
   * and those three still do. What it must not do is accept a DIFFERENT
   * document: a plain scalar in YAML runs across line breaks, so two very
   * ordinary things wrong with pasted JSON produced a plausible object instead
   * of the JSON parser's error.
   *
   * Every expected value below is what `JSON.parse` says about the document
   * once the thing wrong with it is removed, which is the only definition of
   * "what the user meant" available here.
   */
  describe('near-JSON that opens with a bracket', () => {
    it.each([
      ["{'a': 1}", 'single quotes'],
      ['{a: 1, b: 2}', 'unquoted keys'],
      ['{\n  "a": 1,\n  "b": 2,\n}', 'a trailing comma'],
      ['[1, 2, 3,]', 'a trailing comma in an array'],
    ])('still reads %s (%s)', (source) => {
      const result = parseAuto(source, DELIMITERS.comma);
      expect(result.ok).toBe(true);
    });

    /*
     * `{\n  // a comment\n  "a": 1\n}` came back as
     * `{ '// a comment "a"': 1 }` - the comment and the key after it folded
     * into ONE key, reported as a success. Round two made it the JSON
     * parser's own error; round three reads the document the author meant,
     * as JSONC, and says what it removed.
     *
     * THE ASSERTION THAT MATTERS IS THE ONE IT ALWAYS WAS: nothing is folded
     * into a key. `stripJsonc` is string-aware and removes a comment AS a
     * comment or not at all, so by the time the YAML fallback is asked
     * anything there is no comment left for it to fold.
     */
    it('reads a // comment as JSONC rather than folding it into the key after it', () => {
      const result = readAuto('{\n  // a comment\n  "a": 1\n}', DELIMITERS.comma);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.data).toEqual({ a: 1 });
      expect(titles(result.value.notes)).toContain('Read as JSONC');
    });

    it('reads a /* */ comment as JSONC for the same reason', () => {
      const result = readAuto('{\n  /* c */\n  "a": 1\n}', DELIMITERS.comma);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.data).toEqual({ a: 1 });
      expect(titles(result.value.notes)).toContain('Read as JSONC');
    });

    /*
     * THE NEGATIVE CONTROL. A document with no comment and no trailing comma
     * must not be described as JSONC: a note that fires on ordinary JSON is a
     * note nobody reads on the day it means something.
     */
    it('says nothing about JSONC for JSON that has neither', () => {
      const result = readAuto('{"a": 1}', DELIMITERS.comma);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.notes).toEqual([]);
    });

    /*
     * A literal newline inside a string is invalid JSON and is what
     * hand-editing produces. YAML folded it: the value came back with the
     * newline replaced by a SPACE, which is a changed document reported as a
     * successful conversion.
     */
    it('refuses a literal newline inside a string rather than making it a space', () => {
      const result = parseAuto('{"a":"line one\nline two"}', DELIMITERS.comma);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toBe('That is not valid JSON.');
    });

    it('refuses a key folded across two lines', () => {
      const result = parseAuto('{\n  foo\n  bar: 1\n}', DELIMITERS.comma);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toBe('That is not valid JSON.');
    });
  });

  /*
   * A CSV whose rows do not agree on their field count is not detected as a
   * table - which is right - and then fell through to YAML, which folded it:
   * `a,b,c\n1,2` came back as the string `"a,b,c 1,2"`. A file with a ragged
   * row is a real file with a real problem, and a sentence is not a report of
   * it.
   */
  it('refuses a ragged CSV rather than folding it into a sentence', () => {
    const result = parseAuto('a,b,c\n1,2\n', DELIMITERS.comma);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('not JSON, YAML, CSV or TSV');
  });

  it('does not second-guess YAML that found real structure', () => {
    expect(parseAuto('name: ada\nage: 36', DELIMITERS.comma)).toEqual({
      ok: true,
      value: { name: 'ada', age: 36 },
    });
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
    /*
     * Detection ran `split` over the whole input to look at twenty lines of it,
     * which cost 119 ms on a 4 MB paste before any work had begun.
     *
     * THE TAIL CANNOT CHANGE THE VERDICT, which is the deterministic half of
     * the claim and the one worth asserting first: sixty consistent CSV lines
     * followed by two hundred kilobytes of prose is still a CSV, because the
     * decision is taken from a bounded prefix. A reader that took the whole
     * document into account would call this something else.
     */
    const rows = (count: number): string[] => {
      const out = ['id,name'];
      for (let index = 0; index < count; index += 1) out.push(`${index.toString()},name`);
      return out;
    };

    expect(detect([...rows(60), 'x'.repeat(200_000)].join('\n'))).toBe('csv');

    // And it still decides, rather than giving up, on a document of the size
    // the defect was measured against.
    const large = rows(200_000).join('\n');
    expect(large.length).toBeGreaterThan(2_000_000);
    expect(detect(large)).toBe('csv');

    /*
     * TWO GUARDS BOUND THE PREFIX, AND EACH WAS COVERING FOR THE OTHER.
     *
     * `DETECTION_RECORDS` stops after fifty records and `DETECTION_BUDGET`
     * stops after 64 kB, and the document above defeats neither: remove either
     * constant and the verdict does not move, because whichever is left still
     * stops the walk. Two constants with no test between them, each looking
     * covered because of the other.
     *
     * So one document per guard, each built to be decided by ITS guard alone.
     * Both come back as a mapping rather than a table when their own guard is
     * removed, which is what makes them assertions rather than illustrations.
     */

    // Sixty two-field rows, then sixty with a third field: inside 64 kB, so
    // only the RECORD CAP keeps the tail out of the decision.
    const pastTheRecordCap = [
      ...Array.from({ length: 60 }, (_unused, index) => `${index.toString()},name`),
      ...Array.from({ length: 60 }, (_unused, index) => `${index.toString()},name,extra`),
    ].join('\n');
    expect(pastTheRecordCap.length).toBeLessThan(64 * 1024);
    expect(detect(pastTheRecordCap)).toBe('csv');

    // Three 25 kB two-field rows, then a three-field row: only three records,
    // so only the BYTE BUDGET keeps the fourth out of the decision.
    const wide = 'x'.repeat(25_000);
    const pastTheByteBudget = [
      ...Array.from({ length: 3 }, (_unused, index) => `${wide},${index.toString()}`),
      'a,b,c',
    ].join('\n');
    expect(pastTheByteBudget.length).toBeGreaterThan(64 * 1024);
    expect(detect(pastTheByteBudget)).toBe('csv');

    /*
     * AND THE THIRD BOUND, WHICH NOTHING WAS HOLDING AT ALL.
     *
     * The walk is not the expensive thing in this function. When a document
     * looks delimited, detection then asks whether it ALSO parses as a YAML
     * mapping - a real parse, by the `yaml` package - and that call is given
     * `body.slice(0, DETECTION_BUDGET)` for exactly the same reason the walk is
     * bounded. Removing the slice and handing it the whole `body` changed no
     * verdict anywhere in this suite: a 16 MB paste would have been fully
     * parsed by a function whose job is to guess, and every test stayed green.
     *
     * THIS IS THE COST GUARD THAT IS NOT A CLOCK. It works because a YAML fault
     * past the budget cannot be seen by a bounded parse and cannot be missed by
     * an unbounded one, so the VERDICT says which happened:
     *
     *   - a head of `key: a, b` lines, which looks delimited AND is a mapping,
     *     so the verdict is yaml;
     *   - a YAML fault after 64 kB. Bounded, the fault is never read and the
     *     verdict stays yaml. Unbounded, the parse fails, the mapping test says
     *     no, and the verdict becomes csv.
     *
     * The lines are 255 characters plus a newline so that 65536 falls exactly
     * on a line boundary - a slice that cut a key in half would make the head
     * fail to parse on its own, and the whole thing would be measuring the cut.
     */
    const LINE_LENGTH = 255;
    const mappingLine = (index: number): string => {
      const key = `key${index.toString().padStart(6, '0')}: `;
      const rest = LINE_LENGTH - key.length - 2;
      const left = Math.floor(rest / 2);
      return `${key}${'a'.repeat(left)}, ${'b'.repeat(rest - left)}`;
    };

    const mappingRows = Array.from({ length: 300 }, (_unused, index) => mappingLine(index));
    const fault = 'broken: [1, 2';

    expect(mappingRows.join('\n').length).toBeGreaterThan(64 * 1024);
    // The head on its own is the control: it has to be yaml to begin with, or
    // the two below are a comparison between two identical wrong answers.
    expect(detect(`${mappingRows.join('\n')}\n`)).toBe('yaml');
    expect(detect(`${mappingRows.join('\n')}\n${fault}\n`)).toBe('yaml');

    // THE POSITIVE PARTNER. The same fault inside the budget must move the
    // verdict, or "the verdict did not move" above says nothing about where
    // the fault was.
    expect(
      detect(
        `${mappingRows.slice(0, 20).join('\n')}\n${fault}\n${mappingRows.slice(20).join('\n')}\n`,
      ),
    ).toBe('csv');

    /*
     * THE CLOCK THAT USED TO BE HERE IS GONE, AND ITS ABSENCE IS THE POINT.
     *
     * It asserted 250 ms against a defect measured at 119, which is two times'
     * headroom - and this suite runs a hundred and twenty files at once, so it
     * failed whenever the machine was busy. The obvious repairs were tried and
     * measured rather than assumed:
     *
     *   - A RATIO against a smaller document. The decision is bounded, but the
     *     whole string is still trimmed and scanned for a `sep=` directive, so
     *     the cost is not flat in the tail: the ratio wandered between 2 and 34
     *     for CORRECT behaviour. A measurement of the machine in the clothes of
     *     a complexity claim.
     *   - A TIGHTER ABSOLUTE BOUND, on the fastest of three samples. Ten
     *     attempts each, on this document: 3.8-7.8 ms correct, 17.8-27.5 ms
     *     with the defect reintroduced. That is a 2.3x separation, and 2.3x is
     *     not enough for a wall clock competing with a hundred and nineteen
     *     other test files.
     *
     * So WALL-CLOCK cost is not asserted here and is not asserted anywhere.
     * What replaced it is above: three bounds, each held by a document its own
     * bound alone decides, and the third of them - the YAML verification - is
     * the one that turns a bounded guess into a full parse of a 16 MB file if
     * it is removed. That is the regression the deleted stopwatch was aimed at,
     * and it is now caught by a verdict rather than by a duration.
     *
     * WHAT IS STILL NOT GUARDED, SAID PLAINLY. `stripBom`, the `sep=` scan and
     * `trim` all touch the whole string before any bound applies, so detection
     * is linear in the input no matter what. No clock-free witness for a linear
     * cost exists here - the function has no observable seam a counter could
     * sit in, and the only way to see that work is to time it, which is what
     * measurement showed cannot separate correct from broken in this suite. A
     * line that says "not measured" beats a green one that means "the machine
     * was quiet".
     */
  });
});

/* ---------------------------------------------------------------------- *
 * The half of the verdict nothing was checking
 * ---------------------------------------------------------------------- */

/*
 * `detectSource` returns THREE things and this file only ever read one.
 *
 * Round five's mutation sweep found five separate `fellBack: false` literals
 * that could be flipped to `true` with no test noticing, and `fellBack` is not
 * bookkeeping: it is the difference between "this document said it was YAML"
 * and "nothing else matched, so YAML". The `Detected` report port prints it as
 * whether the tool GUESSED, which round four already had to fix once at the
 * other end - `detected: !chosen` on the report port said it guessed when it
 * was told, to every reader but the panel.
 *
 * It also changes behaviour. `parseAuto` only second-guesses a successful YAML
 * parse when detection fell back, so a `---` document that YAML reads to a
 * folded scalar is accepted when the flag is right and refused as "not a
 * format" when it is wrong.
 *
 * So the table asserts the whole verdict for one document per return in
 * `detectSource`, which is what makes it a table rather than three examples.
 */
describe('what detection says it decided, and whether it guessed', () => {
  it.each([
    ['an empty document', '', 'json', false],
    ['a JSON object', '{"a": 1}', 'json', false],
    ['a JSON array', '[1, 2]', 'json', false],
    ['a document marker', '---\na: 1\n', 'yaml', false],
    ['a YAML directive', '%YAML 1.2\n---\na: 1\n', 'yaml', false],
    ['a block sequence item', '- a\n- b\n', 'yaml', false],
    ['a lone sequence dash', '-', 'yaml', false],
    ['a dash on its own line', '-\nalpha\n', 'yaml', false],
    ['a sep= directive', 'sep=;\na;b\nc;d\n', 'csv', false],
    ['a comma table', 'a,b\n1,2\n', 'csv', false],
    ['a tab table', 'a\tb\n1\t2\n', 'tsv', false],
    ['a mapping that looks delimited', 'tags: a, b\nnames: c, d\n', 'yaml', false],
    ['prose nothing matched', 'hello there\n', 'yaml', true],
  ])('reads %s as %s, having guessed: %s', (_name, source, format, fellBack) => {
    const detected = detectSource(source, ',');
    expect(detected.format).toBe(format);
    expect(detected.fellBack).toBe(fellBack);
  });

  /*
   * AND THE FLAG REACHES THE ANSWER, which is what makes the column above
   * worth asserting rather than a field nobody reads. `---` over two lines is
   * a YAML document meaning "a b"; the same two lines without the marker are
   * a paragraph of prose that YAML folds into one string, and this tool refuses
   * that rather than handing back a plausible-looking scalar.
   */
  it('accepts a folded scalar that declared itself and refuses one that did not', () => {
    expect(parseAuto('---\na\nb\n', ',')).toEqual({ ok: true, value: 'a b' });

    const prose = parseAuto('a\nb\n', ',');
    expect(prose.ok).toBe(false);
  });
});

/* ---------------------------------------------------------------------- *
 * Detection, over the shapes a real export actually has
 * ---------------------------------------------------------------------- */

/*
 * `looksDelimited` mirrors the parser's quote rule and its line rule, and
 * round five's sweep found both unasserted: the CRLF skip, the doubled-quote
 * skip, and the record cap could each be broken with nothing noticing. A
 * detector that disagrees with the parser about where the fields are is a
 * detector that hands the parser a delimiter it will then read differently -
 * which is the failure mode this whole tool is about.
 */
describe('detection over the shapes a real export has', () => {
  it('counts a CRLF document the same way it counts an LF one', () => {
    const rows = 'id,name\r\n1,ada\r\n2,grace\r\n';
    expect(detect(rows)).toBe('csv');
    expect(detectSource(rows, ',')).toEqual({ format: 'csv', delimiter: ',', fellBack: false });

    // The same bytes with LF, so the assertion above is about the CR and not
    // about the commas.
    expect(detect(rows.replaceAll('\r\n', '\n'))).toBe('csv');
  });

  it('skips a CR and its LF together, so the next record starts where it starts', () => {
    /*
     * A record whose FIRST character is the delimiter is what makes this
     * visible: advancing by the wrong amount over a CRLF eats it, and that
     * record comes back one field short. Every other CRLF document survives a
     * wrong skip with its field counts intact, which is why the ordinary one
     * above cannot decide this.
     */
    expect(detect('a,b\r\n,c\r\n')).toBe('csv');
    expect(detect('a,b\n,c\n')).toBe('csv');
  });

  it('lets a quote open a quoted field at the start of the SECOND record', () => {
    /*
     * The state that says "a field has begun" has to be cleared at a record
     * boundary as well as at a delimiter. Left set, the opening quote of the
     * second row is read as a literal, the comma inside it is counted, and a
     * perfectly ordinary export becomes a document with ragged rows.
     */
    expect(detect('a,b\n"c,d",e\n')).toBe('csv');
  });

  it('does not let a quote in the middle of a field open a quoted one', () => {
    /*
     * `a"b` is a field with a literal quote in it, to this detector and to the
     * parser both - a quote only opens a quoted field at the START of one. A
     * detector that disagreed would swallow the rest of the document into one
     * field and hand the parser a delimiter it then reads differently.
     */
    expect(detect('a"b,c\nd"e,f\n')).toBe('csv');
    expect(parsed('a"b,c\nd"e,f\n', 'csv')).toEqual([{ 'a"b': 'd"e', c: 'f' }]);
  });

  it('stops at the fiftieth record exactly, not the fifty-first', () => {
    /*
     * The record cap has a document each side of it. Fifty consistent records
     * then a wider one: counted to fifty, the tail is never seen and this is a
     * table; counted to fifty-one, the wider record lands in the comparison and
     * the whole document falls through to YAML.
     */
    const two = Array.from({ length: 50 }, (_unused, index) => `${index.toString()},name`);
    // TERMINATED, which is the whole of what makes this decide anything: an
    // unterminated last record is only counted when the walk read the whole
    // document, so without the trailing newline both sides of the cap agree.
    expect(detect([...two, 'a,b,c', ''].join('\n'))).toBe('csv');

    // One record fewer, so the wider row IS inside the cap: the comparison
    // sees it and refuses to call the document a table.
    expect(detect([...two.slice(0, 49), 'a,b,c', ''].join('\n'))).toBe('yaml');
  });

  it('does not count a delimiter that is inside a quoted field', () => {
    /*
     * `"a"",""b"` is ONE field whose text is `a","b` - two doubled quotes and
     * a comma between them. A detector that ended the quoted field at the
     * first doubled quote counts three fields in that row and two in the next,
     * calls the document inconsistent, and falls through to YAML - where a
     * comma-separated table comes back as one folded string.
     */
    const table = '"a"",""b",c\n"x",y\n';
    expect(detect(table)).toBe('csv');
    expect(parsed(table, 'csv')).toEqual([{ 'a","b': 'x', c: 'y' }]);
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
      /*
       * THE ACTUAL PLACE, NOT MERELY "SOMEWHERE PAST THE FIRST LINE".
       *
       * `jsonErrorPosition` reads V8's message with two regular expressions and
       * pulls capture groups out of them by index. Round five's mutation sweep
       * flipped `lineColumn[1]` to `[0]` and `[2]` to `[3]` with nothing
       * noticing, because the only thing asserted was that a position existed.
       * A position that exists and points at the wrong character is worse than
       * none: it is a caret under innocent text.
       *
       * The document is `{ "a": 1, "b" 2 }` over three lines, and the fault is
       * the missing colon after `"b"` - line 3, column 7.
       *
       * WHAT THIS CANNOT REACH, SAID RATHER THAN IMPLIED. V8 prints the fault
       * BOTH ways - "at position 18 (line 3 column 7)" - so the offset arm of
       * `jsonErrorPosition` is never taken, and its capture index can be
       * changed without any test noticing. It computes the same answer: offset
       * 18 in this document IS line 3, column 7. The arm is there because the
       * wording of that message is not a contract, and there is no way to
       * exercise it short of stubbing `JSON.parse`, which would be a test of
       * the stub.
       */
      expect(result.error.position?.line).toBe(3);
      expect(result.error.position?.column).toBe(7);
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

  it('counts depth through an object as well as through an array', () => {
    /*
     * THE TEST ABOVE IS `[[[[...]]]]`, AND THAT IS ALL IT IS.
     *
     * `toJsonValue` recurses with `depth + 1` in two places, one per container
     * kind, and round five's sweep turned the OBJECT one into `depth - 1` with
     * nothing noticing. A depth counter that never grows is a guard that never
     * fires, and what a person then gets is whichever of `JSON.parse`, the tree
     * walk or `JSON.stringify` overflows first - which is the confusing message
     * the guard was added to replace.
     */
    const open = '{"a":'.repeat(MAX_DEPTH + 1);
    const close = '}'.repeat(MAX_DEPTH + 1);
    const result = parseSource(`${open}1${close}`, 'json', ',');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('limit-exceeded');
      expect(result.error.message).toContain('nested more than');
    }

    /*
     * AND EXACTLY THE LIMIT IS READ, which is the assertion that pins the
     * number rather than its neighbourhood. `MAX_DEPTH` levels is the deepest
     * document this tool accepts - the guard is `depth >= MAX_DEPTH` and the
     * walk starts at zero - so a document one level shallower would be
     * satisfied by an off-by-one in either direction.
     */
    const exact = '{"a":'.repeat(MAX_DEPTH) + '1' + '}'.repeat(MAX_DEPTH);
    expect(parseSource(exact, 'json', ',').ok).toBe(true);
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

/* ========================================================================== *
 * Numbers that do not survive
 * ========================================================================== */

/**
 * A KNOWN, CURRENTLY SILENT LOSS. See `docs/conversion-matrix.md`.
 *
 * JSON's grammar puts no limit on the digits of a number; JavaScript has one
 * numeric type and it is a double. So an integer past 2^53 is rounded on the
 * way in by `JSON.parse` - which is the platform's behaviour and not this
 * tool's - and everything downstream writes the rounded value out. A 64-bit
 * database key, a Twitter or Discord id, a nanosecond timestamp: all of them
 * come back as a DIFFERENT NUMBER, with no error and nothing on any port to
 * say so.
 *
 * These tests do not endorse that. They pin it, so that it is a decision
 * somebody took rather than something nobody had measured, and so that the day
 * it is fixed the fix is visible here. Every expected value is what the
 * ECMAScript number grammar says the nearest double is, which is also what
 * `json.loads` in Python reports when asked for `float(...)` of the same
 * literal - the reference for the LOSS, not for the answer.
 */
describe('numbers larger than a double can hold', () => {
  it.each([
    ['12345678901234567890', 12345678901234567000, 'a 20-digit integer'],
    ['1234567890123456789', 1234567890123456800, 'a Discord-style snowflake id'],
    ['9007199254740993', 9007199254740992, '2^53 + 1, the first integer that is lost'],
    ['-9007199254740993', -9007199254740992, 'the same, negative'],
    ['1699999999123456789', 1699999999123456800, 'a nanosecond timestamp'],
  ])('rounds %s and says nothing (%s)', (literal, rounded) => {
    const result = parseAuto(`{"id": ${literal}}`, DELIMITERS.comma);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ id: rounded });

    // The loss made explicit: the digits that went in are not the digits that
    // come out, and the conversion reported success.
    const written = serialise(result.value, 'json', { indent: 0, delimiter: ',' });
    expect(written.ok).toBe(true);
    if (written.ok) expect(written.value).not.toContain(literal);
  });

  it('keeps an integer that a double can hold exactly', () => {
    // The boundary, so the tests above are about size rather than about all
    // large numbers being mangled.
    const result = parseAuto('{"id": 9007199254740991}', DELIMITERS.comma);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ id: 9007199254740991 });
  });

  it('loses the same digits through YAML, which is the same cause', () => {
    const result = parseAuto('id: 12345678901234567890\n', DELIMITERS.comma);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ id: 12345678901234567000 });
  });

  it('carries the digits intact when they are a string on either side', () => {
    // The workaround, asserted so it is known to work: quoted, the id is text
    // and text is not rounded.
    const result = parseAuto('{"id": "12345678901234567890"}', DELIMITERS.comma);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ id: '12345678901234567890' });
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

  it('refuses a value the model cannot hold, naming the path', () => {
    // !!binary yields a byte array, which the value model has no place for.
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

  it('keeps the empty document a trailing separator declares', () => {
    /*
     * THIS ASSERTION USED TO SAY THE OPPOSITE, and it was wrong.
     *
     * `a: 1\n---\n` was read as one document and a stray marker, on the
     * reasoning that a trailing `---` is punctuation rather than data. `---`
     * STARTS A DOCUMENT. The yaml-test-suite's PUW8 says so about these exact
     * bytes, and so do js-yaml 5.4.2 and CPython's PyYAML 6.0.3, asked
     * directly. Dropping it made a five-document stream come back as a
     * four-element array with no error anywhere.
     */
    expect(parsed('a: 1\n---\n', 'yaml')).toEqual([{ a: 1 }, null]);
  });

  it('still says there is nothing to parse when no marker declared anything', () => {
    // The other half of the same rule, and the reason it is a distinction
    // rather than a removal: an empty box is not a document.
    expect(parseSource('', 'yaml', ',').ok).toBe(false);
    expect(parseSource('   \n\n', 'yaml', ',').ok).toBe(false);
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
        /*
         * AND IT IS A VALUE-MODEL REFUSAL, NOT A SYNTAX ERROR. All three of
         * these documents are valid YAML - the yaml-test-suite composes
         * documents of this shape, js-yaml reads them and PyYAML reads them.
         * What cannot hold them is the value model every conversion here goes
         * through, whose keys are text. Round five separated the two and round
         * eleven stopped the message calling that model JSON; see
         * `duplicateKeyFailure` and "a key that collides only once the document
         * is read" in the oracle test.
         */
        expect(result.error.code).toBe('unsupported-type');
        expect(result.error.message).toBe('Two different YAML keys become one key in this tool.');
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

  /*
   * AN ALIAS WITH NO ANCHOR IS NOT A SIZE PROBLEM, and it was reported as one.
   *
   * `toJS` throws a bare `ReferenceError` for two faults that have nothing in
   * common - an unresolved alias, and the expansion limit above - and both came
   * back as "That YAML expands to too much data to convert" with the library's
   * own sentence about an anchor underneath it. Twenty-six bytes described as a
   * resource-exhaustion refusal, with the message and its own detail
   * contradicting each other.
   *
   * The two are separated by asking the DOCUMENT rather than by matching the
   * error's wording: `visit` walks in document order, so the anchors seen when
   * an alias is reached are exactly the ones the library resolves against. That
   * is why the third case is here - an alias BEFORE its anchor is unresolved in
   * YAML however far down the file the `&` eventually appears, and a check that
   * merely collected every anchor in the document would call it resolved.
   *
   * `merged: {<<: *base, b: 2}` is where this was found: a merge key pasted out
   * of the middle of somebody else's file, without the anchor it refers to.
   */
  it.each([
    ['a flow merge key whose anchor was left behind', 'merged: {<<: *base, b: 2}\n', 'base'],
    ['a plain alias with no anchor at all', 'a: 1\nb: *nope\n', 'nope'],
    ['an alias that comes before its anchor', 'a: *later\nb: &later 1\n', 'later'],
  ])('reports %s as a broken document rather than as too much data', (_name, source, anchor) => {
    const result = parseSource(source, 'yaml', ',');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('parse-error');
    expect(result.error.message).toBe(`The alias *${anchor} has no anchor before it.`);
    // It points at the alias, which is the character the reader has to change.
    expect(result.error.position?.offset).toBe(source.indexOf(`*${anchor}`));
  });

  /*
   * THE POSITIVE PARTNER. An alias that really does resolve must still resolve,
   * or the two assertions above are satisfied by a build that refuses every
   * anchor in the language.
   */
  it('still resolves an alias whose anchor is set before it', () => {
    expect(parsed('a: &x 1\nb: *x\n', 'yaml')).toEqual({ a: 1, b: 1 });
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
    // hold. The value-model check catches it and names the path.
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

  it('counts a CRLF inside a quoted cell as ONE line, not two', () => {
    /*
     * The line a parse error names is the only way to find it in a 16 MB file,
     * and a multi-line cell is where the count goes wrong. The code comment
     * beside the CRLF branch says exactly that - "or every position reported
     * after a multi-line cell points too high up the file" - and nothing was
     * asking: the oracle corpus compares FIELDS against CPython, which is
     * blind to line numbers, and every other position test has no quoted
     * newline above it.
     *
     * Four lines here, and the bad row is the fourth. The ROW's own line is
     * what this asks about: an unterminated-quote error carries a byte offset
     * and is converted back to a line by counting the text, so it would be
     * right whatever the counter did. A row error has no offset, only the
     * number the parser was keeping while it read.
     */
    const rows = parseCsvRows('a,b\r\n"one\r\ntwo",x\r\n1,2,3\r\n', ',');
    expect(rows.ok).toBe(true);
    if (rows.ok) expect(rows.value.map((row) => row.line)).toEqual([1, 2, 4]);

    const result = parseSource('a,b\r\n"one\r\ntwo",x\r\n1,2,3\r\n', 'csv', ',');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Row 3');
      expect(result.error.position?.line).toBe(4);
    }

    // The same file with LF endings is the same four lines, which is what makes
    // the number above about the cell rather than about the terminator.
    const lf = parseSource('a,b\n"one\ntwo",x\n1,2,3\n', 'csv', ',');
    expect(lf.ok).toBe(false);
    if (!lf.ok) expect(lf.error.position?.line).toBe(4);
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
        { fields: ['name'], quoted: [false], line: 1, starts: [{ line: 1, column: 1, offset: 0 }] },
        // Positions are kept for the header alone; see `CsvRow.starts`.
        { fields: [''], quoted: [true], line: 2, starts: [] },
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

  /* -- SD-4b: say when TRIMMING is why two cells collided ---------------- */

  it('says trimming is why two visibly different header cells collided', () => {
    /*
     * `a, a ` is a duplicate column and the header does not look like one: the
     * two cells differ by four characters. The old message named the name they
     * collapsed onto and left the reader comparing two spellings that are
     * identical, which reads as the tool being unable to count.
     *
     * The cells are printed through `JSON.stringify` rather than in backticks
     * on purpose - the whole subject is whitespace, and backticks around
     * ` a ` print something that looks exactly like `a`.
     */
    const result = parseSource('a, a \n1,2', 'csv', ',');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Duplicate column name "a"');
      expect(result.error.detail).toContain('"a" and " a "');
      expect(result.error.detail).toContain('trailing spaces removed');
      expect(result.error.detail).toContain('Quote one of them');
    }
  });

  it('does not blame trimming for two cells that were always the same', () => {
    /*
     * THE NEGATIVE CONTROL, and the one that decides whether the sentence
     * above is a fact or a decoration. `a,a` is an ordinary duplicate; telling
     * its author that the two are "different as written" would be false, and a
     * message that says it unconditionally is a message nobody can trust when
     * it is right.
     */
    const result = parseSource('a,a\n1,2', 'csv', ',');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.detail).toBe(
        'Column names become object keys, so they have to be unique.',
      );
    }
  });

  it('does not blame trimming when both cells were quoted', () => {
    // Quoting means nothing was trimmed, so a collision between two quoted
    // cells is the plain kind however much whitespace is in them.
    const result = parseSource('" a "," a "\n1,2', 'csv', ',');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail).not.toContain('trailing spaces removed');
  });

  /* -- SD-4c: a synthesised name the file is not already using ----------- */

  it('reads a file whose author has a column literally called column_2', () => {
    /*
     * THE REAL DEFECT BEHIND SD-4. `column_2` is a name this tool INVENTS for
     * an empty header cell, and it used to be invented without looking at the
     * document - so a file that already had a column called `column_2`
     * collided with the invention and was refused outright, blaming its author
     * for a duplicate they had not written. There is no spelling of that
     * header that gets the file read: it was unreadable, full stop.
     */
    expect(parsed('column_2,,c\n1,2,3', 'csv')).toEqual([
      { column_2: '1', column_2_2: '2', c: '3' },
    ]);
  });

  it('avoids a literal name that appears AFTER the empty cell', () => {
    /*
     * Which is why the reserved set is built in a pass of its own rather than
     * accumulated as the columns are named. Checking only the names already
     * assigned would invent `column_1` for the first cell and then refuse the
     * second - the same defect, one column further along.
     */
    expect(parsed(',column_1\n1,2', 'csv')).toEqual([{ column_1_2: '1', column_1: '2' }]);
  });

  it('gives two empty cells two different names', () => {
    // The index makes them different already; this is the control that says so,
    // because a synthesiser that ignored the index would collide with itself.
    expect(parsed('a,,,d\n1,2,3,4', 'csv')).toEqual([
      { a: '1', column_2: '2', column_3: '3', d: '4' },
    ]);
  });

  it('still refuses a duplicate the author really did write', () => {
    // The negative control for all of the above: making synthesis collision-safe
    // must not make a genuine duplicate readable.
    const result = parseSource('column_2,column_2\n1,2', 'csv', ',');
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

/* ========================================================================== *
 * The value model, and the refusal that names it
 * ========================================================================== */

/**
 * ROUND ELEVEN, AND THE DECISION IT RESTS ON.
 *
 * SD-2 and SD-5 asked for `.nan` and an integer key to survive YAML to YAML.
 * The decision taken was NOT to widen the model: there is one value model here,
 * `JsonValue`, and it is what the `data` port carries, what a wire carries and
 * what the cache key is built from, so a second one for the single case where
 * source and target are the same format would be a second tool wearing one
 * name.
 *
 * What was wrong was the SENTENCE. `$.a_nan is NaN, which JSON cannot
 * represent` names a format that is in neither half of a YAML to YAML run, and
 * invites the reading that some other route would be exempt. These tests hold
 * the refusal to naming the real constraint, to saying what the model holds,
 * and - the part that decides whether this is a boundary or a wall - to naming
 * a way through that is asserted to work rather than merely offered.
 */
describe('a value the model cannot hold', () => {
  const refusal = (
    source: string,
    format: Parameters<typeof parseSource>[1] = 'yaml',
  ): { message: string; detail: string; line: number | null; column: number | null } => {
    const result = parseSource(source, format, ',');
    expect(result.ok, `expected ${source} to be refused`).toBe(false);
    if (result.ok) return { message: '', detail: '', line: null, column: null };
    return {
      message: result.error.message,
      detail: result.error.detail ?? '',
      line: result.error.position?.line ?? null,
      column: result.error.position?.column ?? null,
    };
  };

  it('names the model rather than JSON, on a run where JSON is neither side', () => {
    const { message } = refusal('a_nan: .nan\n');
    expect(message).toBe("$.a_nan is NaN, which this tool's value model cannot hold.");
    expect(message).not.toContain('JSON');
  });

  it('says what that model holds, so the boundary is a fact and not a shrug', () => {
    const { detail } = refusal('a_nan: .nan\n');
    expect(detail).toContain('text, finite numbers, true, false, null, lists and maps');
    expect(detail).toContain('YAML to YAML takes the same route as YAML to CSV');
  });

  it('records it as a stated limitation and says where it is written down', () => {
    expect(refusal('a_nan: .nan\n').detail).toContain('stated limitation of the tool');
    expect(refusal('a_nan: .nan\n').detail).toContain('The value model, and what it cannot hold');
  });

  /*
   * THE WAY THROUGH, ASSERTED RATHER THAN OFFERED.
   *
   * A refusal that names a workaround nobody has run is worse than one that
   * names none: it is the same wall with a sign on it. So the sentence is
   * asserted AND the document it describes is converted, in the same test.
   */
  it('offers a way through, and the way through works', () => {
    expect(refusal('a_nan: .nan\n').detail).toContain('Quote the value in the source');
    expect(parsed('a_nan: ".nan"\n', 'yaml')).toEqual({ a_nan: '.nan' });
  });

  it('offers it only when quoting really would carry every one of them', () => {
    // A Set is not a thing a pair of quotes rescues, so the sentence must not
    // appear. The control for the test above: it fires on subject, not always.
    const { detail } = refusal('!!set\n? a\n? b\n');
    expect(detail).not.toContain('Quote the value in the source');
    expect(detail).toContain('stated limitation of the tool');
  });

  it('names binary data by what it is, not by whichever class the engine used', () => {
    /*
     * `!!binary` resolves to a `Buffer` where one exists and a `Uint8Array`
     * where one does not, so this message read differently under Node and in a
     * browser - two sentences for one fault, neither of them a word the person
     * who typed `!!binary` used.
     */
    const { message } = refusal('blob: !!binary aGk=\n');
    expect(message).toBe("$.blob is binary data, which this tool's value model cannot hold.");
    expect(message).not.toContain('Buffer');
    expect(message).not.toContain('Uint8Array');
  });

  /* -- SD-12: every offender, not the first ------------------------------- */

  it('names every value outside the model rather than stopping at the first', () => {
    const { message, detail } = refusal('a: .nan\nb: .inf\nc: -.inf\nd: .nan\ne: .nan\nf: .nan\n');

    expect(message).toBe("6 values in that document are outside this tool's value model.");
    for (const path of ['$.a', '$.b', '$.c', '$.d', '$.e', '$.f']) {
      expect(detail, `${path} was not named`).toContain(path);
    }
    // And WHAT each one is, not only where: three of the six are not NaN.
    expect(detail).toContain('$.b is Infinity');
    expect(detail).toContain('$.c is -Infinity');
  });

  it('counts what it found rather than what it listed', () => {
    // Twelve, past the ten the list stops at. The count is of everything,
    // because a 16 MB document of nothing but `.nan` must not be described by
    // a list of three million objects.
    const lines = Array.from({ length: 12 }, (_value, index) => `k${index.toString()}: .nan`);
    const { message, detail } = refusal(`${lines.join('\n')}\n`);

    expect(message).toBe("12 values in that document are outside this tool's value model.");
    expect(detail).toContain('and 2 more');
    expect(detail).toContain('$.k9 is NaN');
    expect(detail).not.toContain('$.k10');
  });

  /*
   * THE CONTROL FOR THE COUNT. One offender must read as one - `1 values in
   * that document` would be the same list machinery with nothing measuring it,
   * and the singular message is the one a person sees almost every time.
   */
  it('still says which one when there is only one', () => {
    expect(refusal('only: .inf\n').message).toBe(
      "$.only is Infinity, which this tool's value model cannot hold.",
    );
  });

  /* -- theme three's fourth member: a path AND a position ----------------- */

  it('points at the value rather than at the top of the document', () => {
    const filler = Array.from({ length: 20 }, (_value, index) => `k${index.toString()}: 1`);
    const { line, column } = refusal(`${filler.join('\n')}\nlate: .nan\n`);

    expect(line).toBe(21);
    // Column 7, not 1: the `.nan`, not the `late:` in front of it. A position
    // at the construct start is the complaint, not the fix.
    expect(column).toBe(7);
  });

  /*
   * AND IT MOVES. A line number asserted once is satisfied by a constant, and
   * this file has shipped exactly that before - round four's first CRLF test
   * asserted a position recomputed from a byte offset and passed against the
   * break. Two documents, two answers.
   */
  it('and the position follows the value when the value moves', () => {
    expect(refusal('early: .nan\nk: 1\n').line).toBe(1);
    expect(refusal('k: 1\nearly: .nan\n').line).toBe(2);
  });

  it('says which document of a stream, and where in it', () => {
    const { message, line } = refusal('---\na: 1\n---\nb: .nan\n');
    expect(message).toBe("$[1].b is NaN, which this tool's value model cannot hold.");
    expect(line).toBe(4);
  });

  it('counts the copy an expanded alias makes, and still points somewhere', () => {
    /*
     * `*b` expands to a second copy of the same value, so there are two
     * offenders - and only one of them sits at a path any node in the document
     * occupies. The caret goes to the one that can be pointed at rather than to
     * nowhere; see `outsideTheModelFailure`.
     */
    const { message, line } = refusal('base: &b\n  n: .nan\ncopy: *b\n');
    expect(message).toBe("2 values in that document are outside this tool's value model.");
    expect(line).toBe(2);
  });

  it('brackets a path step that is not a bare identifier', () => {
    // The spelling `yamlPath` and `lib/jsonNumbers.ts` both already use, and
    // which this walk claimed to share while writing `$.shipped at`.
    expect(refusal('{"shipped at": 1e999}', 'json').message).toContain('$["shipped at"]');
  });

  /* -- the negative controls ---------------------------------------------- */

  /*
   * ON SUBJECT, NOT ON WORDING. The question is whether the document was
   * refused AT ALL for being outside the model - a control that looked for the
   * sentence would pass on a run that refused it for something else.
   */
  it('refuses nothing in a document the model holds perfectly well', () => {
    const fine = 'a: 1\nb: 2.5\nc: true\nd: null\ne: [1, 2]\nf: {g: h}\n';
    const result = parseSource(fine, 'yaml', ',');
    expect(result.ok).toBe(true);
  });

  it('and nothing in one whose awkward values are quoted', () => {
    expect(parsed('a: ".nan"\nb: ".inf"\nc: "2001-12-14"\n', 'yaml')).toEqual({
      a: '.nan',
      b: '.inf',
      c: '2001-12-14',
    });
  });

  /*
   * THE OTHER CONTROL, AND THE ONE THAT WOULD CATCH A WALK THAT STOPPED
   * WORKING. Collecting every offender means walking past one, and a walk that
   * carried on past a DEPTH limit is the failure the limit exists to prevent.
   * Depth still wins, and it is still a `limit-exceeded`.
   */
  it('still stops at the depth limit rather than collecting past it', () => {
    const deep = `${'{"a":'.repeat(MAX_DEPTH + 1)}1${'}'.repeat(MAX_DEPTH + 1)}`;
    const result = parseSource(deep, 'json', ',');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('limit-exceeded');
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
      inputs: { input: bytesValue(bytes) },
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
        input: bytesValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe])),
      },
      options: { target: 'json' },
      context,
    });

    expect(result.ok).toBe(false);
  });
});
