import { describe, expect, it } from 'vitest';

import { lossSummary, SUMMARY_LIMIT } from '@/features/canvas/resultSummary';
import { TOOL_MANIFEST } from '@/features/registry/manifest';
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
 * Corpus rows 4 to 9: what YAML has that the value model does not
 * ========================================================================== */

/**
 * FOUR ROWS OF THE LOSS TABLE, AND ONE NOTE.
 *
 * docs/conversion-matrix.md carried `YAML → JSON` as `lossy, told` from round
 * three to round eight for a comment, an anchor, a tag and a block style, and
 * no builder for any such note existed anywhere in this tool. These are the
 * notes, and the negative control beside each one is what stops the cure being
 * worse: a comment is in nearly every real config file, so a note about one
 * that fired on a document without one would be the note that teaches people
 * to stop reading notes.
 *
 * The broader question - does it fire ONLY when it should, over documents
 * nobody chose for it - is asked of 284 of them in `presentation.sweep.test.ts`.
 */
describe('a YAML comment, which no target can hold', () => {
  it('says so, and quotes the comment', async () => {
    const { report } = await convert('# why this column exists\nretries: 3\n', {
      source: 'yaml',
      target: 'json',
    });

    const note = report.notes.find((entry) => entry.title.includes('comment'));
    expect(note?.level).toBe('warn');
    expect(note?.title).toBe('Not carried over: 1 comment');
    expect(note?.body).toContain('`# why this column exists`');
  });

  it('says nothing for the same document without one', async () => {
    const { report } = await convert('retries: 3\n', { source: 'yaml', target: 'json' });
    expect(losses(report)).toEqual([]);
  });

  it('says it on a YAML target too, where the output has no comment either', async () => {
    const { output, report } = await convert('# keep me\nretries: 3\n', {
      source: 'yaml',
      target: 'yaml',
    });

    expect(losses(report)).toEqual(['Not carried over: 1 comment']);
    // The claim, checked against the thing it is a claim about.
    expect(output).not.toContain('#');
  });

  it('counts a comment on a document the reader drops as empty', async () => {
    /*
     * The yaml-test-suite's M7A3 puts `# No document` between two `...`
     * markers, and the library hangs it on the CONTENTS of a document with
     * nothing in it - which `isEmptyDocument` filters out before anything
     * walks it. Found by the sweep rather than by reading the code, and it is
     * why comments are collected in a pass of their own over every document
     * the parser produced rather than over the ones that survived.
     */
    const { report } = await convert('a: 1\n...\n# no document here\n...\nb: 2\n', {
      source: 'yaml',
      target: 'json',
    });

    const note = report.notes.find((entry) => entry.title.includes('comment'));
    expect(note?.body).toContain('`# no document here`');
  });

  it('says nothing about a comment for a document that is JSON', async () => {
    /*
     * THE CROSS-SUBJECT CONTROL. `#` is a comment in YAML and four characters
     * of a colour in JSON, and this tool reads near-JSON through a YAML
     * fallback - so "no note about YAML comments on a JSON document" is a
     * claim about routing, not a tautology.
     */
    const { report } = await convert('{"colour": "#ff0000", "note": "# not a comment"}', {
      source: 'json',
      target: 'yaml',
    });
    expect(losses(report)).toEqual([]);
  });
});

describe('a YAML anchor, which is expanded rather than dropped', () => {
  it('names the anchor and says the alias became a copy', async () => {
    const { report } = await convert('defaults: &defaults\n  retries: 3\nservice: *defaults\n', {
      source: 'yaml',
      target: 'json',
    });

    const note = report.notes.find((entry) => entry.title.includes('anchor'));
    expect(note?.title).toBe('Not carried over: 1 anchor');
    /*
     * ROUND EIGHT'S CORRECTION, IN THE PRODUCT RATHER THAN IN A DOCUMENT. The
     * write-up said anchors were "dropped"; they are EXPANDED, so the output
     * is BIGGER than the source and it is the reference that went. A note
     * saying "dropped" would describe a smaller document than the one the
     * reader is holding.
     */
    expect(note?.body).toContain('`&defaults`');
    expect(note?.body).toContain('EXPANDED');
    expect(note?.body).toContain('larger than the source');
  });

  it('says nothing for the same document written out in full', async () => {
    const { report } = await convert('defaults:\n  retries: 3\nservice:\n  retries: 3\n', {
      source: 'yaml',
      target: 'json',
    });
    expect(losses(report)).toEqual([]);
  });

  it('says only the name goes when nothing aliases it', async () => {
    // An anchor with no alias expands nothing, so the sentence about a copy
    // would be false. Two shapes, two sentences, and this is the one that says
    // the value is unchanged.
    const { report } = await convert('defaults: &unused\n  retries: 3\n', {
      source: 'yaml',
      target: 'yaml',
    });

    const note = report.notes.find((entry) => entry.title.includes('anchor'));
    expect(note?.body).toContain('no alias pointing at it');
    expect(note?.body).not.toContain('EXPANDED');
  });
});

