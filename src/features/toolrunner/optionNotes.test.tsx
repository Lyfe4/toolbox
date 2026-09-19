import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OptionField } from '@/features/registry/types';

import { forgetOptionNotes, OPTION_NOTES_STORAGE_KEY } from './optionNotes';
import { OptionNotesToggle, OptionsPanel } from './OptionsPanel';

/**
 * THE DESCRIPTIONS ARE A PREFERENCE, AND THE PREFERENCE IS OFF BY DEFAULT.
 *
 * Every option field may carry a sentence explaining it, and every one of them
 * used to be painted on every visit. The half of this that jsdom can see is the
 * DOM: the element survives, the association survives, and one button drives
 * every field in the panel. The half it cannot see - that the hidden element
 * occupies no height, and that the panel is therefore shorter - is measured in
 * two real engines by `checkOptionNotes` in `scripts/cross-browser-check.mjs`.
 */

/*
 * ONE FIELD OF EVERY CONTROL KIND THAT DRAWS A DESCRIPTION.
 *
 * `OptionsPanel` has a `Field` call site per kind, and the preference has to
 * reach all of them - a call site that stopped being handed it would hide two
 * descriptions out of three and look, from any one assertion, exactly right.
 * `toggle` is deliberately absent: `Toggle` draws its own label and no
 * description, so there is nothing for this to reach.
 */
const fields = [
  {
    control: 'text',
    key: 'pattern',
    label: 'Pattern',
    description: 'Written without slashes.',
  },
  {
    control: 'select',
    key: 'mode',
    label: 'Mode',
    description: 'Match or replace.',
    choices: [
      { value: 'match', label: 'Match' },
      { value: 'replace', label: 'Replace' },
    ],
  },
  {
    control: 'number',
    key: 'width',
    label: 'Width',
    description: 'Zero for a single line.',
    min: 0,
    max: 100,
    step: 1,
  },
] as unknown as readonly OptionField<Record<string, unknown>>[];

function renderPanel() {
  return render(
    <>
      <OptionNotesToggle />
      <OptionsPanel
        fields={fields}
        values={{ pattern: '', mode: 'match', width: 0 }}
        onChange={() => undefined}
      />
    </>,
  );
}

beforeEach(() => {
  window.localStorage.removeItem(OPTION_NOTES_STORAGE_KEY);
  forgetOptionNotes();
});

afterEach(() => {
  window.localStorage.removeItem(OPTION_NOTES_STORAGE_KEY);
  forgetOptionNotes();
});

describe('the option notes preference', () => {
  it('starts off, and says so on the control', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: 'Notes', pressed: false })).toBeInTheDocument();
  });

  /*
   * THE ASSERTION THAT MATTERS MOST, because it is the one that would make
   * hiding them unacceptable if it stopped holding. A screen reader hears the
   * sentence when the control takes focus, in both states; what the preference
   * decides is whether it is also drawn.
   */
  it('describes every control whether the notes are shown or not', async () => {
    const user = userEvent.setup();
    renderPanel();

    expect(screen.getByLabelText('Pattern')).toHaveAccessibleDescription(
      'Written without slashes.',
    );
    expect(screen.getByLabelText('Width')).toHaveAccessibleDescription('Zero for a single line.');
    expect(screen.getByRole('combobox', { name: 'Mode' })).toHaveAccessibleDescription(
      'Match or replace.',
    );

    await user.click(screen.getByRole('button', { name: 'Notes' }));

    expect(screen.getByLabelText('Pattern')).toHaveAccessibleDescription(
      'Written without slashes.',
    );
    expect(screen.getByLabelText('Width')).toHaveAccessibleDescription('Zero for a single line.');
  });

  /*
   * ONE CONTROL FOR THE WHOLE PANEL. A disclosure per field would be one extra
   * tab stop per field for a density setting - forty of them on the tall-panel
   * fixture - so the toggle has to reach every field at once.
   */
  it('one press paints every description in the panel', async () => {
    const user = userEvent.setup();
    renderPanel();

    const sentences = ['Written without slashes.', 'Match or replace.', 'Zero for a single line.'];
    const quiet = () =>
      sentences
        .map((sentence) => screen.getByText(sentence).className)
        .filter((name) => name.includes('descriptionQuiet')).length;

    expect(quiet()).toBe(sentences.length);
    await user.click(screen.getByRole('button', { name: 'Notes' }));
    expect(quiet()).toBe(0);
    expect(screen.getByRole('button', { name: 'Notes', pressed: true })).toBeInTheDocument();
  });

  it('is remembered, so it is asked for once and not on every visit', async () => {
    const user = userEvent.setup();
    const { unmount } = renderPanel();

    await user.click(screen.getByRole('button', { name: 'Notes' }));
    expect(window.localStorage.getItem(OPTION_NOTES_STORAGE_KEY)).toBe('shown');

    unmount();
    forgetOptionNotes();
    renderPanel();
    expect(screen.getByRole('button', { name: 'Notes', pressed: true })).toBeInTheDocument();
  });

  /*
   * A BLOCKED `localStorage` MUST NOT BE A BLANK PAGE. Storage throws outright
   * in private modes and under some enterprise policies, and the fallback is
   * the default answer, which is also the conservative one.
   */
  it('falls back to the default when storage refuses to answer', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('denied');
      },
    });

    try {
      forgetOptionNotes();
      renderPanel();
      expect(screen.getByRole('button', { name: 'Notes', pressed: false })).toBeInTheDocument();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
      forgetOptionNotes();
    }
  });
});
