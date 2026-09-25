import { describe, expect, it } from 'vitest';

import { summariseOutputs } from '@/features/canvas/resultSummary';
import { TOOL_MANIFEST, type ToolManifestEntry } from '@/features/registry/manifest';
import {
  bytesValue,
  type Bytes,
  type ToolOutputs,
  type ToolResult,
  type ToolRunContext,
} from '@/features/registry/types';

import { formatNamedBy } from './convert';
import structuredDataTool from './index';

/**
 * A ONE-COLUMN FILE, READ BECAUSE ITS NAME SAYS IT IS A TABLE.
 *
 * SD-1's gap was that a column of ids has no delimiter in it, so detection
 * cannot tell it from prose - and round thirteen was right that no rule on the
 * CONTENT can, because every multi-line paste is a valid one-column CSV. A file
 * called `ids.csv` has said what it is. So a file with that name, and only one
 * column, is read as the table it claims to be; everything else is decided
 * exactly as it was, and each control below is on SUBJECT - the same bytes, or
 * the same name, with one thing changed.
 */

const context: ToolRunContext = { signal: new AbortController().signal };

const AUTO = { source: 'auto', target: 'json' } as const;

const IDS = 'id\n1001\n1002\n1003\n';
const EMAILS = 'email\nada@example.com\ngrace@example.com\n';
const PEOPLE = 'name,age\nada,36\ngrace,45\n';

const encode = (text: string): Bytes => new TextEncoder().encode(text);

async function file(
  text: string,
  filename: string | null,
  options: Record<string, unknown> = AUTO,
): Promise<ToolResult<ToolOutputs>> {
  return await structuredDataTool.run({
    inputs: { input: bytesValue(encode(text), { mediaType: null, filename }) },
    options,
    context,
  });
}

async function pasted(
  text: string,
  options: Record<string, unknown> = AUTO,
): Promise<ToolResult<ToolOutputs>> {
  return await structuredDataTool.run({
    inputs: { input: { type: 'text', text } },
    options,
    context,
  });
}

interface Seen {
  readonly output: string;
  readonly summary: string;
  readonly guess: unknown;
  readonly notes: readonly { level: string; title: string; body: string }[];
}

function seen(result: ToolResult<ToolOutputs>): Seen {
  if (!result.ok) throw new Error(`refused: ${result.error.message}`);
  const report = result.value.report;
  const output = result.value.output;
  if (report?.type !== 'json' || typeof report.data !== 'object' || report.data === null) {
    throw new Error('no report');
  }
  const data = report.data as Record<string, unknown>;
  return {
    output: output?.type === 'text' ? output.text : '',
    summary: typeof data.summary === 'string' ? data.summary : '',
    guess: data.guess,
    notes: Array.isArray(data.notes)
      ? (data.notes as { level: string; title: string; body: string }[])
      : [],
  };
}

const ENTRY: ToolManifestEntry = (() => {
  const found = (TOOL_MANIFEST as readonly ToolManifestEntry[]).find(
    (tool) => tool.id === 'structured-data',
  );
  if (!found) throw new Error('structured-data is not in the manifest');
  return found;
})();

describe('formatNamedBy', () => {
  it.each([
    ['ids.csv', 'csv'],
    ['IDS.CSV', 'csv'],
    ['export.2024.tsv', 'tsv'],
    ['C:\\exports\\ids.Csv', 'csv'],
  ] as const)('reads %s as %s', (name, format) => {
    expect(formatNamedBy(name)).toBe(format);
  });

  it.each([['ids.txt'], ['ids.csv.txt'], ['csv'], ['.csv/ids'], ['ids'], ['']])(
    'claims nothing for %j',
    (name) => {
      expect(formatNamedBy(name)).toBeNull();
    },
  );

  it('claims nothing for no name, which is what pasted text and wired bytes have', () => {
    expect(formatNamedBy(null)).toBeNull();
  });
});

