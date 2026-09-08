/// <reference lib="webworker" />
import { loadTool } from '@/features/registry/loader';
import { fail, type ToolOutputs, type ToolResult } from '@/features/registry/types';

import { collectTransferables, type WorkerRequest, type WorkerResponse } from './protocol';

/**
 * The tool execution worker.
 *
 * Loaded by the engine as a real same-origin module worker, never as a blob
 * URL, so `worker-src 'self'` in the CSP is enough and no eval-like source is
 * ever needed.
 *
 * The worker owns one AbortController per in-flight request. Cancellation is
 * cooperative: a tool that checks `context.signal` stops early. A tool that
 * ignores it cannot be interrupted from inside, which is exactly why the
 * engine also holds a timeout that terminates the whole worker.
 */

const inFlight = new Map<string, AbortController>();

function post(response: WorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(response, { transfer });
}

async function execute(request: Extract<WorkerRequest, { kind: 'execute' }>): Promise<void> {
  const controller = new AbortController();
  inFlight.set(request.requestId, controller);

  let result: ToolResult<ToolOutputs>;

  // Split so the reply can say which half the time went to. An import that
  // costs nothing means the chunk was already here; one that costs 40 ms is
  // the thing prefetching removes.
  const startedAt = performance.now();
  let importedAt = startedAt;

  try {
    const tool = await loadTool(request.toolId);
    importedAt = performance.now();

    /*
     * Told BEFORE the tool runs, not after: this is what lets the engine time
     * the tool's own work instead of the wall clock since the request was
     * posted. Several requests can be in flight against this one worker, and
     * a request that waited its turn must not spend its deadline waiting.
     */
    post({ kind: 'started', requestId: request.requestId });

    result = await tool.run({
      inputs: request.inputs,
      options: request.options,
      context: {
        signal: controller.signal,
        reportProgress: (fraction, label) => {
          post({
            kind: 'progress',
            requestId: request.requestId,
            fraction: Math.min(1, Math.max(0, fraction)),
            label: label ?? null,
          });
        },
      },
    });
  } catch (error) {
    // A tool is contractually forbidden from throwing. If one does anyway, the
    // failure is converted here rather than being allowed to kill the worker
    // and take every other in-flight request down with it.
    result = fail('internal', 'The tool failed unexpectedly.', {
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    inFlight.delete(request.requestId);
  }

  // Transfer any bytes back rather than copying them.
  const transfer = result.ok ? collectTransferables(Object.values(result.value)) : [];
  post(
    {
      kind: 'settled',
      requestId: request.requestId,
      result,
      timing: {
        importMs: importedAt - startedAt,
        runMs: performance.now() - importedAt,
      },
    },
    transfer,
  );
}

/**
 * REGISTERED ONCE, AND ONLY INSIDE A WORKER.
 *
 * This module is the worker's ENTRY, and it is also a shared chunk: the tool
 * chunks it dynamically imports import it back for the registry helpers that
 * Rollup happened to place here, and so does the page's own bundle. An entry
 * that doubles as a library is a module that gets evaluated in places nobody
 * meant it to be, and this one has a global side effect, so both places were
 * real:
 *
 *   - IN THE WORKER, JavaScriptCore evaluated the entry a SECOND time when a
 *     tool chunk imported it, giving `message` two listeners - so every
 *     request ran its tool TWICE. Measured over a base64 -> structured-data ->
 *     hash chain in Playwright's WebKit: two `started` and two `settled` for
 *     every one `execute`, from the first run on a fresh worker. Gecko
 *     evaluates it once and was always clean, which is why the unit suite and
 *     Firefox both said the worker was fine. Nothing was ever WRONG - a tool
 *     is a pure function, so the second answer equals the first and the engine
 *     drops it as a late reply to something already settled - it simply cost
 *     twice the CPU and twice the peak memory of every worker tool in Safari,
 *     which for a 20 MB image conversion is the whole difference.
 *
 *   - ON THE MAIN THREAD, `self` is the window, so evaluating it there put a
 *     `message` listener on the PAGE that would run a tool for anything that
 *     could `postMessage` to it. Nothing can today - the one iframe in the app
 *     is the `sandbox=""` preview, which cannot script - but a page whose
 *     entire promise is that nothing you paste leaves it should not carry an
 *     unintended global entry point to its own executor.
 *
 * The guard is on `self` rather than in module scope on purpose: two
 * evaluations are two module instances with two module scopes, and the thing
 * that must be unique is the listener on the one global they share.
 */
const scope = self as { __patchbayWorkerListening?: true };
const insideWorker = typeof WorkerGlobalScope !== 'undefined';

if (insideWorker && !scope.__patchbayWorkerListening) {
  scope.__patchbayWorkerListening = true;
  listen();
}

function listen(): void {
  self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
    const request = event.data;

    switch (request.kind) {
      case 'execute':
        // Deliberately not awaited: the worker stays responsive to `cancel`
        // messages while a tool is running.
        void execute(request);
        return;

      case 'cancel':
        inFlight.get(request.requestId)?.abort();
        inFlight.delete(request.requestId);
        return;

      case 'ping':
        // Reaching here at all is the answer: the module graph has evaluated.
        post({ kind: 'ready' });
        return;

      case 'preload':
        // Fire and forget. A failure here is not worth reporting - the execute
        // path will import the tool again and fail properly if it must.
        void loadTool(request.toolId).catch(() => undefined);
        return;
    }
  });
}
