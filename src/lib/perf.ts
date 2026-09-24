/**
 * User Timing marks for the execution path.
 *
 * Everything here writes to the browser's own performance timeline, which
 * means the numbers are visible in devtools' Performance panel and readable
 * from the page with `performance.getEntriesByType('measure')`. Nothing is
 * stored, nothing is aggregated, and nothing leaves the machine - it is the
 * platform's timeline, not telemetry.
 *
 * It exists because "the first run feels slow" is not a fact anyone can act
 * on. Splitting that into worker boot, tool chunk import and the tool's own
 * work is what tells you which of the three to fix.
 */

const PREFIX = 'patchbay:';

/**
 * True when the User Timing API is usable.
 *
 * `performance.measure` with a start/end options object is Level 3; jsdom
 * implements enough of it, but a guard costs nothing and this must never be
 * the reason something fails.
 */
function available(): boolean {
  return typeof performance !== 'undefined' && typeof performance.measure === 'function';
}

/**
 * Records a span on the timeline.
 *
 * Failures are swallowed on purpose. This is instrumentation: it may not
 * become a reason the app stops working.
 */
export function span(name: string, startTime: number, duration: number): void {
  if (!available() || duration < 0) return;

  try {
    performance.measure(`${PREFIX}${name}`, { start: startTime, duration });
  } catch {
    // Some engines reject a measure whose start predates the current buffer.
  }
}

/*
 * There is no reader here. One sat in this spot from the first commit that
 * wrote the module, "Used by the perf harness", and nothing ever called it:
 * the harness reads `performance.getEntriesByType('measure')` itself.
 * Removed in round seventeen, when the documentation audit read the comment.
 */
