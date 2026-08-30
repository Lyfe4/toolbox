import { memo } from 'react';

import { PortIcon, SignalIcon, SlidersIcon } from '@/components/Icon';
import type { NodeRunState, NodeRunStatus } from '@/features/execution/graph';
import { getManifestEntry, type ToolCategory, type ToolManifestEntry } from '@/features/registry';
import { cx } from '@/lib/cx';
import { counted } from '@/lib/plural';

import styles from './canvas.module.css';
import {
  BODY_PADDING,
  nodeHeight,
  portRowCount,
  portStackGap,
  portInsetStyle,
  portTopStyle,
  PORT_ROW_HEIGHT,
  type PortSide,
} from './geometry';
import { describeTypes, PortGlyph, PORT_GLYPH_SIZE } from './PortGlyph';

import type { CanvasNode, PortRef } from './types';

/** How a port is keyed in the state sets below: "input:document". */
export function portKey(side: PortSide, portId: string): string {
  return `${side}:${portId}`;
}

/** Inputs first, then outputs: the order the two stacks appear down the node. */
const PORT_SIDES: readonly PortSide[] = ['input', 'output'];

/** Where a port row starts, so its glyph's centre lands on the wire anchor. */
const PORT_INSET = portInsetStyle(PORT_GLYPH_SIZE);

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

