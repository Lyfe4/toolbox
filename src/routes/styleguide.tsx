import { createFileRoute } from '@tanstack/react-router';

import { pageHead } from '@/app/head';

/**
 * Route declaration only. The component lives in the matching .lazy.tsx
 * file, which the bundler emits as its own chunk and the router fetches
 * on first navigation - so none of this page is in the initial download.
 *
 * `head` stays here rather than moving into the lazy file, because the point
 * of a title is that it is known before the chunk arrives.
 */
export const Route = createFileRoute('/styleguide')({
  head: () =>
    pageHead({
      page: 'Styleguide',
      path: '/styleguide',
      description:
        'Every design token, component and theme in Patchbay, with contrast ratios measured live in the browser.',
    }),
});
