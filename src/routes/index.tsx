import { createFileRoute } from '@tanstack/react-router';

import { validateCanvasSearch } from '@/features/canvas/shareSearch';

/**
 * The canvas route.
 *
 * `validateSearch` types and length-bounds the share parameter, so
 * `Route.useSearch()` is typed and nothing oversized reaches the decoder. It is
 * hand-written rather than a schema: this route is eager, and a validator
 * library in the initial bundle costs every visitor 14.4 kB gzipped to check a
 * string's length. The compressed payload inside is still validated with Zod,
 * in the lazy chunk, where the untrusted structure actually is.
 *
 * The component itself lives in index.lazy.tsx so the canvas is fetched on
 * first navigation rather than shipped to everyone who only opens /tools.
 */
export const Route = createFileRoute('/')({
  validateSearch: validateCanvasSearch,
});
