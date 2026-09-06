import { isJsonArray, isJsonObject, type JsonValue } from '@/features/registry/types';

import styles from './regex.module.css';

/**
 * REGEX RESULT RENDERING
 *
 * A regex tester earns its keep in the moment the pattern does not do what
 * the person expected, so this view is arranged around that moment rather
 * than around the happy path:
 *
 *  1. WHAT HAPPENED, in one line, including the flags - because half of the
 *     surprises in this tool are a flag being on or off.
 *  2. WHY, if the tool worked it out. The notes come from running the pattern
 *     again with one thing changed, so they are findings rather than advice.
 *  3. WHERE, as a highlight over the subject. Matches are marked with a
 *     background AND an underline, so the picture survives greyscale, and a
 *     zero-length match - which has no text to colour - is drawn as a caret
 *     with a hidden label rather than as nothing at all.
 *  4. WHAT EXACTLY, as a table. The highlight cannot show overlapping capture
 *     groups without lying about them; the table states each group's offsets
 *     unambiguously and is the authoritative half of the pair.
 *
 * The payload is read defensively rather than cast. It arrives as JsonValue
 * because it crossed the worker boundary, and reading it back with checks
 * means a future change to the tool's output shows up as a missing section
 * instead of a crash inside a render.
 */

/** Beyond this the table stops; the text output still lists everything. */
const MAX_TABLE_ROWS = 200;

interface GroupRow {
  readonly number: number;
  readonly name: string | null;
  readonly value: string | null;
  readonly start: number | null;
  readonly end: number | null;
}

interface MatchRow {
  readonly index: number;
  readonly line: number;
  readonly column: number;
  readonly match: string;
  readonly empty: boolean;
  readonly groups: readonly GroupRow[];
}

interface Segment {
  readonly text: string;
  readonly match: number | null;
}

interface Note {
  readonly level: string;
  readonly title: string;
  readonly body: string;
}

interface RiskFinding {
  readonly level: string;
  readonly message: string;
}

interface Report {
  readonly pattern: string;
  readonly flags: string;
  readonly mode: string;
  readonly count: number;
  readonly listed: number;
  readonly truncated: boolean;
  readonly complete: boolean;
  readonly matches: readonly MatchRow[];
  readonly segments: readonly Segment[] | null;
  readonly highlightSkipped: string | null;
  readonly notes: readonly Note[];
  readonly riskLevel: string;
  readonly riskFindings: readonly RiskFinding[];
}

