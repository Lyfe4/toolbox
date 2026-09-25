import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import { usePipelineStore } from '@/features/execution/pipelineStore';
import { EMPTY_ANNOUNCEMENTS } from '@/lib/announce';

import { Canvas } from './Canvas';
import styles from './canvas.module.css';
import { useCanvasStore } from './graphStore';
import { countUpText, formatDuration, freshArrivals, motionMs, NO_FRESH_ARRIVALS } from './motion';
import { NodeTiming } from './NodeTiming';
import { DEFAULT_VIEWPORT, useViewportStore } from './viewportStore';

import type { CanvasNode, GraphData } from './types';

/**
 * THE CANVAS'S MOTION, AS FAR AS A DOCUMENT WITHOUT A CLOCK CAN SEE IT.
 *
 * jsdom runs no CSS animations and has no layout, so nothing here can say that
 * a wire draws or a node settles - `checkCanvasMotion` in cross-browser-check.mjs
 * samples real frames for that, including the reduced-motion path. What this
 * file holds is the part that decides WHEN: which actions are an arrival and
 * which are not, that typing disarms the count, that coming back to the canvas
 * replays nothing, and what the count shows at each point of the way.
 */

function node(id: string, toolId: CanvasNode['toolId'], x = 0, y = 0): CanvasNode {
  return { id, toolId, position: { x, y }, options: {}, inputs: {}, fileInputs: {} };
}

function graphOf(nodes: readonly CanvasNode[]): GraphData {
  return {
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    nodeOrder: nodes.map((n) => n.id),
    edges: {},
    edgeOrder: [],
    nextId: 10,
  };
}

function seed(nodes: readonly CanvasNode[] = []): void {
  usePipelineStore.getState().reset();
  useCanvasStore.setState({
    graph: graphOf(nodes),
    selection: { nodes: [], edges: [] },
    past: [],
    future: [],
    pendingMove: null,
    ...EMPTY_ANNOUNCEMENTS,
  });
  useViewportStore.setState({ viewport: DEFAULT_VIEWPORT, isPanning: false });
}

/** Stubs `matchMedia` so the reduced-motion query answers `reduced`. */
function preferReducedMotion(reduced: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: reduced && query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        onchange: null,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.documentElement.style.removeProperty('--pb-motion-fast');
});

describe('the count-up text', () => {
  it('starts at zero in the final figure’s own unit', () => {
    expect(countUpText(12, 0)).toBe('0ms');
    expect(countUpText(1234, 0)).toBe('0.00s');
  });

  it('ends on exactly the figure the node shows at rest', () => {
    for (const ms of [1, 1.4, 7, 12.6, 999.4, 1000, 1234, 61_234]) {
      expect(countUpText(ms, 1)).toBe(formatDuration(ms));
    }
  });

  it('never goes backwards and never shows the answer early, across a fine sweep', () => {
    // A fixed stride rather than random draws, so this passes or fails for
    // everybody - see CONTRIBUTING on intermittent property tests.
    for (const ms of [1, 2, 3, 8, 12, 99, 250, 999, 1000, 1500, 12_345]) {
      const final = formatDuration(ms);
      let previous = -1;
      for (let step = 0; step < 200; step += 1) {
        const text = countUpText(ms, step / 200);
        const value = Number.parseFloat(text);
        expect(value).toBeGreaterThanOrEqual(previous);
        // Same unit as the final figure all the way.
        expect(text.endsWith('ms')).toBe(final.endsWith('ms'));
        if (step < 199 && Math.round(ms) > 1) expect(text).not.toBe(final);
        previous = value;
      }
    }
  });

  it('has nothing to count under a millisecond', () => {
    expect(countUpText(0.4, 0)).toBe('<1ms');
    expect(countUpText(0.4, 0.5)).toBe('<1ms');
  });
});

