import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ToolId } from '@/features/registry/manifest';
import type { ToolError, ToolInputs, ToolOutputs } from '@/features/registry/types';

import { createDefaultEngine, type ExecutionEngine } from './engine';

/**
 * The execution state machine, as a discriminated union.
 *
 * Tagging on `status` means the impossible states cannot be represented: there
 * is no way to hold an error and outputs at once, and no way to read `outputs`
 * without having checked that the run actually succeeded.
 */
export type ExecutionState =
  | { readonly status: 'idle' }
  | { readonly status: 'running'; readonly progress: number | null; readonly label: string | null }
  | { readonly status: 'success'; readonly outputs: ToolOutputs; readonly durationMs: number }
  | { readonly status: 'error'; readonly error: ToolError };

const ExecutionEngineContext = createContext<ExecutionEngine | null>(null);

export const ExecutionEngineProvider = ExecutionEngineContext.Provider;

/**
 * One engine, and therefore one worker, shared by the whole app.
 *
 * Created lazily on first use. Constructing the engine does NOT construct a
 * Worker - that happens on the first run - so this is safe to evaluate in a
 * test environment that has no Worker at all.
 */
let sharedEngine: ExecutionEngine | null = null;

function getSharedEngine(): ExecutionEngine {
  sharedEngine ??= createDefaultEngine();
  return sharedEngine;
}

export function useExecutionEngine(): ExecutionEngine {
  return use(ExecutionEngineContext) ?? getSharedEngine();
}

export interface UseToolExecutionResult {
  readonly state: ExecutionState;
  readonly run: (inputs: ToolInputs, options: unknown) => void;
  readonly cancel: () => void;
  readonly reset: () => void;
  readonly isBusy: boolean;
}

export function useToolExecution(toolId: ToolId): UseToolExecutionResult {
  const engine = useExecutionEngine();
  const [state, setState] = useState<ExecutionState>({ status: 'idle' });

  // Held in a ref rather than state: aborting must not wait for a render, and
  // the controller is machinery, not something the UI draws.
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    setState({ status: 'idle' });
  }, []);

  const run = useCallback(
    (inputs: ToolInputs, options: unknown) => {
      // A new run supersedes whatever was in flight.
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      setState({ status: 'running', progress: null, label: null });
      const startedAt = performance.now();

      void engine
        .execute({
          toolId,
          inputs,
          options,
          signal: controller.signal,
          onProgress: (progress, label) => {
            if (!mountedRef.current || controller.signal.aborted) return;
            setState({ status: 'running', progress, label });
          },
        })
        .then((result) => {
          if (!mountedRef.current) return;
          setState(
            result.ok
              ? {
                  status: 'success',
                  outputs: result.value,
                  durationMs: performance.now() - startedAt,
                }
              : { status: 'error', error: result.error },
          );
        });
    },
    [engine, toolId],
  );

  return useMemo(
    () => ({ state, run, cancel, reset, isBusy: state.status === 'running' }),
    [state, run, cancel, reset],
  );
}
