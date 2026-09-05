import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Button, ToastProvider } from '@/components';
import buttonCss from '@/components/Button/Button.module.css?raw';
import { expectNoAxeViolations } from '@/lib/testing/axe';

import { ThemeEditor } from './ThemeEditor';
import { serialiseTheme, THEME_FILE_KIND } from './themeFile';
import { CUSTOM_THEME_STORAGE_KEY } from '../customThemes';
import { useThemeStore } from '../store';
import { useThemeSync } from '../useTheme';

import type { CustomTheme } from '../types';

/**
 * The editor, mounted the way the styleguide mounts it, plus one real
 * component so a token change can be shown to reach something other than the
 * token list.
 *
 * `useThemeSync` is what pushes the store onto <html>; in the application it
 * lives in the root layout, so a test that omitted it would be testing the
 * editor's state and calling it the theme.
 */
function Harness() {
  useThemeSync();
  return (
    <ToastProvider>
      <ThemeEditor />
      <Button>A real primary button</Button>
    </ToastProvider>
  );
}

function renderEditor() {
  return render(<Harness />);
}

/** Opens a new theme started from the default preset. */
async function createTheme(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Create theme' }));
  await screen.findByRole('textbox', { name: 'Name' });
}

/** The text field for one token, which is the complete alternative to the picker. */
function tokenInput(token: string): HTMLElement {
  return screen.getByRole('textbox', { name: token });
}

async function openGroup(user: ReturnType<typeof userEvent.setup>, group: string): Promise<void> {
  await user.click(screen.getByRole('tab', { name: group }));
}

/** What the document is actually wearing right now. */
function appliedToken(token: string): string {
  return document.documentElement.style.getPropertyValue(`--pb-${token}`);
}

beforeEach(() => {
  window.localStorage.clear();
  useThemeStore.setState({
    selection: { kind: 'system' },
    customThemes: [],
    draftTheme: null,
    skippedThemes: 0,
  });
});

afterEach(() => {
  useThemeStore.setState({ draftTheme: null, customThemes: [] });
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('style');
});

