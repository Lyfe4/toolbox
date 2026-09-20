import { describe, expect, it } from 'vitest';

import {
  bytesValue,
  isJsonArray,
  isJsonObject,
  type Bytes,
  type ToolRunContext,
} from '@/features/registry/types';

import { detectSource, DELIMITERS } from './convert';
import structuredDataTool from './index';

/**
 * THE DETECTED REPORT: ONE PORT, AND EVERY LOSS THAT NEEDED IT.
 *
 * Four of this tool's cells were `lossy, silent` in docs/conversion-matrix.md
 * and every one of them was silent for the same reason: a `ToolResult` is a
 * value or an error, and none of these is either. They are facts about what the
 * conversion did.
 *
 * EVERY TEST HERE COMES IN A PAIR. A report is only worth anything if it
 * appears when the loss happens AND stays quiet when it does not - a note that
 * fires on ordinary input is a note nobody reads on the day it means something,
 * which is the failure mode this whole channel exists to avoid. So each `it`
 * that asserts a note has an `it` beside it asserting silence on input of the
 * same shape with the loss removed.
 *
 * WHAT THIS FILE DOES NOT PROVE is that anybody SEES the report. A payload is
 * not visibility. That is asserted on the canvas node in
 * `resultSummary.test.ts`, and in two real browsers - on `/tools` and on a
 * canvas node - in `scripts/cross-browser-check.mjs`, because jsdom has no
 * layout engine and "it is in the DOM" is not the same claim as "it is on
 * screen".
 */

const context: ToolRunContext = {
  signal: new AbortController().signal,
  reportProgress: () => undefined,
};

interface Note {
  readonly level: string;
  readonly title: string;
  readonly body: string;
}

interface Report {
  readonly summary: string;
  readonly notes: readonly Note[];
  readonly from: Readonly<Record<string, unknown>>;
  readonly to: Readonly<Record<string, unknown>>;
  /** Whether the source format was guessed. On the port, and nothing read it. */
  readonly detected: unknown;
}

async function convert(
  input: string | Bytes,
  options: Record<string, unknown> = {},
): Promise<{ readonly output: string; readonly report: Report }> {
  const result = await structuredDataTool.run({
    inputs: {
      input:
        typeof input === 'string'
          ? { type: 'text', text: input }
          : bytesValue(input, { mediaType: null, filename: 'in.txt' }),
    },
    options,
    context,
  });

  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);

  const value = result.value.report;
  if (value?.type !== 'json' || !isJsonObject(value.data)) throw new Error('no report');
  const data = value.data;
  const rawNotes = data.notes;
  const output = result.value.output;

  return {
    output: output?.type === 'text' ? output.text : '',
    report: {
      summary: typeof data.summary === 'string' ? data.summary : '',
      notes:
        rawNotes !== undefined && isJsonArray(rawNotes)
          ? rawNotes.filter(isJsonObject).map((note) => ({
              level: typeof note.level === 'string' ? note.level : '',
              title: typeof note.title === 'string' ? note.title : '',
              body: typeof note.body === 'string' ? note.body : '',
            }))
          : [],
      from: data.from !== undefined && isJsonObject(data.from) ? data.from : {},
      to: data.to !== undefined && isJsonObject(data.to) ? data.to : {},
      detected: data.detected,
    },
  };
}

const titles = (report: Report): string[] => report.notes.map((note) => note.title);
const losses = (report: Report): string[] =>
  report.notes.filter((note) => note.level === 'warn').map((note) => note.title);

/* ========================================================================== *
 * Decision 4: the report exists at all
 * ========================================================================== */

describe('decision 4: the tool says what it detected', () => {
  it('names the format it guessed and the format it wrote', async () => {
    const { report } = await convert('name;age\nada;36\ngrace;45', {
      delimiter: 'semicolon',
      target: 'json',
    });

    expect(report.summary).toBe('CSV (detected) → JSON');
    expect(report.from.format).toBe('CSV');
    expect(report.from.delimiter).toBe('semicolon');
    expect(report.to.format).toBe('JSON');
  });

  it('says so when the format was chosen rather than guessed', async () => {
    // The negative control for the word "detected": picking a format on the
    // panel means no guess was made, and the report must not claim one.
    const { report } = await convert('a: 1\n', { source: 'yaml', target: 'json' });

    expect(report.summary).toBe('YAML → JSON');
    expect(report.summary).not.toContain('detected');
  });

  it('reports nothing lost for a conversion that loses nothing', async () => {
    // JSON to YAML is the `exact` cell in the matrix. If any note appears here,
    // every other assertion in this file is about a channel that cries wolf.
    const { report } = await convert('{"a": 1, "b": [2, 3]}', { target: 'yaml' });

    expect(report.notes).toEqual([]);
    expect(report.summary).toBe('JSON (detected) → YAML');
  });
});

