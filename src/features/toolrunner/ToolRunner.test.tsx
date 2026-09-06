import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import {
  createExecutionEngine,
  ExecutionEngineProvider,
  type ExecutionEngine,
} from '@/features/execution';
import { getManifestEntry, loadTool, type ToolManifestEntry } from '@/features/registry';
import { expectNoAxeViolations } from '@/lib/testing/axe';

import { ToolRunner } from './ToolRunner';

/**
 * A real engine wired to run on the main thread.
 *
 * jsdom has no Worker, so `createWorker` throws loudly if anything reaches for
 * one - which also proves the main-thread path is genuinely being taken rather
 * than silently falling back.
 */
function renderRunner(entry: ToolManifestEntry) {
  const engine = createExecutionEngine({
    createWorker: () => {
      throw new Error('no worker should be created in this test');
    },
    loadTool,
    getExecutionMeta: (id) => ({ ...getManifestEntry(id).execution, strategy: 'main' }),
    setTimer: (callback, ms) => window.setTimeout(callback, ms),
    clearTimer: (handle) => {
      window.clearTimeout(handle);
    },
  });

  return render(
    <ToastProvider>
      <ExecutionEngineProvider value={engine}>
        <ToolRunner entry={entry} />
      </ExecutionEngineProvider>
    </ToastProvider>,
  );
}

/**
 * These waits carry an explicit timeout because the runner dynamically imports
 * the tool module before it can run anything. Under a full parallel suite that
 * import can take longer than Testing Library's 1s default, which showed up as
 * an intermittent failure rather than a real one.
 *
 * Raised from 5s: the suite has grown, and 5s started to be reachable on a
 * loaded machine. A generous ceiling costs nothing when the wait succeeds -
 * `waitFor` returns as soon as the condition holds - and the only thing a
 * tight one buys is a flaky test.
 *
 * SLOW_TEST has to exceed it, or the test is killed before the wait can
 * report anything useful - which is how "the import was slow" presented as
 * "Test timed out in 20000ms" with no clue which assertion was waiting.
 */
/**
 * The tool modules are loaded ONCE, before any test is timed.
 *
 * They arrive through a dynamic import, and the first one in a worker pays for
 * transforming the module and everything it pulls in - structured-data brings
 * zod and yaml with it. Under a full parallel suite that cold import was
 * taking upwards of twenty seconds on a loaded machine, and because it
 * happened INSIDE a `waitFor` the test failed for looking slow rather than for
 * being wrong.
 *
 * Warming them here moves that cost outside the assertions, where it belongs.
 */
beforeAll(async () => {
  await Promise.all([loadTool('base64'), loadTool('structured-data'), loadTool('image-convert')]);
}, 120_000);

const IMPORT_TIMEOUT = { timeout: 20_000 };
const SLOW_TEST = 60_000;

const base64 = getManifestEntry('base64');
const structured = getManifestEntry('structured-data');

describe('ToolRunner', () => {
  it(
    'runs a tool and shows its output',
    async () => {
      const user = userEvent.setup();
      renderRunner(base64);

      await user.type(screen.getByRole('textbox', { name: 'Base64 input' }), 'foobar');
      await user.click(screen.getByRole('button', { name: 'Run' }));

      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: 'Base64 Output' })).toHaveValue('Zm9vYmFy');
      }, IMPORT_TIMEOUT);
    },
    SLOW_TEST,
  );

  it(
    'announces completion through the live region',
    async () => {
      const user = userEvent.setup();
      renderRunner(base64);

      await user.type(screen.getByRole('textbox', { name: 'Base64 input' }), 'hi');
      await user.click(screen.getByRole('button', { name: 'Run' }));

      // The toast viewport is the live region built earlier; results are
      // announced there rather than being visual-only.
      await waitFor(() => {
        expect(screen.getByText('Base64 finished')).toBeInTheDocument();
      }, IMPORT_TIMEOUT);
    },
    SLOW_TEST,
  );

  it('renders a parse error with its position', async () => {
    const user = userEvent.setup();
    renderRunner(base64);

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Mode' })).toBeInTheDocument();
    }, IMPORT_TIMEOUT);

    // Switch to decode, then feed it something that is not base64.
    await user.click(screen.getByRole('combobox', { name: 'Mode' }));
    await user.click(await screen.findByRole('option', { name: 'Decode' }));
    await user.type(screen.getByRole('textbox', { name: 'Base64 input' }), '!!!!');
    await user.click(screen.getByRole('button', { name: 'Run' }));

    // Twice on purpose: once in the error panel, once in the toast live region.
    // Errors are announced as well as drawn, never visual-only.
    await waitFor(() => {
      expect(screen.getAllByText(/is not a valid base64 character/)).toHaveLength(2);
    }, IMPORT_TIMEOUT);
    expect(screen.getByText(/Line 1, column 1/)).toBeInTheDocument();
    expect(screen.getByText(/Code: parse-error/)).toBeInTheDocument();
  });

  it(
    'shows both outputs for a tool that declares two ports',
    async () => {
      const user = userEvent.setup();
      renderRunner(structured);

      await user.type(screen.getByRole('textbox', { name: 'Structured data input' }), '{{"a": 1}');
      await user.click(screen.getByRole('button', { name: 'Run' }));

      // BOTH assertions inside the wait. The second one used to sit outside it,
      // so a run where the two outputs landed on different ticks failed on the
      // one that had not arrived yet - which is a race in the test rather than
      // anything the runner did wrong.
      await waitFor(() => {
        expect(
          screen.getByRole('textbox', { name: 'Structured data Converted' }),
        ).toBeInTheDocument();
        expect(
          screen.getByRole('textbox', { name: 'Structured data Parsed data' }),
        ).toBeInTheDocument();
      }, IMPORT_TIMEOUT);
    },
    SLOW_TEST,
  );

  it('has no axe violations once a result is on screen', async () => {
    const user = userEvent.setup();
    const { container } = renderRunner(base64);

    await user.type(screen.getByRole('textbox', { name: 'Base64 input' }), 'hi');
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Base64 Output' })).toBeInTheDocument();
    }, IMPORT_TIMEOUT);

    await expectNoAxeViolations(container);
  });
});

