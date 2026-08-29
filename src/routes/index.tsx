import { createFileRoute } from '@tanstack/react-router';

import { canvasSearchSchema } from '@/features/canvas/shareSearch';

/**
 * The canvas route.
 *
 * `validateSearch` runs the search params through Zod, so `Route.useSearch()`
 * is typed and the share parameter is length-bounded before anything looks at
 * it. The compressed payload inside is validated separately - decoding it
 * needs DecompressionStream, and validateSearch has to be synchronous.
 *
 * The component itself lives in index.lazy.tsx so the canvas is fetched on
 * first navigation rather than shipped to everyone who only opens /tools.
 */
export const Route = createFileRoute('/')({
  validateSearch: canvasSearchSchema,
});