/* ========================================================================== *
 * Decision 1: delimited detection prefers a YAML mapping
 * ========================================================================== */

describe('decision 1: two lines of YAML are not a table', () => {
  it('reads `tags: a, b` over `names: c, d` as a mapping', async () => {
    /*
     * The matrix's `broken` row. Both lines have two comma-separated fields, so
     * the delimited test was satisfied and the document came back as a one-row
     * table whose columns were `tags: a` and `b` - nonsense that looks like
     * data, with no error anywhere.
     */
    const { output } = await convert('tags: a, b\nnames: c, d', { target: 'json' });

    expect(JSON.parse(output)).toEqual({ tags: 'a, b', names: 'c, d' });
    expect(detectSource('tags: a, b\nnames: c, d', DELIMITERS.comma).format).toBe('yaml');
  });

  it('reads a two-line log with one comma a line as YAML too', async () => {
    const { report } = await convert('alpha: started, ok\nbeta: started, ok', { target: 'json' });
    expect(report.from.format).toBe('YAML');
  });

  /*
   * THE NEGATIVE CONTROL, AND IT IS THE WHOLE COST OF THE DECISION. A header
   * and one row is a real CSV file and the commonest one there is. If the YAML
   * question started answering yes for these, the fix would be worse than the
   * defect it replaced.
   */
  it.each([
    ['a header and one row', 'name,age\nada,36'],
    ['a header and two rows', 'name,age\nada,36\ngrace,45'],
    ['quoted cells with commas inside', 'name,note\n"ada","a, b"\n"grace","c, d"'],
    ['a cell containing a colon and a space', 'name,note\nada,"time: 10"\ngrace,"time: 11"'],
    ['numbers', 'x,y\n1,2\n3,4'],
  ])('still reads %s as a table', async (_name, source) => {
    const { report } = await convert(source, { target: 'json' });
    expect(report.from.format).toBe('CSV');
  });

  it('still reads a two-column TSV as a table', async () => {
    const { report } = await convert('name\tage\nada\t36', { target: 'json' });
    expect(report.from.format).toBe('TSV');
  });
});

/* ========================================================================== *
 * Decision 2: nested values and absent keys in a CSV
 * ========================================================================== */

describe('decision 2: what a table cell cannot hold', () => {
  it('reports a nested value by path, and still writes it', async () => {
    const { output, report } = await convert('[{"user": {"name": "ada"}, "id": 1}]', {
      target: 'csv',
    });

    // The value is still there - refusing the document was the option NOT
    // taken - and reading it back gives the string, which is the loss.
    expect(output).toContain('{""name"":""ada""}');
    expect(losses(report)).toContain(
      'The nested value at $[0].user was written into the cell as JSON',
    );
  });

  it('counts them and names the first few when there are many', async () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({ id: index, at: { deep: index } }));
    const { report } = await convert(JSON.stringify(rows), { target: 'csv' });

    const note = report.notes.find((entry) => entry.title.includes('nested values'));
    expect(note?.title).toBe('9 nested values were written into their cells as JSON');
    expect(note?.body).toContain('$[0].at, $[1].at, $[2].at, $[3].at, $[4].at, and 4 more');
  });

  it('reports a key that some row does not have', async () => {
    const { output, report } = await convert('[{"a": 1, "b": 2}, {"a": 3}]', { target: 'csv' });

    // The empty cell is real and indistinguishable from a present empty string,
    // which is exactly what the note says.
    expect(output).toBe('a,b\n1,2\n3,');
    expect(losses(report)).toContain('1 column was absent from some rows');
  });

  /*
   * THE NEGATIVE CONTROLS. A flat table loses nothing, and a row whose value IS
   * the empty string is present - reporting it would make the note meaningless,
   * because then it would fire on almost every export.
   */
  it('reports no LOSS for a flat table with every key in every row', async () => {
    /*
     * `losses`, not `notes`. Every CSV write carries one `info` note - the
     * output uses LF and stops after the last record, which is a spelling
     * difference from RFC 4180 and matters when the next step is a digest.
     * Nothing is lost, so nothing here is `warn`, which is the level the canvas
     * reads.
     */
    const { report } = await convert('[{"a": 1, "b": 2}, {"a": 3, "b": 4}]', { target: 'csv' });
    expect(losses(report)).toEqual([]);
    expect(titles(report)).toEqual(['Written with LF, and no terminator after the last record']);
  });

  it('reports no loss for a key whose value is the empty string', async () => {
    const { report } = await convert('[{"a": 1, "b": ""}, {"a": 3, "b": "x"}]', { target: 'csv' });
    expect(losses(report)).toEqual([]);
  });
});

