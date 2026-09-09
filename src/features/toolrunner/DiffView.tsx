import { useState } from 'react';

import { isJsonArray, isJsonObject, type JsonValue } from '@/features/registry/types';

import styles from './diff.module.css';
import { RawPayload } from './RawPayload';
import { ViewToggle } from './ViewToggle';

/**
 * ACCESSIBLE DIFF RENDERING
 *
 * Four things a diff has to get right, none of which a coloured <pre> does:
 *
 *  1. Colour is not the only signal. Every row carries a `+`, `-`, `~` or
 *     space sign in its own column, so the diff survives greyscale, a
 *     colour-vision deficiency, and forced-colors mode.
 *  2. It is structure, not prose. The rows are an ordered list, so a screen
 *     reader announces "list, 42 items" and can be navigated item by item -
 *     rather than reading four hundred lines as one unbroken paragraph.
 *  3. Each row says what it is, and WHICH SIDE its line number is on. A
 *     visually hidden prefix names the change and the line: "removed, original
 *     line 12". Sighted users get the same from the two gutters, which is why
 *     it is hidden rather than doubled up.
 *  4. It has to be scannable. A thousand-line file with one changed line was
 *     a thousand rows to scroll; long unchanged runs now collapse to a button
 *     that says how many lines it is hiding, using the same context setting
 *     the unified patch uses.
 *
 * Word-level changes use <ins> and <del>, which carry the meaning natively and
 * are underlined and struck through by default - again, not colour alone.
 *
 * The notes above the list are the other half of being trustworthy. A row can
 * only say what changed on its own line; anything the comparison deliberately
 * looked past - line endings, a missing final newline, lines that differ only
 * in case - has nowhere else to be said, and going unsaid is how a diff misleads
 * without ever being wrong.
 */

interface Part {
  readonly text: string;
  readonly changed: boolean;
}

interface Row {
  readonly kind: 'add' | 'remove' | 'same';
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly text: string;
  readonly oldText: string | null;
  readonly invisible: boolean;
  readonly parts: readonly Part[] | null;
}

type LineEnding = 'lf' | 'crlf' | 'cr' | 'mixed' | 'none';

interface Report {
  readonly rows: readonly Row[];
  readonly stats: {
    readonly added: number;
    readonly removed: number;
    readonly unchanged: number;
    readonly ignored: number;
  };
  readonly identical: boolean;
  readonly equal: boolean;
  readonly context: number;
  readonly refinement: string;
  readonly notes: {
    readonly lineEndings: { readonly original: LineEnding; readonly changed: LineEnding };
    readonly finalNewline: { readonly original: boolean; readonly changed: boolean };
    readonly bidiControls: boolean;
  };
}

const ENDING_NAMES: Record<LineEnding, string> = {
  lf: 'LF',
  crlf: 'CRLF',
  cr: 'CR',
  mixed: 'mixed line endings',
  none: 'no line endings',
};

/**
 * A nested object, or null.
 *
 * Reading a missing key yields `undefined`, which is not a `JsonValue`, so
 * `isJsonObject` cannot be handed one directly - and every note below is
 * optional, because a payload from an older build has none of them.
 */
function objectAt(
  value: Readonly<Record<string, JsonValue>> | null,
  key: string,
): Readonly<Record<string, JsonValue>> | null {
  const child = value?.[key];
  return child !== undefined && isJsonObject(child) ? child : null;
}

function isLineEnding(value: JsonValue | undefined): value is LineEnding {
  return (
    value === 'lf' || value === 'crlf' || value === 'cr' || value === 'mixed' || value === 'none'
  );
}

/**
 * Narrows the tool's JSON back into the shape this view draws.
 *
 * The value arrives as `JsonValue` because it crossed the worker boundary as
 * plain JSON, and the type system cannot remember what it used to be. Reading
 * it back defensively rather than casting means a future change to the tool's
 * output shows up as "nothing to show" rather than as a crash in a render.
 */