const text = (value: JsonValue | undefined, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const number = (value: JsonValue | undefined, fallback = 0): number =>
  typeof value === 'number' ? value : fallback;

const boolean = (value: JsonValue | undefined): boolean => value === true;

function parseGroups(value: JsonValue | undefined): readonly GroupRow[] {
  if (value === undefined || !isJsonArray(value)) return [];

  return value.filter(isJsonObject).map((group) => ({
    number: number(group.number),
    name: typeof group.name === 'string' ? group.name : null,
    value: typeof group.value === 'string' ? group.value : null,
    start: typeof group.start === 'number' ? group.start : null,
    end: typeof group.end === 'number' ? group.end : null,
  }));
}

function parseReport(value: JsonValue): Report | null {
  if (!isJsonObject(value)) return null;

  const rawMatches = value.matches;
  if (rawMatches === undefined || !isJsonArray(rawMatches)) return null;

  const rawSegments = value.segments;
  const rawNotes = value.notes;
  const rawRisk = value.risk;
  const risk = rawRisk !== undefined && isJsonObject(rawRisk) ? rawRisk : null;
  const rawFindings = risk?.findings;

  return {
    pattern: text(value.pattern),
    flags: text(value.flags),
    mode: text(value.mode, 'match'),
    count: number(value.count),
    listed: number(value.listed),
    truncated: boolean(value.truncated),
    // Absent in a payload from an older build: assume it finished rather than
    // inventing a warning the tool never raised.
    complete: value.complete === undefined ? true : boolean(value.complete),
    matches: rawMatches.filter(isJsonObject).map((match) => ({
      index: number(match.index),
      line: number(match.line, 1),
      column: number(match.column, 1),
      match: text(match.match),
      empty: boolean(match.empty),
      groups: parseGroups(match.groups),
    })),
    segments:
      rawSegments !== undefined && isJsonArray(rawSegments)
        ? rawSegments.filter(isJsonObject).map((segment) => ({
            text: text(segment.text),
            match: typeof segment.match === 'number' ? segment.match : null,
          }))
        : null,
    highlightSkipped: typeof value.highlightSkipped === 'string' ? value.highlightSkipped : null,
    notes:
      rawNotes !== undefined && isJsonArray(rawNotes)
        ? rawNotes.filter(isJsonObject).map((note) => ({
            level: text(note.level, 'info'),
            title: text(note.title),
            body: text(note.body),
          }))
        : [],
    riskLevel: text(risk?.level, 'none'),
    riskFindings:
      rawFindings !== undefined && isJsonArray(rawFindings)
        ? rawFindings.filter(isJsonObject).map((finding) => ({
            level: text(finding.level, 'caution'),
            message: text(finding.message),
          }))
        : [],
  };
}

/* -------------------------------------------------------------------------- *
 * Pieces
 * -------------------------------------------------------------------------- */

/** The level in words. Colour is a second signal here, never the only one. */
const NOTE_WORD: Readonly<Record<string, string>> = {
  warn: 'Warning',
  hint: 'Try this',
  info: 'Note',
};

/**
 * Backtick spans in a note, rendered as code.
 *
 * The notes are written once, in the tool, and read both here and by anything
 * consuming the JSON - so they carry their emphasis as Markdown-ish backticks
 * rather than as markup. Splitting on the backtick is the whole of it: there
 * is no parser here and no `innerHTML` anywhere near it.
 */
function Prose({ children }: { readonly children: string }) {
  const parts = children.split('`');

  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <code key={`code-${index.toString()}`} className={styles.code}>
            {part}
          </code>
        ) : (
          <span key={`text-${index.toString()}`}>{part}</span>
        ),
      )}
    </>
  );
}

function noteClass(level: string): string {
  if (level === 'warn') return styles.noteWarn ?? '';
  if (level === 'hint') return styles.noteHint ?? '';
  return styles.noteInfo ?? '';
}

function Highlight({ report }: { readonly report: Report }) {
  if (!report.segments) {
    return (
      <p className={styles.aside}>
        {report.highlightSkipped === 'too-long'
          ? 'The subject is too long to highlight. The offsets below still describe every match.'
          : 'No highlight for this run.'}
      </p>
    );
  }

  return (
    <>
      {/*
        tabIndex, because this box scrolls. A scrollable region that cannot be
        focused is unreachable for anyone driving the page from the keyboard -
        the same defect this project already found once in its shortcuts
        dialog, and the reason axe runs in a real engine.
      */}
      <div
        className={styles.highlight}
        tabIndex={0}
        role="group"
        aria-label="Subject text with matches highlighted"
      >
        <pre className={styles.subject}>
          {/*
            Keyed by position. Segments are a rendering of one immutable run
            and are never reordered or spliced, so the index IS the identity.
          */}
          {report.segments.map((segment, index) =>
            segment.match === null ? (
              <span key={`gap-${index.toString()}`}>{segment.text}</span>
            ) : (
              <mark
                key={`hit-${index.toString()}`}
                className={segment.text === '' ? styles.markEmpty : styles.mark}
              >
                {segment.text === '' ? (
                  <span className={styles.hidden}>empty match</span>
                ) : (
                  segment.text
                )}
              </mark>
            ),
          )}
        </pre>
      </div>
      {report.highlightSkipped === 'too-many' ? (
        <p className={styles.aside}>
          The highlight stops after the first {countOfHighlighted(report).toLocaleString('en')}{' '}
          matches; the count above covers all of them.
        </p>
      ) : null}
    </>
  );
}

function countOfHighlighted(report: Report): number {
  return new Set(
    (report.segments ?? []).map((segment) => segment.match).filter((match) => match !== null),
  ).size;
}

