import { describe, expect, it, vi } from 'vitest';

import type { ToolId } from '@/features/registry/manifest';
import {
  ok,
  type ErasedTool,
  type ExecutionMeta,
  type ToolOutputs,
  type ToolResult,
} from '@/features/registry/types';

import { createExecutionEngine, resolveExecutionMeta, type WorkerHandle } from './engine';
import {
  collectTransferables,
  measureInputs,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol';

/* -------------------------------------------------------------------------- *
 * Test doubles
 *
 * The worker and the clock are both injected, which is what makes the timeout
 * and cancellation paths testable at all: neither depends on real elapsed time
 * or on a real Worker being available in jsdom.
 * -------------------------------------------------------------------------- */

interface FakeWorker {
  readonly handle: WorkerHandle;
  readonly posted: { message: WorkerRequest; transfer: Transferable[] }[];
  readonly reply: (response: WorkerResponse) => void;
  readonly crash: (error: unknown) => void;
  readonly terminated: () => boolean;
}

function createFakeWorker(): FakeWorker {
  const posted: { message: WorkerRequest; transfer: Transferable[] }[] = [];
  let onMessage: ((response: WorkerResponse) => void) | null = null;
  let onError: ((error: unknown) => void) | null = null;
  let terminated = false;

  return {
    handle: {
      post: (message, transfer) => {
        posted.push({ message, transfer });
      },
      terminate: () => {
        terminated = true;
      },
      onMessage: (handler) => {
        onMessage = handler;
      },
      onError: (handler) => {
        onError = handler;
      },
    },
    posted,
    reply: (response) => {
      onMessage?.(response);
    },
    crash: (error) => {
      onError?.(error);
    },
    terminated: () => terminated,
  };
}

function createClock() {
  const timers = new Map<number, () => void>();
  let next = 0;

  return {
    setTimer: (callback: () => void): number => {
      next += 1;
      timers.set(next, callback);
      return next;
    },
    clearTimer: (handle: number): void => {
      timers.delete(handle);
    },
    fireAll: (): void => {
      for (const callback of [...timers.values()]) callback();
      timers.clear();
    },
    /** Fires ONE timer, which is what a single tool running over looks like. */
    fire: (handle: number): void => {
      const callback = timers.get(handle);
      timers.delete(handle);
      callback?.();
    },
    handles: (): readonly number[] => [...timers.keys()],
    pending: (): number => timers.size,
  };
}

const WORKER_META: ExecutionMeta = {
  strategy: 'worker',
  requiresWasm: false,
  wasmModules: [],
  requiresOffscreenCanvas: false,
  reportsProgress: true,
  timeoutMs: 5000,
  maxInputBytes: 1024,
};

const MAIN_META: ExecutionMeta = { ...WORKER_META, strategy: 'main' };

const TOOL_ID = 'base64' as ToolId;
/** A second tool, so a graph can hold two deadlines that differ wildly. */
const SLOW_TOOL_ID = 'regex-tester' as ToolId;

function setup(meta: ExecutionMeta = WORKER_META, tool?: ErasedTool) {
  const workers: FakeWorker[] = [];
  const clock = createClock();

  const engine = createExecutionEngine({
    createWorker: () => {
      const worker = createFakeWorker();
      workers.push(worker);
      return worker.handle;
    },
    loadTool: () => Promise.resolve(tool ?? stubTool()),
    getExecutionMeta: () => meta,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  return { engine, workers, clock };
}

function stubTool(run?: ErasedTool['run']): ErasedTool {
  return {
    id: 'stub',
    name: 'Stub',
    summary: 'Test double.',
    category: 'text',
    inputs: [],
    outputs: [],
    optionsSchema: {
      safeParse: () => ({ success: true, data: {} }),
    } as unknown as ErasedTool['optionsSchema'],
    defaultOptions: {},
    optionFields: [],
    execution: MAIN_META,
    secretOptionKeys: [],
    run: run ?? (() => ok({ out: { type: 'text', text: 'stub' } })),
  };
}

const textInput = { input: { type: 'text', text: 'hello' } } as const;

function settled(requestId: string, result: ToolResult<ToolOutputs>): WorkerResponse {
  return { kind: 'settled', requestId, result, timing: { importMs: 0, runMs: 0 } };
}

/* -------------------------------------------------------------------------- */

describe('execution engine, worker path', () => {
  it('posts a correlated execute request', async () => {
    const { engine, workers } = setup();
    const promise = engine.execute({ toolId: TOOL_ID, inputs: textInput, options: {} });

    const first = workers[0];
    expect(first).toBeDefined();
    const sent = first?.posted[0]?.message;
    expect(sent?.kind).toBe('execute');

    if (sent?.kind === 'execute') {
      expect(sent.toolId).toBe(TOOL_ID);
      expect(sent.inputs).toEqual(textInput);
      first?.reply(settled(sent.requestId, ok({ out: { type: 'text', text: 'done' } })));
    }

    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.out).toEqual({ type: 'text', text: 'done' });
  });

  it('ignores a reply whose id does not match anything in flight', async () => {
    const { engine, workers } = setup();
    const promise = engine.execute({ toolId: TOOL_ID, inputs: textInput, options: {} });
    const worker = workers[0];

    worker?.reply(settled('not-a-real-id', ok({})));

    const sent = worker?.posted[0]?.message;
    if (sent?.kind === 'execute') {
      worker?.reply(settled(sent.requestId, ok({ out: { type: 'text', text: 'right one' } })));
    }

    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.out).toEqual({ type: 'text', text: 'right one' });
  });

  it('forwards progress reports', async () => {
    const { engine, workers } = setup();
    const onProgress = vi.fn();
    const promise = engine.execute({ toolId: TOOL_ID, inputs: textInput, options: {}, onProgress });

    const worker = workers[0];
    const sent = worker?.posted[0]?.message;
    if (sent?.kind === 'execute') {
      worker?.reply({
        kind: 'progress',
        requestId: sent.requestId,
        fraction: 0.5,
        label: 'halfway',
      });
      worker?.reply(settled(sent.requestId, ok({})));
    }

    await promise;
    expect(onProgress).toHaveBeenCalledWith(0.5, 'halfway');
  });

  it('borrows binary inputs by default, so nothing is detached', async () => {
    const { engine, workers } = setup();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const promise = engine.execute({
      toolId: TOOL_ID,
      inputs: { input: { type: 'bytes', bytes, mediaType: null, filename: null } },
      options: {},
    });

    const worker = workers[0];
    const entry = worker?.posted[0];
    // Empty transfer list: the structured clone copies, the caller keeps its
    // buffer, and a second consumer can still read it. See fanout.test.ts.
    expect(entry?.transfer).toEqual([]);
    expect(bytes.byteLength).toBe(4);

    const sent = entry?.message;
    if (sent?.kind === 'execute') worker?.reply(settled(sent.requestId, ok({})));
    await promise;
  });

  it('transfers binary inputs when the caller hands over ownership', async () => {
    const { engine, workers } = setup();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const promise = engine.execute({
      toolId: TOOL_ID,
      inputs: { input: { type: 'bytes', bytes, mediaType: null, filename: null } },
      options: {},
      ownership: 'transfer',
    });

    const worker = workers[0];
    const entry = worker?.posted[0];
    expect(entry?.transfer).toHaveLength(1);
    expect(entry?.transfer[0]).toBe(bytes.buffer);

    const sent = entry?.message;
    if (sent?.kind === 'execute') worker?.reply(settled(sent.requestId, ok({})));
    await promise;
  });
});

describe('timeout', () => {
  it('fails with a timeout error and terminates the worker', async () => {
    const { engine, workers, clock } = setup();
    const promise = engine.execute({ toolId: TOOL_ID, inputs: textInput, options: {} });

    clock.fireAll();

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('timeout');
      expect(result.error.detail).toContain('5s');
    }
    expect(workers[0]?.terminated()).toBe(true);
  });

  /*
   * A tool that knows why it is likely to run over supplies its own message.
   * The regex tester is the reason this exists: "the tool took too long" sends
   * the user hunting for a bug in the app, where "that pattern is too slow"
   * points at the thing they can actually change.
   */
  it("uses the tool's own timeout message when it declares one", async () => {
    const { engine, clock } = setup({
      ...WORKER_META,
      timeoutMessage: 'That pattern is too slow and was stopped.',
    });
    const promise = engine.execute({ toolId: TOOL_ID, inputs: textInput, options: {} });

    clock.fireAll();

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('That pattern is too slow and was stopped.');
      // Still a timeout, still says how long it waited.
      expect(result.error.code).toBe('timeout');
      expect(result.error.detail).toContain('5s');
    }
  });

  it('replaces the terminated worker on the next run', async () => {
    const { engine, workers, clock } = setup();
    const first = engine.execute({ toolId: TOOL_ID, inputs: textInput, options: {} });
    clock.fireAll();
    await first;

    const second = engine.execute({ toolId: TOOL_ID, inputs: textInput, options: {} });
    expect(workers).toHaveLength(2);

    const worker = workers[1];
    const sent = worker?.posted[0]?.message;
    if (sent?.kind === 'execute') worker?.reply(settled(sent.requestId, ok({})));
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it('clears the timer once a result arrives', async () => {
    const { engine, workers, clock } = setup();
    const promise = engine.execute({ toolId: TOOL_ID, inputs: textInput, options: {} });

    const worker = workers[0];
    const sent = worker?.posted[0]?.message;
    if (sent?.kind === 'execute') worker?.reply(settled(sent.requestId, ok({})));
    await promise;

    expect(clock.pending()).toBe(0);
  });
});

describe('cancellation', () => {
  it('tells the worker and settles as cancelled', async () => {
    const { engine, workers } = setup();
    const controller = new AbortController();
    const promise = engine.execute({
      toolId: TOOL_ID,
      inputs: textInput,
      options: {},
      signal: controller.signal,
    });

    controller.abort();

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('cancelled');

    const cancelMessage = workers[0]?.posted.find((entry) => entry.message.kind === 'cancel');
    expect(cancelMessage).toBeDefined();
  });

  it('ignores a result that arrives after cancellation', async () => {
    const { engine, workers } = setup();
    const controller = new AbortController();
    const promise = engine.execute({
      toolId: TOOL_ID,
      inputs: textInput,
      options: {},
      signal: controller.signal,
    });

    const worker = workers[0];
    const sent = worker?.posted[0]?.message;
    controller.abort();
    if (sent?.kind === 'execute') {
      worker?.reply(settled(sent.requestId, ok({ out: { type: 'text', text: 'too late' } })));
    }

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('cancelled');
  });

  it('does not start at all when the signal is already aborted', async () => {
    const { engine, workers } = setup();
    const controller = new AbortController();
    controller.abort();

    const result = await engine.execute({
      toolId: TOOL_ID,
      inputs: textInput,
      options: {},
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('cancelled');
    expect(workers).toHaveLength(0);
  });
});

describe('guards', () => {
  it('rejects an input larger than the tool allows, without spawning a worker', async () => {
    const { engine, workers } = setup();
    const result = await engine.execute({
      toolId: TOOL_ID,
      inputs: {
        input: { type: 'bytes', bytes: new Uint8Array(2048), mediaType: null, filename: null },
      },
      options: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('limit-exceeded');
      expect(result.error.detail).toContain('1.0 kB');
    }
    expect(workers).toHaveLength(0);
  });

  it('fails everything in flight when the worker itself dies', async () => {
    const { engine, workers } = setup();
    const promise = engine.execute({ toolId: TOOL_ID, inputs: textInput, options: {} });

    workers[0]?.crash(new Error('boom'));

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('internal');
      expect(result.error.detail).toBe('boom');
    }
  });
});

describe('main-thread path', () => {
  it('runs without creating a worker when the tool declares it', async () => {
    const { engine, workers } = setup(MAIN_META);

    const result = await engine.execute({ toolId: TOOL_ID, inputs: textInput, options: {} });

    expect(workers).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('converts a thrown error into a result instead of propagating it', async () => {
    const throwing = stubTool(() => {
      throw new Error('tool exploded');
    });
    const { engine } = setup(MAIN_META, throwing);

    const result = await engine.execute({ toolId: TOOL_ID, inputs: textInput, options: {} });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('internal');
      expect(result.error.detail).toBe('tool exploded');
    }
  });

  it('passes an abort signal the tool can observe', async () => {
    const controller = new AbortController();
    const seen: boolean[] = [];
    const observing = stubTool(({ context }) => {
      seen.push(context.signal.aborted);
      return ok({});
    });
    const { engine } = setup(MAIN_META, observing);

    await engine.execute({
      toolId: TOOL_ID,
      inputs: textInput,
      options: {},
      signal: controller.signal,
    });

    expect(seen).toEqual([false]);
  });
});

describe('protocol helpers', () => {
  it('measures text, bytes and json inputs', () => {
    expect(measureInputs({ a: { type: 'text', text: 'abcd' } })).toBe(8);
    expect(
      measureInputs({
        a: { type: 'bytes', bytes: new Uint8Array(10), mediaType: null, filename: null },
      }),
    ).toBe(10);
    expect(measureInputs({ a: { type: 'json', data: { x: 1 } } })).toBeGreaterThan(0);
  });

  it('collects each buffer once, and skips non-binary values', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const transferables = collectTransferables([
      { type: 'bytes', bytes, mediaType: null, filename: null },
      { type: 'bytes', bytes, mediaType: null, filename: null },
      { type: 'text', text: 'not binary' },
      undefined,
    ]);

    expect(transferables).toEqual([bytes.buffer]);
  });
});

/*
 * The documented main-thread fallback for image-convert. Declaring the need
 * eagerly is what makes this possible: by the time a tool's `run` executes it
 * is already in a worker, and cannot move.
 */
describe('capability downgrade', () => {
  const needsCanvas: ExecutionMeta = { ...WORKER_META, requiresOffscreenCanvas: true };

  it('leaves a tool in the worker when OffscreenCanvas is available', () => {
    // Only its presence matters; the engine never constructs one.
    vi.stubGlobal('OffscreenCanvas', function OffscreenCanvasStub() {
      return undefined;
    });
    expect(resolveExecutionMeta(needsCanvas).strategy).toBe('worker');
    vi.unstubAllGlobals();
  });

  it('moves a tool to the main thread when OffscreenCanvas is missing', () => {
    vi.stubGlobal('OffscreenCanvas', undefined);
    expect(resolveExecutionMeta(needsCanvas).strategy).toBe('main');
    vi.unstubAllGlobals();
  });

  it('leaves a tool that does not need it alone either way', () => {
    vi.stubGlobal('OffscreenCanvas', undefined);
    expect(resolveExecutionMeta(WORKER_META).strategy).toBe('worker');
    vi.unstubAllGlobals();
  });
});

/*
 * Warming and prefetching are optimisations, which sets the bar for them: they
 * must help when they can and be invisible when they cannot. A browser that
 * refuses to give us a Worker has to get the old behaviour, not a broken app.
 */
describe('warm up', () => {
  it('starts the worker and pings it without running anything', () => {
    const { engine, workers } = setup();

    engine.warmUp();

    expect(workers).toHaveLength(1);
    expect(workers[0]?.posted[0]?.message).toEqual({ kind: 'ping' });
  });

  it('reuses the warmed worker for the first real run', async () => {
    const { engine, workers } = setup();
    engine.warmUp();

    const promise = engine.execute({ toolId: TOOL_ID, inputs: textInput, options: {} });

    // One worker, not two: the run did not pay to construct anything.
    expect(workers).toHaveLength(1);

    const worker = workers[0];
    const sent = worker?.posted[1]?.message;
    if (sent?.kind === 'execute') worker?.reply(settled(sent.requestId, ok({})));
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it('does nothing visible when no Worker can be created', () => {
    const clock = createClock();
    const engine = createExecutionEngine({
      createWorker: () => {
        throw new Error('Worker is not defined');
      },
      loadTool: () => Promise.resolve(stubTool()),
      getExecutionMeta: () => WORKER_META,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    expect(() => {
      engine.warmUp();
    }).not.toThrow();
  });
});

describe('prefetch', () => {
  it('asks the worker to import a worker tool', () => {
    const { engine, workers } = setup();

    engine.prefetch(TOOL_ID);

    expect(workers[0]?.posted[0]?.message).toEqual({ kind: 'preload', toolId: TOOL_ID });
  });

  it('asks only once for the same tool', () => {
    const { engine, workers } = setup();

    engine.prefetch(TOOL_ID);
    engine.prefetch(TOOL_ID);

    expect(workers[0]?.posted).toHaveLength(1);
  });

  it('imports a main-thread tool into this realm instead', async () => {
    let loaded = 0;
    const clock = createClock();
    const engine = createExecutionEngine({
      createWorker: () => {
        throw new Error('no worker should be created for a main-thread tool');
      },
      loadTool: () => {
        loaded += 1;
        return Promise.resolve(stubTool());
      },
      getExecutionMeta: () => MAIN_META,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    engine.prefetch(TOOL_ID);
    await Promise.resolve();

    expect(loaded).toBe(1);
  });

  it('forgets what it prefetched when the worker is replaced', async () => {
    const { engine, workers, clock } = setup();

    engine.prefetch(TOOL_ID);
    const timedOut = engine.execute({ toolId: TOOL_ID, inputs: textInput, options: {} });
    clock.fireAll();
    await timedOut;

    // The old worker's module registry died with it, so the new one has to be
    // warmed again rather than being assumed ready.
    engine.prefetch(TOOL_ID);
    expect(workers[1]?.posted[0]?.message).toEqual({ kind: 'preload', toolId: TOOL_ID });
  });
});

/* ========================================================================== *
 * One request's timeout, and everything else that was in flight
 * ========================================================================== */

describe('a timeout with other requests in flight', () => {
  /**
   * Two tools, two very different deadlines, one worker between them - which is
   * the ordinary case on a canvas.
   */
  function twoToolSetup() {
    const workers: FakeWorker[] = [];
    const clock = createClock();

    const metaFor = (id: ToolId): ExecutionMeta =>
      id === SLOW_TOOL_ID
        ? { ...WORKER_META, timeoutMs: 2000, timeoutMessage: 'That pattern is too slow.' }
        : { ...WORKER_META, timeoutMs: 15_000 };

    const engine = createExecutionEngine({
      createWorker: () => {
        const worker = createFakeWorker();
        workers.push(worker);
        return worker.handle;
      },
      loadTool: () => Promise.resolve(stubTool()),
      getExecutionMeta: metaFor,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    return { engine, workers, clock };
  }

  /** The request id of the nth execute posted to a worker. */
  function executeIds(worker: FakeWorker | undefined): readonly string[] {
    return (worker?.posted ?? [])
      .map((entry) => entry.message)
      .filter((message) => message.kind === 'execute')
      .map((message) => message.requestId);
  }

  /*
   * THE BUG THIS CATCHES
   *
   * A timeout terminates the worker. It used to settle only the request that
   * ran over and leave every other in-flight request sitting in `pending` with
   * its own timer still ticking - against a worker that no longer existed. A
   * base64 node running beside a runaway regex therefore hung for its own full
   * 15 seconds and then reported a timeout it had never had.
   *
   * Why it matters: the two nodes are unrelated. Nothing the user did to the
   * base64 node caused it, nothing they can do to it fixes it, and the message
   * points at the wrong node entirely.
   */
  it('does not leave the other requests hanging on a dead worker', async () => {
    const { engine, workers, clock } = twoToolSetup();

    const slow = engine.execute({ toolId: SLOW_TOOL_ID, inputs: textInput, options: {} });
    const bystander = engine.execute({ toolId: TOOL_ID, inputs: textInput, options: {} });

    const [slowId] = executeIds(workers[0]);
    expect(slowId).toBeDefined();

    // Only the slow tool's deadline fires. The bystander's has not elapsed.
    const [slowTimer] = clock.handles();
    expect(slowTimer).toBeDefined();
    if (slowTimer !== undefined) clock.fire(slowTimer);

    const slowResult = await slow;
    expect(slowResult.ok).toBe(false);
    if (!slowResult.ok) {
      expect(slowResult.error.code).toBe('timeout');
      expect(slowResult.error.message).toBe('That pattern is too slow.');
    }

    // The bystander was replayed onto the replacement worker rather than being
    // abandoned, so it is still resolvable - and resolves as itself.
    const replacement = workers[1];
    expect(replacement).toBeDefined();
    const [replayedId] = executeIds(replacement);
    expect(replayedId).toBeDefined();
    if (replayedId !== undefined) {
      replacement?.reply(settled(replayedId, ok({ out: { type: 'text', text: 'bystander' } })));
    }

    const bystanderResult = await bystander;
    expect(bystanderResult.ok).toBe(true);
    if (bystanderResult.ok) {
      expect(bystanderResult.value.out).toEqual({ type: 'text', text: 'bystander' });
    }
  });

  /*
   * The replay keeps the SAME request id, so a reply arriving from the new
   * worker still correlates. Getting this wrong would look like the bug above
   * all over again: the reply would be dropped as "a late reply to something
   * already settled" and the caller would wait forever.
   */
  it('replays the bystander under its original request id', async () => {
    const { engine, workers, clock } = twoToolSetup();

    void engine.execute({ toolId: SLOW_TOOL_ID, inputs: textInput, options: {} });
    const bystander = engine.execute({ toolId: TOOL_ID, inputs: textInput, options: {} });

    const before = executeIds(workers[0]);
    const [slowTimer] = clock.handles();
    if (slowTimer !== undefined) clock.fire(slowTimer);

    expect(executeIds(workers[1])).toEqual([before[1]]);

    const replayed = executeIds(workers[1])[0];
    if (replayed !== undefined) workers[1]?.reply(settled(replayed, ok({})));
    await expect(bystander).resolves.toMatchObject({ ok: true });
  });

  /*
   * A replay is bounded at one. Two tools that both wedge would otherwise put
   * the engine in a loop, rebuilding a worker and re-posting the same doomed
   * request forever.
   */
  it('fails a bystander that has already been replayed once', async () => {
    const { engine, clock } = twoToolSetup();

    void engine.execute({ toolId: SLOW_TOOL_ID, inputs: textInput, options: {} });
    const bystander = engine.execute({ toolId: TOOL_ID, inputs: textInput, options: {} });

    // First casualty: replayed.
    const first = clock.handles()[0];
    if (first !== undefined) clock.fire(first);

    // A second run-over on the replacement worker. The bystander's replay
    // budget is spent, so this time it is told what happened rather than
    // being re-posted.
    const settledSoFar = new Set(clock.handles());
    void engine.execute({ toolId: SLOW_TOOL_ID, inputs: textInput, options: {} });
    const second = clock.handles().find((handle) => !settledSoFar.has(handle));
    expect(second).toBeDefined();
    if (second !== undefined) clock.fire(second);

    const result = await bystander;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('internal');
      // It says whose fault it was. A node reporting a failure it did not
      // cause has to at least point somewhere useful.
      expect(result.error.detail).toContain('ran over its time limit');
    }
  });

  /*
   * Transferred buffers are detached in the sender, so replaying a transferred
   * request would post zero-length views and produce a confident, wrong answer
   * several steps later. The engine refuses, and says so instead.
   */
  it('refuses to replay a request whose buffers were transferred', async () => {
    const { engine, clock } = twoToolSetup();

    void engine.execute({ toolId: SLOW_TOOL_ID, inputs: textInput, options: {} });
    const transferred = engine.execute({
      toolId: TOOL_ID,
      inputs: {
        input: { type: 'bytes', bytes: new Uint8Array([1, 2, 3]), mediaType: null, filename: null },
      },
      options: {},
      ownership: 'transfer',
    });

    const [slowTimer] = clock.handles();
    if (slowTimer !== undefined) clock.fire(slowTimer);

    const result = await transferred;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('internal');
  });

  /*
   * There is one worker and one thread behind it. Requests posted together are
   * really a queue, and timing a request from the moment it was POSTED spent
   * its deadline on other tools' work: a 2s regex sitting behind a long image
   * conversion reported a timeout for work it had not begun.
   */
  it("starts a tool's deadline when the tool starts, not when it was queued", async () => {
    const { engine, workers, clock } = twoToolSetup();

    const promise = engine.execute({ toolId: SLOW_TOOL_ID, inputs: textInput, options: {} });
    const [requestId] = executeIds(workers[0]);
    const armedOnPost = clock.handles()[0];
    expect(armedOnPost).toBeDefined();

    // The worker finally reaches this request and says so.
    if (requestId !== undefined) workers[0]?.reply({ kind: 'started', requestId });

    // The original deadline is gone; a fresh one is running in its place.
    const armedOnStart = clock.handles()[0];
    expect(clock.handles()).toHaveLength(1);
    expect(armedOnStart).not.toBe(armedOnPost);

    if (requestId !== undefined) workers[0]?.reply(settled(requestId, ok({})));
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  /*
   * ...but a request the worker never even acknowledges still has to fail. If
   * the deadline only ever started on `started`, a worker that wedged before
   * reaching a queued request would leave it pending for the life of the tab.
   */
  it('still times out a request the worker never starts', async () => {
    const { engine, clock } = twoToolSetup();
    const promise = engine.execute({ toolId: TOOL_ID, inputs: textInput, options: {} });

    clock.fireAll();

    await expect(promise).resolves.toMatchObject({ ok: false, error: { code: 'timeout' } });
  });

  /*
   * A CANCELLED REQUEST THAT WEDGED THE WORKER STILL HAS TO KILL IT.
   *
   * Cancelling settles the caller; it does not stop a synchronous tool, which
   * cannot be interrupted from inside. The only thing in the system that ever
   * destroys a wedged worker is a request's deadline expiring - so forgetting
   * the request on abort, timer and all, removed the last reference to a
   * thread still spinning, and nothing was left that could kill it.
   *
   * What that costs is not an abstraction. The next run is posted to the same
   * worker, joins a queue that will never move, and waits out ITS OWN timeout
   * before anything notices: 15 seconds for a base64 node, 60 for an image
   * conversion, with the main thread idle and every node saying "Running". It
   * is one keystroke away on the canvas - editing a node while a runaway regex
   * is in flight supersedes the run, and a superseded run is cancelled exactly
   * like this.
   */
  it('replaces a worker that a cancelled request left wedged', async () => {
    const { engine, workers, clock } = twoToolSetup();

    const controller = new AbortController();
    const abandoned = engine.execute({
      toolId: SLOW_TOOL_ID,
      inputs: textInput,
      options: {},
      signal: controller.signal,
    });

    const [wedgeId] = executeIds(workers[0]);
    expect(wedgeId).toBeDefined();
    // The tool has begun, and from here it will never speak again.
    if (wedgeId !== undefined) workers[0]?.reply({ kind: 'started', requestId: wedgeId });

    controller.abort();
    await expect(abandoned).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } });

    // Nothing has told the engine the worker is dead, so the next run is posted
    // to it - which is exactly the situation the deadline has to cover.
    const next = engine.execute({ toolId: TOOL_ID, inputs: textInput, options: {} });
    expect(workers).toHaveLength(1);
    const [, nextId] = executeIds(workers[0]);
    expect(nextId).toBeDefined();

    // Two deadlines are armed: the abandoned one and the new request's. The
    // abandoned one is the point - without it this is 1, and the only timer
    // left is the new request's own 15 seconds of nothing.
    expect(clock.pending()).toBe(2);

    const [wedgeTimer] = clock.handles();
    expect(wedgeTimer).toBeDefined();
    if (wedgeTimer !== undefined) clock.fire(wedgeTimer);

    expect(workers[0]?.terminated()).toBe(true);
    expect(workers).toHaveLength(2);

    // And the innocent request went with the worker, so it is replayed rather
    // than failed - the ordinary bystander rule, which now applies here too.
    expect(executeIds(workers[1])).toEqual([nextId]);
    if (nextId !== undefined) {
      workers[1]?.reply(settled(nextId, ok({ out: { type: 'text', text: 'fine' } })));
    }
    await expect(next).resolves.toMatchObject({ ok: true });
  });

  /*
   * The other half of it: a request nobody is waiting for must not be put back
   * on the fresh worker. Replaying it would run a tool for no reader, and on
   * the canvas that is a whole superseded pipeline executing a second time.
   */
  it('does not replay a cancelled request onto the replacement worker', async () => {
    const { engine, workers, clock } = twoToolSetup();

    const controller = new AbortController();
    const abandoned = engine.execute({
      toolId: TOOL_ID,
      inputs: textInput,
      options: {},
      signal: controller.signal,
    });
    const slow = engine.execute({ toolId: SLOW_TOOL_ID, inputs: textInput, options: {} });

    const [abandonedId, slowId] = executeIds(workers[0]);
    controller.abort();
    await expect(abandoned).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } });

    // The slow tool runs over, taking the worker down with it.
    const slowTimer = clock.handles().at(-1);
    expect(slowTimer).toBeDefined();
    if (slowTimer !== undefined) clock.fire(slowTimer);
    await expect(slow).resolves.toMatchObject({ ok: false, error: { code: 'timeout' } });

    expect(executeIds(workers[1])).not.toContain(abandonedId);
    expect(executeIds(workers[1])).toHaveLength(0);
    expect(slowId).toBeDefined();
    // Nothing is left holding a deadline: both entries are gone.
    expect(clock.pending()).toBe(0);
  });
});

describe('dispose', () => {
  /*
   * Dropping the pending map left every awaiting caller holding a promise that
   * could never settle. On the canvas that is a pipeline stuck at `running`
   * for as long as the tab is open, with no way back short of a reload.
   */
  it('settles everything in flight rather than abandoning it', async () => {
    const { engine } = setup();
    const promise = engine.execute({ toolId: TOOL_ID, inputs: textInput, options: {} });

    engine.dispose();

    await expect(promise).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } });
  });
});
