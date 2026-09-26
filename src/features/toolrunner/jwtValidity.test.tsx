import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import { Canvas } from '@/features/canvas/Canvas';
import { useCanvasStore } from '@/features/canvas/graphStore';
import { EMPTY_GRAPH, type CanvasNode } from '@/features/canvas/types';
import { DEFAULT_VIEWPORT, useViewportStore } from '@/features/canvas/viewportStore';
import {
  createExecutionEngine,
  ExecutionEngineProvider,
  type ExecuteOptions,
} from '@/features/execution';
import { usePipelineStore } from '@/features/execution/pipelineStore';
import { getManifestEntry, loadTool } from '@/features/registry';
import type { ToolOutputs, ToolResult } from '@/features/registry/types';
import { EMPTY_ANNOUNCEMENTS } from '@/lib/announce';
import { encodeBase64, textToBytes } from '@/lib/base64';

import { ToolRunner } from './ToolRunner';

/**
 * WHETHER A TOKEN IS STILL GOOD, READ AT A DIFFERENT MOMENT FROM THE RUN.
 *
 * Every other JWT test reads the verdict in the same instant it was computed,
 * and a verdict that is true only at that instant passes all of them. That is
 * how this escaped: jwt-decode decided `expired` from `Date.now()` inside the
 * run and the view drew it, so the answer on screen was the answer at the
 * moment of the run. On the canvas a run is re-served from the cache for as
 * long as the graph stays the same - an hour, a day, a laptop lid - so a
 * token that had expired went on saying `Expires in 5 minutes`.
 *
 * So each case here decodes at one moment and reads at another, on the two
 * routes a person reads it on: a canvas node's inspector and the tool page.
 * The clock is vitest's, not the machine's - `Date` and `setInterval` are
 * faked, so "two hours later" is an instruction rather than a wait, and no
 * answer depends on the host's clock, zone or locale. `setTimeout` stays real
 * because the pipeline's debounce and the testing library's polling use it,
 * and neither is what is being measured.
 *
 * The controls are tokens that have NOT expired, read just as late: still
 * live, so the fix is not "never say valid".
 */

const T0 = Date.UTC(2031, 2, 14, 9, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function b64url(text: string): string {
  return encodeBase64(textToBytes(text), { urlSafe: true, padding: false, wrapAt: 0 });
}

/** An unsigned-looking HS256 token issued at T0 and expiring at `expMs`. */
function tokenExpiringAt(expMs: number): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ sub: 'ada', iat: T0 / 1000, exp: expMs / 1000 }));
  return `${header}.${payload}.bm90LWEtc2ln`;
}

/** The validity strip's verdict, named by its attribute rather than its words. */
function validity(): string | null {
  return document.querySelector('[data-validity]')?.getAttribute('data-validity') ?? null;
}

function validityText(): string {
  return document.querySelector('[data-validity]')?.textContent ?? '';
}

