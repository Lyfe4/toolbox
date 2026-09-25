import { memo, useEffect, useRef, useState } from 'react';

import { cx } from '@/lib/cx';

import styles from './canvas.module.css';
import { portPositionById, wirePath } from './geometry';

import type { EdgeId, GraphData, Point } from './types';

export interface WiresProps {
  readonly graph: GraphData;
  readonly selectedEdges: readonly EdgeId[];
  /** Wires currently carrying data into a running node. */
  readonly activeEdges: ReadonlySet<EdgeId>;
  /**
   * Wires that have just been connected, and draw themselves in.
   *
   * From the canvas's arrivals - see `freshArrivals` - so a wire restored by
   * undo, or loaded with a document, is simply there.
   */
  readonly arrivingEdges: ReadonlySet<EdgeId>;
  readonly onSelectEdge: (id: EdgeId, additive: boolean) => void;
  /**
   * Which wire a press at this client point means.
   *
   * Supplied by the canvas rather than worked out here, and that is a bug fix
   * rather than tidiness. The first version measured the press against this
   * layer's own `getBoundingClientRect()`, reasoning that a 1x1 SVG pinned to
   * the plane's origin IS world (0, 0). Chromium agrees. Gecko and WebKit
   * return the union with the overflowing children of an `overflow: visible`
   * SVG root, so the "origin" was wherever the leftmost wire happened to
   * start - and the resolved point was tens or hundreds of pixels out.
   *
   * The canvas already converts client coordinates to world ones for node
   * drags and for wire drops, from the root's rect and the viewport, and that
   * conversion is exercised by every one of those. There is no reason for a
   * second one to exist, and every reason for it not to.
   */
  readonly resolveEdge: (point: {
    readonly clientX: number;
    readonly clientY: number;
  }) => EdgeId | null;
  /** The wire currently being dragged out of a port, if any. */
  readonly draft: { readonly from: Point; readonly to: Point } | null;
}

/**
 * Every wire, in one SVG beneath the nodes.
 *
 * One SVG rather than one per wire: a single element to composite, a single
 * subtree to diff, and one place for the delegated click handler.
 *
 * The layer re-renders when a node moves, because a wire's path depends on
 * node positions - but the NODES do not, because they are memoised on their own
 * data. Moving a node repaints its two or three wires and the node itself,
 * not the whole canvas.
 */
const EMPTY_EDGES: ReadonlySet<EdgeId> = new Set();

