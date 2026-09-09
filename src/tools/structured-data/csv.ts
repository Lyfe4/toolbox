import { fail, isJsonArray, ok, type JsonValue, type ToolResult } from '@/features/registry/types';
import { setOwnProperty } from '@/lib/safeObject';
import { positionFromOffset } from '@/lib/textPosition';

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

  const endField = (): void => {
    fields.push(field);
    quoted.push(fieldQuoted);
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
    if (!isBlank) rows.push({ fields, quoted, line: rowLine });
    fields = [];
    quoted = [];
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
          continue;
        }
        if (inner === '\n') {
          field += '\n';
          index += 1;
          line += 1;
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
      continue;
    }

    if (char === '\r' || char === '\n') {
      // Consume CRLF as a single break rather than two.
      index += char === '\r' && source[index + 1] === '\n' ? 2 : 1;
      line += 1;
      endRow();
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

/** Turns records into objects, using the first record as the header. */
export function rowsToRecords(rows: readonly CsvRow[]): ToolResult<JsonValue> {
  const header = rows[0];
  if (header === undefined) return ok([]);

  const columns: string[] = [];
  const seen = new Set<string>();

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
        ? `column_${(index + 1).toString()}`
        : cell.trim();

    if (seen.has(name)) {
      return fail('parse-error', `Duplicate column name "${name}".`, {
        position: { line: header.line, column: 1, offset: null },
        detail: 'Column names become object keys, so they have to be unique.',
      });
    }

    seen.add(name);
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

  return ok(records);
}

function needsQuoting(field: string, delimiter: string): boolean {
  return (
    field.includes(delimiter) ||
    field.includes('"') ||
    field.includes('\n') ||
    field.includes('\r') ||
    field !== field.trim()
  );
}

function quoteField(field: string, delimiter: string): string {
  if (!needsQuoting(field, delimiter)) return field;
  return `"${field.replaceAll('"', '""')}"`;
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
  if (!isJsonArray(data)) {
    return fail('unsupported-type', 'CSV needs an array of rows at the top level.', {
      detail: `Found ${describe(data)}. Wrap it in an array, or pick a different target format.`,
    });
  }

  if (data.length === 0) return ok('');

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

  const lines: string[] = [
    writeLine(columns.map((column) => quoteField(column, delimiter)).join(delimiter)),
  ];

  for (const row of data) {
    const record = row as Readonly<Record<string, JsonValue>>;
    lines.push(
      writeLine(
        columns
          .map((column) =>
            // Object.hasOwn, not a bare read: a column literally named
            // "toString" or "constructor" would otherwise pick up the
            // inherited Object.prototype member rather than this row's own
            // (absent) value. Found by the round-trip property test.
            quoteField(
              cellToString(Object.hasOwn(record, column) ? record[column] : undefined),
              delimiter,
            ),
          )
          .join(delimiter),
      ),
    );
  }

  return ok(lines.join('\n'));
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
