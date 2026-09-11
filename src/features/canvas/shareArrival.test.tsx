import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import { usePipelineStore } from '@/features/execution/pipelineStore';
import { EMPTY_ANNOUNCEMENTS } from '@/lib/announce';

import { Canvas } from './Canvas';
import { firstTypedInputNode } from './geometry';
import { useCanvasStore } from './graphStore';
import { INSPECTOR_STORAGE_KEY } from './inspectorPreference';
import { encodeGraphToParam } from './share';
import { EMPTY_GRAPH, type CanvasEdge, type CanvasNode, type GraphData } from './types';
import { DEFAULT_VIEWPORT, useViewportStore } from './viewportStore';

/**
 * ARRIVING BY SHARE LINK.
 *
 * THE MOMENT THIS IS ABOUT. A link's graph lands correctly framed and
 * completely inert: a share link carries no data, so every node reads BLOCKED,
 * and since input moved into the inspector there is nothing on the canvas that
 * says where a value goes. With the inspector closed - which is its default,
 * and the right default for an EMPTY canvas - the first thing a link showed you
 * was a picture of a pipeline and no way into it.
 *
 * WHY THIS IS NOT THE DECISION IT LOOKS LIKE IT REVERSES. The inspector starts
 * closed because a first-time visitor on an empty canvas was being shown an
 * empty panel whose only message was that there was nothing to inspect. A
 * pipeline somebody deliberately sent you is the opposite case in the one
 * respect that matters: it is nothing BUT something to inspect. So the two
 * arrivals are told apart here, and the saved-canvas path is asserted to still
 * respect what the user last chose.
 */

function renderCanvas(shareParam?: string) {
  return render(
    <ToastProvider>
      <Canvas shareParam={shareParam} />
    </ToastProvider>,
  );
}

function node(id: string, toolId: CanvasNode['toolId'], x = 0, y = 0): CanvasNode {
  return { id, toolId, position: { x, y }, options: {}, inputs: {}, fileInputs: {} };
}

function graphOf(nodes: readonly CanvasNode[], edges: readonly CanvasEdge[] = []): GraphData {
  return {
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    nodeOrder: nodes.map((entry) => entry.id),
    edges: Object.fromEntries(edges.map((entry) => [entry.id, entry])),
    edgeOrder: edges.map((entry) => entry.id),
    nextId: nodes.length + edges.length + 1,
  };
}

function wire(id: string, from: string, to: string): CanvasEdge {
  return { id, from: { nodeId: from, portId: 'output' }, to: { nodeId: to, portId: 'input' } };
}

/** Pretends the viewport is wide enough for the docked rail. */
function withRail(): void {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query.includes('min-width: 1000px'),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

/**
 * The two-node chain the cold open's own links carry: a source that takes typed
 * text, feeding something that does not.
 */
const CHAIN = graphOf(
  [node('n1', 'base64', 80, 80), node('n2', 'structured-data', 400, 80)],
  [wire('e1', 'n1', 'n2')],
);

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  usePipelineStore.getState().reset();
  useCanvasStore.setState({
    graph: EMPTY_GRAPH,
    selection: { nodes: [], edges: [] },
    past: [],
    future: [],
    pendingMove: null,
    ...EMPTY_ANNOUNCEMENTS,
  });
  useViewportStore.setState({ viewport: DEFAULT_VIEWPORT, isPanning: false });
});

