import {
  fail,
  isJsonArray,
  ok,
  type JsonValue,
  type SourcePosition,
  type ToolResult,
} from '@/features/registry/types';
import { lost, noted, type ToolNote } from '@/lib/notes';
import { setOwnProperty } from '@/lib/safeObject';
import { positionFromOffset } from '@/lib/textPosition';

/** What a CSV write produced, and what the table could not hold. */
export interface Written {
  readonly text: string;
  readonly notes: readonly ToolNote[];
  /**
   * True when the target really did write several documents into one file.
   *
   * Only YAML can, and only when the value it was handed is still the array the
   * stream was read into. The report asks the WRITER rather than guessing from
   * the source, because `sortKeys` and a value wired in on the `json` port can
   * both put a different array in front of it - and a note that says a stream
   * survived when it did not is the class of confident wrongness this round is
   * about.
   */
  readonly stream: boolean;
}

/**
 * RFC 4180 CSV, with the tolerances real files actually need.
 *
 * Hand-written rather than pulled from a library because the interesting
 * requirement here is precise error positions, and because the whole parser is
 * shorter than the adapter would be. YAML is a different story - that one is
 * left to a maintained parser.
 *
 * Handled:
 *   - quoted fields containing the delimiter, quotes ("" escapes), and newlines
 *   - CRLF, LF and lone CR line endings
 *   - a trailing newline, which does not produce a phantom empty record
 *   - blank lines, which are separators rather than records
 *   - Excel's `sep=;` first line
 *   - ragged rows, reported with the line they actually appear on
 */

/**
 * One parsed record.
 *
 * `quoted` and `line` both exist because information the parser has and throws
 * away cannot be recovered afterwards:
 *
 *   - `quoted` distinguishes `" a "` from ` a `. Header cells are trimmed, and
 *     trimming a cell whose author went to the trouble of quoting it is a
 *     silent edit. It is also what stops `a,"a "` being reported as a duplicate
 *     column when the two names are genuinely different.
 *   - `line` is the real line the record starts on. It is NOT the record index:
 *     a quoted field may contain newlines, so a file's fourth record can begin
 *     on its ninth line, and an error pointing at line 4 sends the reader to
 *     the wrong place.
 */
export interface CsvRow {
  readonly fields: readonly string[];
  readonly quoted: readonly boolean[];
  /** 1-based, counting line breaks inside quoted fields. */
  readonly line: number;
  /**
   * Where each field begins, for the FIRST record only; empty for every other.
   *
   * SD-14b: a duplicate column was reported at line 1, column 1 whichever
   * column collided, because nothing kept the position of a field once it had
   * been read. The header is the only record whose errors name a column, and a
   * position per field of a 16 MB file is memory nothing would read - so the
   * parser keeps the header's and no one else's.
   */
  readonly starts: readonly SourcePosition[];
}

/**
 * Excel writes `sep=;` as the first line when it exports with a delimiter that
 * is not the reader's locale default, and expects readers to consume it.
 *
 * Without this, such a file parses as a one-column table whose header is
 * literally `sep=` - which looks enough like a result to be believed.
 */
const SEP_DIRECTIVE = /^sep=(.)(\r\n|\r|\n)/;

export interface SepDirective {
  /** The delimiter the file declared, or null when it declared none. */
  readonly delimiter: string | null;
  /** The document with the directive line removed. */
  readonly body: string;
  /** 1-based line the body starts on, so positions stay honest. */
  readonly firstLine: number;
}

export function readSepDirective(source: string): SepDirective {
  const match = SEP_DIRECTIVE.exec(source);
  const declared = match?.[1];
  // `sep="` is not a delimiter any writer produces and is unparseable as one -
  // the quote rule would consume it before the delimiter rule ever saw it. A
  // file claiming it is treated as a file with no directive.
  if (match === null || declared === undefined || declared === '"') {
    return { delimiter: null, body: source, firstLine: 1 };
  }
  return { delimiter: declared, body: source.slice(match[0].length), firstLine: 2 };
}

