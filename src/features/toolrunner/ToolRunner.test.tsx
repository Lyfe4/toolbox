import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import { createExecutionEngine, ExecutionEngineProvider } from '@/features/execution';
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
 */
const IMPORT_TIMEOUT = { timeout: 5000 };

const base64 = getManifestEntry('base64');
const structured = getManifestEntry('structured-data');

describe('ToolRunner', () => {
  it('runs a tool and shows its output', async () => {
    const user = userEvent.setup();
    renderRunner(base64);

    await user.type(screen.getByRole('textbox', { name: 'Base64 input' }), 'foobar');
    await user.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Base64 Output' })).toHaveValue('Zm9vYmFy');
    }, IMPORT_TIMEOUT);
  });

  it('announces completion through the live region', async () => {
    const user = userEvent.setup();
    renderRunner(base64);

    await user.type(screen.getByRole('textbox', { name: 'Base64 input' }), 'hi');
    await user.click(screen.getByRole('button', { name: 'Run' }));

    // The toast viewport is the live region built earlier; results are
    // announced there rather than being visual-only.
    await waitFor(() => {
      expect(screen.getByText('Base64 finished')).toBeInTheDocument();
    }, IMPORT_TIMEOUT);
  });

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

  it('shows both outputs for a tool that declares two ports', async () => {
    const user = userEvent.setup();
    renderRunner(structured);

    await user.type(screen.getByRole('textbox', { name: 'Structured data input' }), '{{"a": 1}');
    await user.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => {
      expect(
        screen.getByRole('textbox', { name: 'Structured data Converted' }),
      ).toBeInTheDocument();
    }, IMPORT_TIMEOUT);
    expect(
      screen.getByRole('textbox', { name: 'Structured data Parsed data' }),
    ).toBeInTheDocument();
  });

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
