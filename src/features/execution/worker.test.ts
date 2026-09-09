import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE WORKER ENTRY, WHICH IS ALSO A LIBRARY.
 *
 * `worker.ts` is the worker's entry module and it registers a `message`
 * listener on its global scope. It is also a shared chunk in the build: the
 * tool chunks it dynamically imports import it back for the registry helpers
 * Rollup placed alongside it, and so does the page's own bundle. So the one
 * module gets evaluated in places nobody meant it to be, and a global side
 * effect run more than once is not idempotent by itself.
 *
 * Both places were real, and neither was visible from here before this file:
 *
 *   - Inside a real worker, JavaScriptCore evaluated the entry a second time
 *     when a tool chunk imported it. Two listeners meant every request ran its
 *     tool TWICE - twice the CPU and twice the peak memory of every worker
 *     tool in Safari. Gecko evaluates it once, so Firefox was always clean and
 *     the difference was invisible to anything that did not count.
 *   - On the main thread `self` is the window, so the same evaluation put a
 *     `message` listener on the PAGE that would run a tool for anything able
 *     to `postMessage` to it.
 *
 * jsdom has no Worker, so what is asserted here is the guard itself rather
 * than the browser behaviour that made it necessary: evaluate the module twice
 * and count. `check:browsers` counts the real thing in a real worker.
 */

vi.mock('@/features/registry/loader', () => ({
  loadTool: vi.fn(() => Promise.resolve({})),
}));

/**
 * Every `message` listener added to the global scope by an import.
 *
 * Typed structurally rather than as the spy's own type: `self` is a `Window`
 * here, and naming one of its nine hundred members as a literal to build the
 * spy's type is a great deal of ceremony for "what was it called with".
 */
function messageListeners(spy: {
  readonly mock: { readonly calls: readonly unknown[][] };
}): number {
  return spy.mock.calls.filter((call) => call[0] === 'message').length;
}

describe('the worker entry', () => {
  beforeEach(() => {
    // The flag lives on the global scope, which outlives a module reset -
    // which is the whole point of putting it there, and means it has to be
    // cleared between cases here.
    delete (self as { __patchbayWorkerListening?: true }).__patchbayWorkerListening;
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (self as { __patchbayWorkerListening?: true }).__patchbayWorkerListening;
  });

  it('listens once, however many times the module is evaluated', async () => {
    // The guard only asks whether the constructor exists, so a stand-in for it
    // is enough: nothing here constructs one.
    vi.stubGlobal('WorkerGlobalScope', {});
    const spy = vi.spyOn(self, 'addEventListener');

    await import('./worker');
    vi.resetModules();
    await import('./worker');

    expect(messageListeners(spy)).toBe(1);
  });

  /*
   * The page is not a worker, and a module that is a worker's entry has no
   * business handling the window's messages. This is the half that has nothing
   * to do with any engine's module map: the main bundle imports this chunk for
   * its exports, on every visit.
   */
  it('listens for nothing at all outside a worker', async () => {
    const spy = vi.spyOn(self, 'addEventListener');

    await import('./worker');

    expect(messageListeners(spy)).toBe(0);
  });
});