describe('a YAML tag, which the value model has no place for', () => {
  it('names a custom tag as the author wrote it', async () => {
    const { report } = await convert('custom: !mytype\n  a: 1\n', {
      source: 'yaml',
      target: 'json',
    });

    const note = report.notes.find((entry) => entry.title.includes('tag'));
    expect(note?.title).toBe('Not carried over: 1 tag');
    expect(note?.body).toContain('`!mytype`');
  });

  it('names a standard tag the way it is written rather than as a URI', async () => {
    /*
     * The library resolves `!!str` to `tag:yaml.org,2002:str`, which is correct
     * and is not what is in the document. A note naming a URI the author never
     * typed is a note about somebody else's file.
     */
    const { report } = await convert('typed: !!str 7\n', { source: 'yaml', target: 'json' });

    const note = report.notes.find((entry) => entry.title.includes('tag'));
    expect(note?.body).toContain('`!!str`');
    expect(note?.body).not.toContain('yaml.org');
  });

  it('says nothing for the same document untagged', async () => {
    const { report } = await convert('custom:\n  a: 1\n', { source: 'yaml', target: 'json' });
    expect(losses(report)).toEqual([]);
  });
});

describe('a YAML scalar style, which depends on the target and on the style', () => {
  it('reports a block scalar by path on the way to JSON', async () => {
    const { report } = await convert('description: |\n  one\n  two\n', {
      source: 'yaml',
      target: 'json',
    });

    const note = report.notes.find((entry) => entry.title.includes('style'));
    expect(note?.title).toBe('Not carried over: 1 block style');
    expect(note?.body).toContain('$.description');
  });

  it('says NOTHING about a literal block on a YAML target, because it survives', async () => {
    /*
     * MEASURED AGAINST THE WRITER RATHER THAN PREDICTED, and the output below
     * is the measurement. A literal block keeps its line breaks in the VALUE,
     * so a YAML target writes it back as a literal block and the document does
     * not change - reporting that would be a `warn` about nothing, which is
     * the one thing lib/notes.ts says the level may never be.
     *
     * The assertion on the output is what makes the silence above safe: if the
     * writer ever stops reproducing the block, this fails rather than leaving
     * a silent loss behind a passing test.
     */
    const { output, report } = await convert('description: |\n  one\n  two\n', {
      source: 'yaml',
      target: 'yaml',
    });

    expect(output).toContain('description: |');
    expect(losses(report)).toEqual([]);
  });

  it('and reports a FOLDED one on a YAML target, because the folding already happened', async () => {
    /*
     * The other half of the same measurement. `>` folds in the READER, so
     * `three\nfour` is `three four` before any writer sees it and there is
     * nothing left to put back. The output proves it: the folded block comes
     * back as a literal.
     */
    const { output, report } = await convert('description: >\n  one\n  two\n', {
      source: 'yaml',
      target: 'yaml',
    });

    expect(losses(report)).toEqual(['Not carried over: 1 block style']);
    expect(output).toContain('one two');
    expect(output).not.toContain('description: >');
  });

  it('reports a literal whose value has no line break left in it', async () => {
    // `|-` strips the trailing break, so a one-line literal reads to a value
    // with nothing in it to carry the style, and the writer writes a plain
    // scalar. Eight documents in the yaml-test-suite are this shape.
    const { output, report } = await convert('description: |-\n  only\n', {
      source: 'yaml',
      target: 'yaml',
    });

    expect(losses(report)).toEqual(['Not carried over: 1 block style']);
    expect(output).toBe('description: only\n');
  });

  it('reports a literal used as a key, which is written plain whatever it holds', async () => {
    const { report } = await convert('? |\n  block key\n: value\n', {
      source: 'yaml',
      target: 'yaml',
    });
    expect(losses(report)).toEqual(['Not carried over: 1 block style']);
  });

  it('explains folding only on a document that has a folded scalar', async () => {
    /*
     * The body's sentence about folding is a fact about `>`. On a document
     * whose only reported block is a literal that lost its style for a
     * different reason, printing it would be a true statement about something
     * the reader did not write - the smaller cousin of the note that cries
     * wolf, and the one this pair keeps out.
     */
    const folded = await convert('description: >\n  one\n  two\n', {
      source: 'yaml',
      target: 'yaml',
    });
    const literal = await convert('description: |-\n  only\n', { source: 'yaml', target: 'yaml' });

    const body = (report: Report): string =>
      report.notes.find((entry) => entry.title.includes('style'))?.body ?? '';

    expect(body(folded.report)).toContain('folded by the READER');
    expect(body(literal.report)).not.toContain('folded');
    // Both really did produce the note, or the line above passes on an absence.
    expect(body(literal.report)).toContain('$.description');
  });

  it('says nothing about style for a plain scalar', async () => {
    const { report } = await convert('description: one two\n', { source: 'yaml', target: 'yaml' });
    expect(losses(report)).toEqual([]);
  });

  it('says nothing about style for a quoted one either', async () => {
    /*
     * The boundary this note does NOT claim, asserted so that widening it is a
     * decision rather than a drift. Single versus double quoting is a style
     * too, and warning about every quoted string in every document is the note
     * that cries wolf - so quoting is out of scope and the control says so.
     */
    const { report } = await convert("description: 'one two'\n", {
      source: 'yaml',
      target: 'yaml',
    });
    expect(losses(report)).toEqual([]);
  });
});

