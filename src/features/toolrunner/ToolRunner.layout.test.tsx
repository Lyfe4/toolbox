import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import { createExecutionEngine, ExecutionEngineProvider } from '@/features/execution';
import { getManifestEntry, loadTool, type ToolManifestEntry } from '@/features/registry';

import { ToolRunner } from './ToolRunner';

/*
 * The stylesheet as TEXT. `import.meta.glob` with `?raw` is how
 * token-layering.test.ts reads stylesheets too - jsdom does not parse CSS
 * modules, and the point here is what somebody wrote rather than what a
 * browser computed.
 */
const runnerCss =
  Object.values(
    import.meta.glob<string>('./runner.module.css', {
      query: '?raw',
      import: 'default',
      eager: true,
    }),
  )[0] ?? '';

/**
 * THE ORDER OF THE PAGE, WHICH IS THE WHOLE POINT OF ITS LAYOUT.
 *
 * The options used to come after the output in source order, and the CSS then
 * drew them in a right-hand column. That was two bugs wearing one coat:
 *
 *   - Stacked, below 1000px, the options were literally below the result. To
 *     change one flag you scrolled past an arbitrarily long output, changed
 *     it, and scrolled back up to see what happened.
 *   - Side by side, above 1000px, the eye read Input, Options, Output while
 *     Tab and a screen reader went Input, Output, Options. Nothing looked
 *     wrong, so nothing was reported.
 *
 * The fix is source order, not `order`. These tests assert the source order
 * and the tab order that follows from it - both of which jsdom CAN see -
 * while the geometry that follows from it (which it cannot) is asserted at
 * four widths in scripts/cross-browser-check.mjs.
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

const IMPORT_TIMEOUT = { timeout: 20_000 };
const SLOW_TEST = 60_000;

beforeAll(async () => {
  await loadTool('base64');
}, 120_000);

const base64 = getManifestEntry('base64');

/** Every focusable control, in the order the browser would Tab through them. */
function tabOrder(container: HTMLElement): readonly HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ];
}

describe('the tool runner layout', () => {
  it('puts the options before the output in the DOM, not merely beside it', async () => {
    renderRunner(base64);

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Mode' })).toBeInTheDocument();
    }, IMPORT_TIMEOUT);

    /*
     * Panel names its region from its own <h2>, so this is simultaneously the
     * heading order, the landmark order and the source order.
     */
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Input', 'Options', 'Output', 'Ports']);

    // Stated a second way, because the list above would still pass if the two
    // panels were nested rather than siblings.
    const options = screen.getByRole('region', { name: 'Options' });
    const output = screen.getByRole('region', { name: 'Output' });
    expect(options.compareDocumentPosition(output) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it(
    'walks Tab from the options through Run and only then into the output',
    async () => {
      const user = userEvent.setup();
      const { container } = renderRunner(base64);

      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: 'Mode' })).toBeInTheDocument();
      }, IMPORT_TIMEOUT);

      await user.type(screen.getByRole('textbox', { name: 'Base64 input' }), 'hi');
      await user.click(screen.getByRole('button', { name: 'Run' }));
      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: 'Base64 Output' })).toBeInTheDocument();
      }, IMPORT_TIMEOUT);

      const order = tabOrder(container);
      const at = (element: HTMLElement): number => order.indexOf(element);

      const mode = at(screen.getByRole('combobox', { name: 'Mode' }));
      const run = at(screen.getByRole('button', { name: 'Run' }));
      const output = at(screen.getByRole('textbox', { name: 'Base64 Output' }));
      const copy = at(screen.getByRole('button', { name: 'Copy' }));

      expect(mode).toBeGreaterThan(-1);
      // Run AFTER the options is what makes the narrow layout work at all:
      // change a flag, then reach the button, without going back up the page.
      expect(run).toBeGreaterThan(mode);
      // And the output after both, so nothing has to be scrolled past twice.
      expect(output).toBeGreaterThan(run);
      expect(copy).toBeGreaterThan(output);
    },
    SLOW_TEST,
  );

  it('uses no positive tabindex, so the DOM order IS the tab order', async () => {
    const { container } = renderRunner(base64);

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Mode' })).toBeInTheDocument();
    }, IMPORT_TIMEOUT);

    const positive = [...container.querySelectorAll('[tabindex]')].filter(
      (element) => Number(element.getAttribute('tabindex')) > 0,
    );
    expect(positive).toEqual([]);
  });

  /*
   * A GUARD AGAINST THE FIX BEING UNDONE THE EASY WAY.
   *
   * Every property below can move a box on screen without moving it in the
   * DOM, which is exactly the desync this layout was rewritten to remove -
   * and each is a one-line change that looks like a tidy-up in review.
   */
  it('reorders nothing in CSS', () => {
    // Comments hold the words "order" and "reverse" on purpose; strip them.
    const declarations = runnerCss.replaceAll(/\/\*[\s\S]*?\*\//g, '');

    expect(declarations).not.toMatch(/(^|[;{\s])order\s*:/);
    expect(declarations).not.toMatch(/-reverse/);
    expect(declarations).not.toMatch(/direction\s*:\s*rtl/);
    // `grid-template-areas` is not banned, but a named area whose rows are
    // written out of source order is the same trick. None is used today.
    expect(declarations).not.toMatch(/grid-template-areas/);
  });
});