/* -------------------------------------------------------------------------- *
 * THE BEHAVIOURS THE LAYOUT REWORK WAS NOT ALLOWED TO BREAK
 *
 * Moving Run out of the Input panel, reordering the four regions and dropping
 * the dead textarea on a bytes-only port all touch this component's wiring
 * rather than only its CSS. Each of the following was working, was checked by
 * hand, and had no test of its own - which is the definition of something that
 * regresses quietly. They are named for the behaviour rather than for the
 * change, because that is what a future reader needs.
 * -------------------------------------------------------------------------- */

describe('the tool runner, once its layout moved', () => {
  it(
    'still runs on a dropped file rather than on the text box',
    async () => {
      const user = userEvent.setup();
      renderRunner(base64);

      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: 'Mode' })).toBeInTheDocument();
      }, IMPORT_TIMEOUT);

      // The real <input type="file"> is the control; the styled label is its
      // label and the drop zone is a pointer convenience over the top.
      const chooser = screen.getByLabelText('Choose file');
      await user.upload(chooser, new File(['hello'], 'greeting.txt', { type: 'text/plain' }));

      // The file is named back to the user, with what the BYTES say it is.
      expect(await screen.findByText('greeting.txt')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Run' }));

      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: 'Base64 Output' })).toHaveValue('aGVsbG8=');
      }, IMPORT_TIMEOUT);
    },
    SLOW_TEST,
  );

  it(
    'still copies the output to the clipboard, and says so',
    async () => {
      const user = userEvent.setup();
      renderRunner(base64);

      await user.type(screen.getByRole('textbox', { name: 'Base64 input' }), 'hi');
      await user.click(screen.getByRole('button', { name: 'Run' }));
      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: 'Base64 Output' })).toBeInTheDocument();
      }, IMPORT_TIMEOUT);

      await user.click(screen.getByRole('button', { name: 'Copy' }));

      // The clipboard itself, not just the notification: a write that silently
      // did nothing is the failure mode worth catching.
      await waitFor(async () => {
        expect(await navigator.clipboard.readText()).toBe('aGk=');
      });
      expect(await screen.findByText('Copied')).toBeInTheDocument();
    },
    SLOW_TEST,
  );

  it(
    'still downloads the output as a named file, and says so',
    async () => {
      const user = userEvent.setup();

      // jsdom has neither of these, and clicking a real anchor would try to
      // navigate. Captured rather than merely silenced, because the filename
      // and the media type are the part that matters.
      const blobs: Blob[] = [];
      const clicked: { href: string; download: string }[] = [];
      vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
        blobs.push(blob as Blob);
        return 'blob:test';
      });
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function mockClick(
        this: HTMLAnchorElement,
      ) {
        clicked.push({ href: this.href, download: this.download });
      });

      try {
        renderRunner(base64);

        await user.type(screen.getByRole('textbox', { name: 'Base64 input' }), 'hi');
        await user.click(screen.getByRole('button', { name: 'Run' }));
        await waitFor(() => {
          expect(screen.getByRole('textbox', { name: 'Base64 Output' })).toBeInTheDocument();
        }, IMPORT_TIMEOUT);

        await user.click(screen.getByRole('button', { name: 'Download' }));

        expect(clicked).toEqual([{ href: 'blob:test', download: 'base64.txt' }]);
        expect(blobs[0]?.type).toBe('text/plain;charset=utf-8');
        expect(await screen.findByText('base64.txt')).toBeInTheDocument();
      } finally {
        vi.restoreAllMocks();
      }
    },
    SLOW_TEST,
  );
});

