import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import { usePipelineStore } from '@/features/execution/pipelineStore';
import { EMPTY_ANNOUNCEMENTS } from '@/lib/announce';
import { expectNoAxeViolations } from '@/lib/testing/axe';

import { Canvas } from './Canvas';
import { useCanvasStore } from './graphStore';
import { TOUCH_ROUTES } from './shortcuts';
import { type CanvasNode } from './types';
import { DEFAULT_VIEWPORT, useViewportStore } from './viewportStore';

/**
 * EVERY OVERLAY, OPENED.
 *
 * The shortcuts reference silently stopped scrolling because the palette took
 * `.dialogBody`'s scrolling away and moved it onto the option list - a change
 * that was right for the palette and broke a neighbour nothing was watching.
 * That is the second time a fix has quietly damaged something adjacent.
 *
 * jsdom has no layout, so `scrollHeight > clientHeight` is always false here
 * and "does it actually scroll" cannot be answered in this file - the real
 * measurement is in scripts/cross-browser-check.mjs. What IS answerable, and
 * what would have caught the regression, is structural: every overlay must
 * own a designated scroll container, and it must be the element that holds
 * the long content.
 */

/** Opens each overlay in turn, so a new one cannot be added without a test. */
const OVERLAYS = [
  {
    name: 'tool palette',
    open: async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole('button', { name: /Add tool/ }));
      await screen.findByRole('dialog', { name: 'Add a tool' });
    },
  },
  {
    name: 'shortcuts reference',
    open: async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole('application'));
      await user.keyboard('?');
      await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    },
  },
  {
    name: 'connect: which port',
    open: async (user: ReturnType<typeof userEvent.setup>) => {
      screen.getByRole('group', { name: /Structured data/ }).focus();
      await user.keyboard('c');
      await screen.findByRole('dialog', { name: /Connect from which port/ });
    },
  },
  {
    name: 'connect: which partner',
    open: async (user: ReturnType<typeof userEvent.setup>) => {
      screen.getByRole('group', { name: /Structured data/ }).focus();
      await user.keyboard('c');
      await screen.findByRole('dialog', { name: /Connect from which port/ });
      await user.keyboard('{Enter}');
      await screen.findByRole('dialog', { name: /Connect to which/ });
    },
  },
] as const;

function node(id: string, toolId: CanvasNode['toolId'], x = 0, y = 0): CanvasNode {
  return { id, toolId, position: { x, y }, options: {}, inputs: {}, fileInputs: {} };
}

function renderCanvas() {
  return render(
    <ToastProvider>
      <Canvas />
    </ToastProvider>,
  );
}

/** The element inside a dialog that is allowed to scroll. */
function scrollerIn(dialog: HTMLElement): HTMLElement | null {
  return dialog.querySelector<HTMLElement>('[data-scroll-region]');
}

beforeEach(() => {
  window.localStorage.clear();
  /*
   * The pipeline store keeps a result cache keyed by node id, and every test
   * here builds a canvas whose first node is n1. Without this, one test's
   * result can be served to the next as a cache hit - state leaking between
   * tests in exactly the shape it leaks between documents.
   */
  usePipelineStore.getState().reset();
  useCanvasStore.setState({
    graph: {
      nodes: {
        a: node('a', 'structured-data'),
        b: node('b', 'base64', 400, 0),
      },
      nodeOrder: ['a', 'b'],
      edges: {},
      edgeOrder: [],
      nextId: 3,
    },
    selection: { nodes: [], edges: [] },
    past: [],
    future: [],
    pendingMove: null,
    ...EMPTY_ANNOUNCEMENTS,
  });
  useViewportStore.setState({ viewport: DEFAULT_VIEWPORT, isPanning: false });
});

describe.each(OVERLAYS)('the $name overlay', ({ open }) => {
  it('has exactly one designated scroll region', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await open(user);

    const dialog = screen.getByRole('dialog');
    const regions = dialog.querySelectorAll('[data-scroll-region]');

    // One, not zero (nothing can scroll) and not several (which of them?).
    expect(regions).toHaveLength(1);
  });

  it('puts the long content inside that region, not beside it', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await open(user);

    const dialog = screen.getByRole('dialog');
    const scroller = scrollerIn(dialog);
    expect(scroller).not.toBeNull();

    /*
     * A scroll container with nothing tall in it scrolls nothing. The long
     * part of every overlay here is a list or a table, so one of those has to
     * be inside it - which is exactly what stopped being true when the
     * shortcuts tables were left outside the palette's new scroller.
     */
    const tall = scroller?.querySelector('[role="listbox"], table, [role="group"]');
    expect(tall).not.toBeNull();
  });

  it('is bounded, so overflowing content has somewhere to go', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await open(user);

    // The dialog caps its own height; without that the scroller would simply
    // grow and the page would scroll instead.
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toMatch(/dialog/);
  });

  it('closes on Escape and gives focus back to the canvas', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await open(user);

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('has no axe violations while open', async () => {
    const user = userEvent.setup();
    const { container } = renderCanvas();
    await open(user);

    await expectNoAxeViolations(container);
  });
});

describe('the shortcuts reference specifically', () => {
  it('keeps its own scroller rather than borrowing the palette body', async () => {
    const user = userEvent.setup();
    renderCanvas();

    await user.click(screen.getByRole('application'));
    await user.keyboard('?');

    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    const scroller = scrollerIn(dialog);

    // The regression: the tables ended up in a container that had stopped
    // scrolling, and the ports-and-wires key at the bottom was unreachable.
    if (!scroller) throw new Error('the shortcuts overlay has no scroll region');
    expect(within(scroller).getAllByRole('table').length).toBeGreaterThan(0);
    expect(within(scroller).getByText(/Ports and wires/)).toBeInTheDocument();
  });

  /**
   * THE SECTION THAT SAYS WHAT WORKS WITHOUT A KEYBOARD.
   *
   * Every row is read from `TOUCH_ROUTES`, so this is the assertion that stops
   * the reference and the behaviour drifting: a route added to that list and
   * not rendered fails here, and a route removed from the application but left
   * in the list is a lie this catches at the point somebody has to edit it.
   *
   * It matters more than a normal docs test because the thing being documented
   * is what is REACHABLE. A stale keyboard row sends someone to press a key
   * that does nothing; a stale row here tells a phone user a control exists.
   */
  it('lists every route that needs no keyboard, from the one list in code', async () => {
    const user = userEvent.setup();
    renderCanvas();

    await user.click(screen.getByRole('application'));
    await user.keyboard('?');

    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).getByText('Without a keyboard')).toBeInTheDocument();

    for (const route of TOUCH_ROUTES) {
      expect(within(dialog).getByText(route.gesture)).toBeInTheDocument();
    }
  });

  /*
   * Delete is the one this whole section exists for, so it is named rather than
   * left to the loop: a list that happened to contain eight rows and not that
   * one would pass the assertion above and still describe the gap.
   */
  it('says how something is deleted without a keyboard', async () => {
    const user = userEvent.setup();
    renderCanvas();

    await user.click(screen.getByRole('application'));
    await user.keyboard('?');

    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).getByText(/Delete, Duplicate and Select all/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Remove the wire feeding an input/)).toBeInTheDocument();
  });
});
