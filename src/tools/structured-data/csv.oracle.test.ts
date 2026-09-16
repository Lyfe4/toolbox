import { describe, expect, it } from 'vitest';

import { parseCsvRows, recordsToCsv } from './csv';
import oracle from './spec/csv-oracle.json';

/**
 * THE CSV PARSER AND WRITER, AGAINST AN IMPLEMENTATION NEITHER OF THEM SHARES
 * A LINE WITH.
 *
 * Every expected value in this file was produced by CPython's `csv` module in
 * its default `excel` dialect - `csv.reader` for the first half and
 * `csv.writer` for the second - and committed to
 * [`spec/csv-oracle.json`](./spec/csv-oracle.json). The generator is
 * `scripts/generate-csv-oracle.py`; nothing here shells out at test time, so
 * the suite needs no Python and the fixture is a diff when it changes.
 *
 * WHY AN ORACLE AND NOT MORE EXAMPLES. RFC 4180 is three pages and says
 * nothing about most of what a real file does: a lone CR terminator, a blank
 * line in the middle, a quote that opens mid-field, a field of nothing but
 * quotes. Every expected value this repository wrote for those was written by
 * reading this parser and agreeing with it, which is not a test of anything.
 * Python's module is the one every data pipeline in the world reads CSV with,
 * it was written from the same RFC, and it has no relationship to this code.
 *
 * THREE DIVERGENCES ARE DELIBERATE, and each is asserted below as itself
 * rather than filtered out silently:
 *
 *   1. A BLANK LINE. `csv.reader` yields `[]` for one; this parser drops it.
 *      Neither is in the RFC, which has no blank lines at all. Dropping is
 *      what makes a trailing newline and a mid-file blank line behave the same
 *      way, which is the property a person actually relies on, and a `[]` row
 *      would become a record with every column empty two steps later.
 *   2. THE LAST RECORD'S TERMINATOR. Python writes one; this writer does not.
 *      RFC 4180 says the last record may or may not have an ending line break.
 *   3. EDGE WHITESPACE. This writer quotes a field with a leading or trailing
 *      space; Python leaves it bare. Both are legal and mean the same field -
 *      which the oracle itself says, because it was asked to read both
 *      spellings and returned the same string for each. It is quoted here
 *      because `rowsToRecords` TRIMS an unquoted header cell, so a column
 *      genuinely named `" a"` would come back called `"a"` if the quotes were
 *      dropped on the way out.
 */

interface ReadCase {
  readonly name: string;
  readonly delimiter: string;
  readonly source: string;
  readonly rows: readonly (readonly string[])[];
}

interface WriteCase {
  readonly name: string;
  readonly delimiter: string;
  readonly rows: readonly (readonly string[])[];
  readonly csv: string;
}

const readCases = oracle.read as readonly ReadCase[];
const writeCases = oracle.write as readonly WriteCase[];

/** Python's answer with the rows this parser is documented not to produce. */
function withoutBlankRows(rows: readonly (readonly string[])[]): readonly (readonly string[])[] {
  return rows.filter((row) => row.length > 0);
}

describe('reading, against CPython csv.reader', () => {
  it('has a corpus to check at all', () => {
    // The assertions below are all equalities against fixture data, and an
    // empty fixture satisfies every one of them. This is what says the file
    // was really loaded.
    expect(readCases.length).toBeGreaterThan(20);
    expect(oracle.generator).toContain('csv module');
  });

  it.each(readCases.map((entry) => [entry.name, entry] as const))(
    'reads %s the way Python does',
    (_name, entry) => {
      const result = parseCsvRows(entry.source, entry.delimiter);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.map((row) => row.fields)).toEqual(withoutBlankRows(entry.rows));
    },
  );

  it('drops a blank line where Python yields an empty row', () => {
    // The divergence, stated rather than hidden inside the filter above.
    const entry = readCases.find((candidate) => candidate.name === 'blank line between records');
    expect(entry).toBeDefined();
    if (!entry) return;

    expect(entry.rows).toContainEqual([]);

    const result = parseCsvRows(entry.source, entry.delimiter);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.every((row) => row.fields.length > 0)).toBe(true);
  });
});

describe('writing, against CPython csv.writer', () => {
  it('has a corpus to check at all', () => {
    expect(writeCases.length).toBeGreaterThan(8);
  });

  /**
   * The writer takes records rather than rows, so each case is fed as an array
   * of objects built from the oracle's own header row. That is the only shape
   * this tool can write, and it is what the tool's `output` port carries.
   */
  it.each(writeCases.map((entry) => [entry.name, entry] as const))(
    'writes %s the way Python does',
    (_name, entry) => {
      const [header, ...body] = entry.rows;
      expect(header).toBeDefined();
      if (!header) return;

      const records = body.map((row) =>
        Object.fromEntries(header.map((column, index) => [column, row[index] ?? ''])),
      );

      const result = recordsToCsv(records, entry.delimiter);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      /*
       * Python's writer terminates every record, including the last. This one
       * does not - see the conversion matrix - so the comparison is made
       * against the oracle with its final terminator removed, and the
       * difference is asserted on its own below rather than absorbed here.
       */
      const expected = entry.csv.replace(/\n$/, '');
      if (!QUOTES_EDGE_WHITESPACE.includes(entry.name)) {
        expect(result.value).toBe(expected);
        return;
      }

      // The third divergence. It is not "close enough": the two strings are
      // compared exactly, against Python's answer with the one pair of quotes
      // this writer adds and Python does not.
      const split = expected.lastIndexOf('\n');
      const quoted = `${expected.slice(0, split + 1)}"${expected.slice(split + 1)}"`;
      expect(result.value).toBe(quoted);
    },
  );

  /**
   * The two cases where this writer quotes and Python does not. Named rather
   * than detected, so a third one appearing is a failure rather than a silent
   * widening of the exception.
   */
  const QUOTES_EDGE_WHITESPACE = ['leading space', 'trailing space'];

  it.each([
    [
      ' x',
      'leading space, quoted as this tool writes it',
      'leading space, unquoted as Python writes it',
    ],
    [
      'x ',
      'trailing space, quoted as this tool writes it',
      'trailing space, unquoted as Python writes it',
    ],
  ])('reads %j back identically from either spelling', (field, quotedCase, bareCase) => {
    /*
     * The oracle's verdict on both spellings of the field this writer quotes.
     * It is the whole justification for the divergence: the extra quotes are
     * spelling, not meaning, and the thing saying so is not this codebase.
     */
    const quoted = readCases.find((entry) => entry.name === quotedCase);
    const bare = readCases.find((entry) => entry.name === bareCase);

    expect(quoted?.rows).toEqual([['a'], [field]]);
    expect(bare?.rows).toEqual([['a'], [field]]);
  });

  it('writes no terminator after the last record, where Python writes one', () => {
    const entry = writeCases.find((candidate) => candidate.name === 'plain');
    expect(entry).toBeDefined();
    if (!entry) return;

    expect(entry.csv.endsWith('\n')).toBe(true);

    const result = recordsToCsv([{ name: 'ada', age: '36' }], ',');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.endsWith('\n')).toBe(false);
  });
});
