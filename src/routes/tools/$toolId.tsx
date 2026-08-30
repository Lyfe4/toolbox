import { createFileRoute } from '@tanstack/react-router';

import { pageHead } from '@/app/head';
import { getManifestEntry, isToolId } from '@/features/registry/manifest';

/**
 * Route declaration only. The component lives in the matching .lazy.tsx
 * file, which the bundler emits as its own chunk and the router fetches
 * on first navigation - so none of this page is in the initial download.
 *
 * The title is per-tool, and it comes from the EAGER manifest rather than the
 * tool's own module - so the tab is named correctly while the implementation
 * chunk is still in flight. An id that is not a real tool falls back to a
 * generic title instead of throwing; the component renders the not-found view
 * for that case.
 */
export const Route = createFileRoute('/tools/$toolId')({
  head: ({ params }) => {
    const path = `/tools/${params.toolId}`;
    if (!isToolId(params.toolId)) return pageHead({ page: 'Tool not found', path });

    const tool = getManifestEntry(params.toolId);
    return pageHead({ page: tool.name, path, description: tool.summary });
  },
});
