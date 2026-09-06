import { useId, useState } from 'react';

import { Button } from '@/components/Button';
import { TextArea } from '@/components/TextArea';
import { isJsonArray, isJsonObject, type JsonValue } from '@/features/registry/types';

import styles from './report.module.css';

/**
 * A CONVERSION REPORT: what changed, and what changed that you did not ask for.
 *
 * The payload behind this view already existed and was already careful - the
 * image tool goes to real trouble to notice that a photograph's GPS
 * coordinates were stripped, that an animation was flattened to one frame, or
 * that transparency was matted onto white, and it says each of those in a
 * sentence written for a person. All of it was then rendered as
 * `JSON.stringify(..., 2)` in a read-only textarea, three panels down, because
 * the port's data type is `json` and nothing said otherwise.
 *
 * That is the failure mode the notes exist to prevent, reintroduced one level
 * up: the caveat was said, and nobody was going to read it. In an application
 * whose whole pitch is that your data does not move, "GPS location was
 * removed" is close to the most important sentence it can print.
 *
 * So: the warnings first and in full, then the before-and-after facts, and the
 * numbers last. Level is carried by a word and a rule as well as a colour -
 * the same rule the regex notes follow, for the same reason.
 *
 * The raw payload stays reachable behind a toggle, the same bargain the HTML
 * output strikes between its source and its preview. It is a developer tool:
 * the exact byte counts and the note levels are worth having, and they are
 * what you would copy or wire into something else. Report is the default
 * because the sentences are the part that has to be READ.
 *
 * The payload is read defensively rather than cast, because it crossed the
 * worker boundary as plain JSON: a future change to the tool's output shows up
 * here as a missing section instead of a crash inside a render.
 */

interface Note {
  readonly level: string;
  readonly title: string;
  readonly body: string;
}

/** One side of the conversion. Every field is optional; a report may omit any. */
interface Facts {
  readonly format: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly size: string | null;
  readonly hasAlpha: boolean | null;
  readonly frames: number | null;
  readonly metadata: readonly string[] | null;
}

interface Report {
  readonly summary: string | null;
  readonly from: Facts | null;
  readonly to: Facts | null;
  readonly notes: readonly Note[];
}

const NOTE_WORD: Readonly<Record<string, string>> = {
  warn: 'Warning',
  hint: 'Try this',
  info: 'Note',
};

function parseFacts(value: JsonValue | undefined): Facts | null {
  if (value === undefined || !isJsonObject(value)) return null;

  const metadata = value.metadata;

  return {
    format: typeof value.format === 'string' ? value.format : null,
    width: typeof value.width === 'number' ? value.width : null,
    height: typeof value.height === 'number' ? value.height : null,
    size: typeof value.size === 'string' ? value.size : null,
    hasAlpha: typeof value.hasAlpha === 'boolean' ? value.hasAlpha : null,
    frames: typeof value.frames === 'number' ? value.frames : null,
    metadata:
      metadata !== undefined && isJsonArray(metadata)
        ? metadata.filter((entry): entry is string => typeof entry === 'string')
        : null,
  };
}

function parseReport(value: JsonValue): Report | null {
  if (!isJsonObject(value)) return null;

  const rawNotes = value.notes;

  return {
    summary: typeof value.summary === 'string' ? value.summary : null,
    from: parseFacts(value.from),
    to: parseFacts(value.to),
    notes:
      rawNotes !== undefined && isJsonArray(rawNotes)
        ? rawNotes.filter(isJsonObject).map((note) => ({
            level: typeof note.level === 'string' ? note.level : 'info',
            title: typeof note.title === 'string' ? note.title : '',
            body: typeof note.body === 'string' ? note.body : '',
          }))
        : [],
  };
}

function noteClass(level: string): string {
  if (level === 'warn') return styles.noteWarn ?? '';
  if (level === 'hint') return styles.noteHint ?? '';
  return styles.noteInfo ?? '';
}

/** A media type as a person writes it: `image/webp` becomes `WebP`. */
const FORMAT_NAMES: Readonly<Record<string, string>> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
  'image/gif': 'GIF',
  'image/avif': 'AVIF',
};

function formatName(mediaType: string): string {
  return FORMAT_NAMES[mediaType] ?? mediaType;
}

/**
 * The rows of the comparison, built once and read for both sides.
 *
 * A row is dropped when NEITHER side has anything to say - a report from a
 * tool that never measured transparency should not show an empty
 * "Transparency" row - but kept when only one side does, because "it had
 * alpha and now does not" is the whole point of that row.
 */
