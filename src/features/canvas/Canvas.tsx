import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/Button';
import { CopyIcon, PlusIcon, SearchIcon, SignalIcon } from '@/components/Icon';
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
import { counted } from '@/lib/plural';
import { useMediaQuery } from '@/lib/useMediaQuery';

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
import {
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
import { OverflowMenu, type OverflowItem } from './OverflowMenu';
import { createDebouncedSaver, loadGraph } from './persistence';
import { PIPELINE_PRESETS } from './presets';
import { buildShareUrl, decodeParamToGraph } from './share';
import { CANVAS_DESCRIPTION } from './shortcuts';
import { ShortcutsOverlay } from './ShortcutsOverlay';
import { toWorld, useViewportStore } from './viewportStore';
import { Wires } from './Wires';

import type { GraphData, NodeId, Point, PortRef } from './types';

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
  const descriptionId = useId();

  const graph = useCanvasStore((state) => state.graph);
  const selection = useCanvasStore((state) => state.selection);
  const announcement = useCanvasStore((state) => state.announcement);
  const store = useCanvasStore;

  const viewport = useViewportStore((state) => state.viewport);
  const isPanning = useViewportStore((state) => state.isPanning);

  const { notify } = useToast();
  const [overlay, setOverlay] = useState<Overlay>({ kind: 'none' });
  const [spacePressed, setSpacePressed] = useState(false);
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
  const pipelineAnnouncement = usePipelineStore((state) => state.announcement);

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

  // Pipeline messages go to the canvas's single live region rather than a
  // second one, so nothing competes to be read out.
  const lastPipelineSeq = useRef(0);
  useEffect(() => {
    if (pipelineAnnouncement.seq === lastPipelineSeq.current) return;
    lastPipelineSeq.current = pipelineAnnouncement.seq;
    if (pipelineAnnouncement.text !== '') store.getState().announce(pipelineAnnouncement.text);
  }, [pipelineAnnouncement, store]);

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

    // The refusal marker is transient: it explains one drop, then gets out of
    // the way at the next thing the user does.
    setRefused(null);

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
     * When the caret is in a node's input, the keyboard belongs to the text -
     * otherwise typing "k" would open the palette and Delete would remove the
     * node being edited. Escape is the one key still handled here, to step
     * back out to the node.
     */
    const target = event.target;
    const editing =
      target instanceof HTMLElement &&
      (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);

    if (editing) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      target.closest<HTMLElement>('[data-node-id]')?.focus();
      return;
    }

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
        // Step into this node's input editor, if it has one.
        const field = rootRef.current?.querySelector<HTMLTextAreaElement>(
          `[data-node-id="${focused}"] [data-node-input]`,
        );
        if (field) {
          event.preventDefault();
          field.focus();
        }
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
  const handlers = useRef({ onPointerDown, onPointerMove, onPointerUp, onKeyDown, onKeyUp });

  useEffect(() => {
    handlers.current = { onPointerDown, onPointerMove, onPointerUp, onKeyDown, onKeyUp };
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

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
    };
  }, []);

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
  const overflowItems: readonly OverflowItem[] = useMemo(
    () => [
      { id: 'fit', label: 'Fit', onSelect: onFit },
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
    [onFit, onShare, store],
  );

  return (
    <div
      ref={rootRef}
      className={cx(styles.root, isPanning && styles.panning, spacePressed && styles.panReady)}
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
      */}
      <VisuallyHidden as="div">
        <span role="status" aria-live="polite" data-testid="canvas-announcer">
          {announcement.text}
        </span>
      </VisuallyHidden>

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
              onInputChange={onInputChange}
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
        Below `COMPACT_TOOLBAR` everything but "Add tool" moves into an
        overflow menu. Collapsing rather than shrinking: this bar is
        absolutely positioned with no right anchor, so its width was purely
        the sum of its children - at 320px it grew to 475px and put Share and
        Shortcuts off the side of the screen, unreachable by pointer or by
        Tab. It is now width-constrained as well, so nothing can escape it
        even if a label changes.
      */}
      <div className={styles.toolbar}>
        <Button
          size="sm"
          onClick={() => {
            setOverlay({ kind: 'palette' });
          }}
        >
          <PlusIcon size={12} /> Add tool
        </Button>

        {compact ? (
          <OverflowMenu label="More" items={overflowItems} />
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
      <div className={styles.readout} data-testid="canvas-readout">
        <span className={styles.readoutItem}>
          <SignalIcon size={10} />
          {counted(graph.nodeOrder.length, 'node')}
        </span>
        <span className={styles.readoutItem}>{counted(graph.edgeOrder.length, 'wire')}</span>
        <span className={styles.readoutItem}>{pipelineRunning ? 'running' : 'idle'}</span>
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
  );
}

export { checkConnection };