function parseReport(value: JsonValue): Report | null {
  if (!isJsonObject(value)) return null;

  const rawRows = value.rows;
  const rawStats = value.stats;
  // `isJsonArray` rather than `Array.isArray`, which narrows to `any[]` and
  // would let `any` leak into every element read below.
  if (rawRows === undefined || !isJsonArray(rawRows)) return null;
  if (rawStats === undefined || !isJsonObject(rawStats)) return null;

  const number = (input: JsonValue | undefined): number => (typeof input === 'number' ? input : 0);
  const optionalNumber = (input: JsonValue | undefined): number | null =>
    typeof input === 'number' ? input : null;
  const text = (input: JsonValue | undefined): string | null =>
    typeof input === 'string' ? input : null;

  const rows = rawRows.flatMap((entry): Row[] => {
    if (!isJsonObject(entry)) return [];
    const kind = entry.kind;
    if (kind !== 'add' && kind !== 'remove' && kind !== 'same') return [];

    const rawParts = entry.parts;
    const parts =
      rawParts !== undefined && isJsonArray(rawParts)
        ? rawParts.flatMap((part): Part[] =>
            isJsonObject(part)
              ? [
                  {
                    text: typeof part.text === 'string' ? part.text : '',
                    changed: part.changed === true,
                  },
                ]
              : [],
          )
        : null;

    return [
      {
        kind,
        oldLine: optionalNumber(entry.oldLine),
        newLine: optionalNumber(entry.newLine),
        text: text(entry.text) ?? '',
        oldText: text(entry.oldText),
        invisible: entry.invisible === true,
        parts,
      },
    ];
  });

  const rawNotes = objectAt(value, 'notes');
  const rawEndings = objectAt(rawNotes, 'lineEndings');
  const rawFinal = objectAt(rawNotes, 'finalNewline');

  return {
    rows,
    stats: {
      added: number(rawStats.added),
      removed: number(rawStats.removed),
      unchanged: number(rawStats.unchanged),
      ignored: number(rawStats.ignored),
    },
    identical: value.identical === true,
    // Older payloads have no `equal`; falling back to `identical` keeps them
    // rendering the way they always did rather than showing every row twice.
    equal: value.equal === undefined ? value.identical === true : value.equal === true,
    context: number(value.context),
    refinement: typeof value.refinement === 'string' ? value.refinement : 'off',
    notes: {
      lineEndings: {
        original: isLineEnding(rawEndings?.original) ? rawEndings.original : 'none',
        changed: isLineEnding(rawEndings?.changed) ? rawEndings.changed : 'none',
      },
      finalNewline: {
        original: rawFinal?.original !== false,
        changed: rawFinal?.changed !== false,
      },
      bidiControls: rawNotes?.bidiControls === true,
    },
  };
}

/**
 * The differences that are real but do not appear as a changed row.
 *
 * Each of these was, at some point, a silent lie: two files differing only in
 * their line endings reported every line as rewritten, and once that was fixed
 * by normalising them, they reported nothing at all.
 */
function notesOf(report: Report): readonly string[] {
  const notes: string[] = [];
  const { lineEndings, finalNewline, bidiControls } = report.notes;

  if (lineEndings.original !== lineEndings.changed) {
    notes.push(
      `Line endings differ: the original uses ${ENDING_NAMES[lineEndings.original]}, the changed text uses ${ENDING_NAMES[lineEndings.changed]}. Lines are compared with that difference removed.`,
    );
  } else if (lineEndings.original === 'mixed') {
    notes.push('Both texts mix line endings.');
  }

  if (finalNewline.original !== finalNewline.changed) {
    notes.push(
      finalNewline.changed
        ? 'The original has no final newline; the changed text has one.'
        : 'The original has a final newline; the changed text has none.',
    );
  }

  if (report.stats.ignored > 0) {
    notes.push(
      `${report.stats.ignored.toString()} ${report.stats.ignored === 1 ? 'line differs' : 'lines differ'} only in whitespace or case and ${report.stats.ignored === 1 ? 'is' : 'are'} shown unchanged, marked ~.`,
    );
  }

  if (report.refinement === 'skipped-too-large') {
    notes.push('Word-level highlighting was skipped: too much of the text changed.');
  }

  if (bidiControls) {
    notes.push(
      'This text contains bidirectional formatting characters, which can make a line display in a different order from the one it is stored in.',
    );
  }

  return notes;
}

/* -------------------------------------------------------------------------- *
 * Rows
 * -------------------------------------------------------------------------- */

const SIGN = { add: '+', remove: '-', same: ' ' } as const;
const SPOKEN = { add: 'added', remove: 'removed', same: 'unchanged' } as const;

/** A `same` row whose two sides are not actually the same string. */
function isIgnored(row: Row): boolean {
  return row.kind === 'same' && row.oldText !== null;
}