/* ========================================================================== *
 * Decision 3: integers past 2^53
 * ========================================================================== */

describe('decision 3: integers a double cannot hold', () => {
  it('reports a rounded integer by path, from JSON', async () => {
    const { output, report } = await convert('{"id": 12345678901234567890}', { target: 'json' });

    expect(output).toContain('12345678901234567000');
    const note = report.notes.find((entry) => entry.title.includes('rounded'));
    expect(note?.level).toBe('warn');
    expect(note?.title).toBe('The number at $.id was rounded');
    expect(note?.body).toContain('12345678901234567890 became 12345678901234567000');
  });

  it('reports one from YAML, at the same path spelling', async () => {
    const { report } = await convert('user:\n  id: 12345678901234567890\n', { target: 'json' });
    expect(titles(report)).toContain('The number at $.user.id was rounded');
  });

  it('names the document a rounded number came out of, in a stream', async () => {
    const { report } = await convert('id: 12345678901234567890\n---\nid: 1\n', { target: 'json' });
    expect(titles(report)).toContain('The number at $[0].id was rounded');
  });

  it('counts them when there are several', async () => {
    const { report } = await convert('{"a": 12345678901234567890, "b": 98765432109876543210}', {
      target: 'json',
    });
    expect(titles(report)).toContain('2 numbers were rounded');
  });

  /*
   * THE NEGATIVE CONTROLS, and the first is the one that matters most.
   *
   * 9007199254740994 is 2^53 + 2. `Number.isSafeInteger` says false and a
   * double holds it EXACTLY, so the obvious implementation - walk the parsed
   * value, report every unsafe integer - reports a number that was not rounded.
   * That is the same class of confident wrongness this round exists to remove,
   * which is why the question is asked of the literal rather than of the value.
   */
  it('says nothing about an integer past 2^53 that a double holds exactly', async () => {
    const { output, report } = await convert('{"id": 9007199254740994}', { target: 'json' });

    expect(output).toContain('9007199254740994');
    expect(report.notes).toEqual([]);
  });

  it('says nothing about ordinary numbers', async () => {
    const { report } = await convert('{"a": 1, "b": -42, "c": 3.5, "d": 900719925474099}', {
      target: 'json',
    });
    expect(report.notes).toEqual([]);
  });

  it('says nothing about a long run of digits inside a string', async () => {
    // The cheap gate in front of the scan is a regular expression over the
    // whole document, so a document that trips it must still come back clean
    // when the digits are not a number.
    const { report } = await convert('{"id": "12345678901234567890"}', { target: 'json' });
    expect(report.notes).toEqual([]);
  });

  it('keeps every digit when the source is a table, and says nothing', async () => {
    // CSV reads every cell as a string, so this is the one reading path in the
    // tool with no numeric ceiling at all - and the note would be false.
    const { output, report } = await convert('id,name\n12345678901234567890,ada', {
      target: 'json',
    });

    expect(output).toContain('"12345678901234567890"');
    expect(report.notes).toEqual([]);
  });
});

/* ========================================================================== *
 * SD-13: the advice fits the target, and the old advice was false
 * ========================================================================== */

