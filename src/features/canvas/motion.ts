import { portKey } from './geometry';

import type { Arrivals } from './graphStore';
import type { EdgeId, NodeId } from './types';

/**
 * THE CANVAS'S MOTION, AND THE RULE ALL OF IT FOLLOWS.
 *
 * Five things move: a wire draws in, a node settles, a port flicks when a wire
 * lands on it, a node's timing counts up, and the grid draws in once per page
 * load. Every one of them is TRIGGERED BY AN EVENT AND RUNS FOR A FIXED
 * LENGTH. None of them tracks how long anything took, because nodes here run
 * in 1-8ms - under a frame - and motion tied to a real duration is motion
 * nobody sees.
 *
 * What this file owns is the part that can be decided without a document:
 * which elements an arrival is about, and what a count-up shows at a given
 * point. The motion itself is CSS wherever it can be, so the reduced-motion
 * media query can remove it outright.
 */

/**
 * The query every JavaScript half of the motion asks.
 *
 * The CSS halves answer it with `animation: none` in their own media blocks,
 * NOT with the shared override in global.css. That override collapses an
 * animation to 1ms rather than removing it, so a frame can still land inside
 * it and paint the from-state - a wire invisible, a node at 96% - for one
 * frame. For the inspector that is the price of `animationend` firing; here
 * nothing waits on an end event, so there is no reason to pay it.
 */
export const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/**
 * The ports on one node that a new wire has just touched.
 *
 * One object per node per arrival, so a node's props change identity only
 * when a wire really does land on it and the `memo` on every other node holds.
 */
export interface PortContact {
  readonly seq: number;
  /** `portKey`s. */
  readonly keys: ReadonlySet<string>;
}

/** An arrival, resolved to the elements it is about. */
export interface FreshArrivals {
  readonly seq: number;
  readonly nodes: ReadonlySet<NodeId>;
  readonly edges: ReadonlySet<EdgeId>;
  readonly ports: ReadonlyMap<NodeId, PortContact>;
}

export const NO_FRESH_ARRIVALS: FreshArrivals = {
  seq: 0,
  nodes: new Set(),
  edges: new Set(),
  ports: new Map(),
};

/**
 * Which of the store's arrivals this canvas should animate.
 *
 * `since` is the arrival the canvas found when it MOUNTED, and anything at or
 * before it is history rather than news. That is what makes navigation free of
 * motion: leave for `/tools` and come back, and the last node you added is
 * still the store's latest arrival - but it arrived before this canvas
 * existed, so nothing settles again.
 *
 * Under reduced motion nothing is fresh at all. The stylesheet removes the
 * animations too, but resolving nothing here means no class is ever written,
 * so the preference does not depend on a media block being kept in step with
 * every rule it has to cancel.
 */
export function freshArrivals(arrivals: Arrivals, since: number, reduced: boolean): FreshArrivals {
  if (reduced || arrivals.seq <= since) return NO_FRESH_ARRIVALS;

  const keys = new Map<NodeId, Set<string>>();
  const touch = (nodeId: NodeId, key: string): void => {
    const set = keys.get(nodeId) ?? new Set<string>();
    set.add(key);
    keys.set(nodeId, set);
  };
  for (const edge of arrivals.edges) {
    touch(edge.from.nodeId, portKey('output', edge.from.portId));
    touch(edge.to.nodeId, portKey('input', edge.to.portId));
  }

  return {
    seq: arrivals.seq,
    nodes: new Set(arrivals.nodes),
    edges: new Set(arrivals.edges.map((edge) => edge.id)),
    ports: new Map([...keys].map(([nodeId, set]) => [nodeId, { seq: arrivals.seq, keys: set }])),
  };
}

/** Sub-millisecond runs read as "<1ms" rather than "0ms". */
export function formatDuration(ms: number): string {
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms).toString()}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * What a counting timing figure shows, `progress` of the way through.
 *
 * In the FINAL figure's unit throughout, so `1.23s` counts `0.00s` to `1.23s`
 * rather than passing through `999ms` and changing shape on the way; the
 * figure's box is sized to its final text, so nothing beside it moves either.
 * A figure under a millisecond has nothing to count and is shown as it is.
 *
 * Rounded DOWN, so the count never shows the final value early - and at
 * `progress` 1 it is exactly `formatDuration`, the figure the node shows at
 * rest, so the last frame of the count and the resting state are one string.
 */
export function countUpText(durationMs: number, progress: number): string {
  const final = formatDuration(durationMs);
  if (progress >= 1 || durationMs < 1) return final;
  const at = Math.max(0, progress);

  if (durationMs < 1000) {
    return `${Math.floor(Math.round(durationMs) * at).toString()}ms`;
  }
  const centiseconds = Math.floor(Math.round(durationMs / 10) * at);
  return `${(centiseconds / 100).toFixed(2)}s`;
}

/**
 * A motion token's length in milliseconds, read from the cascade.
 *
 * The count-up is the one piece of motion JavaScript has to pace, and reading
 * its length back out of `--pb-motion-fast` keeps semantic.css the only place
 * that number is written. Null for anything that is not a plain `ms` or `s`
 * length, and the caller treats that as "do not animate" rather than guessing.
 *
 * `.12s` AS WELL AS `120ms`, and the first is what a browser actually hands
 * back. The build's CSS minifier rewrites `120ms` to its shortest spelling,
 * and a custom property's computed value is its tokens as written, so in both
 * engines the token reads `.12s` - no leading digit, other unit. The first
 * version of this accepted only what semantic.css says, and every count in the
 * built app ended after one frame.
 */
export function motionMs(value: string): number | null {
  const match = /^(\d*\.?\d+)(ms|s)$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  return match[2] === 's' ? amount * 1000 : amount;
}

/**
 * THE GRID'S DRAW-IN: HOW MUCH OF EACH RANK'S INK IS SHOWING, `elapsedMs` IN.
 *
 * Coarsest first. The heavy rule arrives first and each finer rank follows it
 * `GRID_DRAW_IN_STAGGER_MS` later, so the surface assembles the way the ladder
 * is built - structure, then the subdivisions between it - rather than
 * travelling across the screen. Every rule is in its final place on every
 * frame; only its ink changes, which is why a finished draw-in is exactly the
 * grid at rest and nothing about the placement can differ between the two.
 *
 * OVERLAPPING RAMPS RATHER THAN STEPS. Five ranks stepping on in turn is a pop
 * every 80ms, and a pop is the thing the grid's own fade exists to remove; with
 * each ramp longer than the stagger, at most three ranks are part-way at once
 * and the eye reads one motion. Linear, for the reason the old sweep was: an
 * eased ramp spends its tail on ink nobody can tell from full.
 *
 * Rank `r` starts at `r * STAGGER` and is whole `RAMP` later, so the finest of
 * five is whole at `4 * 60 + 160` = `GRID_DRAW_IN_MS`, the same 400ms the
 * sweep took. A rank past the ladder is simply whole.
 */
export const GRID_DRAW_IN_STAGGER_MS = 60;
export const GRID_DRAW_IN_RAMP_MS = 160;
export const GRID_DRAW_IN_MS = 4 * GRID_DRAW_IN_STAGGER_MS + GRID_DRAW_IN_RAMP_MS;

export function gridDrawInInk(elapsedMs: number, rank: number): number {
  const into = elapsedMs - rank * GRID_DRAW_IN_STAGGER_MS;
  return Math.min(1, Math.max(0, into / GRID_DRAW_IN_RAMP_MS));
}