function signOf(row: Row): string {
  return isIgnored(row) ? '~' : SIGN[row.kind];
}

function spokenPrefix(row: Row): string {
  const side =
    row.kind === 'remove'
      ? `original line ${(row.oldLine ?? 0).toString()}`
      : row.kind === 'add'
        ? `changed line ${(row.newLine ?? 0).toString()}`
        : `line ${(row.newLine ?? row.oldLine ?? 0).toString()}`;

  if (isIgnored(row)) return `unchanged apart from an ignored difference, ${side}: `;
  return `${SPOKEN[row.kind]}, ${side}: `;
}

function RowContent({ row }: { readonly row: Row }) {
  // An empty line still needs to occupy a row, hence the zero-width space.
  if (row.parts === null) return <>{row.text === '' ? '​' : row.text}</>;

  return (
    <>
      {row.parts.map((part, index) => {
        const key = `${index.toString()}:${part.text}`;
        if (!part.changed) return <span key={key}>{part.text}</span>;
        // <ins>/<del> rather than styled spans: the semantics are the point,
        // and the default underline and strikethrough are a non-colour signal.
        return row.kind === 'add' ? (
          <ins key={key} className={styles.word}>
            {part.text}
          </ins>
        ) : (
          <del key={key} className={styles.word}>
            {part.text}
          </del>
        );
      })}
    </>
  );
}

function DiffRowItem({ row }: { readonly row: Row }) {
  /*
   * The badge is the answer to the worst thing a diff can show: two lines that
   * are byte-different and pixel-identical. A BOM, a zero-width space, a
   * combining accent against its precomposed form. Without it the reader sees
   * `-café` above `+café` and concludes the tool is broken.
   */
  const badge = row.invisible && row.kind !== 'add';

  return (
    <li
      className={`${styles.row ?? ''} ${styles[row.kind] ?? ''} ${isIgnored(row) ? (styles.ignored ?? '') : ''}`}
    >
      <span className={styles.hidden}>{spokenPrefix(row)}</span>
      <span className={styles.gutter} aria-hidden="true">
        {row.oldLine ?? ''}
      </span>
      <span className={styles.gutter} aria-hidden="true">
        {row.newLine ?? ''}
      </span>
      <span className={styles.sign} aria-hidden="true">
        {signOf(row)}
      </span>
      <span className={styles.text}>
        <RowContent row={row} />
        {badge ? (
          <span className={styles.flag}> [differs only in invisible characters]</span>
        ) : null}
      </span>
    </li>
  );
}

/* -------------------------------------------------------------------------- *
 * Collapsing
 * -------------------------------------------------------------------------- */

/** Either some rows to draw, or a run of unchanged ones folded away. */
type Chunk =
  | { readonly kind: 'rows'; readonly from: number; readonly rows: readonly Row[] }
  | { readonly kind: 'fold'; readonly from: number; readonly rows: readonly Row[] };

/**
 * Folds long runs of unchanged rows.
 *
 * The window is the tool's own `context` option, so "3 context lines" means
 * one thing in the patch and on screen rather than two. A run at the very
 * start of the file keeps only its tail and one at the end only its head:
 * there is no change on the far side for the context to be context FOR.
 *
 * With context 0 every unchanged line folds, which is the honest reading of
 * asking for no context, and matches what the patch would contain.
 */
function chunkRows(rows: readonly Row[], context: number): readonly Chunk[] {
  const chunks: Chunk[] = [];
  let index = 0;

  while (index < rows.length) {
    const row = rows[index];
    if (!row) break;

    if (row.kind !== 'same' || isIgnored(row)) {
      const start = index;
      while (index < rows.length) {
        const next = rows[index];
        if (!next || (next.kind === 'same' && !isIgnored(next))) break;
        index += 1;
      }
      chunks.push({ kind: 'rows', from: start, rows: rows.slice(start, index) });
      continue;
    }

    const start = index;
    while (index < rows.length) {
      const next = rows[index];
      if (next?.kind !== 'same' || isIgnored(next)) break;
      index += 1;
    }
    const run = rows.slice(start, index);
    const head = start === 0 ? 0 : context;
    const tail = index === rows.length ? 0 : context;

    if (run.length <= head + tail) {
      chunks.push({ kind: 'rows', from: start, rows: run });
      continue;
    }

    if (head > 0) chunks.push({ kind: 'rows', from: start, rows: run.slice(0, head) });
    chunks.push({
      kind: 'fold',
      from: start + head,
      rows: run.slice(head, run.length - tail),
    });
    if (tail > 0) {
      chunks.push({ kind: 'rows', from: index - tail, rows: run.slice(run.length - tail) });
    }
  }

  return chunks;
}