/**
 * WHAT THE ROUNDING NOTE TOLD PEOPLE TO DO, AND WHY IT COULD NOT WORK.
 *
 * The sentence was `Convert to CSV or TSV to keep the digits, where every cell
 * stays a string`, appended whatever the target was. SD-13 filed it as
 * JSON-specific advice appearing on a non-JSON target. It is worse than that:
 * **the rounding happens in the READER**, so by the time any writer runs the
 * digits are gone, and following the advice to the letter produces the rounded
 * number in a CSV cell. The first test here is that measurement, and it is the
 * reason the sentence changed rather than being re-worded.
 *
 * These run through the TOOL rather than through `readSource`, which is what
 * makes them the guard on the target actually being threaded: `readSource`
 * takes the target optionally - `parseSource` throws the notes away and has
 * none - so a wiring that forgot to pass it would still compile.
 */
describe('SD-13: what to do about a rounded integer', () => {
  // An array at the top level, because a CSV target needs rows and the same
  // document has to reach all four targets for the comparison to mean anything.
  const ONE_ROW = '[{"id": 12345678901234567890}]';

  const advice = async (options: Record<string, unknown>): Promise<string> => {
    const { report } = await convert(ONE_ROW, options);
    return report.notes.find((entry) => entry.title.includes('rounded'))?.body ?? '';
  };

  it('does not keep the digits, which is exactly what the old advice promised', async () => {
    const { output } = await convert(ONE_ROW, { source: 'json', target: 'csv' });

    // The whole file, not a substring: the claim is that the digits are gone,
    // and `toContain` would be satisfied by a cell that also held them.
    expect(output).toBe('id\n12345678901234567000');
  });

  it('and the advice that replaced it does keep them', async () => {
    const { output, report } = await convert('[{"id": "12345678901234567890"}]', {
      source: 'json',
      target: 'csv',
    });

    expect(output).toBe('id\n12345678901234567890');
    expect(losses(report)).toEqual([]);
  });

  it('tells a YAML target what its own output will hold', async () => {
    const body = await advice({ source: 'json', target: 'yaml' });
    expect(body).toContain('Quoting it in the source - `"12345678901234567890"`');
    expect(body).toContain('the YAML output then holds it as a string');
  });

  it('tells a JSON target the same thing in its own words', async () => {
    expect(await advice({ source: 'json', target: 'json' })).toContain(
      'the JSON output then holds it as a string',
    );
  });

  it('tells a CSV target that the output looks no different', async () => {
    expect(await advice({ source: 'json', target: 'csv' })).toContain(
      'a CSV cell has no type, so the output is the same either way',
    );
  });

  it('and says TSV when the target is TSV', async () => {
    expect(await advice({ source: 'json', target: 'tsv' })).toContain('a TSV cell has no type');
  });

  it('reaches a YAML source too, where JSON is in neither half', async () => {
    const { report } = await convert('id: 12345678901234567890\n', {
      source: 'yaml',
      target: 'yaml',
    });
    const body = report.notes.find((entry) => entry.title.includes('rounded'))?.body ?? '';

    expect(body).toContain('the YAML output then holds it as a string');
    expect(body).not.toContain('Convert to CSV or TSV');
  });

  /*
   * THE NEGATIVE CONTROL, ON SUBJECT. The subject is "a note about rounding",
   * not the words the advice happens to use - a control keyed on the advice
   * would pass against a note that fired on every document and simply chose
   * different advice for it. Every target, because the target is the new
   * variable and a note that appeared for one of them would be missed by a
   * control that only tried the default.
   */
  it('says nothing about rounding for a number that was not rounded, on any target', async () => {
    for (const target of ['json', 'yaml', 'csv', 'tsv']) {
      const { report } = await convert('[{"id": 42}]', { source: 'json', target });
      expect(
        report.notes.filter((entry) => entry.title.includes('rounded')),
        `target ${target}`,
      ).toEqual([]);
    }
  });
});

/* ========================================================================== *
 * Corpus row 10: a YAML key that was not text
 * ========================================================================== */

