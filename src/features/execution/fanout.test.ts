import { describe, expect, it } from 'vitest';

import { getManifestEntry, loadTool, type ToolId } from '@/features/registry';
import type { Bytes, ToolOutputs, ToolResult } from '@/features/registry/types';

import { createExecutionEngine, type ExecutionEngine } from './engine';

/**
 * Fan-out is the case the canvas creates and the single-tool page never did:
 * one binary output feeding two different inputs.
 *
 * Under the old always-transfer behaviour the first consumer detached the
 * buffer and the second silently received zero bytes. These tests pin the
 * borrow-by-default contract so that cannot come back.
 */
function makeEngine(): ExecutionEngine {
  return createExecutionEngine({
    createWorker: () => {
      throw new Error('no worker in jsdom');
    },
    loadTool,
    // Main-thread strategy so the run is synchronous and the assertion is
    // about ownership, not about worker plumbing.
    getExecutionMeta: (id) => ({ ...getManifestEntry(id).execution, strategy: 'main' }),
    setTimer: (callback, ms) => window.setTimeout(callback, ms),
    clearTimer: (handle) => {
      window.clearTimeout(handle);
    },
  });
}

function textOf(result: ToolResult<ToolOutputs>, port: string): string {
  if (!result.ok) throw new Error(`expected success, got ${result.error.message}`);
  const value = result.value[port];
  if (value?.type !== 'text') throw new Error(`expected text on ${port}`);
  return value.text;
}

const BASE64: ToolId = 'base64';

describe('binary fan-out', () => {
  it('lets one Uint8Array feed two runs with intact data', async () => {
    const engine = makeEngine();
    const bytes: Bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    const original = Array.from(bytes);

    const first = await engine.execute({
      toolId: BASE64,
      inputs: { input: { type: 'bytes', bytes, mediaType: null, filename: null } },
      options: { mode: 'encode' },
    });

    // The buffer must still be alive after the first consumer.
    expect(bytes.byteLength).toBe(6);
    expect(Array.from(bytes)).toEqual(original);

    const second = await engine.execute({
      toolId: BASE64,
      inputs: { input: { type: 'bytes', bytes, mediaType: null, filename: null } },
      options: { mode: 'encode', urlSafe: true },
    });

    // Both consumers saw the same six bytes, not an empty view.
    expect(textOf(first, 'output')).toBe('3q2+7wD/');
    expect(textOf(second, 'output')).toBe('3q2-7wD_');
  });

  it('survives three consumers, the last as intact as the first', async () => {
    const engine = makeEngine();
    const bytes: Bytes = new Uint8Array([1, 2, 3]);

    const results = await Promise.all(
      [0, 1, 2].map(() =>
        engine.execute({
          toolId: BASE64,
          inputs: { input: { type: 'bytes', bytes, mediaType: null, filename: null } },
          options: { mode: 'encode' },
        }),
      ),
    );

    for (const result of results) expect(textOf(result, 'output')).toBe('AQID');
    expect(bytes.byteLength).toBe(3);
  });

  it('defaults to borrow, so no caller has to know about ownership', async () => {
    const engine = makeEngine();
    const bytes: Bytes = new Uint8Array([7, 7, 7]);

    await engine.execute({
      toolId: BASE64,
      // No `ownership` given at all.
      inputs: { input: { type: 'bytes', bytes, mediaType: null, filename: null } },
      options: { mode: 'encode' },
    });

    expect(bytes.byteLength).toBe(3);
  });
});