describe('a one-column file named .csv or .tsv', () => {
  it('is read as the table it says it is', async () => {
    const read = seen(await file(IDS, 'ids.csv'));
    expect(JSON.parse(read.output)).toEqual([{ id: '1001' }, { id: '1002' }, { id: '1003' }]);
  });

  it('reads a column of email addresses, the other shape these files come in', async () => {
    const read = seen(await file(EMAILS, 'contacts.CSV'));
    expect(JSON.parse(read.output)).toEqual([
      { email: 'ada@example.com' },
      { email: 'grace@example.com' },
    ]);
  });

  it('reads a .tsv as TSV, and says so', async () => {
    const read = seen(await file(IDS, 'ids.tsv'));
    expect(JSON.parse(read.output)).toEqual([{ id: '1001' }, { id: '1002' }, { id: '1003' }]);
    expect(read.summary).toBe('TSV (from the file name) → JSON');
  });

  it('keeps a delimiter inside a quoted cell as text, as a reader would', async () => {
    const read = seen(await file('name\n"Hopper, Grace"\n"Lovelace, Ada"\n', 'names.csv'));
    expect(JSON.parse(read.output)).toEqual([{ name: 'Hopper, Grace' }, { name: 'Lovelace, Ada' }]);
  });

  /*
   * THE REPORT SAYS A NAME DECIDED IT, in words that are not the content
   * guesses' words - `(detected)` would claim the text was read and found to
   * be CSV, which is exactly what did not happen.
   */
  it('says in its summary and in a note that the name decided it', async () => {
    const read = seen(await file(IDS, 'ids.csv'));
    expect(read.summary).toBe('CSV (from the file name) → JSON');
    expect(read.summary).not.toContain('(detected)');

    const note = read.notes.find((entry) => entry.title.includes('because the file is named'));
    expect(note?.level).toBe('info');
    expect(note?.title).toBe('Read as CSV because the file is named ids.csv');
    expect(note?.body).toContain('The name decided it');
    // Nothing was lost, so nothing may say so.
    expect(read.notes.filter((entry) => entry.level === 'warn')).toEqual([]);
  });

  it('gives a node a guess to print beside its result', async () => {
    const result = await file(IDS, 'ids.csv');
    if (!result.ok) throw new Error('refused');
    expect(seen(result).guess).toBe('CSV by its name');
    expect(summariseOutputs(ENTRY, result.value)).toBe('3 items · CSV by its name');
  });
});

describe('the controls, each on the same subject as the case it controls', () => {
  it('a .txt file with one column is refused exactly as pasted text is', async () => {
    const named = await file(IDS, 'ids.txt');
    const typed = await pasted(IDS);
    expect(named.ok).toBe(false);
    expect(typed.ok).toBe(false);
    if (named.ok || typed.ok) return;
    expect(named.error).toEqual(typed.error);
  });

  it('a file with no name at all - bytes out of another tool - is refused too', async () => {
    const result = await file(IDS, null);
    expect(result.ok).toBe(false);
  });

  it('pasted text keeps the refusal, and the refusal still says to choose CSV', async () => {
    const result = await pasted(IDS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe(
      'This is not JSON, YAML, CSV or TSV that this tool can read.',
    );
    expect(result.error.detail).toContain(
      'If it is a table with a single column, choose CSV as the source format',
    );
    expect(result.error.detail).toContain(
      'A file whose name ends in .csv or .tsv is read as a table',
    );
  });

  /*
   * SEVERAL COLUMNS, EXACTLY AS BEFORE. Not "also read as CSV": the whole
   * result, every port, equal to the same bytes under a name that claims
   * nothing - so the name changed no output, no note and no summary.
   */
  it.each([
    ['a comma table detection reads', PEOPLE],
    ['a semicolon table detection reads', 'name;age\nada;36\ngrace;45\n'],
    ['a ragged table detection refuses', 'a,b,c\n1,2\n'],
    ['a ragged semicolon table, one column under comma', 'a;b;c\n1;2\n'],
    ['a pipe table detection names', 'name|age\nada|36\ngrace|45\n'],
    ['a column holding an unquoted comma', 'name\nHopper, Grace\nLovelace, Ada\n'],
  ])('a .csv holding %s behaves as the same bytes named .txt', async (_name, text) => {
    expect(await file(text, 'data.csv')).toEqual(await file(text, 'data.txt'));
  });

  it('the name never outranks content that says what it is', async () => {
    for (const text of ['[{"id": 1}]', '---\nid: 1\n', '- 1001\n- 1002\n', 'id: 1001\n']) {
      expect(await file(text, 'ids.csv')).toEqual(await file(text, 'ids.txt'));
    }
  });

  it('a source format chosen on the panel ignores the name', async () => {
    const options = { source: 'yaml', target: 'json' };
    expect(await file(IDS, 'ids.csv', options)).toEqual(await file(IDS, 'ids.txt', options));
  });

  it('a multi-column .csv carries no guess, so its node prints only its result', async () => {
    const result = await file(PEOPLE, 'people.csv');
    if (!result.ok) throw new Error('refused');
    expect(seen(result).guess).toBeUndefined();
    expect(summariseOutputs(ENTRY, result.value)).toBe('2 items');
  });
});
