import { isJsonArray, isJsonObject, type JsonValue } from '@/features/registry/types';

import styles from './diff.module.css';

/**
 * ACCESSIBLE DIFF RENDERING
 *
 * Three things a diff has to get right, none of which a coloured <pre> does:
 *
 *  1. Colour is not the only signal. Every row carries a `+`, `-` or space
 *     sign in its own column, so the diff survives greyscale, a colour-vision
 *     deficiency, and forced-colors mode.
 *  2. It is structure, not prose. The rows are an ordered list, so a screen
 *     reader announces "list, 42 items" and can be navigated item by item -
 *     rather than reading four hundred lines as one unbroken paragraph.
 *  3. Each row says what it is. A visually hidden prefix names the change and
 *     the line number: "removed, line 12". Sighted users get the same
 *     information from the gutter, which is why it is hidden rather than
 *     doubled up.
 *
 * Word-level changes use <ins> and <del>, which carry the meaning natively and
 * are underlined and struck through by default - again, not colour alone.
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
  readonly parts: readonly Part[] | null;
}

interface Report {
  readonly rows: readonly Row[];
  readonly stats: { readonly added: number; readonly removed: number; readonly unchanged: number };
  readonly identical: boolean;
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
        text: typeof entry.text === 'string' ? entry.text : '',
        parts,
      },
    ];
  });

  return {
    rows,
    stats: {
      added: number(rawStats.added),
      removed: number(rawStats.removed),
      unchanged: number(rawStats.unchanged),
    },
    identical: value.identical === true,
  };
}

const SIGN = { add: '+', remove: '-', same: ' ' } as const;
const SPOKEN = { add: 'added', remove: 'removed', same: 'unchanged' } as const;

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

export interface DiffViewProps {
  readonly value: JsonValue;
  readonly label: string;
}

export function DiffView({ value, label }: DiffViewProps) {
  const report = parseReport(value);

  if (!report) {
    return <p className={styles.empty}>That result is not a diff this view can render.</p>;
  }

  if (report.identical) {
    return <p className={styles.empty}>The two inputs are identical.</p>;
  }

  const summary = `${report.stats.added.toString()} added, ${report.stats.removed.toString()} removed, ${report.stats.unchanged.toString()} unchanged`;

  return (
    <div className={styles.wrapper}>
      {/* Announced first, so the shape of the change is known before the detail. */}
      <p className={styles.summary}>{summary}</p>

      <ol className={styles.rows} aria-label={`${label}: ${summary}`}>
        {report.rows.map((row, index) => (
          <li
            key={`${index.toString()}:${row.kind}`}
            className={`${styles.row ?? ''} ${styles[row.kind] ?? ''}`}
          >
            <span className={styles.hidden}>
              {SPOKEN[row.kind]}, line {(row.newLine ?? row.oldLine ?? 0).toString()}:{' '}
            </span>
            <span className={styles.gutter} aria-hidden="true">
              {row.oldLine ?? ''}
            </span>
            <span className={styles.gutter} aria-hidden="true">
              {row.newLine ?? ''}
            </span>
            <span className={styles.sign} aria-hidden="true">
              {SIGN[row.kind]}
            </span>
            <span className={styles.text}>
              <RowContent row={row} />
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
