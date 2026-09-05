import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import { TooltipProvider } from '@/components/Tooltip';
import { expectNoAxeViolations } from '@/lib/testing/axe';

import { Canvas } from './Canvas';
import { useCanvasStore } from './graphStore';
import { EMPTY_GRAPH, type CanvasNode } from './types';
import { DEFAULT_VIEWPORT, useViewportStore } from './viewportStore';

/**
 * TOOLTIPS ON TRUNCATED PORT LABELS.
 *
 * The whole feature is a question about layout, and jsdom has no layout - every
 * box is zero-sized, so nothing is ever truncated and nothing would ever get a
 * tooltip. Stubbing the two widths is therefore not a shortcut past a real
 * measurement; it is the only way to reach the branch at all, and it is why
 * `scripts/cross-browser-check.mjs` measures the real thing in real engines.
 *
 * What these tests own is the BEHAVIOUR either side of that measurement: which
 * labels get a tooltip, whether focus opens it, what the accessible name says,
 * and that attaching one does not cost the port its primary gesture.
 */

/** Labels the stub should report as overflowing their box. */
const TRUNCATED = new Set(['Rendered HTML', 'Detected source', 'Converted image']);

const realScrollWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth');
const realClientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');

beforeAll(() => {
  /*
   * Keyed on the element's own text, so a test reads as "this label is too
   * long" rather than "element number four is 90 pixels wide". Everything
   * else in the tree keeps reporting jsdom's zero, which is what makes the
   * negative cases meaningful: they are not special-cased, they simply do not
   * overflow.
   */
  Object.defineProperty(Element.prototype, 'scrollWidth', {
    configurable: true,
    get(this: Element) {
      return TRUNCATED.has(this.textContent) ? 104 : 0;
    },
  });
  Object.defineProperty(Element.prototype, 'clientWidth', {
    configurable: true,
    get(this: Element) {
      return TRUNCATED.has(this.textContent) ? 84 : 0;
    },
  });
});

afterAll(() => {
  if (realScrollWidth) Object.defineProperty(Element.prototype, 'scrollWidth', realScrollWidth);
  if (realClientWidth) Object.defineProperty(Element.prototype, 'clientWidth', realClientWidth);
});

function node(id: string, toolId: CanvasNode['toolId'], x: number, y: number): CanvasNode {
  return { id, toolId, position: { x, y }, options: {}, inputs: {} };
}

function seed(nodes: readonly CanvasNode[]): void {
  useCanvasStore.setState({
    graph: {
      nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
      nodeOrder: nodes.map((n) => n.id),
      edges: {},
      edgeOrder: [],
      nextId: nodes.length + 1,
    },
    selection: { nodes: [], edges: [] },
    past: [],
    future: [],
    pendingMove: null,
    announcement: { text: '', seq: 0 },
  });
}

function renderCanvas() {
  // The real canvas route wraps Canvas in a TooltipProvider - deliberately
  // there rather than in __root, so Radix's Popper stays out of the initial
  // payload. Mirrored here so the test renders the tree the app renders.
  return render(
    <ToastProvider>
      <TooltipProvider>
        <Canvas />
      </TooltipProvider>
    </ToastProvider>,
  );
}

function port(portId: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-port-id="${portId}"]`);
  if (!found) throw new Error(`no port ${portId}`);
  return found;
}

beforeEach(() => {
  useCanvasStore.setState({ graph: EMPTY_GRAPH, selection: { nodes: [], edges: [] } });
  useViewportStore.setState({ viewport: DEFAULT_VIEWPORT });
  // text-convert has both: "Input" and "Converted" fit, "Rendered HTML" and
  // "Detected source" do not.
  seed([node('n1', 'text-convert', 40, 40)]);
});

describe('which labels get a tooltip', () => {
  it('gives one to a label that is actually cut off', async () => {
    renderCanvas();

    await waitFor(() => {
      // Radix stamps the trigger; its absence is how the negative case below
      // is read too, so the same signal answers both questions.
      expect(port('rendered')).toHaveAttribute('data-state', 'closed');
    });
  });

  it('does not give one to a label that fits', async () => {
    renderCanvas();

    await waitFor(() => {
      expect(port('rendered')).toHaveAttribute('data-state');
    });

    // Measured the same way and found to fit: no tooltip, because a card
    // repeating a label you can already read is noise on every port.
    expect(port('input')).not.toHaveAttribute('data-state');
    expect(port('output')).not.toHaveAttribute('data-state');
  });
});

describe('reaching it', () => {
  it('opens on focus, not only on hover', async () => {
    renderCanvas();
    await waitFor(() => {
      expect(port('detected')).toHaveAttribute('data-state', 'closed');
    });

    /*
     * Focused directly rather than tabbed to, because ports are not tab stops:
     * Tab walks NODES and `C` opens the connect dialog, which lists every port
     * by its full name. So this asserts the thing that is actually in
     * question - that the tooltip is bound to focus and not to hover - rather
     * than asserting a tab order the canvas deliberately does not have.
     */
    act(() => {
      port('detected').focus();
    });

    await waitFor(() => {
      expect(screen.getByRole('tooltip')).toHaveTextContent('Detected source');
    });
    // Announced, not merely drawn.
    expect(port('detected')).toHaveAttribute('aria-describedby');
  });

  it('opens on hover as well', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await waitFor(() => {
      expect(port('rendered')).toHaveAttribute('data-state', 'closed');
    });

    await user.hover(port('rendered'));

    await waitFor(() => {
      expect(screen.getByRole('tooltip')).toHaveTextContent('Rendered HTML');
    });
  });
});

describe('the accessible name', () => {
  it('carries the full label whether or not it is cut off', async () => {
    renderCanvas();
    await waitFor(() => {
      expect(port('rendered')).toHaveAttribute('data-state');
    });

    // Truncation is a fact about the box, never about the name of the thing.
    expect(port('rendered')).toHaveAccessibleName('Output Rendered HTML, carries text');
    expect(port('detected')).toHaveAccessibleName('Output Detected source, carries text');
    expect(port('input')).toHaveAccessibleName('Input Input, accepts text');
  });
});

describe('the port keeps its job', () => {
  it('still starts a wire drag when its label is truncated', async () => {
    renderCanvas();
    await waitFor(() => {
      expect(port('rendered')).toHaveAttribute('data-state');
    });

    /*
     * The risk the tooltip introduces. Radix clones the trigger to attach its
     * own handlers, and a port's primary gesture is pointerdown - so if
     * composition dropped ours, the tooltip would have quietly replaced wiring
     * with a hover card. On touch this is the only thing that happens at all:
     * Radix does not open on tap, so the drag is uncontested.
     */
    act(() => {
      port('rendered').dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          clientX: 300,
          clientY: 120,
          pointerId: 1,
          isPrimary: true,
          button: 0,
          buttons: 1,
        }),
      );
    });
    act(() => {
      screen.getByRole('application').dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          cancelable: true,
          clientX: 420,
          clientY: 220,
          pointerId: 1,
          isPrimary: true,
          buttons: 1,
        }),
      );
    });

    expect(document.querySelector('svg path[class*="wireDraft"]')).not.toBeNull();
    expect(port('rendered')).toHaveAttribute('data-port-state', 'held');
  });
});

describe('accessibility', () => {
  it('has no axe violations with tooltips present', async () => {
    const { container } = renderCanvas();
    await waitFor(() => {
      expect(port('rendered')).toHaveAttribute('data-state');
    });

    await expectNoAxeViolations(container);
  });
});
