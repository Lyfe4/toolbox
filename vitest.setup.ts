// Adds the jest-dom matchers (toBeInTheDocument, toHaveAccessibleName, ...)
// to Vitest's `expect`, including their TypeScript types.
import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll } from 'vitest';

// Testing Library only auto-cleans when Vitest globals are enabled, and they
// are not, so unmount between tests explicitly.
afterEach(() => {
  cleanup();
});

/*
 * jsdom has no layout engine, so a handful of DOM APIs that Radix relies on for
 * positioning and pointer tracking simply do not exist. These are the minimum
 * stubs needed for those components to mount; nothing here changes behaviour
 * the tests actually assert on.
 */
beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    globalThis.ResizeObserver = class {
      observe(): void {
        // no layout in jsdom, so nothing to report
      }
      unobserve(): void {
        // no-op
      }
      disconnect(): void {
        // no-op
      }
    };
  }

  if (!('DOMRect' in globalThis)) {
    globalThis.DOMRect = class {
      static fromRect(): DOMRect {
        return new globalThis.DOMRect();
      }
      readonly x = 0;
      readonly y = 0;
      readonly width = 0;
      readonly height = 0;
      readonly top = 0;
      readonly right = 0;
      readonly bottom = 0;
      readonly left = 0;
      toJSON(): unknown {
        return {};
      }
    };
  }

  // jsdom has no matchMedia at all, and the theme engine subscribes to
  // prefers-color-scheme. A stub that always reports "no match" is enough:
  // the tests that care about theme resolution call the pure functions.
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    });
  }

  Element.prototype.scrollIntoView = function scrollIntoView(): void {
    // no-op
  };
  Element.prototype.hasPointerCapture = function hasPointerCapture(): boolean {
    return false;
  };
  Element.prototype.setPointerCapture = function setPointerCapture(): void {
    // no-op
  };
  Element.prototype.releasePointerCapture = function releasePointerCapture(): void {
    // no-op
  };
});