function MatchTable({ report }: { readonly report: Report }) {
  const rows = report.matches.slice(0, MAX_TABLE_ROWS);
  const withGroups = rows.some((row) => row.groups.length > 0);

  return (
    <div className={styles.tableWrap} tabIndex={0} role="group" aria-label="Match listing">
      <table className={styles.table}>
        <caption className={styles.hidden}>
          Every match, with its offset and its capture groups
        </caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            {/* The unit is stated because it is not the one people assume. */}
            <th scope="col">Offset (UTF-16)</th>
            <th scope="col">Line:col</th>
            <th scope="col">Match</th>
            {withGroups ? <th scope="col">Groups</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.index.toString()}-${index.toString()}`}>
              <td className={styles.numeric}>{index + 1}</td>
              <td className={styles.numeric}>{row.index}</td>
              <td className={styles.numeric}>
                {row.line}:{row.column}
              </td>
              <td className={styles.cell}>
                {row.empty ? (
                  <span className={styles.aside}>(empty match)</span>
                ) : (
                  <span className={styles.value}>{visible(row.match)}</span>
                )}
              </td>
              {withGroups ? (
                <td className={styles.cell}>
                  <ul className={styles.groupList}>
                    {row.groups.map((group) => (
                      <li key={group.number}>
                        <span className={styles.groupName}>
                          ${group.number}
                          {group.name === null ? '' : ` \u00b7 ${group.name}`}
                        </span>{' '}
                        {group.value === null ? (
                          <span className={styles.aside}>did not participate</span>
                        ) : (
                          <>
                            <span className={styles.value}>{visible(group.value)}</span>
                            {group.start === null ? null : (
                              <span className={styles.aside}> at {group.start}</span>
                            )}
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {report.matches.length > rows.length ? (
        <p className={styles.aside}>
          {(report.matches.length - rows.length).toLocaleString('en')} more in the Result output.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Line breaks and tabs, made visible.
 *
 * A cell containing a real newline silently becomes two lines and reads as
 * two matches. Showing the escape is the only honest way to put a
 * multi-line match in a one-line cell.
 */
function visible(value: string): string {
  return value.replaceAll('\r', '\\r').replaceAll('\n', '\\n').replaceAll('\t', '\\t');
}

/* -------------------------------------------------------------------------- *
 * View
 * -------------------------------------------------------------------------- */

export interface RegexViewProps {
  readonly value: JsonValue;
  readonly label: string;
}

export function RegexView({ value, label }: RegexViewProps) {
  const report = parseReport(value);
  if (!report) return <p className={styles.aside}>Nothing to show.</p>;

  const plural = report.count === 1 ? 'match' : 'matches';

  return (
    <section className={styles.wrapper} aria-label={label}>
      <p className={styles.summary}>
        <span className={styles.count}>
          {report.count.toLocaleString('en')} {plural}
          {report.complete ? '' : ' so far'}
        </span>
        {report.pattern === '' ? null : (
          <span className={styles.pattern}>
            /{report.pattern}/{report.flags}
          </span>
        )}
      </p>

      {report.riskLevel === 'none' ? null : (
        <div className={styles.risk}>
          <p className={styles.riskHead}>
            {report.riskLevel === 'danger'
              ? 'This pattern can backtrack catastrophically'
              : 'Worth a look before running this on more text'}
          </p>
          <ul className={styles.riskList}>
            {report.riskFindings.map((finding) => (
              <li key={finding.message}>
                <Prose>{finding.message}</Prose>
              </li>
            ))}
          </ul>
          <p className={styles.aside}>
            A structural check, not a proof. It can be wrong in both directions.
          </p>
        </div>
      )}

      {report.notes.length === 0 ? null : (
        <ul className={styles.notes}>
          {report.notes.map((note) => (
            <li key={note.title} className={noteClass(note.level)}>
              <span className={styles.noteWord}>{NOTE_WORD[note.level] ?? 'Note'}</span>
              <span className={styles.noteTitle}>
                <Prose>{note.title}</Prose>
              </span>
              <span className={styles.noteBody}>
                <Prose>{note.body}</Prose>
              </span>
            </li>
          ))}
        </ul>
      )}

      {report.matches.length === 0 ? null : (
        <>
          <Highlight report={report} />
          <MatchTable report={report} />
        </>
      )}
    </section>
  );
}
