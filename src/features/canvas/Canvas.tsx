import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/Button';
import { CopyIcon, PlusIcon, SearchIcon, SignalIcon, SlidersIcon } from '@/components/Icon';
import { IconButton } from '@/components/IconButton';
import { LiveRegion } from '@/components/LiveRegion';
import { useToast } from '@/components/Toast';
import { VisuallyHidden } from '@/components/VisuallyHidden';
import { idleState } from '@/features/execution/graph';
import { usePipelineStore } from '@/features/execution/pipelineStore';
import { getSharedEngine } from '@/features/execution/sharedEngine';
import {
  getManifestEntry,
  TOOL_MANIFEST,
  type ToolCategory,
  type ToolId,
} from '@/features/registry';
import { cx } from '@/lib/cx';
import { describeFile, loadFileForPort, type LoadedFile } from '@/lib/fileInput';
import { counted } from '@/lib/plural';
import { useMediaQuery } from '@/lib/useMediaQuery';

import { useAttachmentStore } from './attachmentStore';
import styles from './canvas.module.css';
import { CanvasNodeView, portKey } from './CanvasNodeView';
import { CommandDialog, type DialogGroup, type DialogOption } from './CommandDialog';
import {
  checkConnection,
  connectionCount,
  nearestCompatiblePort,
  nearestPortOfSide,
  orientEnds,
  validPartnersFor,
  type PortEnd,
} from './connections';
import { fileTargetPorts, otherInputBytes } from './fileInputs';
import {
  clamp,
  clearOfExistingNodes,
  GRID,
  gridStyle,
  MAX_ZOOM,
  MIN_ZOOM,
  NODE_WIDTH,
  portPositionById,
  snapPoint,
  spatialOrder,
  typedInputPorts,
  type PortSide,
} from './geometry';
import { useCanvasStore } from './graphStore';
import inspectorStyles from './inspector.module.css';
import { useKeyboardInset } from './keyboardInset';
import { NodeInspector, type InspectorNode } from './NodeInspector';
import { OverflowMenu, type OverflowItem } from './OverflowMenu';
import { createDebouncedSaver, loadGraph } from './persistence';
import { pinchPair, pinchSample, pinchStep, type PinchSample } from './pinch';
import { PIPELINE_PRESETS } from './presets';
import { buildShareUrl, decodeParamToGraph } from './share';
import { CANVAS_DESCRIPTION } from './shortcuts';
import { ShortcutsOverlay } from './ShortcutsOverlay';
import { toWorld, useViewportStore } from './viewportStore';
import { Wires } from './Wires';

import type { GraphData, NodeId, Point, PortRef } from './types';
/*
 * Aliased, because this file also handles the NATIVE PointerEvent and
 * KeyboardEvent - the canvas binds its own listeners imperatively - and two
 * types with the same name and different shapes in one file is how a handler
 * ends up reading `nativeEvent` off something that has none.
 */
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';

/**
 * The order tool categories appear in the palette.
 *
 * Written out rather than derived, because the alternative is the order the
 * manifest happens to be written in - which is how "encoding" ended up as
 * three separate sections. `satisfies` ties every entry to a real category,
 * and palette.test.ts asserts this is a permutation of TOOL_CATEGORIES, so
 * adding a category to the registry and forgetting it here is a test failure
 * rather than a group that quietly never renders.
 *
 * Ordered by how often they are reached for, not alphabetically.
 */
export const PALETTE_CATEGORY_ORDER = [
  'encoding',
  'text',
  'data',
  'colour',
  'hashing',
  'time',
] as const satisfies readonly ToolCategory[];

/** Pipelines lead, then the tool categories. */
export const PALETTE_GROUPS: readonly DialogGroup[] = [
  {
    id: 'pipelines',
    label: 'Pipelines',
    note: 'whole prewired graphs',
    distinct: true,
  },
  ...PALETTE_CATEGORY_ORDER.map((category) => ({ id: category, label: category })),
];

/** The connection flow has one group each; declared for the same reason. */
/** Outputs lead: connecting forwards is the common case and stays one Enter. */
const PORT_GROUPS: readonly DialogGroup[] = [
  { id: 'outputs', label: 'Outputs', note: 'wire onwards' },
  { id: 'inputs', label: 'Inputs', note: 'wire backwards' },
];
const PARTNER_GROUPS: readonly DialogGroup[] = [{ id: 'partners', label: 'Valid ports' }];

/** Which overlay, if any, is open. */
type Overlay =
  | { readonly kind: 'none' }
  | { readonly kind: 'palette' }
  | { readonly kind: 'shortcuts' }
  /* Step one of the keyboard connect flow: which of this node's ports? */
  | { readonly kind: 'choose-port'; readonly nodeId: NodeId }
  /* Step two: which port on another node does it join? */
  | { readonly kind: 'choose-partner'; readonly origin: PortEnd };

/**
 * Encodes a port end into a dialog option id, and back.
 *
 * `|` because a tool id or a port id may contain a hyphen, and a node id may
 * not contain a pipe. Round-tripped rather than parsed loosely, so a malformed
 * id resolves to null instead of half a port reference.
 */
function encodeEnd(end: PortEnd): string {
  return `${end.ref.nodeId}|${end.side}|${end.ref.portId}`;
}

function decodeEnd(id: string): PortEnd | null {
  const [nodeId, side, portId] = id.split('|');
  if (nodeId === undefined || portId === undefined) return null;
  if (side !== 'input' && side !== 'output') return null;
  return { ref: { nodeId, portId }, side };
}

const EMPTY_PORTS: readonly string[] = [];

/**
 * Below this the toolbar collapses to "Add tool" plus an overflow menu.
 *
 * Chosen from the measured width of the full row - about 450px of controls,
 * plus the bar's own inset - so the switch happens with room to spare rather
 * than at the exact pixel things start to overflow.
 */
const COMPACT_TOOLBAR = '(max-width: 640px)';

const SHARE_NOTE = 'Link holds structure only, never your input';

/**
 * Where the inspector stops being a rail beside the canvas and becomes a sheet
 * over it. Matches the breakpoint in inspector.module.css, which carries the
 * arithmetic behind the number.
 */
const INSPECTOR_RAIL = '(min-width: 1000px)';

/**
 * The rail's width, in the same units the CSS custom property takes.
 *
 * The minimum is what the output views are already held to at the narrow end
 * by `checkMobileLayout`; the maximum stops the rail eating a canvas that no
 * longer has room for a graph. The step is the grid, so a keyboard resize
 * lands on the same 8px baseline everything else does.
 */
const RAIL_MIN = 320;
const RAIL_MAX = 640;
const RAIL_DEFAULT = 340;
const RAIL_STEP = GRID * 2;

/**
 * True for a pointer that touches the screen directly.
 *
 * A POSITIVE test, not `pointerType !== 'mouse'`, and the difference is not
 * cosmetic. An unrecognised or missing pointerType has to fall back to the
 * mouse behaviour, because that is the conservative one: the touch branch
 * captures the pointer on the canvas root, and a captured pointer retargets
 * its own pointerup and click to the capture element.
 *
 * Found the hard way. Playwright's Firefox reports an EMPTY pointerType for
 * synthesized mouse input, so `!== 'mouse'` sent ordinary clicks down the
 * touch path - the root captured the pointer, the click never reached the
 * button underneath, and every control in the toolbar silently stopped
 * working. Real browsers report "mouse" properly, but a rule that turns an
 * unknown device into a broken UI is the wrong rule regardless of who
 * reports what.
 */
function isDirectPointer(event: PointerEvent): boolean {
  return event.pointerType === 'touch' || event.pointerType === 'pen';
}

const NUDGE = GRID;
const BIG_NUDGE = GRID * 8;

/**
 * How far a new node steps when the spot it wanted is taken, and how many
 * times it will try before giving up and stacking anyway.
 */
const CASCADE = GRID * 4;
const CASCADE_LIMIT = 12;

/**
 * Finds a free position at or near `wanted`.
 *
 * The palette always placed a new node at the exact centre of the viewport,
 * which meant adding two tools in a row put the second one perfectly on top of
 * the first - two nodes both reporting "at 608, 368". A pointer user drags the
 * top one off and never thinks about it; from the keyboard the only way out is
 * arrow keys, 8px at a time, on a node you cannot see is there twice. Found by
 * walking the whole add-connect-run flow with the keyboard only.
 *
 * NOT `clearOfExistingNodes`, which is what presets use: that pushes the new
 * thing below EVERYTHING on the canvas, which is right for a whole subgraph
 * read left-to-right and wrong for a single node - after a few tools you would
 * be adding them off the bottom of the screen, which is the problem the
 * centre-of-viewport placement existed to avoid. A short diagonal cascade
 * keeps the node where the user is looking.
 *
 * The candidate is snapped first, because the store snaps too - comparing an
 * unsnapped candidate against stored positions never matches, which is exactly
 * how the first version of this quietly did nothing at all.
 */
function freeSpot(graph: GraphData, wanted: Point): Point {
  const key = (point: Point): string => `${point.x.toString()},${point.y.toString()}`;
  const taken = new Set(Object.values(graph.nodes).map((node) => key(node.position)));

  let spot = snapPoint(wanted);
  for (let step = 0; step < CASCADE_LIMIT; step += 1) {
    if (!taken.has(key(spot))) return spot;
    spot = { x: spot.x + CASCADE, y: spot.y + CASCADE };
  }

  // Twelve nodes already stacked on one spot is not a case worth more code
  // than this; the last candidate is returned rather than looping forever.
  return spot;
}

export interface CanvasProps {
  /** Validated and length-bounded by the route's search schema. */
  readonly shareParam?: string | undefined;
}

