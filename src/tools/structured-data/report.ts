import type { JsonValue } from '@/features/registry/types';
import { lossLine, lost, noted, notesToJson, type ToolNote } from '@/lib/notes';

import { DELIMITERS, type Format, type Reading } from './convert';

/**
 * THE PORT THAT SAYS WHAT THIS TOOL DECIDED, AND WHAT IT COST.
 *
 * `text-convert` has had a `Detected` output since it was written, precisely so
 * that a wrong guess about a document's format is visible rather than silent.
 * `structured-data` - which has strictly more ways to guess wrong, four formats
 * and four delimiters - had none, and it also had nowhere to put the three
 * losses inside its own conversions. Those are the same hole, and this is the
 * one change that closes it.
 *
 * WHY A `report` PORT AND NOT A SENTENCE. There is more than one thing to say
 * now - the format, the delimiter, and a note per loss with a level - and
 * `ReportView` already draws exactly that shape for `image-convert`. A second
 * renderer for the same payload would be a second thing to keep in step.
 *
 * WHY IT IS NOT ENOUGH ON ITS OWN. A port is visible on `/tools`, where every
 * output is drawn whether or not anything is wired to it, and INVISIBLE on the
 * canvas, where a node summarises its first output and nothing else. That is
 * why the notes' `warn` level means what it means: the canvas reads it off this
 * port and prints it on the node's face. See `resultSummary.lossSummary`.
 */

const FORMAT_NAMES: Readonly<Record<Format, string>> = {
  json: 'JSON',
  yaml: 'YAML',
  csv: 'CSV',
  tsv: 'TSV',
};

const DELIMITER_NAMES: Readonly<Record<string, string>> = {
  [DELIMITERS.comma]: 'comma',
  [DELIMITERS.semicolon]: 'semicolon',
  [DELIMITERS.tab]: 'tab',
  [DELIMITERS.pipe]: 'pipe',
};

/** A delimiter as a person names it, for a report row. */
export function delimiterName(delimiter: string | null): string | null {
  if (delimiter === null) return null;
  return DELIMITER_NAMES[delimiter] ?? JSON.stringify(delimiter);
}

export interface ReportInput {
  readonly reading: Reading;
  readonly target: Format;
  readonly targetDelimiter: string | null;
  /** True when the source format was chosen on the panel rather than guessed. */
  readonly chosen: boolean;
  /** Notes from the write half, which knows what the target could not hold. */
  readonly writeNotes: readonly ToolNote[];
  /** True when the writer really did put several documents in one file. */
  readonly wroteStream: boolean;
  /** Notes from before either half: a byte order mark, say. */
  readonly inputNotes: readonly ToolNote[];
}

/**
 * WHAT HAPPENED TO A STREAM, WHICH DEPENDS ENTIRELY ON WHERE IT WENT.
 *
 * `---`-separated documents and JSON Lines are both "several documents in one
 * file", and both have exactly one JSON-representable form: an array. That is
 * the right answer and it was never the problem. The problem was that a
 * Kubernetes manifest converted to JSON and back came out as a SEQUENCE - a
 * file `kubectl` will not read - with nothing anywhere to say so.
 *
 * Round three fixed the YAML target, which now writes the stream back as a
 * stream. So there are two facts to report and they are not the same fact, and
 * only the writer knows which one happened: `wroteStream` is measured rather
 * than inferred, because `sortKeys` and a value arriving on the `json` port can
 * both put a different array in front of the writer.
 */
function streamNotes(documents: number, wroteStream: boolean): readonly ToolNote[] {
  if (documents <= 1) return [];
  const count = documents.toString();

  return wroteStream
    ? [
        noted(
          `Read as a stream of ${count} documents, and written back as one`,
          'The source separates its documents, and so does the output: a `---` goes in front of each. Convert to JSON, CSV or TSV instead and the documents become the elements of an array, because none of those has a document separator.',
        ),
      ]
    : [
        lost(
          `A stream of ${count} documents became an array`,
          'The source holds several documents in one file. JSON, CSV and TSV have no spelling for a document separator, so they become the elements of an array - and converting the result back produces one document, not several. Choose YAML as the target to keep the stream.',
        ),
      ];
}

export function buildReport(input: ReportInput): JsonValue {
  const { reading, target, chosen } = input;

  const notes: ToolNote[] = [
    ...input.inputNotes,
    ...reading.notes,
    ...streamNotes(reading.documents, input.wroteStream),
    ...input.writeNotes,
  ];

  const from = FORMAT_NAMES[reading.format];
  const to = FORMAT_NAMES[target];
  const losses = lossLine(notes);

  /*
   * The summary is the line a node prints when there is NOTHING lost, and the
   * first line of the panel otherwise. `JSON → YAML` is the whole answer to
   * "what did it decide"; the losses are appended because a summary that omits
   * them would be the second wording of the same fact going out of step with
   * the first.
   */
  const summary = `${chosen ? from : `${from} (detected)`} → ${to}${losses === null ? '' : ` · ${losses}`}`;

  return {
    summary,
    from: {
      format: from,
      delimiter: delimiterName(reading.delimiter),
      // Only when there is more than one, because a "Documents: 1" row against
      // an empty one is a row that says nothing on every ordinary conversion -
      // and `factRows` drops a row exactly when neither side has anything.
      documents: reading.documents > 1 ? reading.documents : null,
    },
    to: {
      format: to,
      delimiter: delimiterName(input.targetDelimiter),
    },
    detected: !chosen,
    notes: notesToJson(notes),
  };
}
