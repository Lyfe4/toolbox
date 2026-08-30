import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { routeTree } from '@/routeTree.gen';

import { ROUTE_PENDING_MIN_MS, ROUTE_PENDING_MS, ROUTE_PRELOAD_DELAY_MS } from './navigation';
import { router } from './router';

/**
 * ROUTE TRANSITION FEEDBACK
 *
 * The measured waits are in navigation.ts. The two behaviours that matter are
 * the two easy ones to get wrong: a fast navigation must show NOTHING, and a
 * slow one must show something for long enough to read.
 *
 * The first version of this failed the first half - `state.status` flips to
 * 'pending' on every navigation including the 0-3ms ones, so a bar wired to
 * it flashed on every click. `defaultPendingMs` gates a route's own
 * pendingComponent, not the router status, which is why the same thresholds
 * are applied to the bar explicitly.
 */

function makeRouter(path = '/') {
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    defaultPendingMs: ROUTE_PENDING_MS,
    defaultPendingMinMs: ROUTE_PENDING_MIN_MS,
    defaultPreload: 'intent',
    defaultPreloadDelay: ROUTE_PRELOAD_DELAY_MS,
  });
}

async function renderApp(path = '/') {
  const testRouter = makeRouter(path);
  await testRouter.load();
  const result = render(<RouterProvider router={testRouter} />);
  return { ...result, router: testRouter };
}

const track = (): HTMLElement => screen.getByTestId('route-progress');

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the router configuration', () => {
  it('carries the measured thresholds rather than defaults', () => {
    expect(router.options.defaultPendingMs).toBe(ROUTE_PENDING_MS);
    expect(router.options.defaultPendingMinMs).toBe(ROUTE_PENDING_MIN_MS);
  });

  it('preloads on intent, not on mount', () => {
    // 'intent' is hover and focus. Anything eager would fetch every route's
    // chunk for every visitor, which is the opposite of the point.
    expect(router.options.defaultPreload).toBe('intent');
    expect(router.options.defaultPreloadDelay).toBe(ROUTE_PRELOAD_DELAY_MS);
  });
});

/*
 * The fast-versus-slow distinction is NOT tested here.
 *
 * In jsdom a route's dynamic import takes over a second to transform, so
 * every navigation is "slow" and the assertion would be measuring vitest.
 * The threshold logic is unit-tested in useDelayedPending.test.ts, and the
 * end-to-end behaviour - bar on a slow navigation, silence on a fast one - is
 * asserted against a real browser in scripts/cross-browser-check.mjs.
 */

describe('the announcement', () => {
  it('is silent before anything has been navigated to', async () => {
    await renderApp('/');
    expect(screen.getByTestId('route-announcer')).toHaveTextContent('');
  });

  it('names the route that arrived, in a live region', async () => {
    const user = userEvent.setup();
    await renderApp('/');

    await user.click(screen.getByRole('link', { name: 'Tools' }));

    const announcer = await screen.findByTestId('route-announcer');
    await waitFor(() => {
      expect(announcer).toHaveTextContent('Tools loaded.');
    });
    // Polite, not assertive: arriving somewhere is not an interruption.
    expect(announcer).toHaveAttribute('aria-live', 'polite');
    expect(announcer).toHaveAttribute('role', 'status');
  });

  it('announces each subsequent navigation too', async () => {
    const user = userEvent.setup();
    await renderApp('/');

    await user.click(screen.getByRole('link', { name: 'Styleguide' }));
    await waitFor(() => {
      expect(screen.getByTestId('route-announcer')).toHaveTextContent('Styleguide loaded.');
    });

    await user.click(screen.getByRole('link', { name: 'Home' }));
    await waitFor(() => {
      expect(screen.getByTestId('route-announcer')).toHaveTextContent('Canvas loaded.');
    });
  });
});

describe('the indicator itself', () => {
  it('is hidden from assistive technology, since the live region carries it', async () => {
    await renderApp('/');
    expect(track()).toHaveAttribute('aria-hidden', 'true');
  });

  it('holds its space whether or not a navigation is in flight', async () => {
    await renderApp('/');
    // Always in the DOM: a bar that appears and disappears would shift the
    // page under the pointer at the exact moment the user is reading it.
    expect(track()).toBeInTheDocument();
  });
});

describe('preloading on intent', () => {
  it('preloads a route when its link is hovered', async () => {
    const user = userEvent.setup();
    const { router: testRouter } = await renderApp('/');
    const preload = vi.spyOn(testRouter, 'preloadRoute');

    await user.hover(screen.getByRole('link', { name: 'Styleguide' }));
    await waitFor(() => {
      expect(preload).toHaveBeenCalled();
    });
  });

  it('preloads a route when its link is focused, so the keyboard benefits too', async () => {
    const user = userEvent.setup();
    const { router: testRouter } = await renderApp('/');
    const preload = vi.spyOn(testRouter, 'preloadRoute');

    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();

    await waitFor(() => {
      expect(preload).toHaveBeenCalled();
    });
  });

  it('does not preload anything merely by rendering', async () => {
    const testRouter = makeRouter('/');
    await testRouter.load();
    const preload = vi.spyOn(testRouter, 'preloadRoute');

    render(<RouterProvider router={testRouter} />);
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Tools' })).toBeInTheDocument();
    });

    // Intent-based only: three chunks fetched on every page load would cost
    // every visitor bandwidth for routes most of them never open.
    expect(preload).not.toHaveBeenCalled();
  });
});
