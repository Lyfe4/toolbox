import { describe, expect, it } from 'vitest';

import { parseCsvRows, recordsToCsv } from './csv';
import fixture from './spec/tsv-readers.json';

/**
 * SD-6: HOW THIS WRITER SPELLS A TSV CELL, HELD TO WHAT NINE READERS DO.
 *
 * TSV has no specification to be exact against, so the reference is the
 * readers themselves, asked by `scripts/generate-tsv-readers.py` and committed
 * as `spec/tsv-readers.json`. The finding offered two fixes - escape as `\t`,
 * or refuse - and the measurement rejected the first outright: no reader
 * measured decodes a backslash escape. What it supports instead is below, and
 * the claim this file makes is the one the decision rests on:
 *
 *   FOR EVERY CASE, THE SPELLING THIS WRITER CHOOSES IS READ CORRECTLY BY AS
 *   MANY READERS AS ANY SPELLING MEASURED.
 *
 * So a change to `needsQuoting` that quoted a padded cell again, or stopped
 * quoting a leading quote, fails here with the readers it lost named.
 */

interface Spelling {
  readonly written: string;
  readonly readers: Readonly<Record<string, string>>;
}

interface Case {
  readonly id: string;
  readonly value: string;
  readonly spellings: Readonly<Record<string, Spelling>>;
}

const { cases, readers } = fixture as unknown as {
  readonly cases: readonly Case[];
  readonly readers: readonly string[];
};

const score = (spelling: Spelling): number =>
  Object.values(spelling.readers).filter((verdict) => verdict === 'ok').length;

/** The data cell this writer produces for a value, as bytes. */
function writtenCell(value: string): string {
  const result = recordsToCsv([{ a: value, b: 'z' }], '\t');
  if (!result.ok) throw new Error(result.error.message);
  // `a\tb\n<cell>\tz`: everything between the header's line break and the
  // sentinel, which no case's value contains.
  return result.value.slice('a\tb\n'.length, result.value.length - '\tz'.length);
}

describe('the TSV reader measurement', () => {
  it('has the nine readers and the cases it claims to', () => {
    expect(readers).toHaveLength(9);
    expect(cases.length).toBeGreaterThanOrEqual(8);
  });

  it.each(cases.map((entry) => [entry.id, entry] as const))(
    'writes the %s case in a spelling no measured spelling beats',
    (_id, entry) => {
      const cell = writtenCell(entry.value);
      const chosen = Object.entries(entry.spellings).find(
        ([, spelling]) => spelling.written === cell,
      );

      // A spelling the fixture never measured is a decision nothing supports.
      expect(
        chosen,
        `this writer wrote ${JSON.stringify(cell)}, which was not measured`,
      ).toBeDefined();
      if (chosen === undefined) return;

      const best = Math.max(...Object.values(entry.spellings).map(score));
      const lost = Object.entries(chosen[1].readers)
        .filter(([, verdict]) => verdict !== 'ok')
        .map(([name]) => name);
      expect(score(chosen[1]), `${chosen[0]} is misread by ${lost.join(', ')}`).toBe(best);
    },
  );

  it.each(cases.map((entry) => [entry.id, entry] as const))(
    'reads its own %s spelling back as the value',
    (_id, entry) => {
      const rows = parseCsvRows(`a\tb\n${writtenCell(entry.value)}\tz`, '\t');
      expect(rows.ok).toBe(true);
      if (rows.ok) expect(rows.value[1]?.fields).toEqual([entry.value, 'z']);
    },
  );

  /*
   * The two claims the note makes, held to the fixture rather than typed into
   * a sentence: every quote-aware reader reads a quoted tab, and no spelling
   * at all works for awk or cut.
   */
  it.each(['tab', 'line break'])('says the right thing about a %s', (id) => {
    const entry = cases.find((candidate) => candidate.id === id);
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    const quoted = entry.spellings.quoted;
    const named = ['python-csv', 'pandas', 'polars', 'duckdb', 'papaparse', 'd3-dsv'];
    for (const reader of named) expect(quoted?.readers[reader], reader).toBe('ok');

    for (const spelling of Object.values(entry.spellings)) {
      expect(spelling.readers.awk).not.toBe('ok');
      expect(spelling.readers.cut).not.toBe('ok');
    }
  });

  it('rejected escaping on the evidence: no reader decodes a backslash', () => {
    const escaped = cases.flatMap((entry) =>
      entry.spellings.backslash === undefined ? [] : [entry.spellings.backslash],
    );
    expect(escaped.length).toBeGreaterThanOrEqual(3);
    for (const spelling of escaped) expect(score(spelling)).toBe(0);
  });
});
