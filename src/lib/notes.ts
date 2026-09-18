import type { JsonValue } from '@/features/registry/types';

/**
 * WHAT A CONVERSION LOST, IN THE ONE SHAPE EVERY VIEW ALREADY READS.
 *
 * `image-convert` and `video-remux` invented this shape - a level, a title and
 * a body, on a `report`-presented output port - and `ReportView` was written
 * to draw it. Round three needs the same channel for four more tools, so the
 * shape is written down once here rather than copied a fifth time.
 *
 * THE LEVELS ARE NOT INTERCHANGEABLE, and the difference is what the canvas
 * reads:
 *
 *   warn  something the conversion COULD NOT CARRY. A rounded integer, a
 *         nested object flattened into a cell, a stream that became an array.
 *         This is the level a node prints on its own face - see
 *         `resultSummary.lossSummary` - because a loss nobody scrolls to has
 *         not been told.
 *   info  something worth knowing that cost nothing. What format was detected,
 *         which delimiter was used, a setting that did not apply.
 *
 * So `warn` is a promise: every note at that level names something that went
 * in and did not come out. Anything that merely explains the run is `info`,
 * and a note that cries wolf is one nobody reads on the day it is true.
 */
export type NoteLevel = 'warn' | 'info';

export interface ToolNote {
  readonly level: NoteLevel;
  /** One line, written for a person. This is what a node prints. */
  readonly title: string;
  /** The rest of the explanation, including what to do instead. */
  readonly body: string;
  /**
   * WHICH OF THIS TOOL'S OUTPUT PORTS THE LOSS IS ACTUALLY IN.
   *
   * Empty on an `info` note, because nothing was lost for a port to carry.
   *
   * A LOSS IS NOT A PROPERTY OF THE RUN, IT IS A PROPERTY OF A VALUE, and
   * round seven is where that distinction stopped being academic.
   * `structured-data` declares three outputs: `output` is the document in the
   * target format, `data` is the parsed SOURCE structure, and `report` is this
   * list. Converting `[{"user": {"name": "ada"}}]` to CSV flattens the nested
   * object into a cell - and that happens in the WRITE half, so the damage is
   * in `output` and `data` still holds the object intact. `data` is also the
   * port whose whole description is "for wiring into another tool": it is the
   * way AROUND this loss.
   *
   * So a downstream node fed from `data` is not downstream of anything, and a
   * warning on it would be the one thing the canvas rules refuse outright - a
   * note that fires on the workaround. Round three's read of "the node lost
   * something" was accurate about the node and too coarse to follow a wire,
   * which is why this field exists rather than a rule in the canvas that
   * guesses.
   *
   * Required rather than optional, and required on `lost` rather than on
   * `ToolNote`: a default would have to be either "every port" or "no port",
   * and both are silent when a new tool forgets. See
   * `notePorts.test.ts`, which holds every warn note this app can produce to a
   * non-empty subset of its tool's own non-report output ports.
   */
  readonly reaches: readonly string[];
}

/**
 * A note at `warn`: something went in and did not come out.
 *
 * `reaches` names the output ports the loss is in. See `ToolNote.reaches`;
 * naming a port the tool does not declare, or naming none, fails a test.
 */
export function lost(title: string, body: string, reaches: readonly string[]): ToolNote {
  return { level: 'warn', title, body, reaches };
}

/** A note at `info`: something worth knowing that cost nothing. */
export function noted(title: string, body: string): ToolNote {
  return { level: 'info', title, body, reaches: [] };
}

/**
 * The one line that goes on a node and at the end of a report's summary.
 *
 * Titles rather than bodies, joined - the same choice `image-convert` made for
 * its own summary line, for the same reason: the title is the sentence, and
 * the body is why.
 */
export function lossLine(notes: readonly ToolNote[]): string | null {
  const titles = notes.filter((note) => note.level === 'warn').map((note) => note.title);
  return titles.length === 0 ? null : titles.join(' · ');
}

/** `notes` as it crosses a port: plain JSON, which is all a worker can send. */
export function notesToJson(notes: readonly ToolNote[]): JsonValue {
  return notes.map((note) => ({
    level: note.level,
    title: note.title,
    body: note.body,
    // As an array of strings, so the canvas can read it off the port without
    // knowing anything about the tool that wrote it. See `lossTrace.ts`.
    reaches: [...note.reaches],
  }));
}