describe('reading a motion token', () => {
  it('reads what the build actually hands back, not only what semantic.css says', () => {
    // The minifier writes 120ms as .12s, and that is what getComputedStyle
    // returns in both engines. The first version refused it.
    expect(motionMs('.12s')).toBe(120);
    expect(motionMs('120ms')).toBe(120);
    expect(motionMs(' 0.15s ')).toBe(150);
    expect(motionMs('1ms')).toBe(1);
  });

  it('refuses anything it would have to guess at', () => {
    expect(motionMs('')).toBeNull();
    expect(motionMs('var(--raw-duration-fast)')).toBeNull();
    expect(motionMs('120')).toBeNull();
    expect(motionMs('calc(120ms * 2)')).toBeNull();
  });
});

describe('which arrival is news', () => {
  const arrival = {
    seq: 3,
    nodes: ['n2'],
    edges: [
      {
        id: 'e1',
        from: { nodeId: 'n1', portId: 'output' },
        to: { nodeId: 'n2', portId: 'input' },
      },
    ],
  };

  it('resolves a new wire to the port at each end of it', () => {
    const fresh = freshArrivals(arrival, 0, false);
    expect([...fresh.edges]).toEqual(['e1']);
    expect([...fresh.nodes]).toEqual(['n2']);
    expect(fresh.ports.get('n1')).toEqual({ seq: 3, keys: new Set(['output:output']) });
    expect(fresh.ports.get('n2')).toEqual({ seq: 3, keys: new Set(['input:input']) });
  });

  it('is nothing at all for an arrival the canvas found when it mounted', () => {
    expect(freshArrivals(arrival, 3, false)).toBe(NO_FRESH_ARRIVALS);
  });

  it('is nothing at all under reduced motion', () => {
    expect(freshArrivals(arrival, 0, true)).toBe(NO_FRESH_ARRIVALS);
  });
});

describe('the store writes an arrival only for things that are new', () => {
  beforeEach(() => {
    seed([node('a', 'base64', 0, 0), node('b', 'hash', 400, 0)]);
  });

  it('adding a node, a duplicate and a wire are each one arrival', () => {
    const store = useCanvasStore.getState();
    const before = store.arrivals.seq;

    const id = store.addNode('base64', { x: 0, y: 300 });
    expect(useCanvasStore.getState().arrivals).toMatchObject({
      seq: before + 1,
      nodes: [id],
      edges: [],
    });
    expect(useCanvasStore.getState().countArmed).toEqual([id]);

    useCanvasStore.getState().duplicateSelection();
    const duplicated = useCanvasStore.getState().arrivals;
    expect(duplicated.seq).toBe(before + 2);
    expect(duplicated.nodes).toHaveLength(1);
    expect(duplicated.nodes[0]).not.toBe(id);

    useCanvasStore
      .getState()
      .connect({ nodeId: 'a', portId: 'output' }, { nodeId: 'b', portId: 'input' });
    const wired = useCanvasStore.getState();
    expect(wired.arrivals.seq).toBe(before + 3);
    expect(wired.arrivals.nodes).toEqual([]);
    expect(wired.arrivals.edges.map((edge) => edge.to)).toEqual([{ nodeId: 'b', portId: 'input' }]);
    // The node the wire lands on is the one that runs because of it.
    expect(wired.countArmed).toEqual(['b']);
  });

  it('a refused wire is not an arrival', () => {
    const store = useCanvasStore.getState();
    store.connect({ nodeId: 'a', portId: 'output' }, { nodeId: 'b', portId: 'input' });
    const seq = useCanvasStore.getState().arrivals.seq;
    // The same input a second time is occupied, and refused.
    const refused = useCanvasStore
      .getState()
      .connect({ nodeId: 'a', portId: 'output' }, { nodeId: 'b', portId: 'input' });
    expect(refused.ok).toBe(false);
    expect(useCanvasStore.getState().arrivals.seq).toBe(seq);
  });

  it('undo, redo and a replaced document retire the arrival rather than repeat it', () => {
    const store = useCanvasStore.getState();
    store.addNode('base64', { x: 0, y: 300 });

    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().arrivals).toMatchObject({ nodes: [], edges: [] });
    useCanvasStore.getState().redo();
    // The node is back, and it did not ARRIVE: nothing settles on a redo.
    expect(useCanvasStore.getState().arrivals).toMatchObject({ nodes: [], edges: [] });
    expect(useCanvasStore.getState().countArmed).toEqual([]);

    useCanvasStore.getState().addNode('hash', { x: 0, y: 600 });
    useCanvasStore.getState().replaceGraph(graphOf([node('n1', 'base64')]));
    expect(useCanvasStore.getState().arrivals).toMatchObject({ nodes: [], edges: [] });
  });

  it('any typed value disarms every pending count, and changes nothing else', () => {
    const store = useCanvasStore.getState();
    store.connect({ nodeId: 'a', portId: 'output' }, { nodeId: 'b', portId: 'input' });
    const arrivals = useCanvasStore.getState().arrivals;
    expect(useCanvasStore.getState().countArmed).toEqual(['b']);

    // Typing into a DIFFERENT node than the armed one still disarms it: its
    // run would be caused by the keystroke upstream.
    useCanvasStore.getState().setNodeInput('a', 'input', 'h');
    expect(useCanvasStore.getState().countArmed).toEqual([]);
    // The arrival itself is untouched, so a wire mid-draw is not restarted.
    expect(useCanvasStore.getState().arrivals).toBe(arrivals);

    // An option edit and a file disarm as well.
    useCanvasStore.setState({ countArmed: ['b'] });
    useCanvasStore.getState().setNodeOptions('b', { algorithm: 'SHA-1' }, true);
    expect(useCanvasStore.getState().countArmed).toEqual([]);
    useCanvasStore.setState({ countArmed: ['b'] });
    useCanvasStore.getState().setNodeFile('a', 'input', null);
    expect(useCanvasStore.getState().countArmed).toEqual([]);
  });
});

