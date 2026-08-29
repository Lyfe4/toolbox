import { createFileRoute } from '@tanstack/react-router';

/**
 * Route declaration only. The component lives in the matching .lazy.tsx
 * file, which the bundler emits as its own chunk and the router fetches
 * on first navigation - so none of this page is in the initial download.
 */
export const Route = createFileRoute('/tools/')({});
