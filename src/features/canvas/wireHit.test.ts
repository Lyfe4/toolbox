import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { distanceToWire, nearestEdge, portPositionById, wirePath } from './geometry';

import type { CanvasNode, GraphData, Point } from './types';

/**
 * WHICH WIRE A PRESS MEANS.
 *
 * A wire is a 1.5px curve on a plane that pans and zooms, and it is the only
 * thing on this canvas with no box of its own to grow into a target. The grab
 * band is 24px wide on a mouse and 44px under a finger, which makes a wire
 * hittable and immediately creates the second problem: bands that wide overlap
 * wherever wires converge, and they converge hardest at a node's inputs, which
 * sit on a 24px pitch. The browser hands such a press to whichever band paints
 * last - document order, which is to say an arbitrary wire that changes the
 * moment an unrelated one is added.
 *
 * `nearestEdge` is the rule a person is actually applying when they aim, and it
 * is a total order, so the same press always selects the same wire. These tests
 * are about that arithmetic; whether the band is really 24px on screen at every
 * zoom is a question about layout and is asserted in
 * `scripts/cross-browser-check.mjs`.
 */

function node(id: string, toolId: CanvasNode['toolId'], x: number, y: number): CanvasNode {
  return { id, toolId, position: { x, y }, options: {}, inputs: {}, fileInputs: {} };
}

/** Two base64 nodes feeding one diff, which is the only two-input tool. */
function convergingGraph(): GraphData {
  const nodes = [
    node('a', 'base64', 0, 0),
    node('b', 'base64', 0, 400),
    node('d', 'diff', 500, 100),
  ];

  return {
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    nodeOrder: nodes.map((n) => n.id),
    edges: {
      top: {
        id: 'top',
        from: { nodeId: 'a', portId: 'output' },
        to: { nodeId: 'd', portId: 'original' },
      },
      bottom: {
        id: 'bottom',
        from: { nodeId: 'b', portId: 'output' },
        to: { nodeId: 'd', portId: 'changed' },
      },
    },
    edgeOrder: ['top', 'bottom'],
    nextId: 4,
  };
}

/** Where a named edge starts and ends, through the layer's own arithmetic. */
function endsOf(graph: GraphData, id: string): { from: Point; to: Point } {
  const edge = graph.edges[id];
  if (!edge) throw new Error(`no edge ${id}`);
  const from = portPositionById(graph, edge.from.nodeId, 'output', edge.from.portId);
  const to = portPositionById(graph, edge.to.nodeId, 'input', edge.to.portId);
  if (!from || !to) throw new Error(`no ends for ${id}`);
  return { from, to };
}

describe('distance to a wire', () => {
  it('is zero at either end', () => {
    const graph = convergingGraph();
    const { from, to } = endsOf(graph, 'top');

    expect(distanceToWire(from, to, from)).toBeCloseTo(0, 5);
    expect(distanceToWire(from, to, to)).toBeCloseTo(0, 5);
  });

  /*
   * The curve is a cubic whose control points push horizontally, so a wire
   * between two ports at the same height is a straight horizontal line and its
   * distance is plain vertical offset. That is the one case with an answer
   * worth writing down by hand.
   */
  it('is the perpendicular offset for a wire between two ports at one height', () => {
    const from = { x: 0, y: 100 };
    const to = { x: 300, y: 100 };

    expect(distanceToWire(from, to, { x: 150, y: 110 })).toBeCloseTo(10, 3);
    expect(distanceToWire(from, to, { x: 150, y: 60 })).toBeCloseTo(40, 3);
  });

  /*
   * A SAMPLED CURVE MUST NOT REPORT A DISTANCE THE CURVE DOES NOT HAVE.
   *
   * The polyline through the samples is a chord approximation, so it can only
   * ever cut INSIDE the curve - meaning a measured distance is an upper bound
   * on the true one and never an under-estimate that would make a wire look
   * nearer than it is. The property that has to hold is the one a caller
   * depends on: a point taken from the curve itself measures as being on it.
   *
   * THE HALF-PIXEL IS THE POINT, not a round number. This test is what set
   * `WIRE_SAMPLES`: at 24 segments it failed here with a worst case of 1.0px
   * on a 1200px wire, which is exactly the kind of quiet inaccuracy a
   * hand-written three-point test cannot find.
   *
   * AND IT IS WHAT CAUGHT THE SECOND VERSION OF THE SAME MISTAKE. Forty-eight
   * segments was then chosen for this bound and does not meet it - the real
   * worst case is 0.62px, at a wire running fully backwards between opposite
   * corners, near its far end. So this passed on most runs and failed on the
   * ones where fast-check reached that corner: about one in six, with a
   * message about a number rather than about a wire. The count is 96 now,
   * measured at 0.084px, and the bound below is unchanged because it is the
   * property a caller depends on rather than a description of the sampling.
   */
  it('reports a point taken off the curve as being on the curve', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -600, max: 600 }),
        fc.integer({ min: -600, max: 600 }),
        fc.integer({ min: -600, max: 600 }),
        fc.integer({ min: -600, max: 600 }),
        fc.integer({ min: 0, max: 100 }),
        (fromX, fromY, toX, toY, atPercent) => {
          const from = { x: fromX, y: fromY };
          const to = { x: toX, y: toY };

          /*
           * THE SAMPLE COMES OFF THE EXACT CURVE; THE MEASUREMENT COMES OFF
           * THE FLATTENED ONE. That asymmetry is the whole test.
           *
           * `pointOnDrawnCurve` reads the four control points out of the `d`
           * attribute `wirePath` emits and evaluates the cubic at `t`, so the
           * point is on the curve the browser will paint. `distanceToWire`
           * measures against its own 96-segment polyline. What is being bounded
           * is the gap between those two - the error the approximation
           * introduces - over the whole plane rather than at the three points a
           * hand-written case can name.
           */
          expect(wirePath(from, to)).toContain('C');

          const t = atPercent / 100;
          const point = pointOnDrawnCurve(from, to, t);
          expect(distanceToWire(from, to, point)).toBeLessThan(0.5);
        },
      ),
      { numRuns: 300 },
    );
  });
});

