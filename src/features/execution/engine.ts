import { getManifestEntry, type ToolId } from '@/features/registry/manifest';
import {
  fail,
  type ErasedTool,
  type ExecutionMeta,
  type ToolInputs,
  type ToolOutputs,
  type ToolResult,
} from '@/features/registry/types';
import { span } from '@/lib/perf';

import {
  collectTransferables,
  measureInputs,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol';

/**
 * A worker, reduced to the four things the engine needs from one.
 *
 * Wrapping it like this keeps `new Worker(new URL(...))` in a single place and
 * lets the tests drive the engine with a fake - which is the only practical way
 * to test the timeout and cancellation paths deterministically.
 */
export interface WorkerHandle {
  readonly post: (message: WorkerRequest, transfer: Transferable[]) => void;
  readonly terminate: () => void;
  readonly onMessage: (handler: (response: WorkerResponse) => void) => void;
  readonly onError: (handler: (error: unknown) => void) => void;
}

/**
 * The real worker.
 *
 * `new URL('./worker.ts', import.meta.url)` is the form the bundler
 * understands: it emits worker.ts as its own same-origin file and rewrites
 * this to the hashed URL. A blob: URL would need a laxer `worker-src`, so this
 * is a security choice as much as a build one.
 */
export function createBrowserWorker(): WorkerHandle {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

  return {
    post: (message, transfer) => {
      worker.postMessage(message, transfer);
    },
    terminate: () => {
      worker.terminate();
    },
    onMessage: (handler) => {
      worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
        handler(event.data);
      });
    },
    onError: (handler) => {
      worker.addEventListener('error', (event) => {
        handler(event);
      });
    },
  };
}

/**
 * Who owns a binary input's memory once `execute` is called.
 *
 * 'borrow' (the default) structured-clones the input, so the caller's
 * Uint8Array stays intact and can be handed to another run afterwards. That is
 * what makes fan-out possible: on the canvas one output feeds several inputs,
 * and a transferred buffer would be detached by the first consumer, leaving
 * the second with a zero-length view and no error to explain it.
 *
 * 'transfer' moves the buffer to the worker with zero copy, detaching the
 * caller's view. Only pass it when the caller can prove the bytes are consumed
 * exactly once and will never be read again.
 */
export type InputOwnership = 'borrow' | 'transfer';

export interface ExecuteOptions {
  readonly toolId: ToolId;
  readonly inputs: ToolInputs;
  readonly options: unknown;
  readonly signal?: AbortSignal;
  readonly onProgress?: (fraction: number, label: string | null) => void;
  /** Defaults to 'borrow'. See InputOwnership. */
  readonly ownership?: InputOwnership;
}

export interface EngineDependencies {
  readonly createWorker: () => WorkerHandle;
  /** Injected so the main-thread path can be tested without a bundler. */
  readonly loadTool: (id: ToolId) => Promise<ErasedTool>;
  /**
   * Where the engine learns a tool's strategy, timeout and size limit. Injected
   * rather than reaching into the registry directly, so the engine has no
   * dependency on the real tool list and the tests can describe any tool shape.
   */
  readonly getExecutionMeta: (id: ToolId) => ExecutionMeta;
  /** Injected so tests can drive timers deterministically. */
  readonly setTimer: (callback: () => void, ms: number) => number;
  readonly clearTimer: (handle: number) => void;
}

interface Pending {
  readonly settle: (result: ToolResult<ToolOutputs>) => void;
  readonly onProgress: ((fraction: number, label: string | null) => void) | undefined;
  readonly timer: number;
  /** Main-thread time the request was posted, for placing the spans. */
  readonly postedAt: number;
  readonly toolId: ToolId;
}

/** Guarded because the perf timeline is instrumentation, never a dependency. */
function now(): number {
  return typeof performance === 'undefined' ? 0 : performance.now();
}

let nextRequestId = 0;

export interface ExecutionEngine {
  readonly execute: (options: ExecuteOptions) => Promise<ToolResult<ToolOutputs>>;
  /**
   * Starts the worker and waits for it to answer, without running anything.
   *
   * Called when the canvas mounts. The boot is unavoidable; what is avoidable
   * is paying for it inside the user's first run, where it reads as the tool
   * being slow. Idempotent, and silent about failure - it is an optimisation,
   * so a browser that will not give us a worker must simply get the old
   * behaviour rather than a broken canvas.
   */
  readonly warmUp: () => void;
  /**
   * Imports a tool's chunk ahead of time, in whichever context will run it.
   *
   * Called when a node is added, which is a deliberate act. Deliberately NOT
   * called on hover across the palette: prefetching eight tools to save one
   * fetch trades a small latency problem for a large bandwidth one.
   */
  readonly prefetch: (id: ToolId) => void;
  /** Tears down the worker. Used on teardown and after a timeout. */
  readonly dispose: () => void;
}