describe('the timing figure', () => {
  function renderTiming(durationMs: number | null, armed: number | null) {
    const view = render(<NodeTiming durationMs={durationMs} armed={armed} />);
    const text = (): string | null => view.container.textContent || null;
    return { ...view, text };
  }

  it('shows the figure as it is on mount, armed or not', () => {
    const { text } = renderTiming(12, 4);
    expect(text()).toBe('12ms');
  });

  it('starts at zero on the render that first has a new figure, when armed', () => {
    const { rerender, text } = renderTiming(null, 4);
    rerender(<NodeTiming durationMs={12} armed={4} />);
    expect(text()).toBe('0ms');
  });

  it('holds the final figure’s width from that first frame', () => {
    const { rerender, container } = renderTiming(null, 4);
    rerender(<NodeTiming durationMs={12} armed={4} />);
    expect(container.querySelector('[data-final]')?.getAttribute('data-final')).toBe('12ms');
  });

  it('counts to the figure, only ever upwards, and stops there', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    document.documentElement.style.setProperty('--pb-motion-fast', '120ms');
    const { rerender, text } = renderTiming(null, 4);
    rerender(<NodeTiming durationMs={12} armed={4} />);

    const seen: string[] = [text() ?? ''];
    for (let frame = 0; frame < 12; frame += 1) {
      act(() => {
        vi.advanceTimersByTime(16);
      });
      seen.push(text() ?? '');
    }
    const values = seen.map((value) => Number.parseFloat(value));
    expect(seen[0]).toBe('0ms');
    expect(values.every((value, index) => index === 0 || value >= (values[index - 1] ?? 0))).toBe(
      true,
    );
    // Part of the way, on the way there.
    expect(seen.some((value) => value !== '0ms' && value !== '12ms')).toBe(true);
    expect(seen.at(-1)).toBe('12ms');
  });

  it('does not count when nothing armed it - a run somebody typed for', () => {
    const { rerender, text } = renderTiming(8, null);
    rerender(<NodeTiming durationMs={null} armed={null} />);
    rerender(<NodeTiming durationMs={12} armed={null} />);
    expect(text()).toBe('12ms');
  });

  it('counts once per arrival, and swaps the next figure in', () => {
    const { rerender, text } = renderTiming(null, 4);
    rerender(<NodeTiming durationMs={12} armed={4} />);
    expect(text()).toBe('0ms');
    rerender(<NodeTiming durationMs={null} armed={4} />);
    rerender(<NodeTiming durationMs={30} armed={4} />);
    expect(text()).toBe('30ms');
  });

  it('stops where it is the moment it is disarmed', () => {
    const { rerender, text } = renderTiming(null, 4);
    rerender(<NodeTiming durationMs={12} armed={4} />);
    expect(text()).toBe('0ms');
    rerender(<NodeTiming durationMs={12} armed={null} />);
    expect(text()).toBe('12ms');
  });

  it('does not count under reduced motion', () => {
    preferReducedMotion(true);
    const { rerender, text } = renderTiming(null, 4);
    rerender(<NodeTiming durationMs={12} armed={4} />);
    expect(text()).toBe('12ms');
  });
});