/**
 * THE HALF OF SD-5 THAT SURVIVES THE DECISION NOT TO WIDEN THE MODEL.
 *
 * `2024: launched` comes back as `"2024": launched`, because the value model
 * every conversion here goes through has text keys. Round eleven decided not
 * to carry a second model for the one case where source and target are both
 * YAML - see `VALUE_MODEL` in convert.ts - which leaves exactly one honest
 * thing to do about the loss, and nothing was doing it.
 *
 * This is corpus row 10, and it is the row that turns this round.
 */
describe('a YAML key that is not text', () => {
  it('says so, naming the key as the author wrote it', async () => {
    const { output, report } = await convert('2024: launched\n', {
      source: 'yaml',
      target: 'yaml',
    });

    expect(output).toBe('"2024": launched\n');
    const note = report.notes.find((entry) => entry.title.includes('key'));
    expect(note?.level).toBe('warn');
    expect(note?.title).toBe('1 key became text');
    expect(note?.body).toContain('`2024` at $');
  });

  it('counts them and says where each one is', async () => {
    const { report } = await convert('years:\n  2024: x\n  true: y\n', {
      source: 'yaml',
      target: 'yaml',
    });
    const note = report.notes.find((entry) => entry.title.includes('key'));

    expect(note?.title).toBe('2 keys became text');
    expect(note?.body).toContain('`2024` at $.years');
    expect(note?.body).toContain('`true` at $.years');
  });

  it('names an empty key by what it is rather than by nothing', async () => {
    // `: a` is a null key, which has no source text to quote back.
    const { report } = await convert(': a\n', { source: 'yaml', target: 'yaml' });
    expect(report.notes.find((entry) => entry.title.includes('key'))?.body).toContain(
      'an empty key, which YAML reads as null',
    );
  });

  it('says it on the way to JSON as well, because the key changed when it was read', async () => {
    const { report } = await convert('2024: launched\n', { source: 'yaml', target: 'json' });
    expect(losses(report)).toContain('1 key became text');
  });

  /*
   * THE CONTROLS. The first is the ordinary one; the second is the sharp one,
   * and it is the reason the note is built from the SOURCE spelling rather than
   * from the key that came out. `"2024"` and `2024` produce the identical
   * parsed value and the identical output, and only one of them lost anything.
   */
  it('says nothing about a key that was already text', async () => {
    const { report } = await convert('year: launched\n', { source: 'yaml', target: 'yaml' });
    expect(report.notes.filter((entry) => entry.title.includes('key'))).toEqual([]);
  });

  it('and nothing about a numeric-looking key the author quoted', async () => {
    const { output, report } = await convert('"2024": launched\n', {
      source: 'yaml',
      target: 'yaml',
    });

    expect(output).toBe('"2024": launched\n');
    expect(report.notes.filter((entry) => entry.title.includes('key'))).toEqual([]);
  });
});

/* ========================================================================== *
 * Decision 7: JSONC
 * ========================================================================== */

describe('decision 7: JSON with comments', () => {
  it('reads a tsconfig-shaped document and says what it removed', async () => {
    const { output, report } = await convert(
      '{\n  // the target\n  "target": "ES2022",\n  "strict": true,\n}',
      { target: 'json' },
    );

    expect(JSON.parse(output)).toEqual({ target: 'ES2022', strict: true });
    const note = report.notes.find((entry) => entry.title === 'Read as JSONC');
    expect(note?.level).toBe('info');
    expect(note?.body).toContain('1 comment and 1 trailing comma');
  });

  it('never folds a comment into the key after it', async () => {
    // The bug this replaces: the YAML fallback read the comment and the key as
    // ONE key, `// a comment "a"`, and reported success.
    const { output } = await convert('{\n  // a comment\n  "a": 1\n}', { target: 'json' });
    expect(Object.keys(JSON.parse(output) as object)).toEqual(['a']);
  });

  it('says nothing about JSONC for a document with neither', async () => {
    const { report } = await convert('{"a": 1}', { target: 'json' });
    expect(report.notes).toEqual([]);
  });

  it('says nothing for a document whose only slashes are inside strings', async () => {
    // A stripper that had stopped tracking string state would both report a
    // comment here and change the value.
    const { output, report } = await convert('{"url": "https://example.com/a"}', {
      target: 'json',
    });

    expect(JSON.parse(output)).toEqual({ url: 'https://example.com/a' });
    expect(report.notes).toEqual([]);
  });
});