/** Moves the clock, then lets one second pass so a ticking view can notice. */
function later(ms: number): void {
  act(() => {
    vi.setSystemTime(Date.now() + ms);
    vi.advanceTimersByTime(1000);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: T0 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* ========================================================================== *
 * The canvas
 * ========================================================================== */

describe('a canvas node read later', () => {
  let runs: ExecuteOptions[] = [];

  /** The real tool, in-process, counting every time it is really run. */
  async function runForReal(options: ExecuteOptions): Promise<ToolResult<ToolOutputs>> {
    runs.push(options);
    const tool = await loadTool(options.toolId);
    return tool.run({
      inputs: options.inputs,
      options: options.options,
      context: { signal: new AbortController().signal },
    });
  }

  function node(id: string, toolId: CanvasNode['toolId'], input: string, x = 0): CanvasNode {
    return { id, toolId, position: { x, y: 0 }, options: {}, inputs: { input }, fileInputs: {} };
  }

  beforeEach(() => {
    runs = [];
    window.localStorage.clear();
    usePipelineStore.getState().reset();
    usePipelineStore.setState({ execute: runForReal });
    useViewportStore.setState({ viewport: DEFAULT_VIEWPORT, isPanning: false });
    useCanvasStore.setState({
      graph: EMPTY_GRAPH,
      selection: { nodes: [], edges: [] },
      past: [],
      future: [],
      pendingMove: null,
      ...EMPTY_ANNOUNCEMENTS,
    });
  });

  /*
   * WAITING ON THE PIPELINE ITSELF, NOT ON THE PAGE.
   *
   * The first version waited only for the JWT node's strip, and edited the
   * graph while the same run could still be loading base64 for the other node:
   * the edit aborted that run, base64 executed once instead of twice, and the
   * cache test failed in about one run in three - after another test, never on
   * its own. And the testing library's `waitFor` polls with `setInterval`,
   * which this file fakes, so it re-checks only when the DOM changes; a
   * condition on a plain array would never be looked at again. So a run is
   * awaited by subscribing to the store, which says when one has finished.
   */
  async function runFinished(after: unknown): Promise<void> {
    await act(async () => {
      await new Promise<void>((resolve) => {
        const done = (): boolean => {
          const state = usePipelineStore.getState();
          return !state.running && state.summary !== null && state.summary !== after;
        };
        if (done()) {
          resolve();
          return;
        }
        const stop = usePipelineStore.subscribe(() => {
          if (!done()) return;
          stop();
          resolve();
        });
      });
    });
  }

  /** A decoded token on the canvas, selected, with the inspector open on it. */
  async function decodedOnTheCanvas(token: string): Promise<void> {
    const nodes = [node('jwt', 'jwt-decode', token), node('other', 'base64', 'seed', 400)];
    useCanvasStore.setState({
      graph: {
        nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
        nodeOrder: nodes.map((entry) => entry.id),
        edges: {},
        edgeOrder: [],
        nextId: 3,
      },
      selection: { nodes: ['jwt'], edges: [] },
    });

    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Canvas />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Inspector' }));
    await runFinished(null);
    expect(validity()).not.toBeNull();
  }

  const decodes = (): number => runs.filter((entry) => entry.toolId === 'jwt-decode').length;

  it('says a token has expired once it has, without the node running again', async () => {
    await decodedOnTheCanvas(tokenExpiringAt(T0 + HOUR));
    expect(validity()).toBe('live');

    later(2 * HOUR);

    expect(validity()).toBe('expired');
    expect(validityText()).toContain('1 hour ago');
    // The answer moved because the READING moved: the tool ran once.
    expect(decodes()).toBe(1);
  });

  /*
   * THE CACHE, EXERCISED. Editing the other node re-runs the pipeline, and the
   * JWT node's key has not changed, so its result is served from the cache -
   * which is the route that kept the old answer alive indefinitely.
   */
  it('still says expired when a re-run serves the node from the cache', async () => {
    await decodedOnTheCanvas(tokenExpiringAt(T0 + HOUR));
    later(2 * HOUR);

    const first = usePipelineStore.getState().summary;
    act(() => {
      useCanvasStore.getState().setNodeInput('other', 'input', 'changed');
    });
    await runFinished(first);

    expect(runs.filter((entry) => entry.toolId === 'base64')).toHaveLength(2);
    expect(usePipelineStore.getState().summary?.cached).toBe(1);

    expect(decodes()).toBe(1);
    expect(validity()).toBe('expired');
  });

  /*
   * A hidden tab is late timers, and nothing else this view relies on
   * (CONTRIBUTING, "name the mechanism"). The clock jumps and no interval
   * fires at all; coming back into view is enough.
   */
  it('catches up the moment the tab is visible again, before any tick', async () => {
    await decodedOnTheCanvas(tokenExpiringAt(T0 + HOUR));

    act(() => {
      vi.setSystemTime(T0 + 3 * HOUR);
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(validity()).toBe('expired');
  });

  it('control: a token that has not expired, read as late, is still live', async () => {
    await decodedOnTheCanvas(tokenExpiringAt(T0 + 5 * HOUR));
    expect(validityText()).toContain('in 5 hours');

    later(2 * HOUR);

    expect(validity()).toBe('live');
    // And the countdown is the reader's, not the run's.
    expect(validityText()).toContain('in 2 hours');
    expect(decodes()).toBe(1);
  });
});

/* ========================================================================== *
 * The tool page
 * ========================================================================== */

describe('the tool page read later', () => {
  function renderPage(): void {
    const engine = createExecutionEngine({
      createWorker: () => {
        throw new Error('no worker in jsdom');
      },
      loadTool,
      getExecutionMeta: (id) => ({ ...getManifestEntry(id).execution, strategy: 'main' }),
      setTimer: (callback, ms) => window.setTimeout(callback, ms),
      clearTimer: (handle) => {
        window.clearTimeout(handle);
      },
    });
    render(
      <ToastProvider>
        <ExecutionEngineProvider value={engine}>
          <ToolRunner entry={getManifestEntry('jwt-decode')} />
        </ExecutionEngineProvider>
      </ToastProvider>,
    );
  }

  async function decodedOnThePage(token: string): Promise<void> {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('textbox', { name: 'JWT input' }));
    await user.paste(token);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => {
      expect(validity()).not.toBeNull();
    });
  }

  it('says a token has expired once it has, without pressing Run again', async () => {
    await decodedOnThePage(tokenExpiringAt(T0 + 10 * MINUTE));
    expect(validity()).toBe('live');

    later(HOUR);

    expect(validity()).toBe('expired');
  });

  it('control: a token that has not expired, read as late, is still live', async () => {
    await decodedOnThePage(tokenExpiringAt(T0 + 4 * HOUR));

    later(HOUR);

    expect(validity()).toBe('live');
    expect(validityText()).toContain('in 2 hours');
  });
});
