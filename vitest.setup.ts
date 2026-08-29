// Adds the jest-dom matchers (toBeInTheDocument, toHaveAccessibleName, ...)
// to Vitest's `expect`, including their TypeScript types.
import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only auto-cleans when Vitest globals are enabled, and they
// are not, so unmount between tests explicitly.
afterEach(() => {
  cleanup();
});