describe('creating a theme', () => {
  it('starts from a preset rather than from nothing', async () => {
    const user = userEvent.setup();
    renderEditor();

    expect(screen.getByText(/No custom themes yet/)).toBeInTheDocument();
    await createTheme(user);

    // Named for you, based on the preset, so the first thing you do is not
    // inventing a name for something you have not made yet.
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Graphite custom');
    // Nothing overridden: every token still says where it came from.
    expect(screen.getAllByText('inherited').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Reset surface-base' })).toBeDisabled();
  });

  it("shows the base preset's value in every field before anything is changed", async () => {
    const user = userEvent.setup();
    renderEditor();
    await createTheme(user);

    // graphite's --pb-surface-base, straight out of themes.css.
    expect(tokenInput('surface-base')).toHaveValue('#0b0d11');
  });
});

describe('editing a token', () => {
  it('applies to the whole document, not just the token list', async () => {
    const user = userEvent.setup();
    renderEditor();
    await createTheme(user);
    await openGroup(user, 'Accent');

    await user.clear(tokenInput('accent'));
    await user.type(tokenInput('accent'), '#00ff00');

    await waitFor(() => {
      expect(appliedToken('accent')).toBe('#00ff00');
    });

    /*
     * AND THAT THE TOKEN REACHES A COMPONENT.
     *
     * jsdom has no layout engine and does not substitute `var()`, so asking
     * for the button's computed background would return the literal string
     * `var(--pb-accent)` rather than a colour - which is why the two halves of
     * the chain are asserted separately. The override is on <html>, where the
     * cascade begins; and the primary button's own stylesheet reads that exact
     * custom property. `pnpm check:browsers` closes the loop in a real engine.
     */
    expect(screen.getByRole('button', { name: 'A real primary button' })).toBeInTheDocument();
    expect(buttonCss).toContain('var(--pb-accent)');
  });

  it('accepts every notation the colour tool reads, and shows the canonical form', async () => {
    const user = userEvent.setup();
    renderEditor();
    await createTheme(user);
    await openGroup(user, 'Accent');

    await user.clear(tokenInput('accent'));
    await user.type(tokenInput('accent'), 'hsl(120 100% 50%)');

    // What was typed stays in the box...
    expect(tokenInput('accent')).toHaveValue('hsl(120 100% 50%)');
    // ...and what it became is shown beside it.
    await waitFor(() => {
      expect(appliedToken('accent')).toBe('#00ff00');
    });
    expect(screen.getByText('overrides #ff9500')).toBeInTheDocument();
  });

  it('rejects a colour it cannot read without corrupting the theme', async () => {
    const user = userEvent.setup();
    renderEditor();
    await createTheme(user);
    await openGroup(user, 'Accent');

    await user.clear(tokenInput('accent'));
    await user.type(tokenInput('accent'), 'chartreuse');

    expect(await screen.findByRole('alert')).toHaveTextContent(/Not a colour/);
    expect(tokenInput('accent')).toHaveAttribute('aria-invalid', 'true');
    // The draft never saw it: nothing was applied, and the token is still
    // inherited rather than overridden.
    expect(appliedToken('accent')).toBe('');
    expect(screen.getByRole('button', { name: 'Reset accent' })).toBeDisabled();
  });

  it('refuses a value that would put a url() into the stylesheet', async () => {
    const user = userEvent.setup();
    renderEditor();
    await createTheme(user);
    await openGroup(user, 'Accent');

    await user.clear(tokenInput('accent'));
    await user.type(tokenInput('accent'), 'url(https://example.com/pixel.png)');

    expect(await screen.findByRole('alert')).toHaveTextContent(/Not a colour/);
    expect(appliedToken('accent')).toBe('');
  });

  it('resets one token back to what it inherits', async () => {
    const user = userEvent.setup();
    renderEditor();
    await createTheme(user);
    await openGroup(user, 'Accent');

    await user.clear(tokenInput('accent'));
    await user.type(tokenInput('accent'), '#00ff00');
    await waitFor(() => {
      expect(appliedToken('accent')).toBe('#00ff00');
    });

    await user.click(screen.getByRole('button', { name: 'Reset accent' }));

    await waitFor(() => {
      expect(appliedToken('accent')).toBe('');
    });
    expect(tokenInput('accent')).toHaveValue('#ff9500');
  });

  it('resets the whole theme', async () => {
    const user = userEvent.setup();
    renderEditor();
    await createTheme(user);
    await openGroup(user, 'Accent');

    await user.clear(tokenInput('accent'));
    await user.type(tokenInput('accent'), '#00ff00');
    await waitFor(() => {
      expect(appliedToken('accent')).toBe('#00ff00');
    });

    await user.click(screen.getByRole('button', { name: 'Reset every token' }));

    await waitFor(() => {
      expect(appliedToken('accent')).toBe('');
    });
    expect(screen.getByRole('button', { name: 'Reset every token' })).toBeDisabled();
  });
});

describe('undo and redo', () => {
  it('steps back and forward through an editing session', async () => {
    const user = userEvent.setup();
    renderEditor();
    await createTheme(user);
    await openGroup(user, 'Accent');

    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();

    await user.clear(tokenInput('accent'));
    await user.type(tokenInput('accent'), '#00ff00');
    await waitFor(() => {
      expect(appliedToken('accent')).toBe('#00ff00');
    });

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(appliedToken('accent')).toBe('');
    });

    await user.click(screen.getByRole('button', { name: 'Redo' }));
    await waitFor(() => {
      expect(appliedToken('accent')).toBe('#00ff00');
    });
  });

  it('coalesces a run of edits to one token into a single step', async () => {
    const user = userEvent.setup();
    renderEditor();
    await createTheme(user);
    await openGroup(user, 'Accent');

    /*
     * Typing six characters is six changes. Without coalescing, undo would
     * have to be pressed six times to get back - which is what makes an undo
     * button useless next to a colour picker that fires on every pixel of a
     * drag.
     */
    await user.clear(tokenInput('accent'));
    await user.type(tokenInput('accent'), '#00ff00');
    await waitFor(() => {
      expect(appliedToken('accent')).toBe('#00ff00');
    });

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() => {
      expect(appliedToken('accent')).toBe('');
    });
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
  });
});

