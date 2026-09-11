import type { ToolId } from '@/features/registry/manifest';
import type { ToolInputs, ToolOutputs, ToolResult, ToolValue } from '@/features/registry/types';
import { binarySize, residentBytes } from '@/lib/binary';

/**
 * The worker message protocol.
 *
 * Both directions are discriminated unions tagged on `kind`, so a handler that
 * forgets a case is a compile error rather than a message silently dropped on
 * the floor. Nothing here is `any`, and nothing is posted that is not one of
 * these shapes.
 */

export interface ExecuteRequest {
  readonly kind: 'execute';
  /** Correlates this request with its responses. */
  readonly requestId: string;
  readonly toolId: ToolId;
  readonly inputs: ToolInputs;
  readonly options: unknown;
}

export interface CancelRequest {
  readonly kind: 'cancel';
  readonly requestId: string;
}

/**
 * "Are you up yet?"
 *
 * Constructing a Worker starts fetching and evaluating its module graph, but
 * says nothing about when that finished. A round trip is the only way to know,
 * and knowing is what lets the canvas pay for the boot on mount instead of on
 * the user's first run.
 */
export interface PingRequest {
  readonly kind: 'ping';
}

/**
 * "Import this tool now, you will need it shortly."
 *
 * The worker has its own module registry, so a tool imported on the main
 * thread is still a fresh import inside the worker. Sent when a node is added
 * to the canvas - a deliberate act by the user, not a guess.
 */
export interface PreloadRequest {
  readonly kind: 'preload';
  readonly toolId: ToolId;
}

export type WorkerRequest = ExecuteRequest | CancelRequest | PingRequest | PreloadRequest;

export interface ProgressResponse {
  readonly kind: 'progress';
  readonly requestId: string;
  /** 0 to 1. */
  readonly fraction: number;
  readonly label: string | null;
}

/**
 * Where a run's time actually went, measured inside the worker.
 *
 * Durations rather than timestamps: a worker's `performance.now()` is measured
 * from its own time origin, so its clock readings mean nothing on the main
 * thread. Durations survive the trip.
 */
export interface RunTiming {
  /** Fetching and evaluating the tool's chunk. Zero once it is cached. */
  readonly importMs: number;
  /** The tool's own work. */
  readonly runMs: number;
}

/**
 * "I have the tool, I am starting the work now."
 *
 * Sent between the import and the tool's first instruction. The engine uses it
 * to re-arm the timeout, so a tool's deadline measures ITS OWN work rather
 * than the time its request spent queued behind other requests in the one
 * shared worker. Without this a 2s regex queued behind a 40s image conversion
 * reports a timeout it never had - the clock ran while it was not running.
 */
export interface StartedResponse {
  readonly kind: 'started';
  readonly requestId: string;
}

export interface SettledResponse {
  readonly kind: 'settled';
  readonly requestId: string;
  readonly result: ToolResult<ToolOutputs>;
  readonly timing: RunTiming;
}

/** Sent once, in reply to a ping, when the worker's module graph is live. */
export interface ReadyResponse {
  readonly kind: 'ready';
}

export type WorkerResponse = ProgressResponse | StartedResponse | SettledResponse | ReadyResponse;

/**
 * Collects the ArrayBuffers inside a set of values so they can be TRANSFERRED
 * rather than copied.
 *
 * A structured clone of a 30 MB buffer allocates and copies 30 MB. Transferring
 * moves ownership instead: the receiving side gets the same memory and the
 * sending side's view is detached. That makes it near-free, and it is why the
 * engine documents binary inputs as consumed by the call.
 *
 * SharedArrayBuffer is deliberately skipped - it is shared, not transferable,
 * and attempting to transfer one throws.
 */
export function collectTransferables(values: Iterable<ToolValue | undefined>): Transferable[] {
  const transferables: Transferable[] = [];

  for (const value of values) {
    if (value === undefined) continue;
    if (value.type !== 'bytes') continue;

    /*
     * A DEFERRED VALUE CONTRIBUTES NOTHING HERE, and needs to contribute
     * nothing: a Blob crosses `postMessage` by reference already, so there is
     * no copy for a transfer to save and no buffer for it to detach. The
     * values this list exists for are the resident ones.
     */
    const bytes = residentBytes(value.data);
    if (bytes === null) continue;

    const buffer = bytes.buffer;
    if (buffer instanceof ArrayBuffer && !transferables.includes(buffer)) {
      transferables.push(buffer);
    }
  }

  return transferables;
}

/** Total byte weight of a set of inputs, for the size guard. */
export function measureInputs(inputs: ToolInputs): number {
  let total = 0;

  for (const value of Object.values(inputs)) {
    if (value === undefined) continue;
    switch (value.type) {
      case 'text':
        // Two bytes per UTF-16 code unit is an upper bound, and cheaper than
        // encoding the whole string just to weigh it.
        total += value.text.length * 2;
        break;
      case 'bytes':
        // Read off the value rather than out of it. A deferred value knows its
        // own size without anything having to touch the bytes, which is what
        // makes the engine's size guard free for a four-gigabyte input.
        total += binarySize(value.data);
        break;
      case 'json':
        total += JSON.stringify(value.data).length * 2;
        break;
      case 'color':
        total += 32;
        break;
    }
  }

  return total;
}