function factRows(
  from: Facts | null,
  to: Facts | null,
): readonly { readonly label: string; readonly from: string; readonly to: string }[] {
  const dimensions = (facts: Facts | null): string =>
    facts?.width === null || facts?.height === null || facts === null
      ? ''
      : `${facts.width.toString()} × ${facts.height.toString()}`;

  const alpha = (facts: Facts | null): string =>
    facts?.hasAlpha === null || facts === null ? '' : facts.hasAlpha ? 'Yes' : 'No';

  const frames = (facts: Facts | null): string =>
    facts?.frames === null || facts === null ? '' : facts.frames.toString();

  const metadata = (facts: Facts | null): string =>
    facts?.metadata === null || facts === null
      ? ''
      : facts.metadata.length === 0
        ? 'None'
        : facts.metadata.join(', ');

  return [
    {
      label: 'Format',
      from: from?.format === null || from === null ? '' : formatName(from.format),
      to: to?.format === null || to === null ? '' : formatName(to.format),
    },
    { label: 'Dimensions', from: dimensions(from), to: dimensions(to) },
    { label: 'Size', from: from?.size ?? '', to: to?.size ?? '' },
    { label: 'Transparency', from: alpha(from), to: alpha(to) },
    { label: 'Frames', from: frames(from), to: frames(to) },
    { label: 'Metadata', from: metadata(from), to: metadata(to) },
  ].filter((row) => row.from !== '' || row.to !== '');
}

export interface ReportViewProps {
  readonly value: JsonValue;
  readonly label: string;
  readonly baseFilename: string;
  readonly onCopy: (text: string) => void;
  readonly onDownload: (blob: Blob, filename: string) => void;
}

export function ReportView({ value, label, baseFilename, onCopy, onDownload }: ReportViewProps) {
  const [raw, setRaw] = useState(false);
  const statusId = useId();
  const report = parseReport(value);
  if (!report) return <p className={styles.aside}>Nothing to show.</p>;

  const rows = factRows(report.from, report.to);
  const json = JSON.stringify(value, null, 2);

  return (
    <section className={styles.wrapper} aria-label={label}>
      <div className={styles.toggle} role="group" aria-label={`${label} view`}>
        <Button
          size="sm"
          variant={raw ? 'ghost' : 'primary'}
          aria-pressed={!raw}
          onClick={() => {
            setRaw(false);
          }}
        >
          Report
        </Button>
        <Button
          size="sm"
          variant={raw ? 'primary' : 'ghost'}
          aria-pressed={raw}
          onClick={() => {
            setRaw(true);
          }}
        >
          Raw
        </Button>
        {/*
          Two aria-pressed buttons already announce as pressed or not, which
          describes the CONTROL. This says what is on screen, which is the
          RESULT - the same split the HTML output's toggle makes.
        */}
        <span className={styles.status} id={statusId} role="status">
          {raw ? 'Showing the raw report' : 'Showing the summarised report'}
        </span>
      </div>

      {raw ? (
        <>
          <TextArea
            className={styles.json}
            aria-label={`${label} raw`}
            value={json}
            readOnly
            spellCheck={false}
          />
          <div className={styles.actions}>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onCopy(json);
              }}
            >
              Copy
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onDownload(
                  new Blob([json], { type: 'application/json;charset=utf-8' }),
                  `${baseFilename}.json`,
                );
              }}
            >
              Download
            </Button>
          </div>
        </>
      ) : null}

      {/*
        The notes come FIRST, above the numbers. Everything in this list is a
        change to the result that the user did not ask for, and the numbers are
        the part they already know.
      */}
      {raw ? null : report.notes.length === 0 ? null : (
        <ul className={styles.notes} aria-label={`${label} notes`}>
          {report.notes.map((note) => (
            <li key={note.title} className={noteClass(note.level)}>
              <span className={styles.noteWord}>{NOTE_WORD[note.level] ?? 'Note'}</span>
              <span className={styles.noteTitle}>{note.title}</span>
              <span className={styles.noteBody}>{note.body}</span>
            </li>
          ))}
        </ul>
      )}

      {raw || rows.length === 0 ? null : (
        <table className={styles.table}>
          <caption className={styles.hidden}>Before and after the conversion</caption>
          <thead>
            <tr>
              <th scope="col">
                <span className={styles.hidden}>Property</span>
              </th>
              <th scope="col">From</th>
              <th scope="col">To</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                {/*
                  A row header rather than a cell, so a screen reader reading
                  the "To" cell announces which property it belongs to instead
                  of leaving the user to count columns.
                */}
                <th scope="row" className={styles.rowHead}>
                  {row.label}
                </th>
                <td className={styles.value}>{row.from === '' ? '—' : row.from}</td>
                <td className={styles.value}>{row.to === '' ? '—' : row.to}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {raw || report.summary === null ? null : <p className={styles.summary}>{report.summary}</p>}
    </section>
  );
}
