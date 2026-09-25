import { useEffect, useState } from 'react';

import { mediaMatches } from '@/lib/useMediaQuery';

import styles from './canvas.module.css';
import { countUpText, formatDuration, motionMs, REDUCED_MOTION } from './motion';

export interface NodeTimingProps {
  readonly durationMs: number | null;
  /** The arrival this figure may count up for, or null. */
  readonly armed: number | null;
}

/** A count in progress: which arrival it is for, and how far through it is. */
interface Count {
  readonly seq: number;
  readonly durationMs: number;
  readonly progress: number;
}

/**
 * A node's timing figure, which counts up from zero when a run it was armed
 * for lands.
 *
 * THE COUNT IS A FIXED LENGTH AND SAYS NOTHING ABOUT THE RUN. It lasts
 * `--pb-motion-fast` whether the run took 1ms or 800, because a count paced by
 * the run's own duration would be over before a frame was painted for almost
 * every node here. What it acknowledges is that a number arrived, not how long
 * the number took.
 *
 * WHEN IT COUNTS, which is the whole of the design. Only on a CHANGE of figure
 * - never on mount, so a canvas coming back from another route shows its
 * numbers as they are - and only while armed, which the store does when a node
 * is created or a wire lands on it and undoes on any typed value. Once per
 * arrival: the figure a second run produces is swapped in, not counted.
 *
 * ALWAYS MOUNTED, even with no figure, because the arming and the last figure
 * have to survive the `running` state in between - `settle` clears
 * `durationMs` while a node runs, so the figure is absent for a moment on
 * every run and this is how the count knows the next one is a change.
 */
export function NodeTiming({ durationMs, armed }: NodeTimingProps) {
  const [seen, setSeen] = useState(durationMs);
  const [played, setPlayed] = useState<number | null>(null);
  const [count, setCount] = useState<Count | null>(null);

  /*
   * DECIDED DURING RENDER, the pattern React documents for state that follows
   * a prop. An effect would decide one commit late, so the new figure would be
   * painted in full for a frame and then snap back to zero - a count that
   * begins by giving away its answer. Here the render that first has the new
   * figure is the render that shows `0ms`.
   */
  if (seen !== durationMs) {
    setSeen(durationMs);
    if (durationMs !== null && armed !== null && armed !== played) {
      setPlayed(armed);
      setCount(mediaMatches(REDUCED_MOTION) ? null : { seq: armed, durationMs, progress: 0 });
    } else if (count !== null) {
      // A new figure mid-count is shown as it is.
      setCount(null);
    }
  } else if (count !== null && count.seq !== armed) {
    // Disarmed mid-count - somebody typed - so it stops where it is.
    setCount(null);
  }

  const counting = count?.seq ?? null;

  useEffect(() => {
    if (counting === null) return undefined;

    const length = motionMs(
      getComputedStyle(document.documentElement).getPropertyValue('--pb-motion-fast'),
    );
    const started = performance.now();
    let frame = 0;

    const tick = (now: number): void => {
      const progress = length === null || length <= 0 ? 1 : (now - started) / length;
      if (progress >= 1) {
        setCount(null);
        return;
      }
      setCount((current) => (current === null ? null : { ...current, progress }));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [counting]);

  if (durationMs === null) return null;
  const final = formatDuration(durationMs);
  const text = count === null ? final : countUpText(count.durationMs, count.progress);

  return (
    /*
     * THE BOX IS THE FINAL FIGURE'S SIZE FROM THE FIRST FRAME. `0ms` is one
     * character narrower than `12ms`, and the title beside this is the flexible
     * item in the header, so a count that sized to its text would slide the
     * title's ellipsis on every step. The final text sits in the same grid
     * cell as a hidden pseudo-element and holds the width; the counting text
     * is right-aligned over it.
     */
    <span className={styles.nodeTiming} data-final={final} aria-hidden="true">
      <span className={styles.nodeTimingValue}>{text}</span>
    </span>
  );
}