describe('naming', () => {
  it('refuses to save two themes with the same name', async () => {
    const user = userEvent.setup();
    renderEditor();

    await createTheme(user);
    await user.click(screen.getByRole('button', { name: 'Save theme' }));
    await screen.findByRole('button', { name: 'Save changes' });
    await user.click(screen.getByRole('button', { name: 'Close' }));

    // A second theme, renamed to collide with the first.
    await createTheme(user);
    await user.clear(screen.getByRole('textbox', { name: 'Name' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Graphite custom');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Another theme is already called "Graphite custom".',
    );
    expect(screen.getByRole('button', { name: 'Save theme' })).toBeDisabled();
  });

  it('refuses an empty name', async () => {
    const user = userEvent.setup();
    renderEditor();
    await createTheme(user);

    await user.clear(screen.getByRole('textbox', { name: 'Name' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('A theme needs a name.');
    expect(screen.getByRole('button', { name: 'Save theme' })).toBeDisabled();
  });

  it('lets a saved theme keep its own name', async () => {
    const user = userEvent.setup();
    renderEditor();
    await createTheme(user);
    await user.click(screen.getByRole('button', { name: 'Save theme' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    });
    expect(screen.queryByText(/already called/)).not.toBeInTheDocument();
  });
});

describe('the library', () => {
  const SAVED: CustomTheme = {
    id: 'theme-saved',
    label: 'Midnight',
    base: 'blueprint',
    overrides: { accent: '#00ff00' },
  };

  beforeEach(() => {
    useThemeStore.setState({ customThemes: [SAVED] });
  });

  it('applies a theme, and says so', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(useThemeStore.getState().selection).toEqual({ kind: 'custom', id: 'theme-saved' });
    expect(await screen.findByText('Theme applied')).toBeInTheDocument();
  });

  it('duplicates a theme under a free name', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('button', { name: 'Duplicate' }));

    const labels = useThemeStore.getState().customThemes.map((theme) => theme.label);
    expect(labels).toEqual(['Midnight', 'Midnight 2']);
    // A copy, not a reference: editing one must not change the other.
    const [first, second] = useThemeStore.getState().customThemes;
    expect(second?.overrides).not.toBe(first?.overrides);
  });

  it('needs two deliberate clicks to delete', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(useThemeStore.getState().customThemes).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Confirm delete' }));
    expect(useThemeStore.getState().customThemes).toEqual([]);
  });

  it('persists a saved theme under its own versioned key', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('button', { name: 'Duplicate' }));

    const raw = window.localStorage.getItem(CUSTOM_THEME_STORAGE_KEY) ?? '';
    expect(raw).toContain('Midnight 2');
    expect(JSON.parse(raw)).toMatchObject({ version: 1 });
    // Not mixed in with the selection.
    expect(window.localStorage.getItem('patchbay:theme:v1') ?? '').not.toContain('Midnight');
  });

  it('reports themes that could not be read rather than hiding them', () => {
    useThemeStore.setState({ skippedThemes: 2 });
    renderEditor();

    expect(screen.getByText(/2 stored themes could not be read/)).toBeInTheDocument();
  });
});

