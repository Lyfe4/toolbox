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
 * Every declaration block written for `.name`, comments stripped.
 *
 * Scanned rather than matched with a regex because a class appears more than
 * once - `.controls` is declared at the base width and again inside the media
 * query - and both bodies have to be seen. Prettier normalises the selector to
 * `.name {`, which is what makes the literal search safe: `.output {` cannot
 * pick up `.outputLabel {`.
 */
function rulesFor(name: string): string {
  const declarations = runnerCss.replaceAll(/\/\*[\s\S]*?\*\//g, '');
  const bodies: string[] = [];

  for (let from = 0; ;) {
    const open = declarations.indexOf(`.${name} {`, from);
    if (open === -1) break;
    const brace = declarations.indexOf('{', open);
    const close = declarations.indexOf('}', brace);
    bodies.push(declarations.slice(brace + 1, close));
    from = close + 1;
  }

  // A class that has stopped existing would make every assertion below pass by
  // matching nothing, which is the one way this helper could lie.
  if (bodies.length === 0) throw new Error(`no rule for .${name} in runner.module.css`);
  return bodies.join('\n');
}

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
        expect(screen.getByRole('textbox', { name: 'Base64 Result' })).toBeInTheDocument();
      }, IMPORT_TIMEOUT);

      const order = tabOrder(container);
      const at = (element: HTMLElement): number => order.indexOf(element);

      const mode = at(screen.getByRole('combobox', { name: 'Mode' }));
      const run = at(screen.getByRole('button', { name: 'Run' }));
      const output = at(screen.getByRole('textbox', { name: 'Base64 Result' }));
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
  it('holds the three regions the rail travels beside, and the footnotes', async () => {
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
      // The footnote stack: a plain div whose first heading is the Ports
      // panel's, followed by whatever the route passes beside it.
      'Ports',
    ]);
  });

  /*
   * THE FOOTNOTE IS BACK INSIDE THE GRID, AND THE RULE THAT KEEPS IT SAFE IS A
   * NARROWER ONE THAN THE RULE THAT PUT IT OUTSIDE.
   *
   * A sticky box's travel is bounded by its containing block, and for a grid
   * item that block is the grid CONTAINER - so a full-bleed row inside this
   * grid lies across the rail's entire travel range, which is how the rail once
   * came to cover 52px of the Ports panel at the foot of a JWT page.
   *
   * Moving Ports out of the grid fixed that by removing the HORIZONTAL half of
   * the overlap as a side effect. The rule that actually prevents it is that
   * nothing may occupy the rail's COLUMN: two boxes that never share a
   * horizontal band cannot overlap however far either one travels. That rule
   * lets the footnotes sit in the content column, which is where the space is -
   * a tall options rail leaves several hundred pixels of nothing beside a short
   * input, and these are what fills it.
   *
   * So the assertion moves from "not in the grid" to "not in the rail's
   * column", which is the thing that has to stay true. The geometry it implies
   * is measured in `cross-browser-check.mjs`, which asserts the rail overlaps
   * no section at rest AND at the foot of the page - the state the original
   * defect appeared in.
   */
  it('keeps the ports footnote out of the column the rail occupies', async () => {
    const { container } = renderRunner(base64);

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Mode' })).toBeInTheDocument();
    }, IMPORT_TIMEOUT);

    const ports = screen.getByRole('region', { name: 'Ports' });
    expect(layoutRegion(container).contains(ports)).toBe(true);

    // Still after the output in the DOM: bringing it into the grid must not
    // move it in the source, which is what the reading order depends on.
    const output = screen.getByRole('region', { name: 'Output' });
    expect(output.compareDocumentPosition(ports) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /*
   * And the column is declared rather than left to auto-placement, in both
   * layouts. `grid-column: 2` is the rail's, and a full-bleed `1 / -1` crosses
   * it - either one on this stack is the overlap coming back.
   */
  it('declares the footnote stack into the content column at every width', () => {
    const notes = rulesFor('notes');
    expect(notes).toMatch(/grid-column:\s*1\s*;/);
    expect(notes).not.toMatch(/grid-column:\s*2/);
    expect(notes).not.toMatch(/grid-column:\s*1\s*\/\s*-1/);
    expect(rulesFor('controls')).toMatch(/grid-column:\s*2/);
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
        'Ports',
      ]);
      expect(layoutRegion(container).contains(screen.getByRole('region', { name: 'Ports' }))).toBe(
        true,
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

/* ========================================================================== *
 * THE HEIGHT THE PAGE DOES NOT RESERVE
 * ========================================================================== */

/**
 * THE PAGE USED TO BE A VIEWPORT TALL WHETHER OR NOT IT HAD ANYTHING IN IT.
 *
 * `.layout` carried `min-block-size: calc(100dvh - var(--pb-space-lg) * 2)`
 * and the rail carried `block-size: 100%`, and between them they held every
 * tool page open to a full screen. The purpose was to hold Run still - a
 * region that is never shorter than a full-height rail is a region whose last
 * row is always in the same place - and it worked. What it cost is what the
 * page looked like: measured in the production build at 1280x800 with nothing
 * run yet, EVERY tool had a 768px grid, a 694px options scroller around 302px
 * of options, and a 416px Output panel around one sentence. Image's was 600px.
 *
 * BOTH ARE GONE AND RUN MOVES AGAIN. That is the trade, not an oversight: the
 * rail is a sticky unit of options-then-button, so the button is one gap below
 * the last option and travels when the options change height. Exactly one tool
 * does that - `text-convert`, whose conditional fields put the button at 536,
 * 669 or 914 depending on the target format. Reserving a screen of height on
 * every page of every tool to hold one button still on one of them, and
 * leaving that button 200-400px of bare background away from the settings it
 * applies, was the more expensive half of the bargain.
 *
 * What replaces the stillness is asserted rather than assumed, in
 * `cross-browser-check.mjs` and against all three of text-convert's layouts:
 * Run is one gap below the options, never on top of them, and never more than
 * a screen from the fold.
 *
 * What did NOT depend on the reserved height, and is unchanged: row one is
 * `min-content`, so the Output panel's top is the input's height alone, and
 * `.optionsScroll` is a scroll container whose min-content contribution in the
 * scrolling axis is zero, so a tall options panel cannot size the grid's rows.
 *
 * These are text assertions for the same reason the reordering guard above is
 * one: jsdom has no layout engine, every box in it is zero by zero, and the
 * thing that would bring the defect back is a one-line declaration that reads
 * like a tidy-up. The heights themselves are measured in
 * `scripts/cross-browser-check.mjs`.
 */
/*
 * THE THIRD COLUMN, AND THE CAP THAT IS THE POINT OF IT.
 *
 * Above 1000 the page was a main column and a rail, and the main column was
 * whatever was left of the window - so on `/tools/base64` the input editor
 * measured 906px at 1280 and 1546px at 1920, for a string somebody pasted, and
 * the result it produced was a row further down the page. Above 1440 the input
 * is a measure, the rail is beside it and the result is the third column.
 *
 * Text assertions, for the same reason the reordering guard is one: the thing
 * that brings the defect back is `minmax(0, 1fr)` where `440px` is, which reads
 * as a simplification. The geometry it produces is measured at nine widths in
 * `scripts/cross-browser-check.mjs`.
 */
describe('the input column above the second breakpoint', () => {
  it('is a fixed measure rather than a share of the window', () => {
    expect(runnerCss).toMatch(/@media \(min-width: 1440px\)/);
    expect(rulesFor('layout')).toMatch(/grid-template-columns:\s*440px 300px minmax\(0, 1fr\)/);
  });

  /*
   * And the three regions are placed left to right in the order they are
   * written in. This is the same claim the reordering guard makes from the
   * other side: nothing here may use `order`, so the columns are the only
   * thing deciding where a region lands, and they must agree with the source.
   */
  it('places input, rail and output in source order across the columns', () => {
    expect(rulesFor('input')).toMatch(/grid-column:\s*1/);
    expect(rulesFor('controls')).toMatch(/grid-column:\s*2/);
    expect(rulesFor('output')).toMatch(/grid-column:\s*3/);
  });
});

/*
 * THE TWO TEXTAREA FLOORS WIN BY SPECIFICITY, NOT BY DOCUMENT ORDER.
 *
 * `.editor` (200px, an input you paste into) and `.result` (48px, an output
 * sized to its content) both have to beat `.textarea`'s own 80px floor. A CSS
 * module is one class deep, so a bare `.editor` TIES with `.textarea` and the
 * winner is whichever stylesheet the bundler put last - which differs between
 * `pnpm dev` and the build.
 *
 * Measured on `/tools/structured-data` at 1440 before this: the input editor is
 * 200px in the production build and 87px under `pnpm dev`. A development
 * environment that disagrees with the product about the size of its main input
 * is worse than a wrong size, because every judgement made in it is suspect -
 * and it had already cost this repository one wrong conclusion, since these
 * rules read as dead code in dev and were mistaken for exactly that.
 *
 * An element qualifier makes each selector (0,1,1) against (0,1,0), so the
 * cascade decides it the same way in both. The heights themselves are measured
 * against the build in `checkRunnerLayout`; this guards the mechanism, because
 * dropping the qualifier looks like tidying a redundant selector.
 */
describe('the textarea floors', () => {
  it('beat the shared floor by specificity rather than by stylesheet order', () => {
    const declarations = runnerCss.replaceAll(/\/\*[\s\S]*?\*\//g, '');
    expect(declarations).toMatch(/textarea\.editor\s*\{/);
    expect(declarations).toMatch(/textarea\.result\s*\{/);
    // The bare forms are what the cascade cannot decide on its own.
    expect(declarations).not.toMatch(/(^|[\s,}])\.editor\s*\{/);
    expect(declarations).not.toMatch(/(^|[\s,}])\.result\s*\{/);
  });
});

describe('the reserved viewport height', () => {
  it('is not given to the grid, at any width', () => {
    expect(rulesFor('layout')).not.toMatch(/min-block-size/);
  });

  /*
   * The rail may be CAPPED by the viewport - it has to be, or a tall options
   * panel would put Run somewhere no scroll can reach - but it may not be
   * SIZED by it. `max-block-size` bounds a box; `block-size` and
   * `min-block-size` invent one.
   */
  it('is not given to the rail either, which may be capped but not filled', () => {
    const rail = rulesFor('controls');
    expect(rail).toMatch(/max-block-size:\s*calc\(100dvh/);
    expect(rail).not.toMatch(/(^|[;\s])block-size:/);
    expect(rail).not.toMatch(/min-block-size:/);
  });

  /*
   * And the Output panel still stretches. That is not the reserved height
   * coming back: it is where the surplus goes when the rail genuinely is the
   * taller of the two columns, which is a real relationship between the
   * things on the page rather than an invented one. Without it that surplus
   * would be bare page background between the result and the ports footnote.
   */
  it('leaves the output stretching into whatever surplus the rail creates', () => {
    expect(rulesFor('output')).toMatch(/align-self:\s*stretch/);
  });

  /*
   * AND STOPS STRETCHING IT WHERE THERE IS NOTHING TO FILL.
   *
   * `rulesFor` joins every block written for a class, so the assertion above is
   * satisfied by either breakpoint and says nothing about which. The two want
   * opposite things and the reason is structural: at 1000px the Output panel is
   * row two of a grid the rail spans, so the rail's surplus is enclosed between
   * the result and the ports footnote and stretching is what hides it; at
   * 1440px the three panels are siblings in one row, so the surplus is the end
   * of a shorter column and stretching would size the result panel by the
   * tool's option count instead. Measured on the shipped build at 1920, both
   * idle and both drawing the one sentence "No output yet": text-convert's
   * panel was 624px and structured-data's 399px.
   *
   * So each block is asserted where it lives. Collapsing them back to one
   * declaration is the change that reads like tidying up.
   */
  it('stops stretching it once the columns are siblings rather than rows', () => {
    const [twoColumn, threeColumn] = runnerCss
      .replaceAll(/\/\*[\s\S]*?\*\//g, '')
      .split('@media (min-width: 1440px)');

    expect(twoColumn).toMatch(/align-self:\s*stretch/);
    expect(twoColumn).not.toMatch(/align-self:\s*start/);
    expect(threeColumn).toMatch(/align-self:\s*start/);
    expect(threeColumn).not.toMatch(/align-self:\s*stretch/);
  });

  /*
   * THE RAIL IS THE ONLY THING ON THIS PAGE ALLOWED TO PIN.
   *
   * The run card used to pin too - `position: sticky; inset-block-end` - to
   * lift it to the fold from a resting place the reserved height had put below
   * one. The card is opaque and the box it lifted over is `.optionsScroll`, so
   * on the shipped build it covered the last 159px of a SCROLLING options list
   * on text-convert's Markdown layout. Three fields you could scroll to and
   * not see.
   *
   * Reintroducing it is a two-line change that would look like restoring a
   * convenience, and every symptom of it is geometric. So the rule is stated
   * where it can be read: one sticky in this stylesheet, and it is the rail's.
   */
  it('pins the rail and nothing else, so no control can lift over the options', () => {
    const declarations = runnerCss.replaceAll(/\/\*[\s\S]*?\*\//g, '');
    expect(declarations.match(/position:\s*sticky/g) ?? []).toHaveLength(1);
    expect(rulesFor('controls')).toMatch(/position:\s*sticky/);
  });
});

/* ========================================================================== *
 * ONE NAME PER THING
 * ========================================================================== */

describe('an output port label', () => {
  /*
   * NO PORT LABEL MAY REPEAT THE PANEL HEADING ABOVE IT.
   *
   * Base64 used to declare its single output as "Output", under a panel whose
   * heading is "Output" - two labels for one value, and the same duplication on
   * five of the nine tools. The rule that came out of it is that a port's label
   * is drawn only where it distinguishes something, which for a one-output tool
   * is never.
   *
   * ROUND THREE GAVE BASE64 A SECOND OUTPUT, so its first port's label is drawn
   * now - and the word it was drawn with was "Output", under the heading
   * "Output". This test caught it. The port is called 'Result' for that reason
   * and the assertion stands as it was: whatever a tool's ports are called, the
   * word in the panel heading appears once.
   */
  it(
    'is not printed under a panel heading that already says it',
    async () => {
      const user = userEvent.setup();
      renderRunner(base64);

      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: 'Mode' })).toBeInTheDocument();
      }, IMPORT_TIMEOUT);

      await user.type(screen.getByRole('textbox', { name: 'Base64 input' }), 'hi');
      await user.click(screen.getByRole('button', { name: 'Run' }));
      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: 'Base64 Result' })).toBeInTheDocument();
      }, IMPORT_TIMEOUT);

      // The panel heading, and nothing else on the page saying the same word.
      expect(screen.getAllByText('Output')).toHaveLength(1);
      // Still reachable by name, because the accessible name of the box is
      // built from the port label whether or not it is drawn.
      expect(screen.getByRole('textbox', { name: 'Base64 Result' })).toBeInTheDocument();
    },
    SLOW_TEST,
  );

  /*
   * AND IT IS STILL DRAWN WHERE IT DISTINGUISHES SOMETHING. Diff emits two -
   * the unified patch and the notes - and a page that showed both without
   * saying which was which would be worse than the duplication this removes.
   */
  it(
    'is printed for every port when a tool has more than one',
    async () => {
      const user = userEvent.setup();
      const diff = getManifestEntry('diff');
      renderRunner(diff);

      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: 'Diff Original input' })).toBeInTheDocument();
      }, IMPORT_TIMEOUT);

      await user.type(screen.getByRole('textbox', { name: 'Diff Original input' }), 'a');
      await user.type(screen.getByRole('textbox', { name: 'Diff Changed input' }), 'b');
      await user.click(screen.getByRole('button', { name: 'Run' }));

      await waitFor(() => {
        for (const port of diff.outputs) {
          expect(screen.getByText(port.label)).toBeInTheDocument();
        }
      }, IMPORT_TIMEOUT);

      expect(diff.outputs.length).toBeGreaterThan(1);
    },
    SLOW_TEST,
  );
});