export interface CanvasNodeViewProps {
  readonly node: CanvasNode;
  readonly selected: boolean;
  readonly connections: number;
  readonly run: NodeRunState;
  /** Input ports with no wire; each gets its own small editor. */
  readonly typedInputPorts: readonly string[];
  /** Whether a wire is being dragged anywhere on the canvas. */
  readonly linking: boolean;
  /** Ports on THIS node the current drag could legally land on. Keyed by portKey. */
  readonly validPorts: ReadonlySet<string>;
  /** The port the current drag started from, if it is on this node. */
  readonly heldPort: string | null;
  /** The port the drag would snap to right now, if it is on this node. */
  readonly armedPort: string | null;
  /** The port that just refused a drop, if it is on this node. */
  readonly refusedPort: string | null;
  readonly connectedPorts: ReadonlySet<string>;
  readonly onPortPointerDown: (ref: PortRef, side: PortSide) => void;
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
  linking,
  validPorts,
  heldPort,
  armedPort,
  refusedPort,
  connectedPorts,
  onPortPointerDown,
  onInputChange,
}: CanvasNodeViewProps) {
  const entry: ToolManifestEntry = getManifestEntry(node.toolId);
  const Glyph = CATEGORY_GLYPHS[entry.category] ?? SignalIcon;
  const height = nodeHeight(entry, typedInputPorts.length);
  /** The space the two port stacks reserve, so the footer sits below them. */
  const bodyHeight = portRowCount(entry) * PORT_ROW_HEIGHT + portStackGap(entry) + BODY_PADDING * 2;

  /*
   * WHICH NODES SHOW GUIDANCE
   *
   * The rule is about WHY a node is blocked, not about how many wires happen
   * to touch it:
   *
   *   blocked, and a required port is genuinely empty  -> actionable guidance
   *   blocked for any other reason (waiting upstream)  -> the terse status
   *   failed                                           -> the error
   *   anything else                                    -> the tool summary
   *
   * It used to also require `connections === 0`, so two nodes blocked for the
   * identical reason showed different text as soon as one of them had an
   * unrelated OUTPUT wire - it got "Needs input" while its twin got the full
   * sentence. `hintFor` already returns null when nothing is actually
   * waiting, so the wire count was never the right question.
   */
  const blockedHint = run.status === 'blocked' ? hintFor(entry, node, typedInputPorts) : null;

  /*
   * The accessible name carries everything a sighted user reads off the node
   * plus everything they read off its position on the plane.
   */
  const label = [
    entry.name,
    `at ${node.position.x.toString()}, ${node.position.y.toString()}`,
    counted(connections, 'connection'),
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
        // Not the node the drag started from: its own ports are never legal
        // partners, and dimming the thing you are holding reads as a refusal.
        linking && heldPort === null && validPorts.size === 0 && styles.nodeInvalid,
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
          : (blockedHint ?? run.blockedReason ?? entry.summary)}
      </p>

      {/*
        PORTS
        ─────
        Two independent stacks, one after the other: every input, then a gap,
        then every output. They used to be side-by-side columns sharing rows,
        which made "the single input" read as paired with "the first output" on
        a node that has one of the former and two of the latter. They are
        separate lists and are now laid out as separate lists.

        Positioned against the NODE rather than the body, using the very
        function the wire layer uses, so a connector and the wire that lands on
        it cannot drift apart.
      */}
      <div className={styles.nodeBody} style={{ blockSize: bodyHeight }} aria-hidden="true" />

      {PORT_SIDES.map((side) =>
        (side === 'input' ? entry.inputs : entry.outputs).map((port, index) => {
          const key = portKey(side, port.id);
          const valid = validPorts.has(key);
          const held = heldPort === key;
          const armed = armedPort === key;
          const refused = refusedPort === key;
          // Receding is only meaningful while a drag is looking for a home.
          const receded = linking && !valid && !held;

          return (
            <button
              key={key}
              type="button"
              tabIndex={-1}
              className={cx(
                styles.port,
                side === 'input' ? styles.portInput : styles.portOutput,
                linking && valid && styles.portValid,
                receded && styles.portReceded,
                held && styles.portHeld,
                armed && styles.portArmed,
                refused && styles.portRefused,
              )}
              style={{
                top: portTopStyle(entry, side, index),
                [side === 'input' ? 'insetInlineStart' : 'insetInlineEnd']: PORT_INSET,
              }}
              data-port-id={port.id}
              data-port-side={side}
              data-port-state={
                held ? 'held' : armed ? 'armed' : refused ? 'refused' : valid ? 'valid' : 'idle'
              }
              aria-label={
                side === 'input'
                  ? `Input ${port.label}, accepts ${describeTypes(port.types)}`
                  : `Output ${port.label}, carries ${describeTypes(port.types)}`
              }
              onPointerDown={(event) => {
                event.stopPropagation();
                onPortPointerDown({ nodeId: node.id, portId: port.id }, side);
              }}
            >
              {/*
                A real element rather than a border or an outline, so the state
                rings hold their space and nothing reflows when one appears.
                It is also what carries held/armed/valid SHAPE-wise, which is
                what keeps these states legible without colour.
              */}
              <span className={styles.portHalo} aria-hidden="true" />
              <PortGlyph
                types={port.types}
                connected={connectedPorts.has(key)}
                className={styles.portConnector}
              />
              <span className={styles.portLabel}>{port.label}</span>
            </button>
          );
        }),
      )}

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
        <span>{counted(connections, 'wire')}</span>
      </div>
    </div>
  );
});

/**
 * What to do about a blocked node that has nothing wired into it.
 *
 * Returns null when the node is only waiting on something upstream: telling
 * someone to type into a port that already has a wire would be wrong.
 */
function hintFor(
  entry: ToolManifestEntry,
  node: CanvasNode,
  unwired: readonly string[],
): string | null {
  const waiting = entry.inputs.find(
    (port) => port.required && unwired.includes(port.id) && (node.inputs[port.id] ?? '') === '',
  );
  if (!waiting) return null;

  /*
   * Short enough for two lines at the node's 224px width, and naming the port
   * so it is actionable on a node with more than one. The long form -
   * "drag a wire from another node's output into the input on the left" - ran
   * to three lines and was cut mid-sentence by the summary box.
   *
   * Direction is not spelled out here; the shortcuts overlay's ports-and-wires
   * key covers it once, properly, instead of every node repeating it.
   */
  return waiting.types.includes('text')
    ? `Type below, or wire an output into ${waiting.label}.`
    : `Wire an output into ${waiting.label}.`;
}

/** Sub-millisecond runs read as "<1ms" rather than "0ms". */
export function formatDuration(ms: number): string {
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms).toString()}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
