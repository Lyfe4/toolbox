import { memo } from 'react';

import { Button } from '@/components/Button';
import { PortIcon, SignalIcon, SlidersIcon } from '@/components/Icon';
import type { NodeRunState, NodeRunStatus } from '@/features/execution/graph';
import { getManifestEntry, type ToolCategory, type ToolManifestEntry } from '@/features/registry';
import { cx } from '@/lib/cx';
import { counted } from '@/lib/plural';
import { formatBytes } from '@/lib/sniff';

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
import { PortButton } from './PortButton';
import { PORT_GLYPH_SIZE } from './PortGlyph';
import { summariseOutputs } from './resultSummary';

import type { CanvasNode, NodeId, PortRef } from './types';

/** How a port is keyed in the state sets below: "input:document". */
export function portKey(side: PortSide, portId: string): string {
  return `${side}:${portId}`;
}

/**
 * The attribute the canvas root's pointer handler looks for.
 *
 * A pointerdown anywhere inside a node starts a MOVE and captures the pointer
 * on the canvas root, and a captured pointer retargets its own pointerup and
 * its click to the capture element - so a button drawn inside a node is a
 * button whose click never arrives. The root already has this exact escape
 * hatch for the toolbar (`data-canvas-chrome`); this is the node's, and it is
 * a separate one because the two want different things afterwards: a press on
 * the toolbar must not touch the selection, and a press on a node's own
 * control is a press on an already-selected node.
 */