/**
 * A point on the cubic that `wirePath` writes, read back out of the path
 * string.
 *
 * Parsed rather than recomputed, deliberately: recomputing the bezier here
 * would mean this test agrees with `distanceToWire` because both were written
 * by the same hand, which is not evidence. Parsing the `d` attribute means the
 * geometry under test is the geometry the browser will paint.
 */
function pointOnDrawnCurve(from: Point, to: Point, t: number): Point {
  const numbers = [...wirePath(from, to).matchAll(/-?\d+(?:\.\d+)?/g)].map((match) =>
    Number(match[0]),
  );
  const [p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y] = numbers;
  if (
    p0x === undefined ||
    p0y === undefined ||
    p1x === undefined ||
    p1y === undefined ||
    p2x === undefined ||
    p2y === undefined ||
    p3x === undefined ||
    p3y === undefined
  ) {
    throw new Error(`unparseable path: ${wirePath(from, to)}`);
  }

  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;

  return {
    x: a * p0x + b * p1x + c * p2x + d * p3x,
    y: a * p0y + b * p1y + c * p2y + d * p3y,
  };
}

describe('the nearest wire', () => {
  it('is null on a graph with no wires', () => {
    const graph = { ...convergingGraph(), edges: {}, edgeOrder: [] };
    expect(nearestEdge(graph, { x: 100, y: 100 })).toBeNull();
  });

  /*
   * THE ONE THIS FUNCTION EXISTS FOR.
   *
   * Two wires arriving at the two inputs of one `diff` node, which are 24px
   * apart. A press just above the upper one has to select the upper one and a
   * press just below the lower one the lower - and, crucially, the answer must
   * not depend on which of them was added first. So the same two presses are
   * repeated against a graph with the edge order reversed, which is exactly
   * what changes when the browser's own paint-order hit test is trusted.
   */
  it('picks the nearer of two wires converging on one node, whatever order they are in', () => {
    const graph = convergingGraph();
    const top = endsOf(graph, 'top');
    const bottom = endsOf(graph, 'bottom');

    const reversed: GraphData = { ...graph, edgeOrder: ['bottom', 'top'] };

    for (const candidate of [graph, reversed]) {
      expect(nearestEdge(candidate, { x: top.to.x - 6, y: top.to.y - 8 })).toBe('top');
      expect(nearestEdge(candidate, { x: bottom.to.x - 6, y: bottom.to.y + 8 })).toBe('bottom');
    }
  });

  /*
   * A press exactly between the two is a tie, and a tie has to resolve the
   * same way twice rather than by whichever comparison happened to run first.
   * `<` rather than `<=` in the scan means the earliest edge in `edgeOrder`
   * holds a tie, which is stated here because the opposite is just as arguable
   * and a future rewrite should have to change a test to change the answer.
   */
  it('resolves an exact tie in favour of the earlier wire, repeatably', () => {
    const graph = convergingGraph();
    const top = endsOf(graph, 'top');
    const bottom = endsOf(graph, 'bottom');
    const between = { x: top.to.x, y: (top.to.y + bottom.to.y) / 2 };

    expect(nearestEdge(graph, between)).toBe(nearestEdge(graph, between));
    expect(nearestEdge({ ...graph, edgeOrder: ['bottom', 'top'] }, between)).toBe('bottom');
  });

  /*
   * A wire whose node has gone is skipped rather than crashing or winning.
   * `edges` and `nodes` are separate records in the document and a hand-edited
   * save can name a node that is not there - the same class of input
   * `CanvasNodeView` guards its file summary against.
   */
  it('ignores a wire whose endpoints cannot be placed', () => {
    const graph = convergingGraph();
    const orphaned: GraphData = {
      ...graph,
      edges: {
        ...graph.edges,
        ghost: {
          id: 'ghost',
          from: { nodeId: 'missing', portId: 'output' },
          to: { nodeId: 'd', portId: 'original' },
        },
      },
      edgeOrder: ['ghost', 'top', 'bottom'],
    };

    const top = endsOf(graph, 'top');
    expect(nearestEdge(orphaned, { x: top.to.x - 6, y: top.to.y - 8 })).toBe('top');
  });
});