describe('on the canvas', () => {
  function renderCanvas() {
    return render(
      <ToastProvider>
        <Canvas />
      </ToastProvider>,
    );
  }

  const arriving = (id: string): boolean =>
    screen.getByTestId(`node-${id}`).classList.contains(styles.nodeArriving ?? '');

  beforeEach(() => {
    seed([node('a', 'base64', 96, 96), node('b', 'hash', 496, 96)]);
  });

  it('settles a node that was just added, and not the ones that were there', () => {
    renderCanvas();
    let id = '';
    act(() => {
      id = useCanvasStore.getState().addNode('base64', { x: 96, y: 400 });
    });
    expect(arriving(id)).toBe(true);
    expect(arriving('a')).toBe(false);
  });

  it('replays nothing when the canvas mounts again, as it does after /tools', () => {
    const first = renderCanvas();
    let id = '';
    act(() => {
      id = useCanvasStore.getState().addNode('base64', { x: 96, y: 400 });
    });
    expect(arriving(id)).toBe(true);
    first.unmount();

    // The store still says this was the latest arrival. It is history now.
    renderCanvas();
    expect(arriving(id)).toBe(false);
  });

  it('draws in a wire that was just connected, and flicks both of its ports', () => {
    const { container } = renderCanvas();
    act(() => {
      useCanvasStore
        .getState()
        .connect({ nodeId: 'a', portId: 'output' }, { nodeId: 'b', portId: 'input' });
    });

    const wire = container.querySelector('[data-edge-id] path:last-child');
    expect(wire?.classList.contains(styles.wireArriving ?? '')).toBe(true);
    expect(wire?.getAttribute('pathLength')).toBe('1');

    const contact = (nodeId: string, side: string, portId: string): boolean =>
      screen
        .getByTestId(`node-${nodeId}`)
        .querySelector(`[data-port-side="${side}"][data-port-id="${portId}"] svg`)
        ?.classList.contains(styles.portContact ?? '') ?? false;
    expect(contact('a', 'output', 'output')).toBe(true);
    expect(contact('b', 'input', 'input')).toBe(true);
    // Only the two ends.
    expect(contact('a', 'output', 'report')).toBe(false);
  });

  it('does not draw a wire back in on undo and redo', () => {
    const { container } = renderCanvas();
    act(() => {
      useCanvasStore
        .getState()
        .connect({ nodeId: 'a', portId: 'output' }, { nodeId: 'b', portId: 'input' });
    });
    act(() => {
      useCanvasStore.getState().undo();
    });
    act(() => {
      useCanvasStore.getState().redo();
    });
    const wire = container.querySelector('[data-edge-id] path:last-child');
    expect(wire).not.toBeNull();
    expect(wire?.classList.contains(styles.wireArriving ?? '')).toBe(false);
    expect(wire?.hasAttribute('pathLength')).toBe(false);
  });

  it('marks nothing at all under reduced motion', () => {
    preferReducedMotion(true);
    const { container } = renderCanvas();
    let id = '';
    act(() => {
      id = useCanvasStore.getState().addNode('base64', { x: 96, y: 400 });
      useCanvasStore
        .getState()
        .connect({ nodeId: 'a', portId: 'output' }, { nodeId: 'b', portId: 'input' });
    });
    expect(arriving(id)).toBe(false);
    expect(container.querySelector(`.${styles.wireArriving ?? 'x'}`)).toBeNull();
    expect(container.querySelector(`.${styles.portContact ?? 'x'}`)).toBeNull();
  });
});
