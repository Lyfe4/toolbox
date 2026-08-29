import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/Button';
import { CopyIcon, PlusIcon, SearchIcon, SignalIcon } from '@/components/Icon';
import { useToast } from '@/components/Toast';
import { VisuallyHidden } from '@/components/VisuallyHidden';
import { idleState } from '@/features/execution/graph';
import { usePipelineStore } from '@/features/execution/pipelineStore';
import { getManifestEntry, TOOL_MANIFEST, type ToolId } from '@/features/registry';
import { cx } from '@/lib/cx';

import styles from './canvas.module.css';
import { CanvasNodeView } from './CanvasNodeView';
import { CommandDialog, type DialogOption } from './CommandDialog';
import { checkConnection, connectionCount, validTargetsFor } from './connections';
import {
  GRID,
  MAX_ZOOM,
  MIN_ZOOM,
  NODE_WIDTH,
  nodeTakesTypedInput,
  spatialOrder,
} from './geometry';
import { useCanvasStore } from './graphStore';
import { createDebouncedSaver, loadGraph } from './persistence';
import { PIPELINE_PRESETS } from './presets';
import { buildShareUrl, decodeParamToGraph } from './share';
import { CANVAS_DESCRIPTION } from './shortcuts';
import { ShortcutsOverlay } from './ShortcutsOverlay';
import { toWorld, useViewportStore } from './viewportStore';
import { Wires } from './Wires';

import type { NodeId, Point, PortRef } from './types';

/** Which overlay, if any, is open. */
type Overlay =
  | { readonly kind: 'none' }
  | { readonly kind: 'palette' }
  | { readonly kind: 'shortcuts' }
  | { readonly kind: 'choose-output'; readonly nodeId: NodeId }
  | { readonly kind: 'choose-target'; readonly from: PortRef };