describe('contrast', () => {
  it('says nothing is wrong with an untouched preset', async () => {
    const user = userEvent.setup();
    renderEditor();
    await createTheme(user);

    expect(screen.getByText('All 33 pairs meet WCAG AA.')).toBeInTheDocument();
  });

  it('names what fails and what it fails against', async () => {
    const user = userEvent.setup();
    renderEditor();
    await createTheme(user);
    await openGroup(user, 'Ink');

    await user.clear(tokenInput('ink-primary'));
    await user.type(tokenInput('ink-primary'), '#0c0d12');

    const failure = await screen.findByText('--pb-ink-primary on --pb-surface-base');
    const row = failure.closest('li');
    expect(row).not.toBeNull();
    if (row === null) return;

    // The verdict, the two tokens, the measured ratio and the bar it missed.
    expect(within(row).getByText('Fail.')).toBeInTheDocument();
    expect(row.textContent).toMatch(/1\.\d\d:1, needs 4\.5:1/);
    expect(screen.getByText(/of 33 pairs fail WCAG AA/)).toBeInTheDocument();
  });

  it('announces the state once the user has stopped, not on every change', async () => {
    const user = userEvent.setup();
    renderEditor();
    await createTheme(user);
    await openGroup(user, 'Ink');

    const announcer = screen.getByTestId('theme-announcer');
    await user.clear(tokenInput('ink-primary'));
    await user.type(tokenInput('ink-primary'), '#0c0d12');

    // Debounced, so typing six characters does not produce six announcements.
    expect(announcer).toHaveTextContent('');

    await waitFor(() => {
      expect(announcer).toHaveTextContent(/contrast pairs? below WCAG AA/);
    });
    expect(announcer).toHaveTextContent(/Worst:/);
  });

  it("saves a failing theme, because it is the user's choice, but says so", async () => {
    const user = userEvent.setup();
    renderEditor();
    await createTheme(user);
    await openGroup(user, 'Ink');

    await user.clear(tokenInput('ink-primary'));
    await user.type(tokenInput('ink-primary'), '#0c0d12');
    await screen.findByText(/of 33 pairs fail WCAG AA/);

    await user.click(screen.getByRole('button', { name: 'Save theme' }));

    expect(useThemeStore.getState().customThemes).toHaveLength(1);
    expect(await screen.findByText('Theme saved with failing contrast')).toBeInTheDocument();
  });

  it('warns when a failing theme is applied', async () => {
    useThemeStore.setState({
      customThemes: [
        { id: 'bad', label: 'Bad', base: 'graphite', overrides: { 'ink-primary': '#0c0d12' } },
      ],
    });
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(await screen.findByText('Applied a theme that fails WCAG AA')).toBeInTheDocument();
  });
});

describe('live preview', () => {
  it('can be switched off without discarding the work', async () => {
    const user = userEvent.setup();
    renderEditor();
    await createTheme(user);
    await openGroup(user, 'Accent');

    await user.clear(tokenInput('accent'));
    await user.type(tokenInput('accent'), '#00ff00');
    await waitFor(() => {
      expect(appliedToken('accent')).toBe('#00ff00');
    });

    /*
     * THE ESCAPE HATCH. The editor is painted by the theme it edits, so a
     * half-finished theme can make the page hard to read. This puts the page
     * back without losing anything - and it is a switch with a text label, so
     * it stays operable however bad the colours have become.
     */
    await user.click(screen.getByRole('switch', { name: 'Live preview' }));

    await waitFor(() => {
      expect(appliedToken('accent')).toBe('');
    });
    expect(tokenInput('accent')).toHaveValue('#00ff00');

    await user.click(screen.getByRole('switch', { name: 'Live preview' }));
    await waitFor(() => {
      expect(appliedToken('accent')).toBe('#00ff00');
    });
  });

  it('stops applying the draft once the editor is closed', async () => {
    const user = userEvent.setup();
    renderEditor();
    await createTheme(user);
    await openGroup(user, 'Accent');

    await user.clear(tokenInput('accent'));
    await user.type(tokenInput('accent'), '#00ff00');
    await waitFor(() => {
      expect(appliedToken('accent')).toBe('#00ff00');
    });

    await user.click(screen.getByRole('button', { name: 'Discard changes' }));

    await waitFor(() => {
      expect(appliedToken('accent')).toBe('');
    });
    expect(useThemeStore.getState().customThemes).toEqual([]);
  });
});

