import { useEffect, useState } from 'react';

import { nextAnnouncement, type Announcement } from '@/lib/announce';

import { VisuallyHidden } from '../VisuallyHidden';

/**
 * How long a message holds the region before the next one is written.
 *
 * The region is one string, so "announce" really means "mutate this text and
 * hope something was watching". Two mutations inside a frame are one mutation
 * as far as an assistive technology is concerned, and the first message is
 * simply gone. A short floor per message is what turns a shared region from a
 * last-writer-wins variable into a queue.
 *
 * 200ms is chosen to be longer than a frame by a comfortable margin and short
 * enough that a burst of half a dozen messages still finishes inside about a
 * second. It is a delivery floor, not a reading time: assistive technologies
 * do their own queueing once they have seen the change.
 */
export const LIVE_REGION_DWELL_MS = 200;

export interface LiveRegionProps {
  /** The append-only message log to drain. See `@/lib/announce`. */
  readonly log: readonly Announcement[];
  readonly testId?: string;
  /** Overridable so a caller can tune the pace. */
  readonly dwellMs?: number;
}

interface DrainState {
  readonly spoken: Announcement | null;
  /** True while the current message is holding the floor. */
  readonly holding: boolean;
}

const NOTHING_SPOKEN: DrainState = { spoken: null, holding: false };

/**
 * A polite live region that drains a log one message at a time.
 *
 * The region element is rendered from the first paint and never conditionally:
 * a live region added to the document at the same moment as its content is
 * unreliable across assistive technologies, because there was nothing there to
 * be watching. For the same reason the first message is written one turn of
 * the event loop AFTER the commit that created the region, rather than in it.
 *
 * The message is a KEYED CHILD rather than the region's own text. Announcing
 * the same string twice - "Nothing to undo." pressed twice - writes identical
 * text, and identical text is not a DOM change and is therefore silent.
 * Keying on the sequence number replaces the child instead, which is an
 * addition, which is what `aria-live` reacts to.
 */
export function LiveRegion({ log, testId, dwellMs = LIVE_REGION_DWELL_MS }: LiveRegionProps) {
  const [state, setState] = useState<DrainState>(NOTHING_SPOKEN);

  useEffect(() => {
    if (state.holding) {
      const release = window.setTimeout(() => {
        setState((current) => ({ ...current, holding: false }));
      }, dwellMs);
      return () => {
        window.clearTimeout(release);
      };
    }

    const next = nextAnnouncement(log, state.spoken?.seq ?? 0);
    if (!next) return undefined;

    const show = window.setTimeout(() => {
      setState({ spoken: next, holding: true });
    });
    return () => {
      window.clearTimeout(show);
    };
  }, [log, state, dwellMs]);

  return (
    <VisuallyHidden as="div">
      <div
        role="status"
        aria-live="polite"
        {...(testId === undefined ? {} : { 'data-testid': testId })}
      >
        {state.spoken === null ? null : <span key={state.spoken.seq}>{state.spoken.text}</span>}
      </div>
    </VisuallyHidden>
  );
}
