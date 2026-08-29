import { describe, expect, it, vi } from 'vitest';

import type { ToolId } from '@/features/registry/manifest';
import {
  ok,
  type ErasedTool,
  type ExecutionMeta,
  type ToolOutputs,
  type ToolResult,
} from '@/features/registry/types';

import { createExecutionEngine, type WorkerHandle } from './engine';
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
    pending: (): number => timers.size,
  };
}

const WORKER_META: ExecutionMeta = {
  strategy: 'worker',
  requiresWasm: false,
  wasmModules: [],
  reportsProgress: true,
  timeoutMs: 5000,
  maxInputBytes: 1024,
};

const MAIN_META: ExecutionMeta = { ...WORKER_META, strategy: 'main' };

const TOOL_ID = 'base64' as ToolId;

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
    run: run ?? (() => ok({ out: { type: 'text', text: 'stub' } })),
  };
}

const textInput = { input: { type: 'text', text: 'hello' } } as const;

function settled(requestId: string, result: ToolResult<ToolOutputs>): WorkerResponse {
  return { kind: 'settled', requestId, result };
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

  it('transfers binary inputs instead of copying them', async () => {
    const { engine, workers } = setup();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const promise = engine.execute({
      toolId: TOOL_ID,
      inputs: { input: { type: 'bytes', bytes, mediaType: null, filename: null } },
      options: {},
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
