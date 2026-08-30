import { createFileRoute } from '@tanstack/react-router';

import { pageMeta } from '@/app/head';

/**
 * Route declaration only. The component lives in the matching .lazy.tsx
 * file, which the bundler emits as its own chunk and the router fetches
 * on first navigation - so none of this page is in the initial download.
 */
export const Route = createFileRoute('/tools/')({
  head: () => ({
    meta: pageMeta({
      page: 'Tools',
      description:
        'Every Patchbay tool as a plain, keyboard-first list: encoders, hashes, formatters, diff, regex, colour and image conversion.',
    }),
  }),
});