export const Wires = memo(function Wires({
  graph,
  selectedEdges,
  activeEdges,
  arrivingEdges,
  onSelectEdge,
  resolveEdge,
  draft,
}: WiresProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const selected = new Set(selectedEdges);

  /*
   * WIRES THAT HAVE FINISHED DRAWING, for the one arrival being shown.
   *
   * A wire drawing in and a wire carrying data both animate the same two
   * properties, so they cannot run at once: the dash would replace the draw,
   * and the draw would start again from nothing when the dash ended - a wire
   * that draws itself twice. The first run after a connection lands inside
   * the draw's 150ms often enough to matter, because the run it causes is the
   * point of connecting. So the draw wins while it lasts, and its own
   * `animationend` hands the wire back.
   *
   * Reset per arrival rather than kept for the session: a replaced document
   * reuses edge ids, and a wire must not be skipped because an unrelated wire
   * of the same name was drawn an hour ago.
   */
  const [drawn, setDrawn] = useState<{
    readonly of: ReadonlySet<EdgeId>;
    readonly ids: ReadonlySet<EdgeId>;
  }>(() => ({ of: arrivingEdges, ids: new Set() }));
  const drawnIds = drawn.of === arrivingEdges ? drawn.ids : EMPTY_EDGES;

  /*
   * Click handling is delegated and attached imperatively rather than as a
   * per-path JSX prop. One listener serves every wire however many there are,
   * and an <path onClick> would be an interaction handler on a non-interactive
   * element - which is a warning worth keeping switched on for real cases.
   *
   * THE PRESS SAYS "A WIRE"; THE GEOMETRY SAYS WHICH ONE. The hit band is
   * finger-sized now (see `.wireHit`), so wherever wires converge - hardest at
   * a node's inputs, which sit on a 24px pitch - several bands cover the same
   * pixel and the browser hands the press to whichever paints last. That is
   * document order, which is to say an arbitrary wire that changes when an
   * unrelated one is added. `resolveEdge` answers the question the user was
   * actually asking - which wire is NEAREST - and answers it the same way
   * every time.
   *
   * The band still decides WHETHER this is a wire press at all, so a tap on
   * empty canvas is untouched and still pans.
   */
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const hit = target.closest('[data-edge-id]');
      if (hit === null) return;

      /*
       * The band said "a wire"; `resolveEdge` says which one. The fallback is
       * the band's own id, for a press the geometry cannot place at all - a
       * wire whose node has gone from the document between the render and the
       * press.
       */
      const id = resolveEdge(event) ?? hit.getAttribute('data-edge-id');
      if (id === null) return;

      event.stopPropagation();
      onSelectEdge(id, event.shiftKey);
    };

    svg.addEventListener('pointerdown', onPointerDown);
    return () => {
      svg.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onSelectEdge, resolveEdge]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;

    // Delegated for the reason the press is: one listener, however many wires.
    const onAnimationEnd = (event: AnimationEvent): void => {
      const target = event.target;
      if (!(target instanceof Element) || !target.classList.contains(styles.wireArriving ?? ''))
        return;
      const id = target.closest('[data-edge-id]')?.getAttribute('data-edge-id');
      if (id === null || id === undefined) return;
      setDrawn((current) => {
        const ids = new Set(current.of === arrivingEdges ? current.ids : []);
        ids.add(id);
        return { of: arrivingEdges, ids };
      });
    };

    svg.addEventListener('animationend', onAnimationEnd);
    return () => {
      svg.removeEventListener('animationend', onAnimationEnd);
    };
  }, [arrivingEdges]);

  return (
    <svg ref={svgRef} className={styles.wireLayer} aria-hidden="true" width={1} height={1}>
      {graph.edgeOrder.map((id) => {
        const edge = graph.edges[id];
        if (!edge) return null;

        const from = portPositionById(graph, edge.from.nodeId, 'output', edge.from.portId);
        const to = portPositionById(graph, edge.to.nodeId, 'input', edge.to.portId);
        if (!from || !to) return null;

        const path = wirePath(from, to);
        const arriving = arrivingEdges.has(id) && !drawnIds.has(id);

        return (
          <g key={id} data-edge-id={id}>
            {/* Fat transparent stroke: the thing a pointer can actually hit. */}
            <path className={styles.wireHit} d={path} />
            {/*
              `wireActive` was WRITTEN, COMPUTED AND PASSED, AND NEVER APPLIED.
              Canvas.tsx derives `activeEdges` from the live run states every
              render and hands it here; this component's parameter list simply
              did not destructure it, so the travelling dash that shows data
              moving through a wire has never once been drawn. Nothing failed:
              the prop was declared, typed and supplied, and a class nobody
              names is silent by construction - which is the same hole the
              reverse half of `cssModules.test.ts` now closes.
            */}
            {/*
              DRAWN IN, NOT CUT IN. `pathLength` makes the wire one unit long
              whatever its real length, so the stylesheet can sweep a single
              dash from 0 to 1 without anyone measuring a cubic - and it is set
              only while the draw runs, because the travelling dash below is
              written in real lengths and would be scaled into nonsense by it.
              From the output end to the input end: the direction data goes,
              and the direction the travelling dash already moves.
            */}
            <path
              className={cx(
                styles.wire,
                arriving ? styles.wireArriving : activeEdges.has(id) && styles.wireActive,
                selected.has(id) && styles.wireSelected,
              )}
              d={path}
              {...(arriving ? { pathLength: 1 } : {})}
            />
          </g>
        );
      })}

      {draft ? <path className={styles.wireDraft} d={wirePath(draft.from, draft.to)} /> : null}
    </svg>
  );
});
