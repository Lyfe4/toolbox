import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { TOOL_MANIFEST } from '@/features/registry';
import { expectNoAxeViolations } from '@/lib/testing/axe';
import { renderRoute } from '@/lib/testing/renderRoute';

describe('/tools index', () => {
  it('lists every tool', async () => {
    await renderRoute('/tools');

    expect(screen.getByRole('heading', { level: 1, name: 'Every tool' })).toBeInTheDocument();
    // Every one, by its route - this checked two of the ten until round seventeen.
    const hrefs = screen
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
      .filter((href) => href?.startsWith('/tools/'));
    expect([...new Set(hrefs)].sort()).toEqual(
      TOOL_MANIFEST.map((entry) => `/tools/${entry.id}`).sort(),
    );
  });

  it('filters as you type, and announces the count', async () => {
    const user = userEvent.setup();
    await renderRoute('/tools');

    await user.type(screen.getByLabelText('Search'), 'base64');

    await waitFor(() => {
      expect(screen.queryByRole('link', { name: /Structured data/ })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /Base64/ })).toBeInTheDocument();
    // The count sits in a live region so the change is announced, not just drawn.
    expect(screen.getByTestId('tool-count')).toHaveTextContent('1 tool');
  });

  it('matches on a keyword that is not visible on the card', async () => {
    const user = userEvent.setup();
    await renderRoute('/tools');

    await user.type(screen.getByLabelText('Search'), 'btoa');
    await waitFor(() => {
      expect(screen.getByTestId('tool-count')).toHaveTextContent('1 tool');
    });
  });

  it('says so when nothing matches', async () => {
    const user = userEvent.setup();
    await renderRoute('/tools');

    await user.type(screen.getByLabelText('Search'), 'zzzzz');
    await waitFor(() => {
      expect(screen.getByText(/No tool matches/)).toBeInTheDocument();
    });
  });

  it('reaches every tool by keyboard alone', async () => {
    const user = userEvent.setup();
    await renderRoute('/tools');

    const link = screen.getByRole('link', { name: /Base64/ });
    // Tab until the first tool card has focus, proving there is a keyboard
    // path to it and it is a single stop rather than several.
    for (let step = 0; step < 12 && document.activeElement !== link; step += 1) {
      await user.tab();
    }
    expect(link).toHaveFocus();
  });

  /*
   * ONE LINE PER DIRECTION, NOT ONE CHIP PER PORT.
   *
   * A chip per port is five of them on `text-convert`, in a wrapping row whose
   * break point is a function of the column width - so `out: json` fell onto a
   * line of its own on some cards and not others, and no two cards in a row
   * broke in the same place. jsdom sees the markup that makes at most two lines
   * possible; `checkToolIndex` measures that they really do not wrap, at four
   * widths, in two engines.
   */
  it('states what a tool accepts and produces once each, deduplicated', async () => {
    await renderRoute('/tools');

    expect(screen.getByRole('link', { name: /Base64/ })).toHaveTextContent('text · bytes');

    /*
     * Structured data is the one that proves the deduplication rather than
     * merely surviving it: it declares json on TWO of its three outputs, so the
     * multiset is `text · json · json` and the set - which is what a reader
     * scanning for "what can I wire this to" wants - is `text · json`.
     */
    const structured = screen.getByRole('link', { name: /Structured data/ });
    expect(structured).toHaveTextContent('text · json');
    expect(structured).not.toHaveTextContent('json · json');
  });

  /*
   * The direction is SPOKEN and DRAWN separately: `In` on its own is a
   * direction to the eye and an ambiguity to an ear.
   */
  it('names the direction for a screen reader rather than leaving it to the glyph', async () => {
    await renderRoute('/tools');

    const card = screen.getByRole('link', { name: /Base64/ });
    expect(card).toHaveTextContent('Accepts');
    expect(card).toHaveTextContent('Produces');
  });

  it('has no axe violations', async () => {
    const { container } = await renderRoute('/tools');
    await expectNoAxeViolations(container);
  });
});

describe('/tools/$toolId', () => {
  it('renders the tool runner for a known tool', async () => {
    await renderRoute('/tools/base64');

    expect(screen.getByRole('heading', { level: 1, name: 'Base64' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Base64 input' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument();
  });

  it('offers a keyboard-accessible file picker beside the drop zone', async () => {
    await renderRoute('/tools/base64');

    // The drop zone is pointer-only by nature; the real file input is the
    // keyboard path, and it must be labelled and reachable.
    const input = screen.getByLabelText('Choose file');
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAccessibleDescription(/drop a file here/i);
  });

  it('renders the options panel from the tool schema', async () => {
    await renderRoute('/tools/base64');

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Mode' })).toBeInTheDocument();
    });
    expect(screen.getByRole('switch', { name: 'URL-safe alphabet' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Padding' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Wrap at column' })).toBeInTheDocument();
  });

  it('shows a not-found page for an unknown id', async () => {
    await renderRoute('/tools/not-a-real-tool');

    expect(screen.getByRole('heading', { level: 1, name: 'No such tool' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Browse every tool' })).toBeInTheDocument();
  });

  it('describes the tool ports', async () => {
    await renderRoute('/tools/structured-data');

    await waitFor(() => {
      expect(screen.getByText(/In · Document · text or json/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Out · Parsed data · json/)).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = await renderRoute('/tools/base64');
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Mode' })).toBeInTheDocument();
    });
    await expectNoAxeViolations(container);
  });
});