/* -------------------------------------------------------------------------- *
 * The busy state and cancellation
 * -------------------------------------------------------------------------- */

/**
 * An engine whose one run never finishes unless the test lets it.
 *
 * The real engine on the main-thread path settles in under a millisecond,
 * which is exactly wrong for asserting anything about the state in between.
 * This holds the run open so the busy readout, the progress bar, the disabled
 * Run button and the Cancel button beside it can all be looked at - and then
 * resolves with `cancelled` when the signal aborts, which is what a worker
 * does.
 */
function deferredEngine(): ExecutionEngine {
  return {
    execute: ({ signal }) =>
      new Promise((resolve) => {
        signal?.addEventListener('abort', () => {
          resolve({ ok: false, error: { code: 'cancelled', message: 'Cancelled.' } });
        });
      }),
    warmUp: () => undefined,
    prefetch: () => undefined,
    dispose: () => undefined,
  };
}

function renderBusyRunner(entry: ToolManifestEntry) {
  return render(
    <ToastProvider>
      <ExecutionEngineProvider value={deferredEngine()}>
        <ToolRunner entry={entry} />
      </ExecutionEngineProvider>
    </ToastProvider>,
  );
}

describe('a run in flight', () => {
  it(
    'shows a busy status with a progress bar, and offers Cancel beside Run',
    async () => {
      const user = userEvent.setup();
      renderBusyRunner(base64);

      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: 'Mode' })).toBeInTheDocument();
      }, IMPORT_TIMEOUT);

      await user.click(screen.getByRole('button', { name: 'Run' }));

      // role="status" rather than a bare div: the busy state is announced as
      // well as drawn, and aria-busy lets AT describe the region as in progress.
      const status = await screen.findByRole('status');
      expect(status).toHaveAttribute('aria-busy', 'true');
      expect(screen.getByRole('progressbar', { name: 'Progress' })).toBeInTheDocument();

      // Run is unavailable while it runs, and Cancel takes its place beside it
      // - in the same region, so a keyboard user does not have to go looking.
      expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    },
    SLOW_TEST,
  );

  it(
    'cancels on request, and announces the cancellation as a warning',
    async () => {
      const user = userEvent.setup();
      renderBusyRunner(base64);

      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: 'Mode' })).toBeInTheDocument();
      }, IMPORT_TIMEOUT);

      await user.click(screen.getByRole('button', { name: 'Run' }));
      await user.click(await screen.findByRole('button', { name: 'Cancel' }));

      // "Cancelled", not "Base64 failed": a cancellation is something the user
      // asked for, and reporting it as a failure is how a tool cries wolf.
      expect(await screen.findByText('Cancelled')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
      });
      expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    },
    SLOW_TEST,
  );
});

/* -------------------------------------------------------------------------- *
 * A port that cannot take typed text
 * -------------------------------------------------------------------------- */

describe('an input port that only accepts bytes', () => {
  /*
   * `image-convert` declares `types: ['bytes']`, and the runner used to give
   * every port a full-size editor regardless. Typing into it could only ever
   * produce `Input "Image" cannot accept text data` - an affordance for
   * behaviour that does not exist, which CONTRIBUTING names as a defect in its
   * own right and which this repo has now found five times.
   */
  it('offers no text box at all, and says what to do instead', async () => {
    renderRunner(getManifestEntry('image-convert'));

    // The port's description, promoted from a placeholder nobody could act on
    // to the instruction for the control that IS there.
    expect(
      await screen.findByText(
        /A PNG, JPEG, GIF or WebP file\. The format is read from the bytes\./,
      ),
    ).toBeInTheDocument();

    expect(screen.queryByRole('textbox', { name: 'Image input' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Choose file')).toBeInTheDocument();
  });

  it('refuses to run empty by naming the fix rather than the type error', async () => {
    const user = userEvent.setup();
    renderRunner(getManifestEntry('image-convert'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
    }, IMPORT_TIMEOUT);

    await user.click(screen.getByRole('button', { name: 'Run' }));

    expect(
      await screen.findByText(/Image takes a file\. Choose or drop one first\./),
    ).toBeInTheDocument();
  });
});