/**
 * Creates the execution engine.
 *
 * Binary inputs are BORROWED by default: they are structured-cloned into the
 * worker and the caller's buffer stays valid, so the same bytes can feed
 * several runs. Pass `ownership: 'transfer'` to hand the memory over instead,
 * which is free but detaches the caller's view.
 */
export function createExecutionEngine(dependencies: EngineDependencies): ExecutionEngine {
  const pending = new Map<string, Pending>();
  let worker: WorkerHandle | null = null;
  /** When the current worker was constructed, for the boot span. */
  let workerCreatedAt = 0;
  let workerReady = false;
  const prefetched = new Set<ToolId>();

  function attachWorker(): WorkerHandle {
    if (worker) return worker;

    workerCreatedAt = now();
    workerReady = false;
    const created = dependencies.createWorker();

    created.onMessage((response) => {
      if (response.kind === 'ready') {
        // The one message that is not about a particular request.
        if (!workerReady) {
          workerReady = true;
          span('worker-boot', workerCreatedAt, now() - workerCreatedAt);
        }
        return;
      }

      const entry = pending.get(response.requestId);
      if (!entry) return; // A late reply to something already settled.

      if (response.kind === 'progress') {
        entry.onProgress?.(response.fraction, response.label);
        return;
      }

      dependencies.clearTimer(entry.timer);
      pending.delete(response.requestId);

      /*
       * The worker reports durations, not timestamps - its clock has a
       * different origin. They are laid end to end from the moment the request
       * was posted, which is close enough to place them on the timeline and
       * exactly right for their lengths.
       */
      const postedAt = entry.postedAt;
      span(`tool-import:${entry.toolId}`, postedAt, response.timing.importMs);
      span(`tool-run:${entry.toolId}`, postedAt + response.timing.importMs, response.timing.runMs);
      span(`execute:${entry.toolId}`, postedAt, now() - postedAt);

      entry.settle(response.result);
    });

    created.onError((error) => {
      // The worker itself died. Fail everything in flight and start clean.
      const message = error instanceof Error ? error.message : 'The worker stopped unexpectedly.';
      for (const [id, entry] of pending) {
        dependencies.clearTimer(entry.timer);
        pending.delete(id);
        entry.settle(fail('internal', 'Execution failed.', { detail: message }));
      }
      replaceWorker();
    });

    worker = created;
    return created;
  }

  function replaceWorker(): void {
    worker?.terminate();
    worker = null;
    workerReady = false;
    // Whatever the old worker had imported died with it, so the record of what
    // has been prefetched has to die too or the new one never gets warmed.
    prefetched.clear();
  }

  async function runOnMainThread(
    options: ExecuteOptions,
    controller: AbortController,
  ): Promise<ToolResult<ToolOutputs>> {
    try {
      const tool = await dependencies.loadTool(options.toolId);
      return await tool.run({
        inputs: options.inputs,
        options: options.options,
        context: {
          signal: controller.signal,
          reportProgress: (fraction, label) => {
            options.onProgress?.(Math.min(1, Math.max(0, fraction)), label ?? null);
          },
        },
      });
    } catch (error) {
      return fail('internal', 'The tool failed unexpectedly.', {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function execute(options: ExecuteOptions): Promise<ToolResult<ToolOutputs>> {
    const meta = dependencies.getExecutionMeta(options.toolId);

    // Cheap guards first, before a tool module is even fetched.
    if (options.signal?.aborted) {
      return fail('cancelled', 'Cancelled before it started.');
    }

    const size = measureInputs(options.inputs);
    if (size > meta.maxInputBytes) {
      return fail(
        'limit-exceeded',
        `That input is too large for this tool (${formatBytes(size)}).`,
        { detail: `The limit is ${formatBytes(meta.maxInputBytes)}.` },
      );
    }

    // Declared on the tool, never guessed here.
    if (meta.strategy === 'main') {
      const controller = new AbortController();
      const onAbort = (): void => {
        controller.abort();
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        return await runOnMainThread(options, controller);
      } finally {
        options.signal?.removeEventListener('abort', onAbort);
      }
    }

    nextRequestId += 1;
    const requestId = `run-${nextRequestId.toString()}`;
    const handle = attachWorker();

    return new Promise<ToolResult<ToolOutputs>>((resolve) => {
      let settled = false;

      const settle = (result: ToolResult<ToolOutputs>): void => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };

      function onAbort(): void {
        const entry = pending.get(requestId);
        if (entry) {
          dependencies.clearTimer(entry.timer);
          pending.delete(requestId);
        }
        // Tell the worker so a cooperative tool can stop early, then settle
        // immediately rather than waiting on a tool that may never check.
        handle.post({ kind: 'cancel', requestId }, []);
        settle(fail('cancelled', 'Cancelled.'));
      }

      const timer = dependencies.setTimer(() => {
        pending.delete(requestId);
        // A wedged synchronous tool cannot be interrupted from inside, so the
        // only reliable remedy is to destroy the worker and build a new one.
        replaceWorker();
        settle(
          fail(
            'timeout',
            // A tool that knows WHY it is likely to run over says so itself.
            // "This pattern is too slow" is actionable; "the tool took too
            // long" invites the user to blame the app and try again.
            meta.timeoutMessage ?? 'The tool took too long and was stopped.',
            { detail: `Exceeded ${(meta.timeoutMs / 1000).toString()}s.` },
          ),
        );
      }, meta.timeoutMs);

      pending.set(requestId, {
        settle,
        onProgress: options.onProgress,
        timer,
        postedAt: now(),
        toolId: options.toolId,
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });

      handle.post(
        {
          kind: 'execute',
          requestId,
          toolId: options.toolId,
          inputs: options.inputs,
          options: options.options,
        },
        // Empty transfer list under 'borrow': structured clone copies the
        // bytes and leaves the caller's buffer usable. Outputs are still
        // transferred the other way (see worker.ts), where nothing reuses them.
        options.ownership === 'transfer' ? collectTransferables(Object.values(options.inputs)) : [],
      );
    });
  }

  /** See ExecutionEngine.warmUp. Never throws. */
  function warmUp(): void {
    try {
      attachWorker().post({ kind: 'ping' }, []);
    } catch {
      // No Worker here - a test environment, or a policy that forbids one.
      // The engine still works; the first run just pays for the boot.
    }
  }

  /** See ExecutionEngine.prefetch. Never throws. */
  function prefetch(id: ToolId): void {
    if (prefetched.has(id)) return;
    prefetched.add(id);

    try {
      // A main-thread tool is imported into THIS realm; a worker tool has to
      // be imported inside the worker, which has its own module registry.
      if (dependencies.getExecutionMeta(id).strategy === 'main') {
        void dependencies.loadTool(id).catch(() => undefined);
        return;
      }

      attachWorker().post({ kind: 'preload', toolId: id }, []);
    } catch {
      // As above: an optimisation that fails must be invisible.
    }
  }

  return {
    execute,
    warmUp,
    prefetch,
    dispose: () => {
      for (const [, entry] of pending) dependencies.clearTimer(entry.timer);
      pending.clear();
      prefetched.clear();
      replaceWorker();
    },
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toString()} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A tool's declared strategy, adjusted for what this browser can actually do.
 *
 * The only adjustment so far: a tool that needs OffscreenCanvas cannot run in
 * a worker on a browser without it, so it runs on the main thread instead.
 * Downgrading here rather than inside the tool is the difference between a
 * documented fallback and a runtime failure - by the time the tool's `run`
 * executes, it is already in the wrong context.
 */
export function resolveExecutionMeta(meta: ExecutionMeta): ExecutionMeta {
  if (
    meta.strategy === 'worker' &&
    meta.requiresOffscreenCanvas &&
    typeof OffscreenCanvas === 'undefined'
  ) {
    return { ...meta, strategy: 'main' };
  }
  return meta;
}

/** The engine wired to a real browser worker. */
export function createDefaultEngine(): ExecutionEngine {
  return createExecutionEngine({
    createWorker: createBrowserWorker,
    loadTool: async (id) => (await import('@/features/registry/loader')).loadTool(id),
    getExecutionMeta: (id) => resolveExecutionMeta(getManifestEntry(id).execution),
    setTimer: (callback, ms) => window.setTimeout(callback, ms),
    clearTimer: (handle) => {
      window.clearTimeout(handle);
    },
  });
}
