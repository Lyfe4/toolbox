import { memo } from 'react';

import { PortIcon, SignalIcon, SlidersIcon } from '@/components/Icon';
import type { NodeRunState, NodeRunStatus } from '@/features/execution/graph';
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

import type { CanvasNode, PortRef } from './types';

const CATEGORY_GLYPHS: Partial<Record<ToolCategory, typeof PortIcon>> = {
  encoding: PortIcon,
  data: SlidersIcon,
};

/**
 * Status is announced as words, never carried by the LED colour alone.
 *
 * The LED also changes SHAPE per state (see canvas.module.css), so the
 * distinction survives greyscale, colour blindness and forced-colors mode -
 * and this text is what a screen reader actually reads.
 */
const STATUS_TEXT: Record<NodeRunStatus, string> = {
  idle: 'not run yet',
  blocked: 'blocked',
  running: 'running',
  ok: 'succeeded',
  error: 'failed',
  'upstream-failed': 'waiting on a failed node upstream',
};

/** The short label printed in the node footer beside the LED. */
const STATUS_LABEL: Record<NodeRunStatus, string> = {
  idle: 'idle',
  blocked: 'blocked',
  running: 'run',
  ok: 'ok',
  error: 'error',
  'upstream-failed': 'upstream',
};

function ledClass(status: NodeRunStatus): string {
  switch (status) {
    case 'idle':
      return cx(styles.led, styles.ledIdle);
    case 'blocked':
      return cx(styles.led, styles.ledBlocked);
    case 'running':
      return cx(styles.led, styles.ledRunning);
    case 'ok':
      return cx(styles.led, styles.ledOk);
    case 'error':
      return cx(styles.led, styles.ledError);
    case 'upstream-failed':
      return cx(styles.led, styles.ledUpstream);
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
  readonly run: NodeRunState;
  /** Input ports with no wire; each gets its own small editor. */
  readonly typedInputPorts: readonly string[];
  readonly linkState: 'none' | 'valid' | 'invalid';
  readonly validInputPorts: ReadonlySet<string>;
  readonly connectedPorts: ReadonlySet<string>;
  readonly onPortPointerDown: (ref: PortRef, side: 'input' | 'output') => void;
  readonly onInputChange: (nodeId: string, portId: string, value: string) => void;
}

/**
 * One node.
 *
 * `memo` matters here: panning and zooming change only the plane's transform,
 * and moving one node must not re-render the other forty-nine.
 */
export const CanvasNodeView = memo(function CanvasNodeView({
  node,
  selected,
  connections,
  run,
  typedInputPorts,
  linkState,
  validInputPorts,
  connectedPorts,
  onPortPointerDown,
  onInputChange,
}: CanvasNodeViewProps) {
  const entry: ToolManifestEntry = getManifestEntry(node.toolId);
  const Glyph = CATEGORY_GLYPHS[entry.category] ?? SignalIcon;
  const height = nodeHeight(entry, typedInputPorts.length);

  /*
   * The accessible name carries everything a sighted user reads off the node
   * plus everything they read off its position on the plane.
   */
  const label = [
    entry.name,
    `at ${node.position.x.toString()}, ${node.position.y.toString()}`,
    `${connections.toString()} ${connections === 1 ? 'connection' : 'connections'}`,
    STATUS_TEXT[run.status],
    run.blockedReason,
    run.status === 'error' ? run.error?.message : null,
    selected ? 'selected' : null,
  ]
    .filter((part): part is string => typeof part === 'string' && part !== '')
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
      data-status={run.status}
      data-testid={`node-${node.id}`}
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
        {/* Per-node timing: small, mono, tabular. A developer-tool detail. */}
        {run.durationMs === null ? null : (
          <span className={styles.nodeTiming} aria-hidden="true">
            {formatDuration(run.durationMs)}
          </span>
        )}
        <span className={ledClass(run.status)} aria-hidden="true" />
      </div>

      <p className={styles.nodeSummary}>
        {run.status === 'error' && run.error
          ? run.error.message
          : (run.blockedReason ?? entry.summary)}
      </p>

      <div className={styles.nodeBody}>
        {entry.inputs.map((port, index) => {
          const dimmed = linkState !== 'none' && !validInputPorts.has(port.id);
          return (
            <button
              key={port.id}
              type="button"
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

      {/*
        One editor per input port that has no wire. A tool with two required
        inputs - diff - gets two, so neither is left permanently blocked just
        because it is not the first port.
      */}
      {typedInputPorts.map((portId) => {
        const port = entry.inputs.find((candidate) => candidate.id === portId);
        return (
          <textarea
            key={portId}
            className={styles.nodeInput}
            /*
             * Not a tab stop: Tab walks NODES, as documented. Enter on the
             * focused node moves focus in here, Escape moves it back out.
             */
            tabIndex={-1}
            data-node-input={portId}
            aria-label={
              entry.inputs.length > 1
                ? `${entry.name} ${port?.label ?? portId} input`
                : `${entry.name} input`
            }
            placeholder={entry.inputs.length > 1 ? (port?.label ?? portId) : 'Type or paste input'}
            value={node.inputs[portId] ?? ''}
            spellCheck={false}
            // The canvas listens for pointerdown to start a drag; a textarea
            // has to keep its own selection behaviour.
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onChange={(event) => {
              onInputChange(node.id, portId, event.target.value);
            }}
          />
        );
      })}

      <div className={styles.nodeFooter}>
        <span>{STATUS_LABEL[run.status]}</span>
        <span>
          {connections.toString()} {connections === 1 ? 'wire' : 'wires'}
        </span>
      </div>
    </div>
  );
});

/** Sub-millisecond runs read as "<1ms" rather than "0ms". */
export function formatDuration(ms: number): string {
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms).toString()}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
