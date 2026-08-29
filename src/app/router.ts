import { createRouter } from '@tanstack/react-router';

import { routeTree } from '@/routeTree.gen';

export const router = createRouter({ routeTree });

// Declaration merging: this tells TanStack Router's own types about *our*
// router instance. Because of it, `<Link to="/nope" />` is a compile error
// rather than a broken link discovered at runtime.
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