const NUDGE = GRID;
const BIG_NUDGE = GRID * 8;

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
  const [draft, setDraft] = useState<{ from: PortRef; at: Point } | null>(null);

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

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

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
    };
  }, [schedule]);

  /* ---------------------------------------------------------------------- *
   * Pointer interactions
   * ---------------------------------------------------------------------- */

  const dragging = useRef<
    | { readonly kind: 'pan'; readonly last: Point }
    | { readonly kind: 'node'; readonly origin: Point }
    | { readonly kind: 'wire'; readonly from: PortRef }
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

  const onPortPointerDown = useCallback((ref: PortRef, side: 'input' | 'output') => {
    // Wires are drawn from outputs. Grabbing an input is a no-op rather than
    // a confusing backwards drag.
    if (side !== 'output') return;
    dragging.current = { kind: 'wire', from: ref };
    setDraft({ from: ref, at: { x: 0, y: 0 } });
  }, []);

  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;

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

    setDraft({ from: current.from, at: screenToWorld(event) });
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
      // Hit-test what is under the pointer rather than relying on enter/leave
      // events, which a fast drag can miss entirely.
      const dropped = document.elementFromPoint(event.clientX, event.clientY);
      const port = dropped?.closest('[data-port-side="input"]');
      const node = port?.closest('[data-node-id]');
      const nodeId = node?.getAttribute('data-node-id');
      const portId = port?.getAttribute('data-port-id');

      if (nodeId && portId) {
        tryConnect(current.from, { nodeId, portId });
      }
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
    (nodeId: string, value: string) => {
      store.getState().setNodeInput(nodeId, value);
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
        .addNode(toolId, { x: centre.x - NODE_WIDTH / 2, y: centre.y - 60 });

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
      const centre = toWorld(
        { x: (rect?.width ?? 800) / 2, y: (rect?.height ?? 600) / 2 },
        useViewportStore.getState().viewport,
      );
      // Placed left of centre so a two- or three-node chain lands in view.
      store.getState().applyPreset(presetId, { x: centre.x - NODE_WIDTH, y: centre.y - 80 });
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

  const beginConnectFrom = useCallback(
    (nodeId: NodeId) => {
      const node = store.getState().graph.nodes[nodeId];
      if (!node) return;

      const entry = getManifestEntry(node.toolId);
      const only = entry.outputs.length === 1 ? entry.outputs[0] : undefined;

      // One output means there is nothing to choose; skip straight to targets.
      setOverlay(
        only
          ? { kind: 'choose-target', from: { nodeId, portId: only.id } }
          : { kind: 'choose-output', nodeId },
      );
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
      out.add(`out:${edge.from.portId}`);
      map.set(edge.from.nodeId, out);
      const into = map.get(edge.to.nodeId) ?? new Set<string>();
      into.add(`in:${edge.to.portId}`);
      map.set(edge.to.nodeId, into);
    }
    return map;
  }, [graph]);

  /** While a wire is in flight, which input ports could accept it. */
  const validTargets = useMemo(() => {
    if (!draft) return new Map<NodeId, Set<string>>();
    const map = new Map<NodeId, Set<string>>();
    for (const target of validTargetsFor(graph, draft.from)) {
      const ports = map.get(target.nodeId) ?? new Set<string>();
      ports.add(target.portId);
      map.set(target.nodeId, ports);
    }
    return map;
  }, [draft, graph]);

  const selectedNodes = useMemo(() => new Set(selection.nodes), [selection.nodes]);

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

  const draftPath = useMemo(() => {
    if (!draft) return null;
    const node = graph.nodes[draft.from.nodeId];
    if (!node) return null;
    const entry = getManifestEntry(node.toolId);
    const index = entry.outputs.findIndex((port) => port.id === draft.from.portId);
    if (index === -1) return null;
    return {
      from: { x: node.position.x + NODE_WIDTH, y: node.position.y + 64 + index * 24 },
      to: draft.at,
    };
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
        meta: 'pipeline',
        detail: preset.summary,
        group: 'Pipelines',
      })),
      ...TOOL_MANIFEST.map((entry) => ({
        id: entry.id,
        name: entry.name,
        meta: entry.category,
        detail: entry.summary,
        group: entry.category,
      })),
    ],
    [],
  );

  const outputOptions: readonly DialogOption[] = useMemo(() => {
    if (overlay.kind !== 'choose-output') return [];
    const node = graph.nodes[overlay.nodeId];
    if (!node) return [];
    return getManifestEntry(node.toolId).outputs.map((port) => ({
      id: port.id,
      name: port.label,
      meta: 'out',
      detail: port.types.join(' or '),
      group: 'Outputs',
    }));
  }, [overlay, graph]);

  const targetOptions: readonly DialogOption[] = useMemo(() => {
    if (overlay.kind !== 'choose-target') return [];
    return validTargetsFor(graph, overlay.from).map((target) => ({
      id: `${target.nodeId}:${target.portId}`,
      name: `${target.nodeLabel} - ${target.portLabel}`,
      meta: 'in',
      detail: target.types.join(' or '),
      group: 'Valid targets',
    }));
  }, [overlay, graph]);

  const closeOverlay = useCallback(() => {
    setOverlay({ kind: 'none' });
    rootRef.current?.focus();
  }, []);

  /* ---------------------------------------------------------------------- */

  const zoomPercent = Math.round(viewport.zoom * 100);

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
          backgroundSize: `${(GRID * viewport.zoom).toString()}px ${(GRID * viewport.zoom).toString()}px, ${(GRID * viewport.zoom).toString()}px ${(GRID * viewport.zoom).toString()}px, ${(GRID * 8 * viewport.zoom).toString()}px ${(GRID * 8 * viewport.zoom).toString()}px, ${(GRID * 8 * viewport.zoom).toString()}px ${(GRID * 8 * viewport.zoom).toString()}px`,
          backgroundPosition: `${viewport.x.toString()}px ${viewport.y.toString()}px`,
          // Fade the dense grid out when it would turn into a solid wash.
          opacity: viewport.zoom < 0.5 ? 0.4 : 1,
        }}
      />

      <div
        className={styles.plane}
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
              acceptsTypedInput={nodeTakesTypedInput(graph, node)}
              linkState={draft === null ? 'none' : valid && valid.size > 0 ? 'valid' : 'invalid'}
              validInputPorts={valid ?? emptySet}
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
          <p>
            Press <kbd className={styles.kbd}>K</kbd> to add a tool, or{' '}
            <kbd className={styles.kbd}>?</kbd> for every shortcut.
          </p>
        </div>
      ) : null}

      <div className={styles.toolbar}>
        <Button
          size="sm"
          onClick={() => {
            setOverlay({ kind: 'palette' });
          }}
        >
          <PlusIcon size={12} /> Add tool
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const rect = rootRef.current?.getBoundingClientRect();
            useViewportStore.getState().fitToContent(graph, {
              width: rect?.width ?? 800,
              height: rect?.height ?? 600,
            });
          }}
        >
          Fit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const rect = rootRef.current?.getBoundingClientRect();
            useViewportStore
              .getState()
              .resetZoom({ x: (rect?.width ?? 800) / 2, y: (rect?.height ?? 600) / 2 });
          }}
        >
          100%
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
        <Button size="sm" variant="ghost" onClick={onShare}>
          <CopyIcon size={12} /> Share
        </Button>
        <span className={styles.shareNote}>Link holds structure only, never your input</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setOverlay({ kind: 'shortcuts' });
          }}
        >
          <SearchIcon size={12} /> Shortcuts
        </Button>
      </div>

      <p className={styles.readout}>
        <span>
          <SignalIcon size={10} /> {graph.nodeOrder.length} nodes
        </span>
        <span>{graph.edgeOrder.length} wires</span>
        <span>{pipelineRunning ? 'running' : 'idle'}</span>
        <span>
          {zoomPercent}%{' '}
          {viewport.zoom <= MIN_ZOOM ? 'min' : viewport.zoom >= MAX_ZOOM ? 'max' : ''}
        </span>
      </p>

      {overlay.kind === 'palette' ? (
        <CommandDialog
          title="Add a tool"
          searchLabel="Search tools"
          placeholder="base64, yaml, convert…"
          options={paletteOptions}
          emptyMessage="No tool matches that."
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

      {overlay.kind === 'choose-output' ? (
        <CommandDialog
          title="Connect from which output?"
          searchLabel="Search outputs"
          placeholder="Filter outputs"
          options={outputOptions}
          emptyMessage="This tool has no outputs."
          onClose={closeOverlay}
          onChoose={(portId) => {
            setOverlay({ kind: 'choose-target', from: { nodeId: overlay.nodeId, portId } });
          }}
        />
      ) : null}

      {overlay.kind === 'choose-target' ? (
        <CommandDialog
          title="Connect to which input?"
          searchLabel="Search valid targets"
          placeholder="Filter targets"
          options={targetOptions}
          emptyMessage="Nothing on the canvas can accept this output yet."
          onClose={closeOverlay}
          onChoose={(id) => {
            const [nodeId, portId] = id.split(':');
            closeOverlay();
            if (nodeId && portId) tryConnect(overlay.from, { nodeId, portId });
          }}
        />
      ) : null}

      {overlay.kind === 'shortcuts' ? <ShortcutsOverlay onClose={closeOverlay} /> : null}
    </div>
  );
}

export { checkConnection };
