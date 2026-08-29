import { memo, useEffect, useRef } from 'react';

import { cx } from '@/lib/cx';

import styles from './canvas.module.css';
import { portPositionById, wirePath } from './geometry';

import type { EdgeId, GraphData, Point } from './types';

export interface WiresProps {
  readonly graph: GraphData;
  readonly selectedEdges: readonly EdgeId[];
  readonly onSelectEdge: (id: EdgeId, additive: boolean) => void;
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
export const Wires = memo(function Wires({
  graph,
  selectedEdges,
  onSelectEdge,
  draft,
}: WiresProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const selected = new Set(selectedEdges);

  /*
   * Click handling is delegated and attached imperatively rather than as a
   * per-path JSX prop. One listener serves every wire however many there are,
   * and an <path onClick> would be an interaction handler on a non-interactive
   * element - which is a warning worth keeping switched on for real cases.
   */
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const hit = target.closest('[data-edge-id]');
      const id = hit?.getAttribute('data-edge-id');
      if (id === null || id === undefined) return;

      event.stopPropagation();
      onSelectEdge(id, event.shiftKey);
    };

    svg.addEventListener('pointerdown', onPointerDown);
    return () => {
      svg.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onSelectEdge]);

  return (
    <svg ref={svgRef} className={styles.wireLayer} aria-hidden="true" width={1} height={1}>
      {graph.edgeOrder.map((id) => {
        const edge = graph.edges[id];
        if (!edge) return null;

        const from = portPositionById(graph, edge.from.nodeId, 'output', edge.from.portId);
        const to = portPositionById(graph, edge.to.nodeId, 'input', edge.to.portId);
        if (!from || !to) return null;

        const path = wirePath(from, to);

        return (
          <g key={id} data-edge-id={id}>
            {/* Fat transparent stroke: the thing a pointer can actually hit. */}
            <path className={styles.wireHit} d={path} />
            <path className={cx(styles.wire, selected.has(id) && styles.wireSelected)} d={path} />
          </g>
        );
      })}

      {draft ? <path className={styles.wireDraft} d={wirePath(draft.from, draft.to)} /> : null}
    </svg>
  );
});
