import type { ToolId } from '@/features/registry/manifest';
import type { ToolInputs, ToolOutputs, ToolResult, ToolValue } from '@/features/registry/types';

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

export type WorkerRequest = ExecuteRequest | CancelRequest;

export interface ProgressResponse {
  readonly kind: 'progress';
  readonly requestId: string;
  /** 0 to 1. */
  readonly fraction: number;
  readonly label: string | null;
}

export interface SettledResponse {
  readonly kind: 'settled';
  readonly requestId: string;
  readonly result: ToolResult<ToolOutputs>;
}

export type WorkerResponse = ProgressResponse | SettledResponse;

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

    const buffer = value.bytes.buffer;
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
        total += value.bytes.byteLength;
        break;
      case 'image':
        total += value.blob.size;
        break;
      case 'json':
        total += JSON.stringify(value.data).length * 2;
        break;
      case 'color':
      case 'datetime':
        total += 32;
        break;
    }
  }

  return total;
}
