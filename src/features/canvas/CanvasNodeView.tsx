import { memo } from 'react';

import { PortIcon, SignalIcon, SlidersIcon } from '@/components/Icon';
import { getManifestEntry, type ToolCategory, type ToolManifestEntry } from '@/features/registry';
import { cx } from '@/lib/cx';

import styles from './canvas.module.css';
import {
  BODY_PADDING,
  HEADER_HEIGHT,
  nodeHeight,
  portOffsetY,
  PORT_ROW_HEIGHT,
  SUMMARY_HEIGHT,
} from './geometry';
import { describeTypes, PortGlyph } from './PortGlyph';

import type { CanvasNode, NodeStatus, PortRef } from './types';

const CATEGORY_GLYPHS: Partial<Record<ToolCategory, typeof PortIcon>> = {
  encoding: PortIcon,
  data: SlidersIcon,
};

const STATUS_TEXT: Record<NodeStatus, string> = {
  idle: 'idle',
  running: 'running',
  ok: 'succeeded',
  error: 'failed',
};

function ledClass(status: NodeStatus): string {
  switch (status) {
    case 'idle':
      return cx(styles.led, styles.ledIdle);
    case 'running':
      return cx(styles.led, styles.ledRunning);
    case 'ok':
      return cx(styles.led, styles.ledOk);
    case 'error':
      return cx(styles.led, styles.ledError);
  }
}

/**
 * Where a port sits inside `.nodeBody`, derived from the same function the
 * wire geometry uses so the two can never disagree by a pixel.
 */
function portTopInBody(index: number): number {
  return portOffsetY(index) - HEADER_HEIGHT - SUMMARY_HEIGHT - PORT_ROW_HEIGHT / 2 + BODY_PADDING;
}

export interface CanvasNodeViewProps {
  readonly node: CanvasNode;
  readonly selected: boolean;
  readonly connections: number;
  /** Set while a wire is being dragged, to dim ports that cannot accept it. */
  readonly linkState: 'none' | 'valid' | 'invalid';
  /** Which of this node's input ports could accept the in-flight wire. */
  readonly validInputPorts: ReadonlySet<string>;
  readonly connectedPorts: ReadonlySet<string>;
  readonly onPortPointerDown: (ref: PortRef, side: 'input' | 'output') => void;
}

/**
 * One node.
 *
 * `memo` matters here: panning and zooming change only the plane's transform,
 * and moving one node must not re-render the other forty-nine. Because the
 * props are primitives and stable sets, React bails out of re-rendering every
 * node whose own data did not change.
 */
export const CanvasNodeView = memo(function CanvasNodeView({
  node,
  selected,
  connections,
  linkState,
  validInputPorts,
  connectedPorts,
  onPortPointerDown,
}: CanvasNodeViewProps) {
  const entry: ToolManifestEntry = getManifestEntry(node.toolId);
  const Glyph = CATEGORY_GLYPHS[entry.category] ?? SignalIcon;
  const height = nodeHeight(entry);

  /*
   * The accessible name carries everything a sighted user reads off the node
   * plus everything they read off its position on the plane: what it is, where
   * it is, how many wires touch it, and whether it is selected.
   */
  const label = [
    entry.name,
    `at ${node.position.x.toString()}, ${node.position.y.toString()}`,
    `${connections.toString()} ${connections === 1 ? 'connection' : 'connections'}`,
    STATUS_TEXT[node.status],
    selected ? 'selected' : null,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');

  return (
    <div
      className={cx(
        styles.node,
        selected && styles.nodeSelected,
        linkState === 'invalid' && styles.nodeInvalid,
      )}
      style={{ left: node.position.x, top: node.position.y, height }}
      data-node-id={node.id}
      data-testid={`node-${node.id}`}
      /*
       * `group` plus tabIndex makes the node a single, focusable, labelled
       * stop. Ports are deliberately not tab stops - Tab walks nodes, and the
       * connect dialog is the keyboard route to a specific port.
       */
      role="group"
      aria-roledescription="Canvas node"
      aria-label={label}
      tabIndex={0}
    >
      <div className={styles.nodeHeader}>
        <span className={styles.nodeGlyph} aria-hidden="true">
          <Glyph size={12} />
        </span>
        <span className={styles.nodeTitle}>{entry.name}</span>
        <span className={ledClass(node.status)} aria-hidden="true" />
      </div>

      <p className={styles.nodeSummary}>{entry.summary}</p>

      <div className={styles.nodeBody}>
        {entry.inputs.map((port, index) => {
          const dimmed = linkState !== 'none' && !validInputPorts.has(port.id);
          return (
            <button
              key={port.id}
              type="button"
              /*
               * A real button, so the linter and the platform both see an
               * interactive element - but tabIndex -1, because Tab moves
               * between nodes rather than stopping at every port.
               */
              tabIndex={-1}
              className={cx(
                styles.port,
                styles.portInput,
                linkState !== 'none' && !dimmed && styles.portValid,
                dimmed && styles.portInvalid,
              )}
              style={{ top: portTopInBody(index) }}
              data-port-id={port.id}
              data-port-side="input"
              aria-label={`Input ${port.label}, accepts ${describeTypes(port.types)}`}
              onPointerDown={(event) => {
                event.stopPropagation();
                onPortPointerDown({ nodeId: node.id, portId: port.id }, 'input');
              }}
            >
              <PortGlyph
                types={port.types}
                connected={connectedPorts.has(`in:${port.id}`)}
                className={styles.portConnector}
              />
              <span className={styles.portLabel}>{port.label}</span>
            </button>
          );
        })}

        {entry.outputs.map((port, index) => (
          <button
            key={port.id}
            type="button"
            tabIndex={-1}
            className={cx(styles.port, styles.portOutput)}
            style={{ top: portTopInBody(index) }}
            data-port-id={port.id}
            data-port-side="output"
            aria-label={`Output ${port.label}, carries ${describeTypes(port.types)}`}
            onPointerDown={(event) => {
              event.stopPropagation();
              onPortPointerDown({ nodeId: node.id, portId: port.id }, 'output');
            }}
          >
            <PortGlyph
              types={port.types}
              connected={connectedPorts.has(`out:${port.id}`)}
              className={styles.portConnector}
            />
            <span className={styles.portLabel}>{port.label}</span>
          </button>
        ))}
      </div>

      <div className={styles.nodeFooter}>
        <span>{entry.category}</span>
        <span>
          {connections.toString()} {connections === 1 ? 'wire' : 'wires'}
        </span>
      </div>
    </div>
  );
});
