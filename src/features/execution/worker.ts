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

  try {
    const tool = await loadTool(request.toolId);

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
  post({ kind: 'settled', requestId: request.requestId, result }, transfer);
}

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
  }
});