export function Canvas({ shareParam }: CanvasProps = {}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const descriptionId = useId();

  const graph = useCanvasStore((state) => state.graph);
  const selection = useCanvasStore((state) => state.selection);
  const announcementLog = useCanvasStore((state) => state.announcementLog);
  const store = useCanvasStore;

  const viewport = useViewportStore((state) => state.viewport);
  const isPanning = useViewportStore((state) => state.isPanning);

  const { notify } = useToast();
  const [overlay, setOverlay] = useState<Overlay>({ kind: 'none' });
  const [spacePressed, setSpacePressed] = useState(false);

  /*
   * THE INSPECTOR IS OPEN OR IT IS NOT, and the selection only decides what it
   * SHOWS.
   *
   * The alternative - open it whenever one node is selected - was rejected
   * twice over. On a phone the panel covers the canvas, so every tap while
   * arranging a graph would bury the graph. And on a desktop, where the rail
   * costs nothing because the canvas simply narrows, a panel that reopens
   * itself is a panel you cannot close.
   *
   * So it defaults to open where it is free and closed where it is not, `I`
   * toggles it at both sizes, and the toolbar carries the same toggle with an
   * `aria-pressed` that says which it currently is.
   */
  const railFits = useMediaQuery(INSPECTOR_RAIL);
  const [inspectorOpen, setInspectorOpen] = useState(railFits);
  const [railWidth, setRailWidth] = useState(RAIL_DEFAULT);
  /**
   * The wire being dragged.
   *
   * `origin` carries the SIDE as well as the port, because a drag may start
   * from either end - see `onPortPointerDown`. `snapped` is the port it would
   * land on if released now.
   */
  const [draft, setDraft] = useState<{
    origin: PortEnd;
    at: Point;
    snapped: PortEnd | null;
  } | null>(null);
  /** The port that just refused a drop, cleared on the next interaction. */
  const [refused, setRefused] = useState<PortEnd | null>(null);

  /* ---------------------------------------------------------------------- *
   * Persistence
   * ---------------------------------------------------------------------- */

  useEffect(() => {
    /*
     * A share link wins over the saved canvas: following a link is an explicit
     * request to see THAT pipeline. It is decoded asynchronously because
     * DecompressionStream is stream-based, and nothing is applied unless the
     * whole payload validates.
     */
    if (shareParam !== undefined && shareParam !== '') {
      let cancelled = false;
      void decodeParamToGraph(shareParam).then((result) => {
        if (cancelled) return;
        if (result.status === 'ok') {
          // Results belong to the graph that produced them. Node ids are
          // reused across documents - every canvas starts at n1 - so leaving
          // the old run's states in place shows the previous pipeline's output
          // on the new pipeline's nodes until the first run of the new one
          // finishes, which is a wrong answer rather than a missing one.
          usePipelineStore.getState().reset();
          store.getState().replaceGraph(result.graph);
          store
            .getState()
            .announce(
              `Loaded a shared pipeline: ${result.graph.nodeOrder.length.toString()} nodes. Inputs are empty - shared links never carry data.`,
            );
        } else {
          notify({ title: 'Shared link rejected', description: result.message, tone: 'error' });
        }
      });
      return () => {
        cancelled = true;
      };
    }

    const result = loadGraph();
    if (result.status === 'loaded') {
      usePipelineStore.getState().reset();
      store.getState().replaceGraph(result.graph);
    } else if (result.status === 'rejected') {
      // A corrupt save produces an empty canvas and an explanation, never a
      // crash and never a half-restored graph.
      notify({ title: 'Saved canvas reset', description: result.message, tone: 'warn' });
    }
    return undefined;
  }, [store, notify, shareParam]);

  useEffect(() => {
    const saver = createDebouncedSaver();
    const unsubscribe = store.subscribe((state) => {
      saver.save(state.graph);
    });
    return () => {
      saver.flush();
      unsubscribe();
    };
  }, [store]);

  /* ---------------------------------------------------------------------- *
   * Pipeline
   * ---------------------------------------------------------------------- */

  const runStates = usePipelineStore((state) => state.states);
  const pipelineRunning = usePipelineStore((state) => state.running);
  /*
   * Derived from the live per-node states rather than from the last summary:
   * a summary is a snapshot of a finished run and goes stale the moment the
   * next one starts, which would leave the readout contradicting the nodes.
   */
  const failedCount = useMemo(
    () => Object.values(runStates).filter((state) => state.status === 'error').length,
    [runStates],
  );
  const pipelineLog = usePipelineStore((state) => state.announcementLog);

  /*
   * Re-run whenever the document changes. `schedule` is debounced, so typing
   * into a node produces one run after the pause rather than one per keystroke,
   * and the executor's cache means only the edited node and its descendants
   * actually execute.
   */
  useEffect(() => {
    usePipelineStore.getState().schedule(graph);
  }, [graph]);

  /*
   * COLD START
   *
   * Two costs used to land inside the user's first run, where they read as the
   * tool being slow rather than as the app starting up:
   *
   *   - booting the worker (fetching and evaluating its module graph), and
   *   - importing the tool's own chunk inside that worker.
   *
   * Both are paid here instead. The worker is started when the canvas mounts,
   * because a canvas exists to run things. A tool's chunk is fetched when its
   * node is ADDED - a deliberate act - and not a moment sooner: prefetching
   * every tool in the palette on hover would trade a few milliseconds of
   * latency for hundreds of kilobytes nobody asked for.
   *
   * Both calls are optimisations and both swallow their own failures, so a
   * browser that will not give us a worker gets the old behaviour rather than
   * a broken canvas.
   */
  useEffect(() => {
    getSharedEngine().warmUp();
  }, []);

  const toolsOnCanvas = useMemo(
    () => [...new Set(graph.nodeOrder.flatMap((id) => graph.nodes[id]?.toolId ?? []))],
    [graph],
  );

  useEffect(() => {
    const engine = getSharedEngine();
    // `prefetch` is idempotent per tool, so re-running this for an unrelated
    // graph change costs a Set lookup.
    for (const toolId of toolsOnCanvas) engine.prefetch(toolId);
  }, [toolsOnCanvas]);

  useEffect(
    () => () => {
      usePipelineStore.getState().cancel();
    },
    [],
  );

  /*
   * Pipeline messages go to the canvas's single live region rather than a
   * second one, so nothing competes to be read out.
   *
   * Every unbridged entry is forwarded, not just the newest. Reading only the
   * latest was the same last-writer-wins bug one layer further out: a run that
   * announced its start and its summary inside one React batch delivered only
   * the summary, and a cancelled-then-restarted run could deliver neither.
   */
  const lastPipelineSeq = useRef(0);
  useEffect(() => {
    const { announce } = store.getState();
    for (const entry of pipelineLog) {
      if (entry.seq <= lastPipelineSeq.current) continue;
      lastPipelineSeq.current = entry.seq;
      if (entry.text !== '') announce(entry.text, entry.channel);
    }
  }, [pipelineLog, store]);

  /* ---------------------------------------------------------------------- *
   * Viewport: pan and zoom, throttled to animation frames
   * ---------------------------------------------------------------------- */

  const pending = useRef<{ pan: Point; zoom: { factor: number; at: Point } | null }>({
    pan: { x: 0, y: 0 },
    zoom: null,
  });
  const frame = useRef<number | null>(null);

  const flush = useCallback(() => {
    frame.current = null;
    const { pan, zoom } = pending.current;
    pending.current = { pan: { x: 0, y: 0 }, zoom: null };

    const viewportStore = useViewportStore.getState();
    if (zoom) viewportStore.zoomAt(zoom.factor, zoom.at);
    if (pan.x !== 0 || pan.y !== 0) viewportStore.panBy(pan);
  }, []);

  const schedule = useCallback(() => {
    // Several wheel events can arrive between two frames. Accumulating them
    // and applying once per frame keeps the transform write on the compositor's
    // schedule instead of ahead of it.
    frame.current ??= requestAnimationFrame(flush);
  }, [flush]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  /*
   * WHEEL, AND WHY IT IS NOT BOUND WHILE A DIALOG IS OPEN
   *
   * The overlays are rendered inside this root, so a wheel over one of them
   * BUBBLES here. The handler is non-passive - zooming has to preventDefault
   * or the page scrolls instead - so it was doing two wrong things at once:
   * feeding the delta into the canvas pan/zoom, and cancelling the dialog's
   * own native scrolling. Scrolling the shortcuts reference panned the canvas
   * 400px and moved the dialog not at all.
   *
   * Not bound at all while an overlay is open, rather than bound and guarded.
   * A listener that exists only to decline the event is still a listener that
   * has to be reasoned about, and detaching it means the wheel reaches the
   * dialog untouched - native scrolling, native momentum, native everything.
   * `overscroll-behavior: contain` on the scroll regions stops it chaining
   * outward from there.
   */
  const overlayOpen = overlay.kind !== 'none';

  useEffect(() => {
    const root = rootRef.current;
    if (!root || overlayOpen) return;

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = root.getBoundingClientRect();
      const at = { x: event.clientX - rect.left, y: event.clientY - rect.top };

      if (event.ctrlKey || event.metaKey) {
        // Trackpad pinch arrives as ctrl+wheel, so this covers both.
        pending.current.zoom = {
          factor: Math.exp(-event.deltaY * 0.01),
          at,
        };
      } else {
        pending.current.pan = {
          x: pending.current.pan.x - event.deltaX,
          y: pending.current.pan.y - event.deltaY,
        };
      }

      schedule();
    };

    // Not passive: zooming has to preventDefault or the page scrolls instead.
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      root.removeEventListener('wheel', onWheel);
      /*
       * Drop anything accumulated but not yet applied. Without this a wheel
       * delta that arrived in the same frame a dialog opened would land on the
       * canvas afterwards, which looks like the canvas moving by itself.
       */
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      pending.current = { pan: { x: 0, y: 0 }, zoom: null };
    };
  }, [schedule, overlayOpen]);

  /* ---------------------------------------------------------------------- *
   * Pointer interactions
   * ---------------------------------------------------------------------- */

  const dragging = useRef<
    | { readonly kind: 'pan'; readonly last: Point }
    | { readonly kind: 'node'; readonly origin: Point }
    | { readonly kind: 'wire'; readonly origin: PortEnd }
    | null
  >(null);

  /*
   * TOUCH.
   *
   * Every active pointer, by pointerId, in client coordinates. A mouse only
   * ever puts one entry in here; a hand puts up to five, and they do NOT
   * arrive and leave in tidy pairs - a finger can be lost to a phone call, a
   * palm can land as a third contact, and the browser can cancel any of them
   * at any moment. So the map is the source of truth and every gesture is
   * derived from it rather than assumed.
   */
  const pointers = useRef(new Map<number, Point>());

  /** The live two-finger gesture, if there is one. */
  const pinch = useRef<{ a: number; b: number; sample: PinchSample } | null>(null);

  /** Client-space position of a tracked pointer pair, or null if either is gone. */
  const pairSample = useCallback((a: number, b: number): PinchSample | null => {
    const first = pointers.current.get(a);
    const second = pointers.current.get(b);
    if (!first || !second) return null;
    return pinchSample(first, second);
  }, []);

  /**
   * Abandons whatever gesture is in flight, leaving the viewport and the graph
   * in a state the user can carry on from.
   *
   * A node move is ENDED rather than discarded - the drag really happened, and
   * committing it keeps the undo history honest. A wire draft is discarded,
   * because a half-drawn wire that a second finger interrupted is not a
   * connection anybody asked for.
   */
  const endGestures = useCallback(() => {
    const current = dragging.current;
    dragging.current = null;
    pinch.current = null;

    if (current?.kind === 'node') store.getState().endMove();
    if (current?.kind === 'wire') setDraft(null);

    useViewportStore.getState().setPanning(false);
  }, [store]);

  const screenToWorld = useCallback((event: { clientX: number; clientY: number }): Point => {
    const rect = rootRef.current?.getBoundingClientRect();
    const point = {
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
    };
    return toWorld(point, useViewportStore.getState().viewport);
  }, []);

  /**
   * Starting a wire, from EITHER end.
   *
   * Inputs used to be a no-op here while still styling themselves as grabbable
   * - a hover highlight and a crosshair cursor advertising an interaction that
   * did not exist. Rather than take the affordance away, the affordance is now
   * true: a drag may start at either end and is put the right way round when
   * it lands. That is what every established node editor does, and it halves
   * the number of attempts that go nowhere.
   *
   * The draft starts anchored at the port itself, not at the world origin, so
   * there is no frame where the line shoots off to the top-left.
   */
  const onPortPointerDown = useCallback(
    (ref: PortRef, side: PortSide) => {
      const origin: PortEnd = { ref, side };
      const at = portPositionById(store.getState().graph, ref.nodeId, side, ref.portId);

      setRefused(null);
      dragging.current = { kind: 'wire', origin };
      setDraft({ origin, at: at ?? { x: 0, y: 0 }, snapped: null });
    },
    [store],
  );

  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    /*
     * A second finger turns whatever was happening into a pinch.
     *
     * Deliberately not restricted to empty canvas: someone who starts dragging
     * a node and then puts a second finger down meant to zoom, and leaving the
     * node stuck to one finger while the other does nothing is the worse
     * reading. endGestures commits the move so the drag is not silently lost.
     */
    if (pointers.current.size >= 2 && isDirectPointer(event)) {
      const pair = pinchPair(pointers.current);
      const sample = pair ? pairSample(pair[0], pair[1]) : null;

      if (pair && sample) {
        endGestures();
        pinch.current = { a: pair[0], b: pair[1], sample };
        rootRef.current?.setPointerCapture(event.pointerId);
        return;
      }
    }

    // The refusal marker is transient: it explains one drop, then gets out of
    // the way at the next thing the user does.
    setRefused(null);

    /*
     * THE CHROME IS NOT THE CANVAS.
     *
     * The toolbar and the readout are rendered inside this root, so a click on
     * one of them arrives here as a pointerdown on "not a node" - which used
     * to clear the selection. Pressing Fit, or Undo, or Share therefore threw
     * away the selection as a side effect nobody asked for, silently, at every
     * width.
     *
     * That was survivable while nothing on screen depended on the selection.
     * It stopped being survivable the moment one of those buttons was the
     * inspector toggle: pressing it deselected the node and opened a panel
     * showing "no node selected", which reads as the feature not working.
     */
    if (target.closest('[data-canvas-chrome]')) return;

    const nodeElement = target.closest('[data-node-id]');
    const nodeId = nodeElement?.getAttribute('data-node-id') ?? null;

    // Middle button or held space pans, whatever is underneath.
    if (event.button === 1 || spacePressed) {
      dragging.current = { kind: 'pan', last: { x: event.clientX, y: event.clientY } };
      useViewportStore.getState().setPanning(true);
      rootRef.current?.setPointerCapture(event.pointerId);
      return;
    }

    if (dragging.current?.kind === 'wire') return;

    if (nodeId === null) {
      /*
       * One finger on empty canvas pans.
       *
       * Only for a pointer that is NOT a mouse. Panning was reachable in three
       * ways - space+drag, middle-drag and the wheel - and a touchscreen has
       * none of them: there is no middle button, no practical space bar, and a
       * touchscreen never emits a wheel event. A pen is in the same position.
       * A mouse keeps its existing behaviour exactly, because left-drag on
       * empty canvas currently clears the selection and nothing else, and
       * changing that is a mouse change nobody asked for.
       */
      if (isDirectPointer(event)) {
        store.getState().clearSelection();
        dragging.current = { kind: 'pan', last: { x: event.clientX, y: event.clientY } };
        useViewportStore.getState().setPanning(true);
        rootRef.current?.setPointerCapture(event.pointerId);
        return;
      }

      store.getState().clearSelection();
      return;
    }

    const state = store.getState();
    if (event.shiftKey) {
      state.toggleNode(nodeId);
    } else if (!state.selection.nodes.includes(nodeId)) {
      state.select({ nodes: [nodeId], edges: [] });
    }

    dragging.current = { kind: 'node', origin: screenToWorld(event) };
    store.getState().beginMove(store.getState().selection.nodes);
    rootRef.current?.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (pointers.current.has(event.pointerId)) {
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    const gesture = pinch.current;
    if (gesture) {
      const next = pairSample(gesture.a, gesture.b);
      // One of the two tracked fingers has gone without an up or a cancel.
      // pointerup will tidy up; there is nothing to measure in the meantime.
      if (!next) return;

      const step = pinchStep(gesture.sample, next);
      const rect = rootRef.current?.getBoundingClientRect();

      const viewport = useViewportStore.getState();
      // Pan first, then zoom about the new midpoint: zoomAt solves for "the
      // world point under here must not move", so it has to be given the
      // midpoint's final position, not the one it had before the pan.
      viewport.panBy(step.pan);
      viewport.zoomAt(step.factor, {
        x: step.at.x - (rect?.left ?? 0),
        y: step.at.y - (rect?.top ?? 0),
      });

      pinch.current = { ...gesture, sample: next };
      return;
    }

    const current = dragging.current;
    if (!current) return;

    if (current.kind === 'pan') {
      useViewportStore.getState().panBy({
        x: event.clientX - current.last.x,
        y: event.clientY - current.last.y,
      });
      dragging.current = { kind: 'pan', last: { x: event.clientX, y: event.clientY } };
      return;
    }

    if (current.kind === 'node') {
      const world = screenToWorld(event);
      store.getState().dragMove({
        x: world.x - current.origin.x,
        y: world.y - current.origin.y,
      });
      return;
    }

    const at = screenToWorld(event);
    // The snap is recomputed on every move so the armed port and the released
    // port are decided by exactly the same rule.
    const snap = nearestCompatiblePort(store.getState().graph, current.origin, at);
    setDraft({
      origin: current.origin,
      at,
      snapped: snap ? { ref: snap.ref, side: snap.side } : null,
    });
  };

  const onPointerUp = (event: PointerEvent): void => {
    pointers.current.delete(event.pointerId);

    const gesture = pinch.current;
    if (gesture) {
      // Still two tracked fingers down? Nothing has ended.
      if (event.pointerId !== gesture.a && event.pointerId !== gesture.b) return;

      pinch.current = null;

      /*
       * Re-anchor rather than stop.
       *
       * Lifting one finger of a pinch normally means "carry on panning with
       * the other", and starting a fresh pan from the survivor's CURRENT
       * position means the canvas does not jump. If two or more are still
       * down - a third finger was resting - promote them to a new pinch
       * instead.
       */
      const pair = pinchPair(pointers.current);
      const sample = pair ? pairSample(pair[0], pair[1]) : null;
      if (pair && sample) {
        pinch.current = { a: pair[0], b: pair[1], sample };
        return;
      }

      const survivor = [...pointers.current.values()][0];
      if (survivor) {
        dragging.current = { kind: 'pan', last: survivor };
        useViewportStore.getState().setPanning(true);
        return;
      }

      useViewportStore.getState().setPanning(false);
      return;
    }

    const current = dragging.current;
    dragging.current = null;
    useViewportStore.getState().setPanning(false);

    if (!current) return;

    if (current.kind === 'node') {
      store.getState().endMove();
      return;
    }

    if (current.kind === 'wire') {
      setDraft(null);
      dropWire(current.origin, screenToWorld(event));
    }
  };

  /* ---------------------------------------------------------------------- *
   * Connecting
   * ---------------------------------------------------------------------- */

  const onShare = useCallback(() => {
    void buildShareUrl(store.getState().graph, window.location.origin).then(
      async (url) => {
        try {
          await navigator.clipboard.writeText(url);
          notify({
            title: 'Share link copied',
            description: `${url.length.toString()} characters. Structure and settings only - your input is not in the link.`,
            tone: 'ok',
          });
          store.getState().announce('Share link copied. It contains no input data.');
        } catch {
          notify({
            title: 'Could not copy',
            description: 'The browser refused clipboard access.',
            tone: 'error',
          });
        }
      },
      () => {
        notify({
          title: 'Could not build a link',
          description: 'The pipeline could not be encoded.',
          tone: 'error',
        });
      },
    );
  }, [store, notify]);

  const onInputChange = useCallback(
    (nodeId: string, portId: string, value: string) => {
      store.getState().setNodeInput(nodeId, portId, value);
    },
    [store],
  );

  /**
   * A FILE CHOSEN FOR, OR CLEARED FROM, AN INPUT PORT.
   *
   * Two writes, and the order matters. The bytes go into the attachment store
   * FIRST, so there is no render in which the document names a file the store
   * cannot produce - which is exactly what a reloaded canvas looks like, and it
   * would be wrong to show it for a frame to somebody who just chose one.
   *
   * The document write is what schedules the run: it changes `graph`, the
   * effect watching `graph` calls `schedule`, and that is the existing 300ms
   * debounce. Nothing here runs the pipeline directly, for the reason the
   * options handler gives - a second trigger is a second thing to keep in step.
   */
  const onFileChange = useCallback(
    (nodeId: NodeId, portId: string, loaded: LoadedFile | null) => {
      const attachments = useAttachmentStore.getState();

      /*
       * ANNOUNCED BY THE PORT'S LABEL, NOT ITS ID. "A port id is an identity;
       * a label is a word for a person" is the port audit's own rule, and this
       * is read aloud - `Removed the file from original.` is the id leaking
       * into a sentence. The node is looked up rather than passed in because
       * the caller already knows which port it means and should not have to
       * know what it is called.
       */
      const node = store.getState().graph.nodes[nodeId];
      const label =
        node === undefined
          ? portId
          : (getManifestEntry(node.toolId).inputs.find((port) => port.id === portId)?.label ??
            portId);

      if (loaded === null) {
        attachments.detach(nodeId, portId);
        store.getState().setNodeFile(nodeId, portId, null);
        store.getState().announce(`Removed the file from ${label}.`);
        return;
      }

      const ref = attachments.attach(nodeId, portId, loaded);
      store.getState().setNodeFile(nodeId, portId, ref);
      store
        .getState()
        .announce(`Loaded ${describeFile(ref.name, ref.size)} into ${label}. Nothing is uploaded.`);
    },
    [store],
  );

  /**
   * A FILE DROPPED ON A NODE.
   *
   * The gesture people try first, and it was doing the worst possible thing:
   * with no handler anywhere on this route, dropping a file on the canvas made
   * the BROWSER navigate to it, replacing the app with a picture. That is fixed
   * whatever else happens here - `dragover` is prevented across the whole
   * workspace - and the drop itself now lands where it looks like it should.
   *
   * WHICH PORT, when a node has two. `diff` is the only tool in the set with
   * two inputs and neither of them is "the" one, so a drop with two candidate
   * ports does not guess: it selects the node, opens the inspector and says so,
   * which puts the user in front of the two named controls that can answer the
   * question. Guessing "the first port" would silently make one of the two
   * comparisons impossible to reach by drag, and the wrong one half the time.
   *
   * A DROP ON THE BACKGROUND IS REFUSED, not turned into a new node. Deciding
   * which tool a file wants means reading its bytes and picking on the user's
   * behalf - a hash for an archive, a converter for a PNG - and a gesture that
   * silently chooses a tool is a worse surprise than one that does nothing and
   * says what would have worked.
   */
  const onNodeDrop = useCallback(
    async (nodeId: NodeId | null, file: File): Promise<void> => {
      const refuse = (message: string): void => {
        notify({ title: 'Nothing to drop that on', description: message, tone: 'warn' });
        store.getState().announce(message);
      };

      if (nodeId === null) {
        refuse('Drop a file onto a node, or choose one in the inspector.');
        return;
      }

      const { graph: current } = store.getState();
      const node = current.nodes[nodeId];
      if (!node) return;

      const entry = getManifestEntry(node.toolId);
      const candidates = fileTargetPorts(current, node);

      if (candidates.length === 0) {
        refuse(`Every input on ${entry.name} is wired. Remove a wire to feed it a file.`);
        return;
      }

      if (candidates.length > 1) {
        store.getState().select({ nodes: [nodeId], edges: [] });
        setInspectorOpen(true);
        const names = candidates.map((port) => port.label).join(' and ');
        notify({
          title: `${entry.name} has more than one input`,
          description: `Choose a file for ${names} in the inspector.`,
          tone: 'warn',
        });
        store.getState().announce(`${entry.name} takes ${names}. Choose which in the inspector.`);
        return;
      }

      const port = candidates[0];
      if (!port) return;

      const attachments = useAttachmentStore.getState().files[nodeId] ?? {};
      const result = await loadFileForPort(port, file, {
        maxBytes: entry.execution.maxInputBytes,
        otherBytes: otherInputBytes(node, entry.inputs, port.id, attachments),
      });

      if ('error' in result) {
        notify({ title: 'File rejected', description: result.error, tone: 'error' });
        store.getState().announce(result.error);
        return;
      }

      onFileChange(nodeId, port.id, result.loaded);
    },
    [notify, onFileChange, store],
  );

  /**
   * The node a file is currently being dragged over, for the drop highlight.
   *
   * A drop target nothing marks is a guess, and on a canvas of overlapping
   * nodes it is a guess the user gets wrong. Held here rather than on the node
   * because only one node can be the target.
   */
  const [dropTarget, setDropTarget] = useState<NodeId | null>(null);

  /*
   * The drag listeners are attached to the WORKSPACE, imperatively.
   *
   * The workspace rather than the canvas root, because `dragover` has to be
   * prevented everywhere on the route - including the inspector's own
   * surroundings - or the browser navigates away from the app on any drop that
   * misses a drop zone. The inspector's own `FileDrop` stops propagation, so a
   * drop that has already named its port never reaches this.
   *
   * Imperatively, for the reason `FileDrop` gives about the same handlers: a
   * `<div>` carrying interaction props is a genuine accessibility smell, and
   * silencing that rule here would blunt it where it really catches something.
   */
  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return undefined;

    const nodeUnder = (target: EventTarget | null): NodeId | null => {
      if (!(target instanceof Element)) return null;
      return target.closest('[data-node-id]')?.getAttribute('data-node-id') ?? null;
    };

    const onDragOver = (event: DragEvent): void => {
      // Without this the browser opens the file and the canvas is gone.
      event.preventDefault();
      setDropTarget(nodeUnder(event.target));
    };
    const onDragLeave = (event: DragEvent): void => {
      // Only when the pointer has actually left the workspace: `dragleave`
      // fires for every child boundary crossed on the way in, and clearing on
      // those makes the highlight flicker off under the cursor.
      if (event.relatedTarget === null) setDropTarget(null);
    };
    const onDrop = (event: DragEvent): void => {
      event.preventDefault();
      setDropTarget(null);
      const file = event.dataTransfer?.files.item(0);
      if (file) void onNodeDrop(nodeUnder(event.target), file);
    };

    workspace.addEventListener('dragover', onDragOver);
    workspace.addEventListener('dragleave', onDragLeave);
    workspace.addEventListener('drop', onDrop);

    return () => {
      workspace.removeEventListener('dragover', onDragOver);
      workspace.removeEventListener('dragleave', onDragLeave);
      workspace.removeEventListener('drop', onDrop);
    };
  }, [onNodeDrop]);

  /*
   * An option change is an ordinary graph edit, so it goes through the same
   * path everything else does: the store updates the document, the effect that
   * watches `graph` schedules a run, and that schedule is debounced by 300ms.
   * Typing into a regex pattern therefore produces one run after the pause,
   * exactly as typing into an input does, and the executor's cache means only
   * this node and its descendants actually execute - the options are part of
   * the node's cache key and nothing upstream of it has changed.
   *
   * Nothing here re-runs the pipeline directly. A second trigger beside the
   * existing one would be a second thing to keep in step with the debounce.
   */
  const onOptionChange = useCallback(
    (nodeId: NodeId, key: string, value: unknown, coalesce: boolean) => {
      const node = store.getState().graph.nodes[nodeId];
      if (!node) return;
      store.getState().setNodeOptions(nodeId, { ...node.options, [key]: value }, coalesce);
    },
    [store],
  );

  /**
   * MOVING FOCUS INTO THE INSPECTOR: WHICH ELEMENT, AND WHEN.
   *
   * Both halves of this were wrong, and each was wrong in a way the other hid.
   *
   * WHICH. The panel's first focusable element in DOCUMENT order is the close
   * button in its header, not the editor - `querySelector` takes the first
   * node that matches ANY of a selector list, not the first selector that
   * matches anything. So Enter, whose whole stated purpose is to step into the
   * node's input, landed on "Close the inspector": a user who pressed Enter
   * and typed got nothing, and their next Space or Enter shut the panel. The
   * editor is asked for by name now, and the generic list is only the fallback
   * for a node that has no text editor at all - a port that takes bytes gets a
   * sentence rather than a box.
   *
   * WHEN. The move was deferred to `requestAnimationFrame`, which meant it
   * happened at some point AFTER the keystroke that asked for it, with nothing
   * to say what had happened to focus in between. Under load that frame can be
   * tens of milliseconds late, and it then lands in the middle of somebody
   * else's interaction and takes focus off whatever they had just put it on -
   * text typed into the editor in that window goes to the close button and is
   * silently discarded, because a button is not an editable element and there
   * is no error for text that lands nowhere. That is a real defect for anyone
   * who types quickly, and it is also what made the worker-wedge check in
   * `check:browsers` fail roughly one run in three: Playwright focuses the
   * field and then inserts the text as a second step, and the stolen frame fell
   * between them.
   *
   * A layout effect runs synchronously after the commit that mounted the panel,
   * in the same task as the keystroke, so there is no window to lose and no
   * frame to guess at. The counter is the request: two Enters in a row are two
   * requests, where a boolean would be one.
   */
  const [focusRequest, setFocusRequest] = useState(0);
  const focusInspector = useCallback(() => {
    setFocusRequest((request) => request + 1);
  }, []);

  useLayoutEffect(() => {
    if (focusRequest === 0) return;
    const panel = workspaceRef.current?.querySelector('[data-testid="node-inspector"]');
    if (!panel) return;

    /*
     * ASKED FOR BY NAME, IN PRIORITY ORDER, ONE SELECTOR AT A TIME.
     *
     * The text editor, then the file chooser, then anything focusable. Three
     * separate calls rather than one selector list, because a list returns the
     * first element matching ANY of them in DOCUMENT order - which is the bug
     * that put focus on "Close the inspector", the panel's header coming before
     * its body.
     *
     * The file chooser is the second entry rather than a happy accident of
     * document order: a port that takes bytes only has no editor to step into,
     * so its chooser is what "step into this node's input" has to mean there.
     * Without it, `Enter` fell through to the generic selector and happened to
     * find the same element - and would have stopped doing so the first time
     * anything else in the panel came before it.
     */
    const target =
      panel.querySelector<HTMLElement>('[data-inspector-input]') ??
      panel.querySelector<HTMLElement>('[data-file-input]') ??
      panel.querySelector<HTMLElement>('textarea, input, select') ??
      panel.querySelector<HTMLElement>('button, [tabindex]:not([tabindex="-1"])');
    target?.focus();
  }, [focusRequest]);

  const toggleInspector = useCallback(() => {
    // The announcement is made OUTSIDE the updater. A `setState` callback has
    // to be pure - React may call it twice, and in StrictMode does - and
    // announcing from inside one is a store write during another component's
    // render, which React refuses out loud.
    setInspectorOpen((open) => !open);
    store.getState().announce(inspectorOpen ? 'Inspector hidden.' : 'Inspector shown.');
  }, [store, inspectorOpen]);

  /**
   * Where focus goes when the node being inspected stops existing.
   *
   * Only called when focus was actually inside the panel - see NodeInspector -
   * so this cannot steal focus from a deletion the user performed on the
   * canvas, which already put focus back on the root itself.
   */
  const onInspectorOrphaned = useCallback(() => {
    rootRef.current?.focus();
    store.getState().announce('That node is gone. The inspector is empty.');
  }, [store]);

  const tryConnect = useCallback(
    (from: PortRef, to: PortRef): boolean => {
      const result = store.getState().connect(from, to);
      if (!result.ok) {
        // Announced by the store into the live region, AND shown, so the
        // reason reaches everyone rather than only screen-reader users.
        notify({
          title: 'Connection refused',
          description: result.rejection.message,
          tone: 'error',
        });
        return false;
      }
      return true;
    },
    [store, notify],
  );

  /**
   * Where a dragged wire lands.
   *
   * Three outcomes, in order:
   *
   *  1. A legal partner within the snap radius - connect to it. Snapping is
   *     geometric rather than a DOM hit test, so a release NEAR an 11px port
   *     still counts, and the nearest of two close candidates wins.
   *  2. No legal partner, but a port of the opposite side is close - connect
   *     anyway so the refusal runs and SAYS why, and mark that port refused so
   *     the reason is visible at the place the user was aiming.
   *  3. Nothing nearby - empty canvas. Cancel silently; the draft is already
   *     gone, so there is nothing to orphan.
   */
  const dropWire = useCallback(
    (origin: PortEnd, at: Point) => {
      const graph = store.getState().graph;

      const snap = nearestCompatiblePort(graph, origin, at);
      if (snap) {
        const oriented = orientEnds(origin, { ref: snap.ref, side: snap.side });
        if (oriented) tryConnect(oriented.from, oriented.to);
        return;
      }

      const opposite: PortSide = origin.side === 'output' ? 'input' : 'output';
      const near = nearestPortOfSide(graph, opposite, at);
      if (!near) return;

      const oriented = orientEnds(origin, { ref: near.ref, side: near.side });
      if (!oriented) return;
      if (!tryConnect(oriented.from, oriented.to)) {
        setRefused({ ref: near.ref, side: near.side });
      }
    },
    [store, tryConnect],
  );

  /* ---------------------------------------------------------------------- *
   * Adding tools
   * ---------------------------------------------------------------------- */

  const addTool = useCallback(
    (toolId: ToolId) => {
      const root = rootRef.current;
      const rect = root?.getBoundingClientRect();
      const current = useViewportStore.getState().viewport;

      // Place it in the middle of what the user is currently looking at, so
      // there is never a new node to go hunting for.
      const centre = toWorld(
        { x: (rect?.width ?? 800) / 2, y: (rect?.height ?? 600) / 2 },
        current,
      );

      const id = store
        .getState()
        .addNode(
          toolId,
          freeSpot(store.getState().graph, { x: centre.x - NODE_WIDTH / 2, y: centre.y - 60 }),
        );

      // Focus follows the new node, so the next keystroke acts on it.
      requestAnimationFrame(() => {
        const element = rootRef.current?.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
        element?.focus();
      });
    },
    [store],
  );

  const addPreset = useCallback(
    (presetId: string) => {
      const rect = rootRef.current?.getBoundingClientRect();
      const size = { width: rect?.width ?? 800, height: rect?.height ?? 600 };
      const centre = toWorld(
        { x: size.width / 2, y: size.height / 2 },
        useViewportStore.getState().viewport,
      );

      /*
       * Placed left of centre so a two- or three-node chain lands in view,
       * then dropped clear of anything already on the canvas. Landing a
       * prewired graph on top of existing nodes reads as corruption, and
       * untangling it by hand is worse than the click was worth.
       */
      const origin = clearOfExistingNodes(store.getState().graph, {
        x: centre.x - NODE_WIDTH,
        y: centre.y - 80,
      });

      store.getState().applyPreset(presetId, origin);

      /*
       * Fit afterwards. A preset is several nodes and their wires, and the
       * point of loading one is to see the shape - which is no use if half of
       * it is off-screen. A single tool is not fitted: that would yank the
       * viewport for one small addition.
       */
      useViewportStore.getState().fitToContent(store.getState().graph, size);
    },
    [store],
  );

  /* ---------------------------------------------------------------------- *
   * Keyboard
   * ---------------------------------------------------------------------- */

  const focusedNodeId = useCallback((): NodeId | null => {
    const active = document.activeElement;
    if (!(active instanceof Element)) return null;
    return active.closest('[data-node-id]')?.getAttribute('data-node-id') ?? null;
  }, []);

  /**
   * The C flow, step one.
   *
   * Lists EVERY port on the node - outputs first, then inputs - because the
   * pointer can now start a drag from either end and the keyboard is not a
   * second-class route to the same graph. Outputs lead, so the highlight
   * starts where it always did and `C, Enter` still means "from my output".
   *
   * The chooser is skipped only for a node with a single port, where there is
   * genuinely nothing to choose.
   */
  const beginConnectFrom = useCallback(
    (nodeId: NodeId) => {
      const node = store.getState().graph.nodes[nodeId];
      if (!node) return;

      const entry = getManifestEntry(node.toolId);
      const ends: PortEnd[] = [
        ...entry.outputs.map((port): PortEnd => ({
          ref: { nodeId, portId: port.id },
          side: 'output',
        })),
        ...entry.inputs.map((port): PortEnd => ({
          ref: { nodeId, portId: port.id },
          side: 'input',
        })),
      ];

      const only = ends.length === 1 ? ends[0] : undefined;
      setOverlay(only ? { kind: 'choose-partner', origin: only } : { kind: 'choose-port', nodeId });
    },
    [store],
  );

  const onKeyDown = (event: KeyboardEvent): void => {
    if (overlay.kind !== 'none') return;

    /*
     * Nothing on the canvas plane takes text any more - input moved to the
     * inspector, which is a SIBLING of this root rather than a child, so its
     * fields never reach this handler at all and there is no longer a case
     * where "k" would open the palette while somebody was typing.
     *
     * The guard stays anyway, and deliberately: this is a `role="application"`
     * region that claims every single letter, and a future control inside it
     * with a text field would silently inherit that claim. It costs one
     * instanceof and it is the difference between a rule and an accident.
     */
    const target = event.target;
    const editing =
      target instanceof HTMLElement &&
      (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);

    if (editing) return;

    const state = store.getState();
    const focused = focusedNodeId();
    const targets = focused ? [focused] : state.selection.nodes;
    const meta = event.ctrlKey || event.metaKey;

    if (event.key === ' ' && !spacePressed) {
      setSpacePressed(true);
      event.preventDefault();
      return;
    }

    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight': {
        if (targets.length === 0) return;
        event.preventDefault();
        const step = event.shiftKey ? BIG_NUDGE : NUDGE;
        const delta = {
          x: event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
          y: event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0,
        };
        state.nudgeNodes(targets, delta);
        return;
      }

      case 'Delete':
      case 'Backspace':
        if (state.selection.nodes.length === 0 && state.selection.edges.length === 0) return;
        event.preventDefault();
        state.deleteSelection();
        rootRef.current?.focus();
        return;

      case 'Escape':
        event.preventDefault();
        dragging.current = null;
        setDraft(null);
        state.clearSelection();
        return;

      case 'Enter': {
        if (!focused) return;
        if (event.shiftKey) {
          event.preventDefault();
          state.toggleNode(focused);
          return;
        }
        /*
         * Enter used to step into the node's own input editor. The editor
         * moved, so Enter follows it: it selects the node on its own, opens
         * the inspector and puts focus in it. Same key, same intent, one more
         * thing on the other end of it - and it is the reason the inspector
         * needs no separate "open on this node" affordance for the keyboard.
         */
        event.preventDefault();
        state.select({ nodes: [focused], edges: [] });
        setInspectorOpen(true);
        focusInspector();
        return;
      }

      case 'c':
      case 'C':
        if (meta || !focused) return;
        event.preventDefault();
        beginConnectFrom(focused);
        return;

      case 'k':
      case 'K':
        event.preventDefault();
        setOverlay({ kind: 'palette' });
        return;

      case 'i':
      case 'I':
        if (meta) return;
        event.preventDefault();
        toggleInspector();
        return;

      case '?':
        event.preventDefault();
        setOverlay({ kind: 'shortcuts' });
        return;

      case 'f':
      case 'F': {
        if (meta) return;
        event.preventDefault();
        const rect = rootRef.current?.getBoundingClientRect();
        useViewportStore.getState().fitToContent(state.graph, {
          width: rect?.width ?? 800,
          height: rect?.height ?? 600,
        });
        state.announce('Fitted every node in view.');
        return;
      }

      case '0': {
        event.preventDefault();
        const rect = rootRef.current?.getBoundingClientRect();
        useViewportStore
          .getState()
          .resetZoom({ x: (rect?.width ?? 800) / 2, y: (rect?.height ?? 600) / 2 });
        state.announce('Zoom reset to 100 percent.');
        return;
      }

      case 'a':
      case 'A':
        if (!meta) return;
        event.preventDefault();
        state.select({ nodes: [...state.graph.nodeOrder], edges: [] });
        state.announce(`Selected ${state.graph.nodeOrder.length.toString()} nodes.`);
        return;

      case 'd':
      case 'D':
        if (!meta) return;
        event.preventDefault();
        state.duplicateSelection();
        return;

      case 'z':
      case 'Z':
        if (!meta) return;
        event.preventDefault();
        if (event.shiftKey) state.redo();
        else state.undo();
        return;

      case 'y':
      case 'Y':
        if (!meta) return;
        event.preventDefault();
        state.redo();
        return;

      default:
        return;
    }
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === ' ') setSpacePressed(false);
  };

  /*
   * Pointer and key handling is attached imperatively.
   *
   * Two reasons. The linter treats a role="application" div as a
   * non-interactive element, and that warning is worth keeping switched on for
   * the cases it really catches. And a latest-ref indirection means the
   * listeners are registered once at mount rather than swapped out on every
   * pan frame, which matters when the component re-renders sixty times a
   * second while the viewport moves.
   */
  const handlers = useRef({
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onKeyDown,
    onKeyUp,
    endGestures,
  });

  useEffect(() => {
    handlers.current = {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onKeyDown,
      onKeyUp,
      endGestures,
    };
  });

  /*
   * On a phone the inspector is a sheet along the bottom of the workspace, and
   * an on-screen keyboard covers the bottom of the layout viewport. See
   * keyboardInset.ts for why the browser cannot fix that one itself.
   */
  useKeyboardInset(workspaceRef);

  /*
   * NOT BOUND WHILE AN OVERLAY IS OPEN, for the same reason the wheel listener
   * is not.
   *
   * The overlays render inside this root, so a touch that lands on a dialog
   * bubbles here. Left bound, a two-finger gesture over an open palette would
   * pinch the canvas underneath it - the touch equivalent of the wheel bug -
   * and even a single tap ran through onPointerDown and cleared the user's
   * node selection just because they had reached for the palette.
   *
   * Detaching rather than guarding keeps the guarantee structural: there is no
   * listener to reason about, so there is no path by which a gesture can reach
   * the canvas while a dialog owns the screen.
   */
  useEffect(() => {
    const root = rootRef.current;
    if (!root || overlayOpen) return;

    // Captured, not read in the cleanup: `pointers` holds one Map for the
    // component's whole life, so this is the same object either way - but
    // saying so explicitly is what makes that true rather than assumed.
    const active = pointers.current;

    const pointerDown = (event: PointerEvent): void => {
      handlers.current.onPointerDown(event);
    };
    const pointerMove = (event: PointerEvent): void => {
      handlers.current.onPointerMove(event);
    };
    const pointerUp = (event: PointerEvent): void => {
      handlers.current.onPointerUp(event);
    };
    const keyDown = (event: KeyboardEvent): void => {
      handlers.current.onKeyDown(event);
    };
    const keyUp = (event: KeyboardEvent): void => {
      handlers.current.onKeyUp(event);
    };

    root.addEventListener('pointerdown', pointerDown);
    root.addEventListener('pointermove', pointerMove);
    root.addEventListener('pointerup', pointerUp);
    root.addEventListener('pointercancel', pointerUp);
    root.addEventListener('keydown', keyDown);
    root.addEventListener('keyup', keyUp);

    return () => {
      root.removeEventListener('pointerdown', pointerDown);
      root.removeEventListener('pointermove', pointerMove);
      root.removeEventListener('pointerup', pointerUp);
      root.removeEventListener('pointercancel', pointerUp);
      root.removeEventListener('keydown', keyDown);
      root.removeEventListener('keyup', keyUp);

      /*
       * A gesture in flight when a dialog opens will never get its pointerup,
       * because the listener that would have received it is gone. Clear the
       * state here or the next touch resumes a drag from a finger that was
       * lifted minutes ago.
       */
      active.clear();
      handlers.current.endGestures();
    };
  }, [overlayOpen]);

  /* ---------------------------------------------------------------------- *
   * Derived rendering data
   * ---------------------------------------------------------------------- */

  /*
   * Nodes are rendered in SPATIAL order, not insertion order, so the browser's
   * own Tab sequence is the documented top-to-bottom, left-to-right order with
   * no roving-tabindex machinery.
   */
  const orderedNodeIds = useMemo(() => spatialOrder(graph), [graph]);

  const connectedPorts = useMemo(() => {
    const map = new Map<NodeId, Set<string>>();
    for (const id of graph.edgeOrder) {
      const edge = graph.edges[id];
      if (!edge) continue;
      const out = map.get(edge.from.nodeId) ?? new Set<string>();
      out.add(portKey('output', edge.from.portId));
      map.set(edge.from.nodeId, out);
      const into = map.get(edge.to.nodeId) ?? new Set<string>();
      into.add(portKey('input', edge.to.portId));
      map.set(edge.to.nodeId, into);
    }
    return map;
  }, [graph]);

  /**
   * While a wire is in flight, which ports could legally accept it.
   *
   * Keyed by side as well as id, because a drag from an input is looking for
   * outputs and both sides can share a port id.
   */
  const validTargets = useMemo(() => {
    if (!draft) return new Map<NodeId, Set<string>>();
    const map = new Map<NodeId, Set<string>>();
    for (const target of validPartnersFor(graph, draft.origin)) {
      const ports = map.get(target.nodeId) ?? new Set<string>();
      ports.add(portKey(target.side, target.portId));
      map.set(target.nodeId, ports);
    }
    return map;
  }, [draft, graph]);

  const selectedNodes = useMemo(() => new Set(selection.nodes), [selection.nodes]);

  /** Which ports on each node take typed input, computed once per graph. */
  const typedInputFor = useMemo(() => {
    const map = new Map<NodeId, readonly string[]>();
    for (const id of graph.nodeOrder) {
      const node = graph.nodes[id];
      if (node) map.set(id, typedInputPorts(graph, node));
    }
    return map;
  }, [graph]);

  /**
   * Which ports on each node have a file whose bytes this session still has.
   *
   * The node draws its own summary from the DOCUMENT (`node.fileInputs`), which
   * cannot tell a file just chosen from one a reload left behind - and those two
   * states say opposite things. This is the other half of the answer.
   */
  const attachedFiles = useAttachmentStore((state) => state.files);
  const fileInputFor = useMemo(() => {
    const map = new Map<NodeId, readonly string[]>();
    for (const [nodeId, ports] of Object.entries(attachedFiles)) {
      map.set(nodeId, Object.keys(ports));
    }
    return map;
  }, [attachedFiles]);

  /*
   * WHAT THE INSPECTOR IS LOOKING AT.
   *
   * Exactly one selected node, or nothing. Several selected nodes deliberately
   * produce `null` rather than the first of them: a panel that silently picks
   * one of a multi-selection to edit is a panel that edits something the user
   * did not choose. The several case is handled in the panel, which lists them
   * and lets one be picked.
   */
  const inspectorTarget = useMemo<InspectorNode | null>(() => {
    if (selection.nodes.length !== 1) return null;
    const id = selection.nodes[0];
    if (id === undefined) return null;
    const node = graph.nodes[id];
    if (!node) return null;

    const wiredFrom: Record<string, string> = {};
    for (const edgeId of graph.edgeOrder) {
      const edge = graph.edges[edgeId];
      if (edge?.to.nodeId !== id) continue;
      const source = graph.nodes[edge.from.nodeId];
      if (!source) continue;
      const sourceEntry = getManifestEntry(source.toolId);
      const port = sourceEntry.outputs.find((candidate) => candidate.id === edge.from.portId);
      wiredFrom[edge.to.portId] = `${sourceEntry.name} · ${port?.label ?? edge.from.portId}`;
    }

    return {
      node,
      run: runStates[id] ?? idleState(),
      typedInputPorts: typedInputFor.get(id) ?? EMPTY_PORTS,
      wiredFrom,
    };
  }, [selection.nodes, graph, runStates, typedInputFor]);

  /** Tool names for the several-selected list, so the panel needs no registry. */
  const selectedLabels = useMemo(() => {
    const labels: Record<NodeId, string> = {};
    for (const id of selection.nodes) {
      const node = graph.nodes[id];
      if (node) labels[id] = getManifestEntry(node.toolId).name;
    }
    return labels;
  }, [selection.nodes, graph]);

  /** Wires feeding a node that is running right now. */
  const activeEdges = useMemo(() => {
    const active = new Set<string>();
    for (const edgeId of graph.edgeOrder) {
      const edge = graph.edges[edgeId];
      if (edge && runStates[edge.to.nodeId]?.status === 'running') active.add(edgeId);
    }
    return active;
  }, [graph, runStates]);
  const emptySet = useMemo(() => new Set<string>(), []);

  /**
   * The wire being dragged.
   *
   * The origin comes from `portPositionById` - the same function the committed
   * wires use. It used to be `node.position.y + 64 + index * 24`, a private
   * copy of the layout arithmetic that was 21px out, so the line left from
   * roughly where the PREVIOUS port is drawn. On a two-output node that made
   * both outputs look like they started in the same place.
   *
   * When a snap is armed the line ends ON that port rather than under the
   * pointer, so what the release will do is visible before releasing.
   */
  const draftPath = useMemo(() => {
    if (!draft) return null;

    const from = portPositionById(
      graph,
      draft.origin.ref.nodeId,
      draft.origin.side,
      draft.origin.ref.portId,
    );
    if (!from) return null;

    const snappedTo = draft.snapped
      ? portPositionById(
          graph,
          draft.snapped.ref.nodeId,
          draft.snapped.side,
          draft.snapped.ref.portId,
        )
      : null;

    // A wire is drawn output -> input, whichever end the drag began at.
    const to = snappedTo ?? draft.at;
    return draft.origin.side === 'output' ? { from, to } : { from: to, to: from };
  }, [draft, graph]);

  /* ---------------------------------------------------------------------- *
   * Overlay option lists
   * ---------------------------------------------------------------------- */

  const paletteOptions: readonly DialogOption[] = useMemo(
    () => [
      // Presets first: they are the fastest way to see what the canvas is for.
      ...PIPELINE_PRESETS.map((preset) => ({
        id: `preset:${preset.id}`,
        name: preset.name,
        detail: preset.summary,
        group: 'pipelines',
      })),
      // No category on the row: the group heading above it already says so,
      // and printing it twice was costing the name the width it needed.
      ...TOOL_MANIFEST.map((entry) => ({
        id: entry.id,
        name: entry.name,
        detail: entry.summary,
        group: entry.category,
      })),
    ],
    [],
  );

  const portOptions: readonly DialogOption[] = useMemo(() => {
    if (overlay.kind !== 'choose-port') return [];
    const node = graph.nodes[overlay.nodeId];
    if (!node) return [];

    const entry = getManifestEntry(node.toolId);
    const nodeId = overlay.nodeId;

    return [
      ...entry.outputs.map((port) => ({
        id: encodeEnd({ ref: { nodeId, portId: port.id }, side: 'output' }),
        name: port.label,
        detail: `carries ${port.types.join(' or ')}`,
        group: 'outputs',
      })),
      ...entry.inputs.map((port) => ({
        id: encodeEnd({ ref: { nodeId, portId: port.id }, side: 'input' }),
        name: port.label,
        detail: `accepts ${port.types.join(' or ')}`,
        group: 'inputs',
      })),
    ];
  }, [overlay, graph]);

  const partnerOptions: readonly DialogOption[] = useMemo(() => {
    if (overlay.kind !== 'choose-partner') return [];
    return validPartnersFor(graph, overlay.origin).map((target) => ({
      id: encodeEnd({ ref: { nodeId: target.nodeId, portId: target.portId }, side: target.side }),
      name: `${target.nodeLabel} - ${target.portLabel}`,
      detail: target.types.join(' or '),
      group: 'partners',
    }));
  }, [overlay, graph]);

  const closeOverlay = useCallback(() => {
    setOverlay({ kind: 'none' });
    rootRef.current?.focus();
  }, []);

  /* ---------------------------------------------------------------------- *
   * Resizing the rail
   * ---------------------------------------------------------------------- */

  /**
   * THE HANDLE IS A `separator`, NOT A DECORATED BORDER.
   *
   * The ARIA window-splitter pattern, which means it is a real tab stop with a
   * value, a range, and arrow keys that change it. A drag handle that only a
   * pointer can move is a preference only a pointer user has, and the reason
   * the rail is resizable at all is that a diff wants more width than a colour
   * swatch does.
   *
   * The width is session state rather than something persisted. It is one
   * drag to restore, and a stored value would be a second storage key, a
   * second thing to validate on read and a second thing to migrate - for a
   * preference that changes with what you happen to be looking at.
   */
  const resizeRail = useCallback((width: number) => {
    setRailWidth(Math.round(clamp(width, RAIL_MIN, RAIL_MAX)));
  }, []);

  const onHandlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      // Not `stopPropagation` for the canvas's sake - the handle is outside
      // the canvas root, so nothing there ever sees this - but the browser's
      // own text selection during a drag has to be suppressed.
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);

      const right = workspaceRef.current?.getBoundingClientRect().right ?? window.innerWidth;

      const move = (moveEvent: PointerEvent): void => {
        resizeRail(right - moveEvent.clientX);
      };
      const up = (): void => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
      };

      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    },
    [resizeRail],
  );

  const onHandleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      // The rail grows leftwards, so ArrowLeft widens it. Stated because the
      // opposite mapping is just as arguable and this is the one the on-screen
      // direction of travel agrees with.
      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          resizeRail(railWidth + RAIL_STEP);
          return;
        case 'ArrowRight':
          event.preventDefault();
          resizeRail(railWidth - RAIL_STEP);
          return;
        case 'Home':
          event.preventDefault();
          resizeRail(RAIL_MAX);
          return;
        case 'End':
          event.preventDefault();
          resizeRail(RAIL_MIN);
          return;
        default:
      }
    },
    [railWidth, resizeRail],
  );

  /**
   * Escape leaves the inspector and returns to the node it is showing.
   *
   * The mirror of Enter, and the same wording the shortcuts map has always
   * carried for stepping out of an editor. It is bound here rather than in the
   * canvas's own key handler because the panel is outside that root, which is
   * exactly what stops the canvas claiming single letters typed into a field.
   */
  const onInspectorEscape = useCallback(() => {
    const id = useCanvasStore.getState().selection.nodes[0];
    const node =
      id === undefined
        ? null
        : rootRef.current?.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
    (node ?? rootRef.current)?.focus();
  }, []);

  /* ---------------------------------------------------------------------- */

  const zoomPercent = Math.round(viewport.zoom * 100);
  const zoomLimit = viewport.zoom <= MIN_ZOOM ? ' min' : viewport.zoom >= MAX_ZOOM ? ' max' : '';

  /*
   * Names the current value AND what activating it does. "100%" alone told a
   * screen-reader user the zoom but not that the thing was a button, let
   * alone what pressing it would change.
   */
  const zoomResetLabel = `Zoom ${zoomPercent.toString()}%. Reset to 100%.`;

  const compact = useMediaQuery(COMPACT_TOOLBAR);
  const shareNoteId = useId();

  const canvasSize = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect();
    return { width: rect?.width ?? 800, height: rect?.height ?? 600 };
  }, []);

  const onFit = useCallback(() => {
    useViewportStore.getState().fitToContent(store.getState().graph, canvasSize());
  }, [store, canvasSize]);

  const onResetZoom = useCallback(() => {
    const size = canvasSize();
    useViewportStore.getState().resetZoom({ x: size.width / 2, y: size.height / 2 });
  }, [canvasSize]);

  /*
   * The overflow's items are the same actions the inline row runs, through the
   * same callbacks - so the narrow layout cannot drift from the wide one.
   */
  /*
   * Zoom reset is NOT here, and not in the toolbar either. It lives on the
   * readout, beside the value it resets - two buttons with the identical
   * accessible name "Zoom 100%. Reset to 100%." is a worse answer than one in
   * the obvious place, and the readout is visible at every width.
   */
  /*
   * Fit is NOT in here. It is the one control that earns its place on a narrow
   * screen: a node is 224px wide, so a 320-390px viewport shows less than two
   * of them, and the usual way to lose a graph is to pan away from it. Fit is
   * how you find it again - burying the recovery action behind another tap was
   * the wrong way round.
   */
  const overflowItems: readonly OverflowItem[] = useMemo(
    () => [
      {
        id: 'undo',
        label: 'Undo',
        onSelect: () => {
          store.getState().undo();
        },
      },
      {
        id: 'redo',
        label: 'Redo',
        onSelect: () => {
          store.getState().redo();
        },
      },
      { id: 'share', label: 'Share', onSelect: onShare, description: SHARE_NOTE },
      {
        id: 'shortcuts',
        label: 'Shortcuts',
        onSelect: () => {
          setOverlay({ kind: 'shortcuts' });
        },
      },
    ],
    [onShare, store],
  );

  return (
    /*
     * THE WORKSPACE: the canvas, then the inspector, as siblings.
     *
     * The inspector is deliberately NOT inside the canvas root. Everything the
     * canvas renders inside that root - the palette, the connect dialogs, the
     * shortcuts reference - is an overlay, and the canvas detaches its wheel,
     * pointer and key listeners for as long as one is open, because those
     * listeners would otherwise pan the canvas underneath a dialog and swallow
     * the dialog's own scrolling.
     *
     * That machinery is right for a dialog and exactly wrong for this panel. A
     * docked inspector has to coexist with a live canvas: you change an option
     * and watch the chain behind it re-run, you pan to see the node it feeds,
     * you press Tab and land on a node. Rendering it as a sibling means none
     * of the canvas's listeners ever see a keystroke meant for a text field,
     * and none of the panel's scrolling is fighting a wheel handler - both
     * without a single guard, because there is no path between them.
     */
    <div
      ref={workspaceRef}
      className={inspectorStyles.workspace}
      style={{ '--inspector-width': `${railWidth.toString()}px` } as CSSProperties}
      /*
       * OPEN OR NOT, AND NOTHING ELSE.
       *
       * The grid has to know whether to reserve a column, because a closed
       * inspector must not leave 340px of empty surface beside the canvas -
       * that part cannot be done in the media query alone. Whether the panel is
       * a rail or a sheet is decided by the media query and by nothing else.
       *
       * That split is not tidiness. This attribute once carried the shape too,
       * from `railFits`, which is a JavaScript copy of the same breakpoint -
       * and the two can disagree for a render, because a media-query
       * subscription that re-subscribes can miss a change. Observed: a 1280px
       * window laying the panel out as a full-width implicit grid row across
       * the canvas, with the rail's CSS still applying. One source of truth for
       * the shape removes the disagreement rather than papering over it.
       */
      data-inspector={inspectorOpen ? 'open' : 'none'}
      data-testid="canvas-workspace"
    >
      <div
        ref={rootRef}
        className={cx(
          styles.root,
          inspectorStyles.surface,
          isPanning && styles.panning,
          spacePressed && styles.panReady,
        )}
        /*
         * role="application" hands arrow keys and single letters to us instead of
         * to the screen reader's browse mode - without it, none of the canvas's
         * keyboard model would ever reach this handler. It is the right role for
         * a spatial editor, and the /tools view remains the document-shaped way
         * to do everything here.
         */
        role="application"
        aria-roledescription="Node canvas"
        aria-label="Pipeline canvas"
        aria-describedby={descriptionId}
        tabIndex={0}
        data-testid="canvas-root"
      >
        <VisuallyHidden as="div">
          <span id={descriptionId}>{CANVAS_DESCRIPTION}</span>
        </VisuallyHidden>

        {/*
          The canvas's own live region. Movement and selection chatter goes here
          rather than to the toast system, which is reserved for things worth
          interrupting for - a refused connection, a reset save.

          It drains a LOG rather than rendering one string. Several unrelated
          sources announce into this one region - the graph store, the pipeline,
          the viewport - and none of them can be asked to take turns, so the
          region takes turns on their behalf. See `@/lib/announce`.
        */}
        <LiveRegion log={announcementLog} testId="canvas-announcer" />

        <div
          className={styles.grid}
          aria-hidden="true"
          style={{
            ...gridStyle(viewport),
            // Fade the dense grid out when it would turn into a solid wash.
            opacity: viewport.zoom < 0.5 ? 0.4 : 1,
          }}
        />

        <div
          className={styles.plane}
          data-testid="canvas-plane"
          style={{
            transform: `translate(${viewport.x.toString()}px, ${viewport.y.toString()}px) scale(${viewport.zoom.toString()})`,
          }}
        >
          <Wires
            graph={graph}
            selectedEdges={selection.edges}
            activeEdges={activeEdges}
            draft={draftPath}
            onSelectEdge={(id, additive) => {
              const state = store.getState();
              state.select({
                nodes: [],
                edges: additive ? [...state.selection.edges, id] : [id],
              });
            }}
          />

          {orderedNodeIds.map((id) => {
            const node = graph.nodes[id];
            if (!node) return null;
            const valid = validTargets.get(id);

            return (
              <CanvasNodeView
                key={id}
                node={node}
                selected={selectedNodes.has(id)}
                connections={connectionCount(graph, id)}
                run={runStates[id] ?? idleState()}
                typedInputPorts={typedInputFor.get(id) ?? EMPTY_PORTS}
                fileInputPorts={fileInputFor.get(id) ?? EMPTY_PORTS}
                dropTarget={dropTarget === id}
                linking={draft !== null}
                validPorts={valid ?? emptySet}
                heldPort={
                  draft?.origin.ref.nodeId === id
                    ? portKey(draft.origin.side, draft.origin.ref.portId)
                    : null
                }
                armedPort={
                  draft?.snapped?.ref.nodeId === id
                    ? portKey(draft.snapped.side, draft.snapped.ref.portId)
                    : null
                }
                refusedPort={
                  refused?.ref.nodeId === id ? portKey(refused.side, refused.ref.portId) : null
                }
                connectedPorts={connectedPorts.get(id) ?? emptySet}
                onPortPointerDown={onPortPointerDown}
              />
            );
          })}
        </div>

        {graph.nodeOrder.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>Empty canvas</p>
            {/*
              One quiet line, naming both routes in. The keyboard shortcut alone
              assumed the reader already knew there was a palette; someone
              looking at an empty grid for the first time needs the visible
              button pointed at too.
            */}
            <p>
              Press <kbd className={styles.kbd}>K</kbd> or choose{' '}
              <span className={styles.emptyStrong}>Add tool</span> to place a module.{' '}
              <kbd className={styles.kbd}>?</kbd> lists every shortcut.
            </p>
          </div>
        ) : null}

        {/*
          THE TOOLBAR
          ───────────
          Below `COMPACT_TOOLBAR` everything but "Add tool" and "Fit" moves
          into an overflow menu. Collapsing rather than shrinking: this bar is
          absolutely positioned with no right anchor, so its width was purely
          the sum of its children - at 320px it grew to 475px and put Share and
          Shortcuts off the side of the screen, unreachable by pointer or by
          Tab. It is now width-constrained as well, so nothing can escape it
          even if a label changes.
        */}
        <div className={styles.toolbar} data-canvas-chrome="toolbar">
          <Button
            size="sm"
            onClick={() => {
              setOverlay({ kind: 'palette' });
            }}
          >
            <PlusIcon size={12} /> Add tool
          </Button>

          {/*
            THE INSPECTOR TOGGLE, at every width and never in the overflow.

            It is the only way to reach the panel with a pointer, so burying it
            behind another tap on the size where the panel is hidden by default
            would make the feature undiscoverable on exactly the devices that
            start without it. `aria-pressed` rather than a changing label: the
            control is the same control in both states, and "Inspector,
            pressed" is what a screen reader should hear rather than a button
            whose name flips between "Show" and "Hide".

            Icon-only when compact, because a fourth worded button is what
            pushed this toolbar off the side of a 320px screen once already.
          */}
          {compact ? (
            <IconButton
              size="sm"
              label="Inspector"
              icon={<SlidersIcon size={12} />}
              aria-pressed={inspectorOpen}
              onClick={toggleInspector}
            />
          ) : (
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={inspectorOpen}
              onClick={toggleInspector}
            >
              <SlidersIcon size={12} /> Inspector
            </Button>
          )}

          {compact ? (
            <>
              {/* Promoted out of the overflow menu - see overflowItems above. */}
              <Button size="sm" variant="ghost" onClick={onFit}>
                Fit
              </Button>
              <OverflowMenu label="More" items={overflowItems} />
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={onFit}>
                Fit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  store.getState().undo();
                }}
              >
                Undo
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  store.getState().redo();
                }}
              >
                Redo
              </Button>
              {/*
                The privacy note is the SHARE button's own description rather
                than a sibling in the button row. It used to sit between Share
                and Shortcuts as a 190px block of wrapped text, crowding both
                and taking width the controls needed. Now it is announced with
                the button and revealed under the toolbar on hover or focus, so
                it can never overlap a control at any width.
              */}
              <span className={styles.shareWrap}>
                <Button size="sm" variant="ghost" aria-describedby={shareNoteId} onClick={onShare}>
                  <CopyIcon size={12} /> Share
                </Button>
                <span className={styles.shareNote} id={shareNoteId} role="note">
                  {SHARE_NOTE}
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setOverlay({ kind: 'shortcuts' });
                }}
              >
                <SearchIcon size={12} /> Shortcuts
              </Button>
            </>
          )}
        </div>

        {/*
          THE READOUT
          ───────────
          Each item is its own inline-flex box. They used to be plain spans, and
          `reset.css` makes every svg `display: block` - a block child inside an
          inline span pushes the text after it onto a second line, which is why
          "5 nodes" drew a row below "1 wires  idle  100%" inside a 32px box and
          read as overlapping.
        */}
        <div className={styles.readout} data-canvas-chrome="readout" data-testid="canvas-readout">
          <span className={styles.readoutItem}>
            <SignalIcon size={10} />
            {counted(graph.nodeOrder.length, 'node')}
          </span>
          <span className={styles.readoutItem}>{counted(graph.edgeOrder.length, 'wire')}</span>
          <span className={styles.readoutItem}>{pipelineRunning ? 'running' : 'idle'}</span>
          {/*
            HOW SEVERAL FAILURES AT ONCE ARE SURFACED.
            ─────────────────────────────────────────
            Each failing node shows its own message, which is right - the message
            belongs beside the thing it is about - but on a graph big enough to
            need scrolling that is a message you cannot see. This is a COUNT, not
            a copy of the messages: enough to know something broke and to go
            looking, without a second place where errors are worded.

            Errors only. Blocked nodes are the normal state of a pipeline you are
            still wiring up, and a chrome that shouts about them is a chrome
            people learn to ignore.
          */}
          {failedCount > 0 ? (
            <span className={cx(styles.readoutItem, styles.readoutFailed)}>
              {failedCount.toString()} failed
            </span>
          ) : null}
          {/*
            A real control, not a label that looks like one. It sat in a
            bordered, raised box with the rest of the readout and did nothing;
            now it does what the 0 shortcut does, and says so.
          */}
          <button
            type="button"
            className={styles.readoutZoom}
            aria-label={zoomResetLabel}
            onClick={onResetZoom}
          >
            {zoomPercent}%{zoomLimit}
          </button>
        </div>

        {overlay.kind === 'palette' ? (
          <CommandDialog
            title="Add a tool"
            searchLabel="Search tools"
            placeholder="base64, yaml, convert…"
            options={paletteOptions}
            groups={PALETTE_GROUPS}
            emptyMessage="No tools are available."
            onClose={closeOverlay}
            onChoose={(id) => {
              closeOverlay();
              if (id.startsWith('preset:')) {
                addPreset(id.slice('preset:'.length));
                return;
              }
              addTool(id as ToolId);
            }}
          />
        ) : null}

        {overlay.kind === 'choose-port' ? (
          <CommandDialog
            title="Connect from which port?"
            searchLabel="Search ports"
            placeholder="Filter ports"
            options={portOptions}
            groups={PORT_GROUPS}
            emptyMessage="This tool has no ports."
            onClose={closeOverlay}
            onChoose={(id) => {
              const origin = decodeEnd(id);
              if (origin) setOverlay({ kind: 'choose-partner', origin });
            }}
          />
        ) : null}

        {overlay.kind === 'choose-partner' ? (
          <CommandDialog
            title={
              overlay.origin.side === 'output'
                ? 'Connect to which input?'
                : 'Connect from which output?'
            }
            searchLabel="Search valid ports"
            placeholder="Filter ports"
            options={partnerOptions}
            groups={PARTNER_GROUPS}
            emptyMessage={
              overlay.origin.side === 'output'
                ? 'Nothing on the canvas can accept this output yet.'
                : 'Nothing on the canvas can feed this input yet.'
            }
            onClose={closeOverlay}
            onChoose={(id) => {
              const partner = decodeEnd(id);
              closeOverlay();
              if (!partner) return;
              // Oriented through the same helper the pointer drop uses, so the
              // two routes cannot disagree about which end is which.
              const oriented = orientEnds(overlay.origin, partner);
              if (oriented) tryConnect(oriented.from, oriented.to);
            }}
          />
        ) : null}

        {overlay.kind === 'shortcuts' ? <ShortcutsOverlay onClose={closeOverlay} /> : null}
      </div>

      {/*
        THE RAIL'S SIZE HANDLE.

        Only present above the breakpoint, where the inspector is a rail
        beside the canvas rather than a sheet over it - there is nothing to
        resize when the panel is the full width of the screen.
      */}
      {inspectorOpen && railFits ? (
        <button
          type="button"
          className={inspectorStyles.handle}
          /*
           * A <button> carrying `role="separator"`, rather than a div with a
           * tabindex. The ARIA window-splitter pattern wants a focusable
           * separator with a value; a native button is what gives it real
           * focus, real activation and a real place in the tab order without
           * any of that being hand-rolled. The role overrides the button's
           * own, which is the point - this is a splitter, not a command.
           */
          role="separator"
          aria-orientation="vertical"
          aria-label="Inspector width"
          aria-valuenow={railWidth}
          aria-valuemin={RAIL_MIN}
          aria-valuemax={RAIL_MAX}
          onPointerDown={onHandlePointerDown}
          onKeyDown={onHandleKeyDown}
          data-testid="inspector-handle"
        />
      ) : null}

      {inspectorOpen ? (
        <NodeInspector
          target={inspectorTarget}
          selectedIds={selection.nodes}
          selectedLabels={selectedLabels}
          onEscape={onInspectorEscape}
          onSelectOnly={(id) => {
            store.getState().select({ nodes: [id], edges: [] });
          }}
          onInputChange={onInputChange}
          onFileChange={onFileChange}
          onOptionChange={onOptionChange}
          onClose={() => {
            /*
             * Closing does NOT clear the selection. The two are separate
             * facts - what you are working on, and whether the panel that
             * shows it is on screen - and collapsing them would mean the
             * only way to get the canvas's full width back was to deselect
             * the node you were about to move.
             */
            setInspectorOpen(false);
            rootRef.current?.focus();
          }}
          onOrphaned={onInspectorOrphaned}
          hasNodes={graph.nodeOrder.length > 0}
        />
      ) : null}
    </div>
  );
}

export { checkConnection };
