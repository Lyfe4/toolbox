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