/* ========================================================================== *
 * The YAML stream
 * ========================================================================== */

describe('a stream of documents', () => {
  it('writes a stream back as a stream, and says that is what happened', async () => {
    const source = 'apiVersion: v1\n---\napiVersion: v2\n';
    const { output, report } = await convert(source, { target: 'yaml' });

    expect(output).toBe('---\napiVersion: v1\n---\napiVersion: v2\n');
    const note = report.notes.find((entry) => entry.title.includes('stream'));
    // Not a loss: the stream survived. The level is what the canvas reads.
    expect(note?.level).toBe('info');
    expect(note?.title).toBe('Read as a stream of 2 documents, and written back as one');
    expect(report.from.documents).toBe(2);
  });

  it('reports the flattening when the target cannot hold a stream', async () => {
    const { output, report } = await convert('a: 1\n---\nb: 2\n', { target: 'json' });

    expect(JSON.parse(output)).toEqual([{ a: 1 }, { b: 2 }]);
    expect(losses(report)).toContain('A stream of 2 documents became an array');
  });

  it('keeps the empty document a trailing separator declares', async () => {
    /*
     * The yaml-test-suite's PUW8, and js-yaml and PyYAML agree: `---` starts a
     * document and an empty one is null. Dropping it made a five-document
     * stream come back as four elements with no error.
     */
    const { output, report } = await convert('a: 1\n---\n', { target: 'json' });

    expect(JSON.parse(output)).toEqual([{ a: 1 }, null]);
    expect(report.from.documents).toBe(2);
  });

  it('says nothing about a stream for a single document', async () => {
    const { report } = await convert('a: 1\n', { target: 'json' });
    expect(report.notes).toEqual([]);
    expect(report.from.documents).toBeNull();
  });

  it('reports JSON Lines as the stream it is', async () => {
    const { report } = await convert('{"a": 1}\n{"a": 2}\n', { target: 'json' });
    expect(losses(report)).toContain('A stream of 2 documents became an array');
  });
});

/* ========================================================================== *
 * The byte order mark
 * ========================================================================== */

describe('a byte order mark', () => {
  it('is reported when bytes arrive carrying one', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"a": 1}')]);
    const { output, report } = await convert(bytes, { target: 'json' });

    expect(JSON.parse(output)).toEqual({ a: 1 });
    expect(titles(report)).toContain('A byte order mark was removed');
  });

  it('is reported when the text itself begins with one', async () => {
    const { report } = await convert('﻿{"a": 1}', { target: 'json' });
    expect(titles(report)).toContain('A byte order mark was ignored');
  });

  it('says nothing for the same document without one', async () => {
    const bytes = new TextEncoder().encode('{"a": 1}');
    const { report } = await convert(bytes, { target: 'json' });
    expect(report.notes).toEqual([]);
  });
});

/* ========================================================================== *
 * What the reports say, asked of the things nothing was asking
 * ========================================================================== */

/**
 * ROUND FOUR: THE ASSERTIONS THAT COULD NOT FAIL.
 *
 * Every test below was written because a deliberate break of the code it
 * describes changed nothing that any test noticed. They are not new behaviour;
 * they are the claims docs/conversion-matrix.md already makes, asked out loud.
 */
