import { RouterProvider } from '@tanstack/react-router';

import { router } from '@/app/router';

/** Root of the application: providers wrap the router, nothing else. */
export function App() {
  return <RouterProvider router={router} />;
}
