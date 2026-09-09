import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import { createExecutionEngine, ExecutionEngineProvider } from '@/features/execution';
import type * as registry from '@/features/registry';
import {
  getManifestEntry,
  loadTool,
  type ToolId,
  type ToolManifestEntry,
} from '@/features/registry';
import type { ErasedTool, OptionField } from '@/features/registry/types';
import { expectNoAxeViolations } from '@/lib/testing/axe';

import { ToolRunner } from './ToolRunner';

/**
 * THE ONE SEAM THIS FILE NEEDS: what option fields a tool declares.
 *
 * `ToolRunner` reads them from `loadTool`, so that is what is replaced - and
 * only that. `importOriginal` keeps the rest of the registry real, because the
 * manifest entry still has to describe genuine ports for the input panel to
 * render at all.
 *
 * `vi.hoisted` rather than a plain const: `vi.mock` is hoisted above the
 * imports and its factory runs while the mocked module is first imported,
 * before any module-level `const` in this file has been initialised. A
 * reference to an ordinary binding from inside the factory is a
 * use-before-definition that fails at import time.
 *
 * Null means "the real fields", so every other test in this file is untouched.
 */
const fixture = vi.hoisted(() => ({
  optionFields: null as readonly unknown[] | null,
}));

vi.mock('@/features/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof registry>();
  return {
    ...actual,
    loadTool: async (id: ToolId): Promise<ErasedTool> => {
      const real = await actual.loadTool(id);
      if (fixture.optionFields === null) return real;
      return {
        ...real,
        optionFields: fixture.optionFields as readonly OptionField<Record<string, unknown>>[],
      };
    },
  };
});

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

/* ========================================================================== *
 * THE STICKY RAIL'S OWN LAYOUT REGION
 * ========================================================================== */

/**
 * WHAT THE RAIL WAS ALLOWED TO PAINT OVER, AND WHY.
 *
 * The options rail is `position: sticky`, and a sticky box's travel is bounded
 * by its containing block. For a grid item that containing block is the grid
 * CONTAINER, not the grid area it was placed in - which is the opposite of the
 * intuitive reading, and it is why the rail spanning "only" the two content
 * rows never constrained it to them. The Ports footnote used to be a third,
 * full-bleed row of the same grid, so it sat inside the rail's travel range:
 * scrolled to the foot of a JWT page the rail covered 52px of it, and from
 * there down its bottom edge tracked the grid's bottom edge exactly.
 *
 * The fix is that `.layout` now holds only the three regions the rail travels
 * beside. Everything a tool page renders below them is a sibling in the page's
 * flow, outside the rail's containing block, where the rail has no permission
 * to go.
 *
 * WHAT THESE TESTS CAN AND CANNOT SEE. jsdom has no layout engine, so every
 * box here is zero by zero and "does the rail overlap the footnote" is not a
 * question it can answer. What it CAN answer is the structural fact the
 * geometry follows from - which regions are inside the sticky box's containing
 * block - and that is the thing a future change would break. The geometry
 * itself is measured at seven widths and four scroll positions in
 * `scripts/cross-browser-check.mjs`.
 */

/** The two-column region: the grid the rail is sticky inside. */
function layoutRegion(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>('[class*="layout"]');
  if (!found) throw new Error('no layout region rendered');
  return found;
}

const headingOf = (element: Element): string =>
  element.querySelector('h2')?.textContent.trim() ?? '(untitled)';