export const NODE_ACTION_ATTRIBUTE = 'data-node-action';

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
  /**
   * Input ports with no wire.
   *
   * The node no longer draws an editor for them - that moved to the inspector
   * - but it still has to know which ports are waiting on the user in order to
   * say so. See `hintFor`.
   */
  readonly typedInputPorts: readonly string[];
  /**
   * Input ports holding a file whose bytes this session still has.
   *
   * The document alone cannot answer this. `node.fileInputs` says a port was
   * fed a file and what it was called; only the attachment store knows whether
   * the bytes survived, and a file chosen a moment ago and a file a reload left
   * behind say opposite things on the node. See `attachmentStore`.
   */
  readonly fileInputPorts: readonly string[];
  /** Whether a file is being dragged over THIS node right now. */
  readonly dropTarget: boolean;
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
  /**
   * Whether this node is the ONLY thing selected.
   *
   * Not `selected`, and the difference is what keeps the control honest. With
   * three nodes selected, three nodes would each draw a button whose menu of
   * one acts on all three - so the affordance appears exactly when there is
   * one node for it to be about.
   */
  readonly soleSelected: boolean;
  /**
   * Opens the connect flow on this node.
   *
   * The SAME callback `C` is bound to, passed straight through. The tap and
   * the keystroke are one route with two entrances rather than two routes that
   * happen to agree today - see the note on the button below.
   */
  readonly onConnect: (nodeId: NodeId) => void;
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
  fileInputPorts,
  dropTarget,
  linking,
  validPorts,
  heldPort,
  armedPort,
  refusedPort,
  connectedPorts,
  onPortPointerDown,
  soleSelected,
  onConnect,
}: CanvasNodeViewProps) {
  const entry: ToolManifestEntry = getManifestEntry(node.toolId);
  const Glyph = CATEGORY_GLYPHS[entry.category] ?? SignalIcon;
  const height = nodeHeight(entry);
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
  const blockedHint =
    run.status === 'blocked' ? hintFor(entry, node, typedInputPorts, fileInputPorts) : null;

  /**
   * WHAT A NODE SAYS ABOUT A FILE IT HAS BEEN GIVEN.
   *
   * `photo.png · 2.1 MB` - the name and the size, which is what tells one image
   * node from another on a canvas of ten. Shown only while there is no result
   * yet, because once a node has run its ANSWER is its situation: that is the
   * rule the summary box already follows for the tool's description, and a file
   * that pushed the result out of the box would have cost the node the thing it
   * exists to show. The name is in the accessible name below whatever the box
   * is showing, so it does not stop being available when the answer arrives.
   *
   * ITERATED OVER THE MANIFEST'S PORTS RATHER THAN THE DOCUMENT'S KEYS.
   * `fileInputs` is keyed by port id and comes back from `localStorage`, which
   * is neither signed nor beyond a user's reach - so a hand-edited save can
   * name a port no tool has. The engine ignores such a key, correctly, because
   * it iterates the ports too; reading the record directly left the node
   * printing `phantom.png · 1.0 kB` under a result the file had nothing to do
   * with, on a node that was running perfectly well.
   *
   * WHAT WAS REJECTED. A permanent chip in the footer, which has 224px for
   * `blocked` and `3 wires` already; and a paperclip badge, which is an
   * unlabelled glyph carrying information - the one thing the accessibility
   * rules here refuse outright - and labelling it needs room the node does not
   * have.
   */
  const fileNames = entry.inputs.flatMap((port) => {
    const ref = node.fileInputs[port.id];
    return ref ? [ref] : [];
  });
  const fileSummary =
    fileNames.length === 0
      ? null
      : fileNames.map((ref) => `${ref.name} · ${formatBytes(ref.size)}`).join(', ');
  /** The first file's bare name, for the accessible name's redundancy check. */
  const fileName = fileNames[0]?.name ?? null;

  /*
   * WHAT A NODE SAYS ABOUT ITS RESULT.
   *
   * A SUMMARY, NOT A PREVIEW - "47 matches", "2.1 MB PNG image" - so a chain
   * can be read at a glance without opening anything. It goes in the summary
   * box rather than beside the footer because the box is already the "what is
   * the situation with this node" line, and once a node has run, its result IS
   * its situation: the tool's own description is only useful up to the moment
   * there is an answer to describe instead.
   *
   * Every branch here is mutually exclusive with the others, so nothing has to
   * decide what wins - a node is failed, or blocked, or it has run.
   */
  const resultSummary = run.status === 'ok' ? summariseOutputs(entry, run.outputs) : null;

  const summaryText =
    run.status === 'error' && run.error
      ? run.error.message
      : (blockedHint ?? resultSummary ?? run.blockedReason ?? fileSummary ?? entry.summary);

  /*
   * The accessible name carries everything a sighted user reads off the node
   * plus everything they read off its position on the plane.
   *
   * The result summary is in here for the same reason it is on screen: a chain
   * that can be scanned by eye and not by ear is not a chain a keyboard user
   * can follow. It is `summariseValue`'s job to keep it short enough to be
   * read aloud - see SUMMARY_LIMIT.
   */
  const label = [
    entry.name,
    `at ${node.position.x.toString()}, ${node.position.y.toString()}`,
    counted(connections, 'connection'),
    STATUS_TEXT[run.status],
    run.blockedReason,
    /*
     * THE FILE, UNLESS THE VISIBLE TEXT HAS ALREADY SAID IT.
     *
     * It is here at all because a chain scannable by eye and not by ear is not
     * one a keyboard user can follow, and "which node has the photograph" is a
     * question a file input creates - so once a RESULT takes the summary box,
     * the filename has nowhere else to be.
     *
     * The condition is not cosmetic. A node reloaded with a file it no longer
     * has says `"holiday.png" needs choosing again`, and appending `from
     * holiday.png · 540 B` to that read the name twice in one breath. The test
     * is on the rendered string rather than on the status, so any future
     * summary that happens to name the file is covered by the same line.
     */
    fileSummary !== null && fileName !== null && !summaryText.includes(fileName)
      ? `from ${fileSummary}`
      : null,
    resultSummary,
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
        // A drop target nothing marks is a guess, and on overlapping nodes it
        // is a guess the user gets wrong.
        dropTarget && styles.nodeDropTarget,
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
        {/* The inner span is what gets clamped to two lines; see the CSS. */}
        <span className={cx(styles.nodeSummaryText, resultSummary !== null && styles.nodeResult)}>
          {summaryText}
        </span>
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
            <PortButton
              key={key}
              label={port.label}
              portId={port.id}
              types={port.types}
              side={side}
              connected={connectedPorts.has(key)}
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
              state={
                held ? 'held' : armed ? 'armed' : refused ? 'refused' : valid ? 'valid' : 'idle'
              }
              onPointerDown={(event) => {
                event.stopPropagation();
                onPortPointerDown({ nodeId: node.id, portId: port.id }, side);
              }}
            />
          );
        }),
      )}

      <div className={styles.nodeFooter}>
        <span>{STATUS_LABEL[run.status]}</span>
        <span>{counted(connections, 'wire')}</span>
      </div>

      {/*
        THE ONE THING ON A NODE A FINGER CAN PRESS.
        ───────────────────────────────────────────
        Wiring two tools together had a pointer route (drag a port) and a
        keyboard route (`C`), and `C` was also the documented way to read a
        port label the node had truncated. A phone has no `C`, so on the one
        device where labels truncate most the documented fallback did not
        exist. Dragging works on touch, so nothing was blocked - the escape
        hatch was simply fiction.

        IT CALLS `onConnect`, WHICH IS `beginConnectFrom`, WHICH IS WHAT `C`
        CALLS. One flow, two entrances. Anything else would be a second
        implementation of "which port, then which partner", and this
        repository has a written history of two routes to one graph drifting
        apart - see `firstRefusedEdge` in connections.ts.

        WHY IT IS OUTSIDE THE NODE'S BOX. Every shared control grows to 44px on
        a coarse pointer (WCAG 2.5.5), and the mobile audit already found what
        that does inside a 24px bar: Panel's title bar overflowed and drew
        through its own border. The header here is that same 24px, the footer
        another, and `nodeHeight` is arithmetic in geometry.ts that the wire
        anchors share - so growing any band of a node moves every wire that
        lands on it. Hung below the node on `position: absolute`, the button
        can be as big as a finger needs without being in the node's layout at
        all.

        WHY ONLY WHEN SOLE-SELECTED, rather than always. A node is 224px and
        permanent chrome on every one of them is a cost paid forever by
        everybody; scoped to the selection it is at most one control on the
        plane, which is also what makes hanging it outside the box safe to do.
        Tapping a node already selects it, so this is the second tap of a
        two-tap gesture rather than a mode to discover.

        WHY NOT ONLY ON A COARSE POINTER, which was the other obvious scope.
        `pointer: coarse` is not "no keyboard" - it is true of a tablet with a
        keyboard attached and false of a mouse user who has never read the
        shortcut list, and connecting was undiscoverable for the second group
        too. Scoping it to the selection had already paid for the space; a
        media query would only have hidden the fix from half the people it is
        for, and put a JavaScript copy of a breakpoint next to a CSS one, which
        this file's neighbour has a bug written up about.

        WHY A WORD AND NOT JUST THE GLYPH. An unlabelled icon carrying
        information is the one thing the rules here refuse outright - it is why
        a paperclip badge was rejected for the file summary above. The
        accessible name names the tool as well, because "Connect" read out of
        context does not say connect WHAT.
      */}
      {soleSelected ? (
        <div className={styles.nodeActions} {...{ [NODE_ACTION_ATTRIBUTE]: '' }}>
          <Button
            size="sm"
            variant="ghost"
            className={styles.nodeAction}
            aria-label={`Connect from ${entry.name}`}
            onClick={() => {
              onConnect(node.id);
            }}
          >
            <PortIcon size={12} /> Connect
          </Button>
        </div>
      ) : null}
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
  withFiles: readonly string[],
): string | null {
  const waiting = entry.inputs.find(
    (port) =>
      port.required &&
      unwired.includes(port.id) &&
      (node.inputs[port.id] ?? '') === '' &&
      // A port holding a file is not waiting on anybody.
      !withFiles.includes(port.id) &&
      /*
       * NOR IS A PORT WHOSE FILE THIS SESSION HAS LOST. It is waiting, but not
       * on anything this hint knows how to say: the engine's `blockedReason`
       * names the file - `"photo.png" needs choosing again` - and telling
       * somebody to type into a port they fed a photograph is how a fixable
       * state reads as a bug.
       */
      node.fileInputs[port.id] === undefined,
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
  /*
   * The two sentences differ because the two ports differ, and that
   * distinction is the whole reason this branch exists: `image-convert`'s only
   * input takes bytes, so telling anyone to type into it describes behaviour
   * that does not exist. The node used to draw an editor for that port anyway
   * - every keystroke in it changed a value the engine then refused to look
   * at, leaving the node blocked forever with a text box under it inviting
   * another go. See the runner's own version of this fix in architecture.md.
   *
   * BOTH SENTENCES NAME A FILE NOW, because both ports can take one. The bytes
   * version used to read `Wire an output into Image.`, which described half of
   * what would work and left the only way to start an image conversion on the
   * canvas undiscoverable - the defect that made a file input necessary in the
   * first place. "Add" rather than "choose" or "drop": one word that covers
   * both the picker and the drag, in a box with room for neither pair.
   */
  return waiting.types.includes('text')
    ? `Type or add a file in the inspector, or wire ${waiting.label}.`
    : `Add a file in the inspector, or wire ${waiting.label}.`;
}

/** Sub-millisecond runs read as "<1ms" rather than "0ms". */
export function formatDuration(ms: number): string {
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms).toString()}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
