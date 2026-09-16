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
}

/** A note at `warn`: something went in and did not come out. */
export function lost(title: string, body: string): ToolNote {
  return { level: 'warn', title, body };
}

/** A note at `info`: something worth knowing that cost nothing. */
export function noted(title: string, body: string): ToolNote {
  return { level: 'info', title, body };
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
  return notes.map((note) => ({ level: note.level, title: note.title, body: note.body }));
}