describe('four losses at once, which is what a real config file looks like', () => {
  const RICH =
    '# why this exists\ndefaults: &defaults\n  retries: 3\nservice: *defaults\ncustom: !mytype\n  a: 1\ntext: |\n  one\n  two\n';

  it('produces ONE note whose title is the census', async () => {
    /*
     * THE ROUND'S ONE DESIGN DECISION, ASSERTED RATHER THAN DESCRIBED.
     *
     * One note per kind is four warnings on an ordinary manifest, and a canvas
     * node shows ONE line - so three of the four would live behind a `+3 more`
     * nobody opens. The four have one cause and one remedy, so they are one
     * fact with a census; the title names every kind present, which is what
     * keeps each row's negative control able to fail.
     */
    const { report } = await convert(RICH, { source: 'yaml', target: 'json' });

    expect(losses(report)).toEqual(['Not carried over: 1 comment, 1 anchor, 1 tag, 1 block style']);
  });

  it('fits the 60 characters a node prints, with every kind still named', async () => {
    /*
     * The title used to read `... were not carried over`, which is 68
     * characters for this document - so a node drew `...were not car…` and
     * clipped the only part that said anything had happened. Leading with the
     * claim clips the tail of an enumeration instead. `SUMMARY_LIMIT` is
     * imported rather than written as 60, because the two must move together.
     */
    const { report } = await convert(RICH, { source: 'yaml', target: 'json' });
    const title = losses(report)[0] ?? '';

    expect(title.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
    for (const kind of ['comment', 'anchor', 'tag', 'block style']) {
      expect(title).toContain(kind);
    }
  });

  it('counts the same kind rather than listing it forever', async () => {
    // Six comments is one clause, not six notes. The bargain every list in
    // these reports strikes, at the boundary where the count starts.
    const source = `${'# one\n'.repeat(6)}a: 1\n`;
    const { report } = await convert(source, { source: 'yaml', target: 'json' });

    const note = report.notes.find((entry) => entry.title.includes('comment'));
    expect(note?.title).toBe('Not carried over: 6 comments');
    expect(note?.body).toContain('and 3 more');
  });
});

describe('the most notes one run can produce, and the order they arrive in', () => {
  /*
   * WHAT SIX NOTES LOOK LIKE, PINNED RATHER THAN DESCRIBED.
   *
   * A YAML stream carrying a comment, an anchor, a tag and a rounded integer,
   * converted to CSV, is the worst case this tool has: three read-half losses,
   * the stream, and both write-half losses. Round twelve added four of the
   * possible titles, so the question "is the panel still readable" stopped
   * being hypothetical - and the answer is a list a person can act on, because
   * every entry has a different remedy.
   *
   * THE ORDER IS THE POINT, and it is the reason this is a test rather than a
   * paragraph. A node prints the FIRST warn title and counts the rest, so the
   * order `readYamlSource` pushes its notes in decides what a person standing
   * at a canvas sees. A rounded integer changes the VALUE; a dropped comment
   * changes how it is written. Swapping them loses nothing a test would
   * otherwise notice, which is exactly why one says so here.
   */
  const WORST =
    '# a comment\nshared: &shared\n  q: 1\n---\nrows: !mytype\n  - id: 12345678901234567890\n';

  it('lists every loss once, with the value losses in front of the presentation ones', async () => {
    const { report } = await convert(WORST, { source: 'yaml', target: 'csv' });

    expect(losses(report)).toEqual([
      'The number at $[1].rows[0].id was rounded',
      'Not carried over: 1 comment, 1 anchor, 1 tag',
      'A stream of 2 documents became an array',
      '2 nested values were written into their cells as JSON',
      '2 columns were absent from some rows',
    ]);
  });

  it('and a node prints the first of them with a count for the rest', async () => {
    /*
     * The canvas half of the same claim. `lossSummary` is imported from the
     * module the canvas uses rather than re-implemented, so a change to how a
     * node summarises reaches this test instead of going unnoticed.
     */
    const result = await structuredDataTool.run({
      inputs: { input: { type: 'text', text: WORST } },
      options: {
        ...(structuredDataTool.defaultOptions as Record<string, unknown>),
        source: 'yaml',
        target: 'csv',
      },
      context,
    });
    expect(result.ok).toBe(true);

    const entry = TOOL_MANIFEST.find((tool) => tool.id === 'structured-data');
    const face = entry === undefined || !result.ok ? null : lossSummary(entry, result.value);
    expect(face).toBe('The number at $[1].rows[0].id was rounded · +4 more');
    expect((face ?? '').length).toBeLessThanOrEqual(SUMMARY_LIMIT);
  });
});

/* ========================================================================== *
 * Corpus row 12: a JSON key written twice
 * ========================================================================== */

describe('a duplicate JSON key, where the last one wins', () => {
  it('names the key, its path and the value that lost', async () => {
    const { report } = await convert('{"retries": 3, "retries": 5}', {
      source: 'json',
      target: 'json',
    });

    const note = report.notes.find((entry) => entry.title.includes('duplicate'));
    expect(note?.level).toBe('warn');
    expect(note?.title).toBe('1 duplicate key was discarded');
    expect(note?.body).toContain('$.retries discarded `3`');
  });

  it('says nothing for a document whose keys are all distinct', async () => {
    const { report } = await convert('{"retries": 5, "tries": 3}', {
      source: 'json',
      target: 'json',
    });
    expect(losses(report)).toEqual([]);
  });

  it('is not confused by the same key in two different objects', async () => {
    /*
     * THE CONTROL THAT DECIDES WHETHER THE SCANNER TRACKS SCOPE. `retries` in
     * two sibling objects is two keys, not one written twice, and a scanner
     * that kept one set for the whole document would call every normal array
     * of records a duplicate.
     */
    const { report } = await convert('[{"retries": 3}, {"retries": 5}]', {
      source: 'json',
      target: 'json',
    });
    expect(losses(report)).toEqual([]);
  });

  it('names a nested one by its path', async () => {
    const { report } = await convert('{"a": [{"b": {"k": 1, "k": 2}}]}', {
      source: 'json',
      target: 'json',
    });

    const note = report.notes.find((entry) => entry.title.includes('duplicate'));
    expect(note?.body).toContain('$.a[0].b.k discarded `1`');
  });

  it('quotes a discarded object rather than printing the whole thing', async () => {
    const big = JSON.stringify({ padding: 'x'.repeat(200) });
    const { report } = await convert(`{"k": ${big}, "k": 1}`, { source: 'json', target: 'json' });

    const note = report.notes.find((entry) => entry.title.includes('duplicate'));
    expect(note?.body).toContain('…');
    expect(note?.body).not.toContain('x'.repeat(100));
  });

  it('counts three of them and reports each', async () => {
    const { report } = await convert('{"a": 1, "a": 2, "b": 3, "b": 4, "b": 5}', {
      source: 'json',
      target: 'json',
    });

    const note = report.notes.find((entry) => entry.title.includes('duplicate'));
    expect(note?.title).toBe('3 duplicate keys were discarded');
  });

  it('survives the JSONC step, which strips comments before parsing', async () => {
    /*
     * The stripper blanks a comment to spaces of the same length rather than
     * removing it, so the scanner runs over a document with the same offsets -
     * which is exactly why the duplicate is still findable afterwards and the
     * path still points where the reader is looking.
     */
    const { report } = await convert('{\n  // a note\n  "retries": 3,\n  "retries": 5,\n}', {
      target: 'json',
    });

    expect(titles(report)).toContain('Read as JSONC');
    expect(losses(report)).toContain('1 duplicate key was discarded');
  });

  it('treats the same key on two JSON Lines records as two keys', async () => {
    // Each line is its own document, so this is the JSON Lines shape of the
    // sibling-objects control above.
    const { report } = await convert('{"a": 1}\n{"a": 2}\n', { target: 'json' });
    expect(losses(report)).not.toContain('1 duplicate key was discarded');
  });

  it('and reports one written twice inside a single record', async () => {
    const { report } = await convert('{"a": 1, "a": 2}\n{"b": 3}\n', { target: 'json' });

    const note = report.notes.find((entry) => entry.title.includes('duplicate'));
    expect(note?.body).toContain('$[0].a');
  });

  it('is a note for JSON and still a refusal for YAML, which is the other spec', async () => {
    /*
     * The boundary, stated as a test because the two readers deliberately
     * disagree: RFC 8259 permits a repeated key and leaves the behaviour
     * undefined, YAML 1.2 makes it an error. Refusing the JSON would make this
     * tool the odd one out on a file every other reader opens.
     */
    await expect(convert('a: 1\na: 2\n', { source: 'yaml', target: 'yaml' })).rejects.toThrow(
      /the same key twice/iu,
    );
  });
});

/* ========================================================================== *
 * Corpus row 11: a CSV header cell that was trimmed
 * ========================================================================== */

describe('a CSV header cell whose spaces were removed', () => {
  it('says so, and shows the cell with its spaces', async () => {
    const { report } = await convert('alpha, shipped at \n1,2\n', {
      source: 'csv',
      target: 'json',
    });

    const note = report.notes.find((entry) => entry.title.includes('trimmed'));
    expect(note?.level).toBe('warn');
    expect(note?.title).toBe('1 header cell was trimmed');
    expect(note?.body).toContain('" shipped at " became `shipped at`');
    expect(note?.body).toContain('Quote the cell - `" shipped at "`');
  });

  it('says nothing for the same header with no spaces in it', async () => {
    const { report } = await convert('alpha,shipped at\n1,2\n', { source: 'csv', target: 'json' });
    expect(losses(report)).toEqual([]);
  });

  it('says nothing for a cell whose author quoted the spaces', async () => {
    /*
     * Quoting is the author saying the spaces are part of the name, so nothing
     * is trimmed and nothing was lost. The control for the control: this is
     * the one header shape that looks like the subject and is not it.
     */
    const { report } = await convert('alpha," shipped at "\n1,2\n', {
      source: 'csv',
      target: 'json',
    });
    expect(losses(report)).toEqual([]);
  });

  it('says nothing about trimming for an empty cell it had to name', async () => {
    // An empty cell is not trimmed, it is replaced - a different decision with
    // a different name, and conflating the two would put a note about lost
    // spaces on a header that had none.
    const { report } = await convert('alpha,,c\n1,2,3\n', { source: 'csv', target: 'json' });
    expect(losses(report)).toEqual([]);
  });

  it('counts several and names the first few', async () => {
    const header = Array.from({ length: 7 }, (_unused, index) => ` c${String(index)} `).join(',');
    const { report } = await convert(`${header}\n1,2,3,4,5,6,7\n`, {
      source: 'csv',
      target: 'json',
    });

    const note = report.notes.find((entry) => entry.title.includes('trimmed'));
    expect(note?.title).toBe('7 header cells were trimmed');
    expect(note?.body).toContain('and 2 more');
  });

  it('reaches a TSV source too, which is the same reader', async () => {
    const { report } = await convert('alpha\t shipped at \n1\t2\n', {
      source: 'tsv',
      target: 'json',
    });
    expect(losses(report)).toContain('1 header cell was trimmed');
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