describe("the sticky rail's containing block", () => {
  it('holds only the three regions the rail travels beside', async () => {
    const { container } = renderRunner(base64);

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Mode' })).toBeInTheDocument();
    }, IMPORT_TIMEOUT);

    /*
     * Named rather than counted, so a failure says WHICH region came back in.
     * The rail is a plain div holding the Options panel and the run card, so it
     * is named from the panel inside it.
     */
    expect([...layoutRegion(container).children].map(headingOf)).toEqual([
      'Input',
      'Options',
      'Output',
    ]);
  });

  it('leaves the ports footnote outside it, where the rail cannot reach', async () => {
    const { container } = renderRunner(base64);

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Mode' })).toBeInTheDocument();
    }, IMPORT_TIMEOUT);

    const ports = screen.getByRole('region', { name: 'Ports' });
    expect(layoutRegion(container).contains(ports)).toBe(false);
    // Still after the output in the DOM: moving it out of the grid must not
    // move it in the source, which is what the reading order depends on.
    const output = screen.getByRole('region', { name: 'Output' });
    expect(output.compareDocumentPosition(ports) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /*
   * A GUARD AGAINST THE FIX BEING UNDONE THE EASY WAY.
   *
   * Putting a section back into the grid is a two-line change that reads like a
   * tidy-up, and the only thing that makes it wrong is a fact about sticky
   * containing blocks that is not visible at the call site. A full-bleed row is
   * spelled `grid-column: 1 / -1`, and nothing in this stylesheet may span both
   * columns.
   */
  it('declares no full-bleed row inside the grid the rail is sticky in', () => {
    const declarations = runnerCss.replaceAll(/\/\*[\s\S]*?\*\//g, '');
    expect(declarations).not.toMatch(/grid-column:\s*1\s*\/\s*-1/);
  });

  /*
   * The z-index went with the overlap. It was not the fix and it never could
   * have been - it decided which of two boxes painted on top of a collision
   * rather than preventing one - and leaving it behind would leave the next
   * reader thinking the overlap is still possible and merely managed.
   */
  it('does not stack the rail above the page to survive an overlap', () => {
    const declarations = runnerCss.replaceAll(/\/\*[\s\S]*?\*\//g, '');
    expect(declarations).not.toMatch(/z-index/);
  });
});

/* ========================================================================== *
 * A TOOL WITH MORE OPTIONS THAN ANY THAT EXISTS
 * ========================================================================== */

/**
 * THE TALL-PANEL FIXTURE.
 *
 * Every claim about the rail has to hold for a tool nobody has written yet, and
 * a tool declares its own options - so the panel's height is not knowable in
 * advance and no real tool's option count is the right thing to test against.
 * Regex declares the most today, at eight fields; this declares forty, and it
 * keeps declaring forty when the real tools change.
 *
 * `loadTool` is what the runner calls to get a tool's option descriptors, so
 * that is what is replaced. Everything else about the registry is the real
 * thing: `importOriginal` keeps `getManifestEntry` honest, because the entry
 * still has to describe real ports for the input panel to render at all.
 */
const TALL_FIELD_COUNT = 40;

function tallOptionFields(): readonly OptionField<Record<string, unknown>>[] {
  return Array.from({ length: TALL_FIELD_COUNT }, (_, index) => ({
    control: 'toggle',
    key: `flag${String(index)}`,
    label: `Flag ${String(index)}`,
    description: 'A field that exists only to make the panel taller than the rail.',
  })) as unknown as readonly OptionField<Record<string, unknown>>[];
}

describe('a tool whose options are taller than the rail', () => {
  beforeEach(() => {
    fixture.optionFields = tallOptionFields();
  });

  afterEach(() => {
    fixture.optionFields = null;
  });

  it(
    'changes nothing about where anything lives',
    async () => {
      const { container } = renderRunner(base64);

      await waitFor(() => {
        expect(screen.getByText('Flag 39')).toBeInTheDocument();
      }, IMPORT_TIMEOUT);

      // The fixture really is producing a panel no real tool would.
      expect(screen.getAllByRole('switch')).toHaveLength(TALL_FIELD_COUNT);

      /*
       * THE INVARIANTS THE GEOMETRY FOLLOWS FROM, restated against a panel
       * forty fields tall. None of them is a measurement, and all of them are
       * what a browser needs in order for the rail to be bounded and for Run
       * to stand still: the grid holds three regions, the footnote is outside
       * it, and Run is the rail's own last row rather than something the
       * options push around.
       */
      expect([...layoutRegion(container).children].map(headingOf)).toEqual([
        'Input',
        'Options',
        'Output',
      ]);
      expect(layoutRegion(container).contains(screen.getByRole('region', { name: 'Ports' }))).toBe(
        false,
      );

      const run = screen.getByRole('button', { name: 'Run' });
      const rail = container.querySelector('[class*="controls"]');
      const card = run.closest('section');
      expect(rail?.contains(run)).toBe(true);
      expect(card).not.toBeNull();
      /*
       * The rail's children, in order: the options scroller, then the run card.
       * Run being the LAST row is what `minmax(0, 1fr) auto` needs in order to
       * hand the scroll to the options and none of it to the button.
       */
      expect([...(rail?.children ?? [])].indexOf(card as Element)).toBe(1);
    },
    SLOW_TEST,
  );

  it(
    'has no axe violations with forty option fields on screen',
    async () => {
      const { container } = renderRunner(base64);

      await waitFor(() => {
        expect(screen.getByText('Flag 39')).toBeInTheDocument();
      }, IMPORT_TIMEOUT);

      await expectNoAxeViolations(container);
    },
    SLOW_TEST,
  );
});

/* ========================================================================== *
 * RUN
 * ========================================================================== */

describe('the run control', () => {
  /*
   * IT SITS IN A CARD. It used to be the rail's bare tail - a button, a cancel
   * button and a progress bar directly on the page background, on a surface
   * where every other region is a bordered module.
   */
  it('is inside a panel rather than on the page background', async () => {
    const { container } = renderRunner(base64);

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Mode' })).toBeInTheDocument();
    }, IMPORT_TIMEOUT);

    const run = screen.getByRole('button', { name: 'Run' });
    const card = run.closest('section');
    expect(card).not.toBeNull();
    expect(card?.className).toMatch(/panel/);
    expect(container.querySelector('[class*="controls"]')?.contains(card ?? null)).toBe(true);
  });

  /*
   * AND IT IS NOT A LANDMARK. `Panel` claims a named region only when it has a
   * title, and this card has none - a fifth unnamed region in the landmark
   * list would be noise, and "Run" as a heading above a button labelled Run is
   * worse than no heading at all.
   */
  it('adds no fifth region to the landmark list', async () => {
    renderRunner(base64);

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Mode' })).toBeInTheDocument();
    }, IMPORT_TIMEOUT);

    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Input',
      'Options',
      'Output',
      'Ports',
    ]);
  });
});
