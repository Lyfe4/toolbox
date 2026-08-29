import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, type RenderResult } from '@testing-library/react';

import { routeTree } from '@/routeTree.gen';

/**
 * Renders a real route at a real URL.
 *
 * Uses the generated route tree rather than an ad-hoc one, so a test exercises
 * the same root layout, providers and lazy-loading the browser would. Lazy
 * route chunks are awaited before returning, so the caller sees a fully
 * rendered page rather than a loading state.
 */
export async function renderRoute(path: string): Promise<RenderResult> {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    // Nothing here should hit a network-shaped code path, and a stuck pending
    // state would just make failures confusing.
    defaultPendingMs: 0,
  });

  await router.load();

  return render(<RouterProvider router={router} />);
}