describe('import and export', () => {
  const FILE = serialiseTheme({
    id: 'ignored',
    label: 'Imported',
    base: 'vellum',
    overrides: { accent: '#123456' },
  });

  it('imports a valid file', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.upload(
      screen.getByLabelText('Import a theme file'),
      new File([FILE], 'theme.json', { type: 'application/json' }),
    );

    await waitFor(() => {
      expect(useThemeStore.getState().customThemes).toHaveLength(1);
    });
    const [imported] = useThemeStore.getState().customThemes;
    expect(imported?.label).toBe('Imported');
    expect(imported?.overrides).toEqual({ accent: '#123456' });
  });

  it('refuses a malformed file, cleanly and out loud', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.upload(
      screen.getByLabelText('Import a theme file'),
      new File(['{ not json'], 'theme.json', { type: 'application/json' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('not valid JSON');
    expect(useThemeStore.getState().customThemes).toEqual([]);
  });

  it('refuses a hostile file without applying any of it', async () => {
    const user = userEvent.setup();
    renderEditor();

    const hostile = JSON.stringify({
      kind: THEME_FILE_KIND,
      version: 1,
      label: 'Tracker',
      base: 'graphite',
      overrides: { accent: '#ff0000', 'surface-base': 'url(https://example.com/pixel.png)' },
    });
    await user.upload(
      screen.getByLabelText('Import a theme file'),
      new File([hostile], 'theme.json', { type: 'application/json' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('not a Patchbay theme');
    expect(useThemeStore.getState().customThemes).toEqual([]);
  });

  it('exports the theme as a downloadable file', async () => {
    const createObjectURL = vi.fn(() => 'blob:theme');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    useThemeStore.setState({
      customThemes: [{ id: 'e', label: 'Midnight', base: 'graphite', overrides: {} }],
    });
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('button', { name: 'Export' }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:theme');
    expect(await screen.findByText('midnight.patchbay-theme.json')).toBeInTheDocument();

    click.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe('accessibility', () => {
  it('has no axe violations in the library', async () => {
    useThemeStore.setState({
      customThemes: [{ id: 'a', label: 'Midnight', base: 'graphite', overrides: {} }],
    });
    const { container } = renderEditor();

    await expectNoAxeViolations(container);
  });

  it('has no axe violations while editing', async () => {
    const user = userEvent.setup();
    const { container } = renderEditor();
    await createTheme(user);

    await expectNoAxeViolations(container);
  });

  it('has no axe violations with a failing-contrast theme active', async () => {
    const user = userEvent.setup();
    const { container } = renderEditor();
    await createTheme(user);
    await openGroup(user, 'Ink');

    await user.clear(tokenInput('ink-primary'));
    await user.type(tokenInput('ink-primary'), '#0c0d12');
    await screen.findByText(/of 33 pairs fail WCAG AA/);

    /*
     * The colour-contrast rule is off under jsdom in every axe run here -
     * there is no layout engine, so axe cannot resolve a computed colour to
     * measure. That measurement is exactly what the contrast panel does
     * instead, and themes.contrast.test.ts does for the presets. What this
     * asserts is that the STRUCTURE survives a bad theme: the failing rows are
     * a real list, the verdicts are text, and nothing has lost its name.
     */
    await expectNoAxeViolations(container);
  });

  it('gives every token both a picker and a text field, each named', async () => {
    const user = userEvent.setup();
    renderEditor();
    await createTheme(user);

    expect(tokenInput('surface-base')).toBeInTheDocument();
    expect(screen.getByLabelText('surface-base, colour picker')).toHaveAttribute('type', 'color');
  });
});