/** Splits a CSV document into records of raw string fields. */
export function parseCsvRows(
  source: string,
  delimiter: string,
  firstLine = 1,
): ToolResult<CsvRow[]> {
  const rows: CsvRow[] = [];
  let fields: string[] = [];
  let quoted: boolean[] = [];
  let field = '';
  let fieldQuoted = false;
  let fieldStarted = false;
  let index = 0;
  let line = firstLine;
  let rowLine = firstLine;
  /** Offset of the first character of the current line, for columns. */
  let lineStart = 0;
  let starts: SourcePosition[] = [];
  /** Where the field being read began. Set when the previous one ended. */
  let fieldAt: SourcePosition = { line, column: 1, offset: 0 };

  const markFieldStart = (): void => {
    if (rows.length === 0) fieldAt = { line, column: index - lineStart + 1, offset: index };
  };

  const endField = (): void => {
    fields.push(field);
    quoted.push(fieldQuoted);
    if (rows.length === 0) starts.push(fieldAt);
    field = '';
    fieldQuoted = false;
    fieldStarted = false;
  };

  const endRow = (): void => {
    endField();
    /*
     * A blank line is a separator, not a record.
     *
     * The distinction is exactly quoting: a line holding nothing at all parses
     * to one empty unquoted field and carries no data, while a line holding
     * `""` is a real record whose single field is empty. Dropping the first and
     * keeping the second is what `csv.reader` does, and it is the only reading
     * under which a trailing newline and a mid-file blank line behave the same.
     */
    const isBlank = fields.length === 1 && fields[0] === '' && quoted[0] === false;
    if (!isBlank) rows.push({ fields, quoted, line: rowLine, starts });
    fields = [];
    quoted = [];
    starts = [];
    rowLine = line;
  };

  while (index < source.length) {
    const char = source[index];

    if (char === '"' && !fieldStarted) {
      // Quoted field: scan to the closing quote, treating "" as one quote.
      const openedAt = index;
      index += 1;
      let closed = false;

      while (index < source.length) {
        const inner = source[index];

        if (inner === '"') {
          if (source[index + 1] === '"') {
            field += '"';
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }

        // Line breaks inside a quoted field are content AND line breaks. They
        // are kept verbatim in the value and still counted, or every position
        // reported after a multi-line cell points too high up the file.
        if (inner === '\r') {
          if (source[index + 1] === '\n') {
            field += '\r\n';
            index += 2;
          } else {
            field += '\r';
            index += 1;
          }
          line += 1;
          lineStart = index;
          continue;
        }
        if (inner === '\n') {
          field += '\n';
          index += 1;
          line += 1;
          lineStart = index;
          continue;
        }

        field += inner ?? '';
        index += 1;
      }

      if (!closed) {
        return fail('parse-error', 'Unterminated quoted field: the closing " is missing.', {
          position: positionFromOffset(source, openedAt, firstLine),
        });
      }

      fieldQuoted = true;
      fieldStarted = true;
      continue;
    }

    if (char === delimiter) {
      endField();
      index += 1;
      markFieldStart();
      continue;
    }

    if (char === '\r' || char === '\n') {
      // Consume CRLF as a single break rather than two.
      index += char === '\r' && source[index + 1] === '\n' ? 2 : 1;
      line += 1;
      lineStart = index;
      endRow();
      markFieldStart();
      continue;
    }

    field += char ?? '';
    fieldStarted = true;
    index += 1;
  }

  /*
   * Flush a pending record.
   *
   * `fieldStarted` is in this condition and used to not be, which lost the last
   * record of any file ending in a quoted empty field: `name\n""` parsed to one
   * row rather than two, so a real record disappeared without a word. An empty
   * quoted field leaves `field` empty and `fields` empty, so the two older
   * tests could not see it.
   */
  if (fieldStarted || field !== '' || fields.length > 0) endRow();

  return ok(rows);
}

/**
 * A NAME FOR AN EMPTY HEADER CELL THAT THE FILE IS NOT ALREADY USING.
 *
 * `column_2` is a synthesised name, and until round twelve it was synthesised
 * without looking at the document it was going into - so a file whose author
 * had written a column called `column_2` collided with the invented one and
 * was refused outright, with a message blaming the author for a duplicate they
 * had not written. There is no spelling of that header that gets the file read:
 * `a,,c` with a real `column_2` anywhere in it is unreadable, and the second
 * column is the one the tool made up.
 *
 * `taken` is every name the header declares PLUS every name assigned so far,
 * which is why it is threaded in rather than recomputed: a document with two
 * empty cells must not synthesise the same name twice either.
 *
 * The suffix is bounded rather than a `for (;;)`: `taken` is finite, so one of
 * the first `taken.size + 1` candidates is free, and a loop that says so is a
 * loop nobody has to prove terminates.
 */
function synthesiseColumnName(index: number, taken: ReadonlySet<string>): string {
  const base = `column_${(index + 1).toString()}`;
  if (!taken.has(base)) return base;

  for (let suffix = 2; suffix <= taken.size + 2; suffix += 1) {
    const candidate = `${base}_${suffix.toString()}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Unreachable while `taken` is finite; a name rather than a throw, because
  // this function is not the place a document gets refused.
  return `${base}_${(taken.size + 3).toString()}`;
}

/** What a CSV read produced, and what the header cost. */
export interface ReadRecords {
  readonly data: JsonValue;
  readonly notes: readonly ToolNote[];
}

/** Turns records into objects, using the first record as the header. */
export function rowsToRecords(rows: readonly CsvRow[]): ToolResult<JsonValue> {
  const read = readRecords(rows);
  return read.ok ? ok(read.value.data) : read;
}

/**
 * The same read, with what the header cost.
 *
 * ONE LOSS, REAL AND PREVIOUSLY SILENT. An unquoted header cell is trimmed,
 * which is the right decision - ` name, age` is what hand-typed CSV looks like
 * and a key of `" age"` helps nobody - and the decision was written down in
 * this tool's README while the edit itself was made in silence. A column named
 * `shipped at ` in the file is `shipped at` in every port downstream, and the
 * first place that matters is a diff of two exports whose headers were typed
 * by different people.
 *
 * The value-only wrapper above is kept because the CSV oracle compares VALUES
 * against CPython's `csv.reader` and should not have to learn a new shape.
 */
export function readRecords(rows: readonly CsvRow[]): ToolResult<ReadRecords> {
  const header = rows[0];
  if (header === undefined) return ok({ data: [], notes: [] });

  const columns: string[] = [];
  /** Name -> the cell it came from, so a collision can say what collided. */
  const seen = new Map<string, { readonly cell: string; readonly quoted: boolean }>();
  /** Header cells whose spaces were removed, for the note at the end. */
  const trimmed: { readonly written: string; readonly name: string }[] = [];

  /*
   * EVERY NAME THE FILE ITSELF DECLARES, BEFORE ANY IS INVENTED.
   *
   * A pre-pass rather than the running `seen` set, because a synthesised name
   * has to avoid a literal column that appears AFTER it: `,column_1` would
   * otherwise invent `column_1` for the first cell and then refuse the second,
   * which is the same defect one column further along.
   */
  const declared = new Set<string>();
  for (let index = 0; index < header.fields.length; index += 1) {
    const cell = header.fields[index] ?? '';
    if (header.quoted[index] === true) declared.add(cell);
    else if (cell.trim() !== '') declared.add(cell.trim());
  }

  for (let index = 0; index < header.fields.length; index += 1) {
    // Unquoted header cells are trimmed, because ` name, age` is how hand-typed
    // CSV looks and a key of " age" helps nobody. A QUOTED cell is left exactly
    // as written: quoting is the author saying the spaces are part of the name.
    const cell = header.fields[index] ?? '';
    const isQuoted = header.quoted[index] === true;
    // An empty header cell still needs a stable key to hang values off - unless
    // it was quoted, which is the author saying the name really is empty. That
    // is what lets `[{ "": "v" }]` survive a trip out to CSV and back.
    const name = isQuoted
      ? cell
      : cell.trim() === ''
        ? synthesiseColumnName(index, new Set([...declared, ...seen.keys()]))
        : cell.trim();

    if (!isQuoted && cell.trim() !== '' && cell !== name) {
      trimmed.push({ written: cell, name });
    }

    const previous = seen.get(name);
    if (previous !== undefined) {
      /*
       * SAY WHEN TRIMMING IS WHY TWO VISIBLY DIFFERENT CELLS COLLIDED.
       *
       * `a, a ` is a duplicate column and the header does not look like one:
       * the two cells differ by four characters. The old message named the
       * name they collapsed onto and left the reader comparing two spellings
       * that are the same, which reads as the tool being unable to count.
       *
       * Only when the two cells really are different as written - two cells
       * both spelled `a` are an ordinary duplicate and the trimming had
       * nothing to do with it.
       */
      const byTrimming = previous.cell !== cell && (!previous.quoted || !isQuoted);

      return fail('parse-error', `Duplicate column name "${name}".`, {
        // The SECOND cell of the pair: the first was fine until this one
        // arrived, and it is the one a reader would rename.
        position: header.starts[index] ?? { line: header.line, column: 1, offset: null },
        detail: byTrimming
          ? `Column names become object keys, so they have to be unique. ${JSON.stringify(previous.cell)} and ${JSON.stringify(cell)} are different as written and the same afterwards, because an unquoted header cell has its leading and trailing spaces removed. Quote one of them to keep the two names apart.`
          : 'Column names become object keys, so they have to be unique.',
      });
    }

    seen.set(name, { cell, quoted: isQuoted });
    columns.push(name);
  }

  const records: JsonValue[] = [];

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row === undefined) continue;

    if (row.fields.length > columns.length) {
      return fail(
        'parse-error',
        `Row ${(rowIndex + 1).toString()} has ${row.fields.length.toString()} fields but the header declares ${columns.length.toString()}.`,
        { position: { line: row.line, column: 1, offset: null } },
      );
    }

    const record: Record<string, JsonValue> = {};
    for (let column = 0; column < columns.length; column += 1) {
      // Short rows are padded rather than rejected: trailing empty fields are
      // extremely common in hand-edited CSV.
      setOwnProperty(record, columns[column] ?? '', row.fields[column] ?? '');
    }
    records.push(record);
  }

  return ok({ data: records, notes: trimmedHeaderNotes(trimmed) });
}

/**
 * The trimming, as one note with a count and the cells named.
 *
 * ONE NOTE, NOT ONE PER CELL - the bargain `roundedNumberNotes` and
 * `nonStringKeyNotes` both strike, for the same reason. A spreadsheet exported
 * with a space after every comma has a space in every column, and forty notes
 * saying the same thing forty times is a list nobody reads.
 *
 * The cell is printed through `JSON.stringify` rather than in backticks
 * because the whole subject is whitespace, and backticks around ` shipped at `
 * print a name that looks identical to the one it became.
 */
function trimmedHeaderNotes(
  trimmed: readonly { readonly written: string; readonly name: string }[],
): readonly ToolNote[] {
  if (trimmed.length === 0) return [];

  const shown = trimmed.slice(0, 5);
  const rest = trimmed.length - shown.length;
  const first = shown[0];
  const where = shown
    .map((entry) => `${JSON.stringify(entry.written)} became \`${entry.name}\``)
    .join(', ');

  return [
    lost(
      trimmed.length === 1
        ? '1 header cell was trimmed'
        : `${trimmed.length.toString()} header cells were trimmed`,
      `An unquoted header cell has its leading and trailing spaces removed, because \` name, age\` is how hand-typed CSV looks and a key of \` age\` helps nobody. ${where}${
        rest > 0 ? `, and ${rest.toString()} more` : ''
      }. ${
        first === undefined ? '' : `Quote the cell - \`"${first.written}"\` - `
      }to keep the spaces in the name.`,
      /*
       * BOTH DATA PORTS. The header becomes the object keys during the READ,
       * so the parsed structure on `data` carries the trimmed name as well as
       * the written document does - unlike the write-half losses below, which
       * `data` escapes.
       */
      ['output', 'data'],
    ),
  ];
}

/**
 * TSV QUOTES ONLY WHAT A READER WOULD OTHERWISE GET WRONG. SD-6, decided by
 * measurement in round thirteen.
 *
 * TSV has no specification - the IANA registration for
 * `text/tab-separated-values` says only that a field may not contain a tab -
 * so what counts is what readers do. Nine were asked, and the answers are
 * committed as `spec/tsv-readers.json` by `scripts/generate-tsv-readers.py`:
 * Python's csv, pandas, polars, DuckDB with and without its sniffer, Papa
 * Parse, d3-dsv, awk and cut.
 *
 *   - A tab or a line break in a cell, in CSV-style quotes: 7 of 9 read it
 *     back. awk and cut, which split on every tab and every line, cannot read
 *     it in ANY spelling.
 *   - The same escaped as `\t` / `\n`: 0 of 9. Every reader measured takes
 *     the backslash literally. That is why escaping, which the finding offers
 *     as one of its two fixes, was rejected.
 *   - A cell with a quote inside it, or spaces at its edges, written BARE: 9 of
 *     9. Quoted, the way this writer used to write them: 7 of 9. So those
 *     quotes cost two readers and bought nothing, and they are gone.
 *   - A cell that BEGINS with a quote, bare: 4 of 9 - the quote-aware readers
 *     take it for an opening quote. Quoted: 7 of 9. It stays quoted.
 *
 * One exception that is this tool's own: a HEADER cell with spaces at its
 * edges is quoted, because this tool's reader trims an unquoted header cell
 * (see `readRecords`), and a file this tool writes has to read back as what
 * it wrote.
 *
 * CSV is untouched: it has RFC 4180, and its writer is held to CPython's
 * byte for byte.
 */
function needsQuoting(field: string, delimiter: string, header: boolean): boolean {
  if (delimiter === '\t') {
    return (
      field.includes('\t') ||
      field.includes('\n') ||
      field.includes('\r') ||
      field.startsWith('"') ||
      (header && field !== field.trim())
    );
  }
  return (
    field.includes(delimiter) ||
    field.includes('"') ||
    field.includes('\n') ||
    field.includes('\r') ||
    field !== field.trim()
  );
}

function quoteField(field: string, delimiter: string, header = false): string {
  if (!needsQuoting(field, delimiter, header)) return field;
  return `"${field.replaceAll('"', '""')}"`;
}

/** A cell TSV has no spelling for, which is written in quotes and reported. */
function hasNoTsvSpelling(field: string): boolean {
  return field.includes('\t') || field.includes('\n') || field.includes('\r');
}

/**
 * Writes one line, quoting it when it would otherwise be empty.
 *
 * A single-column table whose row is `''` produces an empty line, and an empty
 * line is a blank line - so the row came back as nothing at all, and a
 * one-column export silently lost every empty row it had. This used to be
 * written down as a limitation of the format ("CSV cannot distinguish a final
 * record of all-empty fields from a terminating newline"), but the format CAN:
 * `""` is a record holding one empty field and a bare newline is not. Only
 * lines that would be genuinely ambiguous are touched, so nothing else in the
 * output changes shape.
 */
function writeLine(line: string): string {
  return line === '' ? '""' : line;
}

/**
 * Renders a JSON value as CSV.
 *
 * Only an array of flat objects can become a table, so anything else is a
 * structured error rather than a silently mangled export. Nested values are
 * serialised as compact JSON inside the cell - lossy for round-tripping, but
 * far more useful than refusing the whole document over one nested field.
 */
export function recordsToCsv(data: JsonValue, delimiter: string): ToolResult<string> {
  const written = writeCsv(data, delimiter);
  return written.ok ? ok(written.value.text) : written;
}

/**
 * The same write, with what the table could not hold.
 *
 * TWO LOSSES, BOTH REAL, BOTH PREVIOUSLY SILENT.
 *
 * A NESTED VALUE BECOMES COMPACT JSON IN THE CELL. `{"user":{"name":"ada"}}`
 * writes `{"name":"ada"}` into the cell, and reading the file back gives the
 * STRING, not the object. Keeping it is the right trade - flattening to
 * `user.name` is ambiguous for arrays and collides with a key containing a dot,
 * and refusing the whole document over one nested field refuses a conversion
 * people do every day - so what was wrong was only that nothing said so.
 *
 * A KEY ABSENT FROM A ROW BECOMES AN EMPTY CELL. CSV has no other spelling for
 * it, so an absent value and a present empty string are the same two bytes on
 * the way out. That is not fixable in the format; it is reportable, and the
 * report names the columns so the reader knows which of them to distrust.
 *
 * BY PATH, AND CAPPED. `$[3].user` is where to look. A thousand-row export with
 * one nested column would otherwise produce a thousand paths, so the first few
 * are named and the rest counted - the same bargain the rounded-number note
 * strikes, for the same reason.
 */
export function writeCsv(data: JsonValue, delimiter: string): ToolResult<Written> {
  if (!isJsonArray(data)) {
    return fail('unsupported-type', 'CSV needs an array of rows at the top level.', {
      detail: `Found ${describe(data)}. Wrap it in an array, or pick a different target format.`,
    });
  }

  if (data.length === 0) return ok({ text: '', notes: [], stream: false });

  const columns: string[] = [];
  const seen = new Set<string>();

  for (const row of data) {
    if (row === null || typeof row !== 'object' || isJsonArray(row)) {
      return fail('unsupported-type', 'Every row must be an object for CSV output.', {
        detail: `Found ${describe(row)} as a row.`,
      });
    }
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }

  if (columns.length === 0) {
    // Every row was `{}`. Writing that produced a document of empty lines,
    // which read back as either no rows at all or one row of one phantom
    // column, depending on how many there were - two different wrong answers
    // where the real one is that there is no table here to write.
    return fail('unsupported-type', 'These rows have no fields, so there are no columns.', {
      detail: 'A table needs at least one named column.',
    });
  }

  const tsv = delimiter === '\t';
  /** Cells holding a tab or a line break, which TSV has no spelling for. */
  const unspellable: string[] = [];

  if (tsv) {
    for (const column of columns)
      if (hasNoTsvSpelling(column)) unspellable.push(`the header ${JSON.stringify(column)}`);
  }

  const lines: string[] = [
    writeLine(columns.map((column) => quoteField(column, delimiter, true)).join(delimiter)),
  ];

  /** Paths whose value went into a cell as JSON text rather than as a value. */
  const nested: string[] = [];
  /** Columns that some row did not have, so the cell is empty for that row. */
  const missing = new Set<string>();

  data.forEach((row, index) => {
    const record = row as Readonly<Record<string, JsonValue>>;
    lines.push(
      writeLine(
        columns
          .map((column) => {
            // Object.hasOwn, not a bare read: a column literally named
            // "toString" or "constructor" would otherwise pick up the
            // inherited Object.prototype member rather than this row's own
            // (absent) value. Found by the round-trip property test.
            const present = Object.hasOwn(record, column);
            if (!present) missing.add(column);
            const value = present ? record[column] : undefined;
            if (value !== undefined && value !== null && typeof value === 'object') {
              nested.push(`$[${index.toString()}].${column}`);
            }
            const cell = cellToString(value);
            if (tsv && hasNoTsvSpelling(cell)) unspellable.push(`$[${index.toString()}].${column}`);
            return quoteField(cell, delimiter);
          })
          .join(delimiter),
      ),
    );
  });

  /*
   * HOW THIS WRITER SPELLS A TABLE, WHICH IS NOT HOW RFC 4180 DOES.
   *
   * LF rather than CRLF, and no terminator after the last record - both legal,
   * both what every reader accepts, and both a difference from the bytes that
   * went in when the source was a CSV that used CRLF. It matters exactly when
   * the next step is a byte comparison or a digest, which on this canvas is one
   * wire away.
   *
   * `info`, not `warn`: nothing is lost, the table reads back identically, and
   * a warning on every single CSV export is a warning nobody reads. It is here
   * so that the answer exists somewhere other than docs/conversion-matrix.md.
   */
  const notes: ToolNote[] = [
    noted(
      'Written with LF, and no terminator after the last record',
      'RFC 4180 specifies CRLF and permits a file to end either way; this writer uses LF and stops after the last record, whatever the input used. Every reader accepts it. It is worth knowing when the next step is a byte comparison or a digest.',
    ),
  ];

  if (nested.length > 0) {
    const shown = nested.slice(0, 5);
    const rest = nested.length - shown.length;
    notes.push(
      lost(
        nested.length === 1
          ? `The nested value at ${shown[0] ?? ''} was written into the cell as JSON`
          : `${nested.length.toString()} nested values were written into their cells as JSON`,
        `A table cell holds text, so an object or an array becomes compact JSON inside it. Reading the file back gives that TEXT, not the structure. At ${shown.join(', ')}${rest > 0 ? `, and ${rest.toString()} more` : ''}.`,
        /*
         * THE WRITTEN DOCUMENT ONLY. This is the write half: the table is
         * where the object had to become text, and `data` - the parsed source
         * structure - still holds the object. That port is the way around this
         * loss, so a downstream node fed from it is downstream of nothing.
         */
        ['output'],
      ),
    );
  }

  if (missing.size > 0) {
    const names = [...missing];
    const shown = names.slice(0, 5);
    const rest = names.length - shown.length;
    notes.push(
      lost(
        `${names.length.toString()} column${names.length === 1 ? ' was' : 's were'} absent from some rows`,
        `CSV has one spelling for "this row has no such key" and for "this row's value is the empty string", and it is an empty cell. Reading the file back cannot tell them apart. The ${names.length === 1 ? 'column is' : 'columns are'} ${shown.join(', ')}${rest > 0 ? `, and ${rest.toString()} more` : ''}.`,
        // The written document only, for the same reason as the note above.
        ['output'],
      ),
    );
  }

  /*
   * SD-6: A CELL TSV CANNOT SPELL. Written in quotes, because seven of the nine
   * readers measured read that back exactly and no spelling at all works for
   * the other two - and SAID, because those two are the tools TSV is usually
   * chosen for. `warn`: for a reader that splits on tabs, the cell does not
   * come out.
   */
  if (unspellable.length > 0) {
    const shown = unspellable.slice(0, 5);
    const rest = unspellable.length - shown.length;
    notes.push(
      lost(
        unspellable.length === 1
          ? '1 cell holds a tab or a line break'
          : `${unspellable.length.toString()} cells hold a tab or a line break`,
        `TSV has no spelling for either inside a cell - its registration forbids a tab outright - so ${unspellable.length === 1 ? 'it is' : 'they are'} written in double quotes, the way CSV does it. Python's csv, pandas, polars, DuckDB, Papa Parse and d3-dsv all read that back as one cell; cut and awk, which split on every tab and every line, do not, and nothing written here could make them. At ${shown.join(', ')}${rest > 0 ? `, and ${rest.toString()} more` : ''}. Choose CSV if the file is going to something that splits by hand.`,
        ['output'],
      ),
    );
  }

  return ok({ text: lines.join('\n'), notes, stream: false });
}

function cellToString(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Nested structure: keep it, compactly, rather than losing it.
  // Safe without a fallback: by this point `value` is narrowed to an array or
  // a plain object, and JSON.stringify only returns undefined for values
  // outside JsonValue (a function, say). The own-property read above is what
  // guarantees one can never get here.
  return JSON.stringify(value);
}

function describe(value: JsonValue | undefined): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (isJsonArray(value)) return 'an array';
  // "a object" appeared in a user-facing error for the single most likely
  // mistake there is - pointing CSV at a document with one object at the top.
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}