describe('which node the panel opens on', () => {
  it('is the first one there is something to type into', () => {
    /*
     * SPATIAL order, not `nodeOrder`. The order nodes were created in is the
     * author's history and means nothing to the person opening their link; the
     * leftmost node of a left-to-right chain is the one they are already
     * reading as the start. So a link whose author built the chain backwards
     * still opens on the node at the left.
     */
    const backwards = graphOf(
      [node('n1', 'structured-data', 400, 80), node('n2', 'base64', 80, 80)],
      [wire('e1', 'n2', 'n1')],
    );

    expect(firstTypedInputNode(backwards)).toBe('n2');
  });

  it('skips a node whose every input is already wired', () => {
    // Such a node has no editor in the inspector, so landing on it would open
    // the panel onto the same nothing this exists to fix.
    expect(firstTypedInputNode(CHAIN)).toBe('n1');
  });

  it('falls back to the first node when nothing takes typed input', () => {
    const wired = graphOf(
      [node('n1', 'base64', 0, 0), node('n2', 'base64', 200, 0)],
      [wire('e1', 'n1', 'n2')],
    );

    // n1's own input is unwired, so it wins - but the contract that matters is
    // that a graph with no typed input anywhere still names a node rather than
    // returning null and leaving the panel shut.
    expect(firstTypedInputNode(wired)).toBe('n1');
    expect(firstTypedInputNode(EMPTY_GRAPH)).toBeNull();
  });
});

describe('a share link', () => {
  it('opens the inspector on the first node', async () => {
    withRail();
    const param = await encodeGraphToParam(CHAIN);

    renderCanvas(param);

    const panel = await screen.findByTestId('node-inspector');
    // The panel is open AND pointed at something: an open panel reporting that
    // no node is selected would be the empty-canvas failure all over again.
    expect(panel).toBeInTheDocument();
    await waitFor(() => {
      expect(useCanvasStore.getState().selection.nodes).toEqual(['n1']);
    });
  });

  it('says so in the live region, since the panel opening is not announced', async () => {
    withRail();
    renderCanvas(await encodeGraphToParam(CHAIN));

    await waitFor(() => {
      const announced = useCanvasStore
        .getState()
        .announcementLog.map((entry) => entry.text)
        .join(' ');
      expect(announced).toContain('the inspector is open on the first one');
    });
  });

  it('does not move focus into the panel', async () => {
    /*
     * DELIBERATELY NOT, and this is the assertion rather than an omission. The
     * open happens in a promise callback - a page load, not a keystroke - and a
     * focus move from a deferred task landing in the middle of whatever the
     * user did next is the most-repeated defect in this repository. The panel
     * being open is the signpost; Tab or Enter stays the user's move.
     */
    withRail();
    renderCanvas(await encodeGraphToParam(CHAIN));

    const panel = await screen.findByTestId('node-inspector');
    await waitFor(() => {
      expect(useCanvasStore.getState().selection.nodes).toEqual(['n1']);
    });

    expect(panel.contains(document.activeElement)).toBe(false);
  });

  it('opens the sheet below the rail breakpoint too', async () => {
    /*
     * No `withRail`, so jsdom's non-matching `matchMedia` puts the inspector in
     * its phone shape - a sheet over the canvas. The reasoning does not change
     * with the viewport: the problem is that nothing says where to type, and
     * that is true on a phone as well.
     */
    renderCanvas(await encodeGraphToParam(CHAIN));

    expect(await screen.findByTestId('node-inspector')).toBeInTheDocument();
  });

  it(`leaves a rejected link untouched`, async () => {
    withRail();
    renderCanvas('this-is-not-a-payload');

    await waitFor(() => {
      expect(screen.getByText('Shared link rejected')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('node-inspector')).not.toBeInTheDocument();
  });
});

describe('a restored save', () => {
  it('still starts with the inspector closed', async () => {
    /*
     * The other half of the decision. A save's reader has already answered the
     * open-or-closed question and `inspectorPreference` remembers it; a panel
     * that reopened itself on every reload is what starting closed was about.
     * Only a LINK overrides it.
     */
    withRail();
    useCanvasStore.setState({ graph: CHAIN });

    renderCanvas();

    await waitFor(() => {
      expect(screen.getByTestId('canvas-root')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('node-inspector')).not.toBeInTheDocument();
  });

  it('reopens it when that is what the reader last chose', async () => {
    withRail();
    window.localStorage.setItem(INSPECTOR_STORAGE_KEY, 'open');
    useCanvasStore.setState({ graph: CHAIN });

    renderCanvas();

    expect(await screen.findByTestId('node-inspector')).toBeInTheDocument();
  });
});
