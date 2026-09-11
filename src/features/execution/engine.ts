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
  type ExecuteRequest,
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
  timer: number;
  /** Main-thread time the request was posted, for placing the spans. */
  postedAt: number;
  readonly toolId: ToolId;
  /**
   * The exact message, kept so the request can be re-posted onto a fresh
   * worker after an unrelated request destroyed the old one.
   */
  readonly request: ExecuteRequest;
  /** Buffers handed over on post. Empty under 'borrow', which is the default. */
  readonly transfer: Transferable[];
  /**
   * False when this request's buffers were TRANSFERRED. The caller's views are
   * detached, so re-posting would send zero-length data and produce a
   * confidently wrong answer - much worse than the error it was avoiding.
   */
  readonly replayable: boolean;
  /** At most one replay per request, so a wedging tool cannot loop forever. */
  retried: boolean;
  /**
   * True once the caller has stopped waiting for this request.
   *
   * The entry stays in `pending` anyway, and its deadline stays armed. See
   * `onAbort`: cancelling tells the worker to stop, it does not make it stop.
   */
  cancelled: boolean;
  readonly timeoutMs: number;
  readonly timeoutMessage: string | undefined;
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
        // A cancelled request is kept only to hold its deadline; its caller
        // has been settled and must not be told about work it walked away from.
        if (!entry.cancelled) entry.onProgress?.(response.fraction, response.label);
        return;
      }

      if (response.kind === 'started') {
        /*
         * RE-ARMING, NOT EXTENDING.
         *
         * There is one worker and one thread behind it, so several requests
         * posted "concurrently" are really a queue. Timing them from the post
         * meant a node's deadline was spent waiting for its turn: a 2s regex
         * queued behind a 40s image conversion reported a timeout for work it
         * had not started. The clock is restarted here, when the tool actually
         * begins, so a deadline measures the tool's own work.
         *
         * The original timer is not simply cancelled: a request that never
         * gets a `started` at all - because the worker wedged before reaching
         * it - still has to fail rather than hang.
         */
        dependencies.clearTimer(entry.timer);
        entry.postedAt = now();
        entry.timer = armTimeout(response.requestId, entry.timeoutMs);
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
      // The worker itself died, taking everything in flight with it.
      const message = error instanceof Error ? error.message : 'The worker stopped unexpectedly.';
      const casualties = [...pending.entries()];
      pending.clear();
      replaceWorker();
      /*
       * Not replayed. A timeout tells us exactly which tool misbehaved and
       * that the others were innocent; an `error` event says the worker itself
       * is broken - a module that will not load, an uncaught failure in the
       * harness - and a fresh worker built from the same code would almost
       * certainly break the same way. Replaying here trades a clear failure
       * for a slower identical one.
       */
      recover(casualties, message, { replay: false });
    });

    worker = created;
    return created;
  }

  function armTimeout(requestId: string, ms: number): number {
    return dependencies.setTimer(() => {
      onTimeout(requestId);
    }, ms);
  }

  /**
   * One request ran over. Its worker has to be destroyed, and destroying it
   * takes down every OTHER request that happened to be in flight.
   *
   * This is the whole reason this function exists. Before it, a timeout
   * terminated the worker and settled only the request that caused it; the
   * others were left in `pending` with their own timers still running, and
   * each eventually reported a timeout it had never had - a base64 node beside
   * a runaway regex would hang for its full 15s and then blame itself. Every
   * casualty is dealt with here, at the moment the worker dies.
   */
  function onTimeout(requestId: string): void {
    const entry = pending.get(requestId);
    if (!entry) return;

    pending.delete(requestId);
    const casualties = [...pending.entries()];
    pending.clear();

    // A wedged synchronous tool cannot be interrupted from inside, so the only
    // reliable remedy is to destroy the worker and build a new one.
    replaceWorker();

    entry.settle(
      fail(
        'timeout',
        // A tool that knows WHY it is likely to run over says so itself.
        // "This pattern is too slow" is actionable; "the tool took too long"
        // invites the user to blame the app and try again.
        entry.timeoutMessage ?? 'The tool took too long and was stopped.',
        { detail: `Exceeded ${(entry.timeoutMs / 1000).toString()}s.` },
      ),
    );

    recover(casualties, 'Another tool on this canvas ran over its time limit.', { replay: true });
  }

  /**
   * Puts the bystanders of a dead worker back on a live one.
   *
   * They are REPLAYED rather than failed, because a tool is a pure function of
   * its inputs and options: running it again on a fresh worker produces the
   * same answer it would have produced, and reporting a failure the user's
   * node did not cause is the thing worth avoiding. Replay is refused in
   * exactly two cases - a request whose buffers were transferred (they are
   * detached, so a replay would silently compute over nothing) and one that
   * has already been replayed once (or a genuinely poisonous input would loop).
   */
  function recover(
    casualties: readonly (readonly [string, Pending])[],
    cause: string,
    { replay }: { readonly replay: boolean },
  ): void {
    for (const [id, entry] of casualties) {
      dependencies.clearTimer(entry.timer);

      /*
       * A cancelled entry is only here to hold its deadline over a worker that
       * may be wedged (see `onAbort`). Nobody is waiting for its answer, so
       * putting it back on the fresh worker would run a tool for no reader -
       * and on the canvas that is a whole superseded pipeline re-executing.
       */
      if (entry.cancelled) continue;

      if (!replay || !entry.replayable || entry.retried) {
        entry.settle(
          fail('internal', 'This run was interrupted before it could finish.', { detail: cause }),
        );
        continue;
      }

      try {
        entry.retried = true;
        entry.postedAt = now();
        entry.timer = armTimeout(id, entry.timeoutMs);
        pending.set(id, entry);
        attachWorker().post(entry.request, entry.transfer);
      } catch (error) {
        dependencies.clearTimer(entry.timer);
        pending.delete(id);
        entry.settle(
          fail('internal', 'This run was interrupted before it could finish.', {
            detail: error instanceof Error ? error.message : cause,
          }),
        );
      }
    }
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

    /*
     * The deadline this request runs under, which is the tool's own budget
     * plus whatever it granted itself per megabyte.
     *
     * Computed here rather than inside `armTimeout` because it is a property
     * of the REQUEST rather than of the tool: the same tool gets a minute for
     * a phone clip and twenty for an hour of broadcast, and both are its own
     * declared rate applied to what actually arrived.
     */
    const timeoutMs =
      meta.timeoutMs + Math.ceil(size / (1024 * 1024)) * (meta.timeoutMsPerMiB ?? 0);

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

    const request: ExecuteRequest = {
      kind: 'execute',
      requestId,
      toolId: options.toolId,
      inputs: options.inputs,
      options: options.options,
    };
    // Empty transfer list under 'borrow': structured clone copies the bytes and
    // leaves the caller's buffer usable. Outputs are still transferred the
    // other way (see worker.ts), where nothing reuses them.
    const transfer =
      options.ownership === 'transfer' ? collectTransferables(Object.values(options.inputs)) : [];

    return new Promise<ToolResult<ToolOutputs>>((resolve) => {
      let settled = false;

      const settle = (result: ToolResult<ToolOutputs>): void => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };

      function onAbort(): void {
        /*
         * CANCELLING TELLS THE WORKER TO STOP. IT DOES NOT MAKE IT STOP.
         *
         * The caller is settled straight away - waiting on a tool that may
         * never check its signal is the thing cancellation exists to avoid -
         * but the request is NOT forgotten, and its deadline stays armed.
         *
         * Dropping the entry here was a way to strand a worker forever. A
         * synchronous tool cannot be interrupted from inside, so the only
         * thing that ever destroys a wedged worker is a request's deadline
         * expiring; deleting the entry and clearing its timer removed the last
         * reference to a thread still spinning inside `RegExp.exec`, and
         * nothing was left to kill it. The next run was posted to that worker
         * and waited there until either the wedging tool happened to give up by
         * itself or its own deadline expired - with the main thread idle and
         * every node on screen saying "Running". Measured through the whole app
         * in `check:browsers`, deleting a runaway regex node mid-run and then
         * feeding a base64 node: 10.8s in WebKit and 4.1s in Gecko, against
         * 2.1s in both once the deadline survives. Those two numbers are the
         * runaway pattern giving up on its own; the bound for a tool that never
         * returns is the waiting node's own timeout - 15 seconds for base64, 60
         * for an image conversion. On the canvas this is one keystroke away:
         * edit or delete a node while a runaway one is in flight and the
         * superseded run is cancelled exactly like this.
         *
         * So the deadline the tool declared still applies, measured from the
         * same moment it always was. No new number: the guarantee is simply
         * that a request cannot hold the worker past its own limit, whether or
         * not anybody is still listening for the answer.
         */
        const entry = pending.get(requestId);
        if (entry) entry.cancelled = true;
        worker?.post({ kind: 'cancel', requestId }, []);
        settle(fail('cancelled', 'Cancelled.'));
      }

      pending.set(requestId, {
        settle,
        onProgress: options.onProgress,
        timer: armTimeout(requestId, timeoutMs),
        postedAt: now(),
        toolId: options.toolId,
        request,
        transfer,
        replayable: transfer.length === 0,
        retried: false,
        cancelled: false,
        timeoutMs,
        timeoutMessage: meta.timeoutMessage,
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });

      handle.post(request, transfer);
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
      /*
       * Settled, not merely forgotten. Dropping the entries left every awaiting
       * caller with a promise that could never resolve, so a pipeline torn down
       * mid-run would sit at `running` for the life of the tab.
       */
      const abandoned = [...pending.values()];
      pending.clear();
      prefetched.clear();
      replaceWorker();
      for (const entry of abandoned) {
        dependencies.clearTimer(entry.timer);
        entry.settle(fail('cancelled', 'Cancelled.'));
      }
    },
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toString()} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  // A GB tier, because the video tool's own limit is four of them and
  // "4096.0 MB" is a number nobody reads as four gigabytes.
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
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
