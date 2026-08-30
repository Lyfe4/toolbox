import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '@/components/Toast';

import { Canvas } from './Canvas';
import { useCanvasStore } from './graphStore';
import { EMPTY_GRAPH, type CanvasNode, type GraphData } from './types';
import { DEFAULT_VIEWPORT, useViewportStore } from './viewportStore';

/**
 * THE CANVAS CHROME
 *
 * The toolbar, the status readout and the zoom control.
 *
 * jsdom has no layout, so "is anything clipped at 320px" cannot be answered
 * here - that is asserted against real engines in
 * scripts/cross-browser-check.mjs. What IS answerable here is which controls
 * exist at a given width, that they are reachable, and that they do what they
 * claim.
 */

/** Drives the media query the toolbar collapses on. */
function setViewportWidth(matchesCompact: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: matchesCompact && query.includes('max-width'),
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

function renderCanvas() {
  return render(
    <ToastProvider>
      <Canvas />
    </ToastProvider>,
  );
}

function node(id: string, toolId: CanvasNode['toolId'], x: number, y: number): CanvasNode {
  return { id, toolId, position: { x, y }, options: {}, inputs: {} };
}

function seed(nodes: readonly CanvasNode[], edges: GraphData['edges'] = {}): void {
  useCanvasStore.setState({
    graph: {
      nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
      nodeOrder: nodes.map((n) => n.id),
      edges,
      edgeOrder: Object.keys(edges),
      nextId: nodes.length + 1,
    },
    selection: { nodes: [], edges: [] },
    past: [],
    future: [],
    pendingMove: null,
    announcement: { text: '', seq: 0 },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  setViewportWidth(false);
  useCanvasStore.setState({
    graph: EMPTY_GRAPH,
    selection: { nodes: [], edges: [] },
    past: [],
    future: [],
    pendingMove: null,
    announcement: { text: '', seq: 0 },
  });
  useViewportStore.setState({ viewport: DEFAULT_VIEWPORT, isPanning: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the toolbar at a comfortable width', () => {
  it('shows every control inline', () => {
    renderCanvas();

    for (const name of ['Add tool', 'Fit', 'Undo', 'Redo', 'Share', 'Shortcuts']) {
      expect(screen.getByRole('button', { name: new RegExp(name) })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
  });

  it('makes the privacy note the share button description, not a sibling control', () => {
    renderCanvas();

    const share = screen.getByRole('button', { name: /Share/ });
    // Out of the button row: it used to be a 190px block of wrapped text
    // sitting between Share and Shortcuts, crowding both.
    expect(share).toHaveAccessibleDescription(/structure only, never your input/);
  });
});

describe('the toolbar when there is no room', () => {
  it('collapses to Add tool and an overflow menu rather than shrinking', () => {
    setViewportWidth(true);
    renderCanvas();

    expect(screen.getByRole('button', { name: /Add tool/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument();
    // Collapsed, not clipped: the rest are gone from the bar entirely.
    expect(screen.queryByRole('button', { name: 'Shortcuts' })).not.toBeInTheDocument();
  });

  it('keeps every collapsed action reachable', async () => {
    const user = userEvent.setup();
    setViewportWidth(true);
    renderCanvas();

    await user.click(screen.getByRole('button', { name: 'More' }));

    const menu = screen.getByRole('menu', { name: 'More' });
    const labels = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent);

    expect(labels.some((l) => l.startsWith('Fit'))).toBe(true);
    expect(labels.some((l) => l.startsWith('Undo'))).toBe(true);
    expect(labels.some((l) => l.startsWith('Redo'))).toBe(true);
    expect(labels.some((l) => l.startsWith('Share'))).toBe(true);
    expect(labels.some((l) => l.startsWith('Shortcuts'))).toBe(true);
  });

  it('carries the privacy note into the menu with the share action', async () => {
    const user = userEvent.setup();
    setViewportWidth(true);
    renderCanvas();

    await user.click(screen.getByRole('button', { name: 'More' }));
    const share = within(screen.getByRole('menu')).getByRole('menuitem', { name: /Share/ });

    expect(share).toHaveTextContent(/structure only, never your input/);
  });

  it('is operable from the keyboard alone, and gives focus back', async () => {
    const user = userEvent.setup();
    setViewportWidth(true);
    renderCanvas();

    const trigger = screen.getByRole('button', { name: 'More' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    await waitFor(() => {
      expect(items[0]).toHaveFocus();
    });

    await user.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    await user.keyboard('{End}');
    expect(items[items.length - 1]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    // Wraps rather than dead-ending.
    expect(items[0]).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    // Focus goes back where it came from, not to the document body.
    expect(trigger).toHaveFocus();
  });

  it('runs the same action the inline control would', async () => {
    const user = userEvent.setup();
    setViewportWidth(true);
    seed([node('a', 'base64', 200, 200)]);
    renderCanvas();

    act(() => {
      useViewportStore.setState({ viewport: { x: 0, y: 0, zoom: 0.4 }, isPanning: false });
    });

    await user.click(screen.getByRole('button', { name: 'More' }));
    await user.click(screen.getByRole('menuitem', { name: 'Fit' }));

    // Fit reframes on the content, so the viewport is no longer the one set.
    expect(useViewportStore.getState().viewport.zoom).not.toBe(0.4);
  });

  it('leaves the zoom reset on the readout rather than duplicating it', async () => {
    const user = userEvent.setup();
    setViewportWidth(true);
    renderCanvas();

    await user.click(screen.getByRole('button', { name: 'More' }));

    // One control for one action. Two buttons sharing the accessible name
    // "Zoom 100%. Reset to 100%." is worse than one in the obvious place.
    expect(screen.queryByRole('menuitem', { name: /Reset zoom/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Zoom \d+%/ })).toBeInTheDocument();
  });
});

describe('the status readout', () => {
  it('pluralises every count', () => {
    seed([node('a', 'base64', 0, 0)], {
      e1: {
        id: 'e1',
        from: { nodeId: 'a', portId: 'output' },
        to: { nodeId: 'a', portId: 'input' },
      },
    });
    renderCanvas();

    const readout = screen.getByTestId('canvas-readout');
    // The one that shipped was "1 WIRES".
    expect(readout).toHaveTextContent('1 node');
    expect(readout).toHaveTextContent('1 wire');
    expect(readout.textContent).not.toMatch(/\b1 (nodes|wires)\b/);
  });

  it('pluralises a zero and a many correctly too', () => {
    renderCanvas();
    expect(screen.getByTestId('canvas-readout')).toHaveTextContent('0 nodes');
    expect(screen.getByTestId('canvas-readout')).toHaveTextContent('0 wires');
  });

  it('puts each item in its own inline box, so an icon cannot split the line', () => {
    renderCanvas();

    /*
     * reset.css makes every svg `display: block`, and a block child inside an
     * inline span pushes the text after it onto a second line - which drew
     * "5 nodes" a row below its neighbours. Each item is now its own
     * inline-flex box, which is the structural fix; the visual proof is in
     * the cross-browser check.
     */
    const readout = screen.getByTestId('canvas-readout');
    const withIcon = within(readout).getByText(/nodes?$/, { selector: 'span' });
    expect(withIcon.querySelector('svg')).not.toBeNull();
  });
});

describe('the zoom control', () => {
  it('is a real button, not a label that looks like one', () => {
    renderCanvas();
    expect(screen.getByRole('button', { name: /Zoom \d+%/ })).toBeInTheDocument();
  });

  it('names the current zoom and what activating it does', () => {
    act(() => {
      useViewportStore.setState({ viewport: { x: 0, y: 0, zoom: 0.5 }, isPanning: false });
    });
    renderCanvas();

    // "100%" alone said neither that it was a control nor what it would do.
    expect(screen.getByRole('button', { name: 'Zoom 50%. Reset to 100%.' })).toBeInTheDocument();
  });

  it('resets zoom to 100%, matching the 0 shortcut', async () => {
    const user = userEvent.setup();
    act(() => {
      useViewportStore.setState({ viewport: { x: 30, y: 30, zoom: 0.4 }, isPanning: false });
    });
    renderCanvas();

    await user.click(screen.getByRole('button', { name: /Zoom 40%/ }));

    expect(useViewportStore.getState().viewport.zoom).toBe(1);
  });

  it('is keyboard focusable and activates on Enter', async () => {
    const user = userEvent.setup();
    act(() => {
      useViewportStore.setState({ viewport: { x: 0, y: 0, zoom: 2 }, isPanning: false });
    });
    renderCanvas();

    const zoom = screen.getByRole('button', { name: /Zoom 200%/ });
    zoom.focus();
    expect(zoom).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(useViewportStore.getState().viewport.zoom).toBe(1);
  });
});