/* -------------------------------------------------------------------------- *
 * The view
 * -------------------------------------------------------------------------- */

export interface DiffViewProps {
  readonly value: JsonValue;
  readonly label: string;
  readonly baseFilename: string;
  readonly onCopy: (text: string) => void;
  readonly onDownload: (blob: Blob, filename: string) => void;
}

export function DiffView({ value, label, baseFilename, onCopy, onDownload }: DiffViewProps) {
  const [opened, setOpened] = useState<readonly number[]>([]);
  const [view, setView] = useState<'diff' | 'raw'>('diff');
  const report = parseReport(value);

  if (!report) {
    return <p className={styles.empty}>That result is not a diff this view can render.</p>;
  }

  /*
   * THE RAW ROWS, WHICH THIS VIEW USED TO WITHHOLD ENTIRELY.
   *
   * The tool has a second output - the unified patch - and it was tempting to
   * call that the raw form and stop. It is not the same thing: the patch is a
   * different serialisation with its own losses (a `~` row, an `oldText`, the
   * per-row `parts` a word-level highlight is built from) and it is what a
   * REVIEW wants. `changes` is what a program wants, it is the payload this
   * port actually carries, and until now the only way to see it was to wire
   * the port into something else.
   */
  const toggle = (
    <ViewToggle
      label={label}
      value={view}
      onChange={setView}
      options={[
        { id: 'diff', label: 'Diff', status: 'Showing the rendered diff' },
        { id: 'raw', label: 'Raw', status: 'Showing the raw rows' },
      ]}
    />
  );

  const raw = (
    <RawPayload
      label={label}
      value={value}
      baseFilename={baseFilename}
      onCopy={onCopy}
      onDownload={onDownload}
    />
  );

  if (view === 'raw') {
    return (
      <div className={styles.wrapper}>
        {toggle}
        {raw}
      </div>
    );
  }

  const notes = notesOf(report);

  if (report.equal) {
    return (
      <div className={styles.wrapper}>
        {toggle}
        <p className={styles.empty}>
          {report.identical
            ? 'The two inputs are identical.'
            : 'No lines were added or removed. What differs is below.'}
        </p>
        {notes.length > 0 ? <Notes notes={notes} /> : null}
      </div>
    );
  }

  const summary = `${report.stats.added.toString()} added, ${report.stats.removed.toString()} removed, ${report.stats.unchanged.toString()} unchanged`;
  const chunks = chunkRows(report.rows, report.context);

  return (
    <div className={styles.wrapper}>
      {toggle}
      {/* Announced first, so the shape of the change is known before the detail. */}
      <p className={styles.summary}>{summary}</p>
      {notes.length > 0 ? <Notes notes={notes} /> : null}

      <ol className={styles.rows} aria-label={`${label}: ${summary}`}>
        {chunks.map((chunk) => {
          if (chunk.kind === 'rows') {
            return chunk.rows.map((row, offset) => (
              <DiffRowItem key={`${(chunk.from + offset).toString()}:${row.kind}`} row={row} />
            ));
          }

          const isOpen = opened.includes(chunk.from);
          const count = chunk.rows.length;
          const noun = count === 1 ? 'unchanged line' : 'unchanged lines';

          return (
            <li key={`fold:${chunk.from.toString()}`} className={styles.foldItem}>
              <button
                type="button"
                className={styles.fold}
                aria-expanded={isOpen}
                onClick={() => {
                  setOpened((current) =>
                    current.includes(chunk.from)
                      ? current.filter((entry) => entry !== chunk.from)
                      : [...current, chunk.from],
                  );
                }}
              >
                {isOpen ? 'Hide' : 'Show'} {count.toString()} {noun}
              </button>
              {isOpen ? (
                <ol className={styles.nested}>
                  {chunk.rows.map((row, offset) => (
                    <DiffRowItem
                      key={`${(chunk.from + offset).toString()}:${row.kind}`}
                      row={row}
                    />
                  ))}
                </ol>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Notes({ notes }: { readonly notes: readonly string[] }) {
  return (
    <ul className={styles.notes} aria-label="What this comparison ignored">
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}