describe('the claims the reports make about themselves', () => {
  /*
   * THE PATH IS THE WHOLE VALUE OF THE REPORT, AND IT WAS WRONG FOR A SEQUENCE.
   *
   * `yamlPath` pairs each ancestor with the next one, and the last ancestor has
   * no next - so the step into the visited node itself was dropped. For a map
   * that is invisible (a Pair always stands between a scalar and its map); for
   * a sequence the item IS the child, and the index went missing.
   *
   * Measured before the fix, on `- <big>\n- <big>`: `At $, $` - one path, twice,
   * for two different numbers, in the report whose entire claim is that it says
   * WHICH. The instrument that decides it is the JSON reader, which answers the
   * same question about the same document through a completely separate route -
   * a scanner over the source text in `lib/jsonNumbers.ts` rather than the YAML
   * library's own node tree.
   */
  const BIG = '12345678901234567890';
  const ALSO_BIG = '99999999999999999999';

  it('names a rounded integer in a YAML sequence by its index', async () => {
    const { report } = await convert(`- ${BIG}\n- ${ALSO_BIG}\n`, {
      source: 'yaml',
      target: 'yaml',
    });

    const note = report.notes.find((entry) => entry.title.includes('rounded'));
    expect(note?.body).toContain('At $[0], $[1].');
  });

  it('and gives the same answer the JSON reader gives for the same document', async () => {
    // Two readers, two mechanisms, one document. This is what turned "the path
    // looks odd" into "the path is wrong".
    const asYaml = await convert(`- ${BIG}\n- ${ALSO_BIG}\n`, { source: 'yaml', target: 'json' });
    const asJson = await convert(`[${BIG}, ${ALSO_BIG}]`, { source: 'json', target: 'json' });

    const paths = (report: Report): string =>
      report.notes.find((entry) => entry.title.includes('rounded'))?.body.split('At ')[1] ?? '';

    expect(paths(asYaml.report)).not.toBe('');
    expect(paths(asYaml.report)).toBe(paths(asJson.report));
  });

  it('names one nested two sequences deep', async () => {
    const { report } = await convert(`a:\n  - - ${BIG}\n`, { source: 'yaml', target: 'json' });
    expect(titles(report)).toContain('The number at $.a[0][0] was rounded');
  });

  /*
   * THE CAP IS FIVE, WHICH THE MATRIX SAYS AND NOTHING CHECKED. Every list in
   * these reports is capped with a count, because a thousand-row export with
   * one nested column would otherwise produce a thousand paths. Six paths and
   * "and 1 more" reads exactly like five paths and "and 2 more" unless somebody
   * counts.
   */
  it('lists five paths and counts the rest', async () => {
    const rows = Array.from({ length: 7 }, (_unused, index) => ({
      [`k${String(index)}`]: { deep: index },
    }));
    const { report } = await convert(JSON.stringify(rows), { source: 'json', target: 'csv' });

    const nested = report.notes.find((entry) => entry.title.includes('nested values'));
    expect(nested?.title).toBe('7 nested values were written into their cells as JSON');
    expect(nested?.body).toContain('$[4].k4');
    expect(nested?.body).not.toContain('$[5].k5');
    expect(nested?.body).toContain('and 2 more');

    const absent = report.notes.find((entry) => entry.title.includes('absent from some rows'));
    expect(absent?.title).toBe('7 columns were absent from some rows');
    expect(absent?.body).toContain('k5,');
    expect(absent?.body).not.toContain('k6');
    expect(absent?.body).toContain('and 2 more');
  });

  it('names every path when there are five or fewer, with no count', async () => {
    // The negative control for the cap: at the boundary the sentence must not
    // grow a "more" clause for a list that has nothing more in it.
    const rows = Array.from({ length: 5 }, (_unused, index) => ({ k: { deep: index } }));
    const { report } = await convert(JSON.stringify(rows), { source: 'json', target: 'csv' });

    const nested = report.notes.find((entry) => entry.title.includes('nested values'));
    expect(nested?.body).toContain('$[4].k');
    expect(nested?.body).not.toContain('more');
  });
});

/* -------------------------------------------------------------------------- *
 * The flag on the port
 * -------------------------------------------------------------------------- */

describe('the `detected` flag the report carries', () => {
  /*
   * A FIELD ON A PORT THAT NOTHING IN THE APP READS IS STILL A PROMISE.
   *
   * The summary says `CSV (detected) → JSON` and that word IS asserted. The
   * boolean beside it is a separate value, on a `json` port anything on the
   * canvas can be wired to, and inverting it changed nothing any test noticed -
   * so the report would have said it guessed when the user had chosen, and
   * chosen when it had guessed, to every reader but the panel.
   */
  it('is true when the format was guessed and false when it was chosen', async () => {
    const guessed = await convert('name,age\nada,36\ngrace,45', { target: 'json' });
    expect(guessed.report.detected).toBe(true);
    expect(guessed.report.summary).toContain('(detected)');

    const told = await convert('name,age\nada,36\ngrace,45', { source: 'csv', target: 'json' });
    expect(told.report.detected).toBe(false);
    expect(told.report.summary).not.toContain('(detected)');
  });
});
