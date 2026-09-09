/**
 * ANNOUNCEMENTS, AS A LOG RATHER THAN A VARIABLE
 *
 * A live region holds one string. Writing a second string over the first is
 * how you lose the first, and this canvas has several independent sources of
 * speech - the graph store, the pipeline, the viewport - that do not know
 * about each other and cannot be asked to take turns.
 *
 * That has surfaced here four separate times in four different costumes: a
 * connection refusal swallowed by a re-run, a move overwritten by a pipeline
 * summary, a fit-to-view assertion that was red at HEAD because whichever
 * message arrived last won. It was treated as four coincidences. It is one
 * problem, and it has two halves:
 *
 *   1. Messages are lost BEFORE the DOM. React batches, so two `announce`
 *      calls in one tick produce a single render carrying only the second.
 *      Nothing downstream can recover the first, because it never existed as
 *      a rendered value. That is what this module fixes: every announcement
 *      is appended to a log, and the log is the thing components read.
 *
 *   2. Messages are lost AFTER the DOM, when the region's text is replaced
 *      before an assistive technology has observed the previous mutation.
 *      That is fixed in `LiveRegion`, which drains this log one message at a
 *      time.
 *
 * Fixing only (2) would still drop same-tick messages; fixing only (1) would
 * deliver them all in one indistinguishable blur. Both halves are needed, so
 * both are here rather than being patched at whichever call site noticed.
 */

/** A message bound for a live region. */
export interface Announcement {
  readonly text: string;
  /**
   * Increments on every announcement, so saying the same thing twice in a row
   * is still two messages - a live region handed identical text is silent, and
   * "Moved to 40, 40" twice is two real events.
   */
  readonly seq: number;
  /**
   * Groups messages that supersede one another.
   *
   * Holding an arrow key produces a position announcement per repeat. Reading
   * all fifteen would leave a screen-reader user listening to where the node
   * used to be for several seconds after it stopped moving, so a queued
   * message is dropped when a later queued message shares its channel. Only
   * messages still WAITING are affected: anything already spoken stays spoken,
   * and a message with no channel is never superseded by anything.
   */
  readonly channel?: string;
}

/** The slice of a store that owns a live region's messages. */
export interface AnnouncementSlice {
  /** The most recent message. The log is what a region should render. */
  readonly announcement: Announcement;
  /** Every message, oldest first, bounded by RETAINED. */
  readonly announcementLog: readonly Announcement[];
}

/**
 * How many messages the log keeps.
 *
 * Bounded because it is unbounded state on a page that can stay open for days.
 * Generous enough that the drain in `LiveRegion` - one message every couple of
 * hundred milliseconds - cannot fall behind any burst a person can produce.
 */
export const RETAINED_ANNOUNCEMENTS = 32;

export const EMPTY_ANNOUNCEMENTS: AnnouncementSlice = {
  announcement: { text: '', seq: 0 },
  announcementLog: [],
};

/** Appends a message, returning the new slice. */
export function appendAnnouncement(
  slice: AnnouncementSlice,
  text: string,
  channel?: string,
): AnnouncementSlice {
  const announcement: Announcement = {
    text,
    seq: slice.announcement.seq + 1,
    ...(channel === undefined ? {} : { channel }),
  };

  return {
    announcement,
    announcementLog: [...slice.announcementLog, announcement].slice(-RETAINED_ANNOUNCEMENTS),
  };
}

/**
 * The next message to speak, given everything already spoken.
 *
 * Returns the oldest unspoken message, except that a message is skipped when a
 * LATER unspoken message shares its channel - see `Announcement.channel`. The
 * returned message's `seq` is what the caller should record as consumed, which
 * is what makes the skip permanent rather than a message that keeps coming
 * back.
 */
export function nextAnnouncement(
  log: readonly Announcement[],
  consumedSeq: number,
): Announcement | null {
  const waiting = log.filter((entry) => entry.seq > consumedSeq);

  for (let index = 0; index < waiting.length; index += 1) {
    const candidate = waiting[index];
    if (candidate === undefined) continue;
    if (candidate.channel === undefined) return candidate;

    const superseded = waiting
      .slice(index + 1)
      .some((later) => later.channel === candidate.channel);
    if (!superseded) return candidate;
  }

  return null;
}
