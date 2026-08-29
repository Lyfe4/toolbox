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
 *   - ragged rows, reported with the line they appear on
 */

/** Splits a CSV document into rows of raw string fields. */
export function parseCsvRows(source: string, delimiter: string): ToolResult<string[][]> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let index = 0;
  let fieldStarted = false;

  const endField = (): void => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };

  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (index < source.length) {
    const char = source[index];

    if (char === '"' && !fieldStarted) {
      // Quoted field: scan to the closing quote, treating "" as one quote.
      const openedAt = index;
      index += 1;
      let closed = false;

      while (index < source.length) {
        if (source[index] === '"') {
          if (source[index + 1] === '"') {
            field += '"';
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        field += source[index] ?? '';
        index += 1;
      }

      if (!closed) {
        return fail('parse-error', 'Unterminated quoted field: the closing " is missing.', {
          position: positionFromOffset(source, openedAt),
        });
      }

      fieldStarted = true;
      continue;
    }

    if (char === delimiter) {
      endField();
      index += 1;
      continue;
    }

    if (char === '\r' || char === '\n') {
      endRow();
      // Consume CRLF as a single break rather than two.
      index += char === '\r' && source[index + 1] === '\n' ? 2 : 1;
      continue;
    }

    field += char ?? '';
    fieldStarted = true;
    index += 1;
  }

  // A file ending in a newline has already closed its last row; only flush when
  // there is something pending, so no phantom empty record is produced.
  if (field !== '' || row.length > 0) endRow();

  return ok(rows);
}

/** Turns rows into records, using the first row as the header. */
export function rowsToRecords(rows: readonly (readonly string[])[]): ToolResult<JsonValue> {
  const header = rows[0];
  if (header === undefined) return ok([]);

  const columns: string[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < header.length; index += 1) {
    const raw = (header[index] ?? '').trim();
    // An empty header cell still needs a stable key to hang values off.
    const name = raw === '' ? `column_${(index + 1).toString()}` : raw;

    if (seen.has(name)) {
      return fail('parse-error', `Duplicate column name "${name}".`, {
        position: { line: 1, column: index + 1, offset: null },
        detail: 'Column names become object keys, so they have to be unique.',
      });
    }

    seen.add(name);
    columns.push(name);
  }

  const records: JsonValue[] = [];

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];

    if (row.length > columns.length) {
      return fail(
        'parse-error',
        `Row ${(rowIndex + 1).toString()} has ${row.length.toString()} fields but the header declares ${columns.length.toString()}.`,
        { position: { line: rowIndex + 1, column: 1, offset: null } },
      );
    }

    const record: Record<string, JsonValue> = {};
    for (let column = 0; column < columns.length; column += 1) {
      // Short rows are padded rather than rejected: trailing empty fields are
      // extremely common in hand-edited CSV.
      setOwnProperty(record, columns[column] ?? '', row[column] ?? '');
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

  const lines: string[] = [columns.map((column) => quoteField(column, delimiter)).join(delimiter)];

  for (const row of data) {
    const record = row as Readonly<Record<string, JsonValue>>;
    lines.push(
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
  return `a ${typeof value}`;
}
