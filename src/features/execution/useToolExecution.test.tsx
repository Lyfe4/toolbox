import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ToolOutputs, ToolResult } from '@/features/registry/types';

import { ExecutionEngineProvider, useToolExecution } from './useToolExecution';

import type { ExecutionEngine } from './engine';

/**
 * An engine whose runs settle only when the test says so, in any order.
 *
 * The ordering is the whole point: a worker run settles the moment it is
 * aborted, so the stale result always happened to arrive first and the bug
 * below was invisible. A main-thread tool cannot be interrupted from outside -
 * it keeps going and settles whenever it finishes, which can be after the run
 * that replaced it.
 */
function deferredEngine() {
  const settlers: ((result: ToolResult<ToolOutputs>) => void)[] = [];

  const engine: ExecutionEngine = {
    // Deliberately reads no options. The abort signal is one of them, and a
    // synchronous main-thread tool cannot be interrupted from outside: it
    // keeps going and settles whenever it finishes. `ExecutionEngine` on the
    // binding above is what checks the shape, so declaring no parameter at all
    // is still the same engine.
    execute: () =>
      new Promise<ToolResult<ToolOutputs>>((resolve) => {
        settlers.push(resolve);
      }),
    warmUp: () => undefined,
    prefetch: () => undefined,
    dispose: () => undefined,
  };

  return {
    engine,
    settle: (index: number, text: string): void => {
      settlers[index]?.({ ok: true, value: { output: { type: 'text', text } } });
    },
    cancel: (index: number): void => {
      settlers[index]?.({ ok: false, error: { code: 'cancelled', message: 'Cancelled.' } });
    },
    count: (): number => settlers.length,
  };
}

function Probe({ onReady }: { readonly onReady: (run: () => void) => void }) {
  const { state, run } = useToolExecution('base64');
  onReady(() => {
    run({ input: { type: 'text', text: 'x' } }, {});
  });

  return (
    <p data-testid="state">
      {state.status === 'success'
        ? `ok:${state.outputs.output?.type === 'text' ? state.outputs.output.text : ''}`
        : state.status === 'error'
          ? `error:${state.error.code}`
          : state.status}
    </p>
  );
}

describe('a superseded single-tool run', () => {
  /*
   * THE BUG THIS CATCHES.
   *
   * Starting a run aborts the one before it, and the old run's result was
   * still written to state when it eventually arrived. On the worker path that
   * was harmless: aborting settles the request immediately, so the stale
   * result always landed first and was overwritten a moment later by the new
   * one.
   *
   * A main-thread tool has no such guarantee. It keeps running, finishes after
   * the run that replaced it, and its "Cancelled." then painted over a correct
   * result that was already on screen. Every tool with `strategy: 'main'` -
   * and every worker tool on a browser that has been downgraded to the main
   * thread - takes that path.
   */
  it('ignores the older run when it settles after the newer one', async () => {
    const engine = deferredEngine();
    let start = (): void => undefined;

    render(
      <ExecutionEngineProvider value={engine.engine}>
        <Probe
          onReady={(run) => {
            start = run;
          }}
        />
      </ExecutionEngineProvider>,
    );

    await act(async () => {
      start();
      await Promise.resolve();
    });
    await act(async () => {
      // Supersedes the first, which aborts it but cannot stop it.
      start();
      await Promise.resolve();
    });
    expect(engine.count()).toBe(2);

    // The newer run finishes first...
    await act(async () => {
      engine.settle(1, 'newer');
      await Promise.resolve();
    });
    expect(screen.getByTestId('state')).toHaveTextContent('ok:newer');

    // ...and the older one settles afterwards, as cancelled.
    await act(async () => {
      engine.cancel(0);
      await Promise.resolve();
    });
    expect(screen.getByTestId('state')).toHaveTextContent('ok:newer');
  });

  it('still shows the newest run when the results arrive in order', async () => {
    const engine = deferredEngine();
    let start = (): void => undefined;

    render(
      <ExecutionEngineProvider value={engine.engine}>
        <Probe
          onReady={(run) => {
            start = run;
          }}
        />
      </ExecutionEngineProvider>,
    );

    await act(async () => {
      start();
      await Promise.resolve();
    });
    await act(async () => {
      start();
      await Promise.resolve();
    });
    await act(async () => {
      engine.cancel(0);
      await Promise.resolve();
    });
    await act(async () => {
      engine.settle(1, 'newer');
      await Promise.resolve();
    });

    expect(screen.getByTestId('state')).toHaveTextContent('ok:newer');
  });
});
