import { THEMED_TOKENS, type ThemedToken } from './types';

/**
 * THE EDITOR'S VIEW OF THE THEMABLE SURFACE
 *
 * `THEMED_TOKENS` is a flat list of 36 names, which is the right shape for a
 * type and the wrong shape for a person. This file groups them and says, in
 * one line each, what the token is FOR - because "surface-inset" tells you
 * nothing about when it is used and "the well a code block or a text area sits
 * in" tells you everything.
 *
 * Nothing here changes what a theme may set. The groups are presentation.
 */

export interface TokenDescriptor {
  readonly token: ThemedToken;
  /** What this token paints. Shown under the field. */
  readonly hint: string;
}

export interface TokenGroup {
  readonly id: string;
  readonly title: string;
  /** One line explaining what the group as a whole controls. */
  readonly summary: string;
  readonly tokens: readonly TokenDescriptor[];
}

export const TOKEN_GROUPS: readonly TokenGroup[] = [
  {
    id: 'surfaces',
    title: 'Surfaces',
    summary: 'The stack of backgrounds, from the page behind everything to a floating menu.',
    tokens: [
      { token: 'surface-sunken', hint: 'Behind the page. The canvas backdrop.' },
      { token: 'surface-base', hint: 'The page itself. Most things sit on this.' },
      { token: 'surface-raised', hint: 'A panel lifted off the page.' },
      { token: 'surface-overlay', hint: 'A menu, dialog or popover above everything.' },
      { token: 'surface-inset', hint: 'A well: a code block, a text area, a readout.' },
    ],
  },
  {
    id: 'ink',
    title: 'Ink',
    summary: 'Every colour text is drawn in. The first three carry almost all the reading.',
    tokens: [
      { token: 'ink-primary', hint: 'Body text and headings.' },
      { token: 'ink-secondary', hint: 'Supporting prose and descriptions.' },
      { token: 'ink-muted', hint: 'Labels, metadata, units.' },
      { token: 'ink-disabled', hint: 'Text in a control that cannot be used.' },
      { token: 'ink-inverse', hint: 'Text on an inverted surface, such as a tooltip.' },
      { token: 'ink-accent', hint: 'Text that carries the accent: links, active labels.' },
      { token: 'ink-on-accent', hint: 'Text printed on the accent colour itself.' },
    ],
  },
  {
    id: 'borders',
    title: 'Borders',
    summary: 'Rules and edges. Hairline and strong are structural; subtle is decoration.',
    tokens: [
      { token: 'border-subtle', hint: 'A decorative rule inside a panel. Carries no meaning.' },
      { token: 'border-hairline', hint: 'The edge of a panel. Structural, so it must be seen.' },
      { token: 'border-strong', hint: 'A divider that separates rather than decorates.' },
      { token: 'border-accent', hint: 'The edge of something selected or active.' },
    ],
  },
  {
    id: 'accent',
    title: 'Accent',
    summary: 'The one hue the interface leans on. Its three states are hover, press and wash.',
    tokens: [
      { token: 'accent', hint: 'Primary buttons, the selection bar, the active rule.' },
      { token: 'accent-hover', hint: 'The accent under a pointer.' },
      { token: 'accent-active', hint: 'The accent while being pressed.' },
      { token: 'accent-subtle', hint: 'A wash of the accent behind something.' },
    ],
  },
  {
    id: 'controls',
    title: 'Controls',
    summary: 'Inputs, buttons and toggles: their fill and their edge, through every state.',
    tokens: [
      { token: 'control-surface', hint: 'The fill of an input or a secondary button.' },
      { token: 'control-surface-hover', hint: 'That fill under a pointer.' },
      { token: 'control-surface-active', hint: 'That fill while being pressed.' },
      { token: 'control-surface-disabled', hint: 'That fill when the control cannot be used.' },
      { token: 'control-border', hint: 'The edge of a control. Structural, so it must be seen.' },
      { token: 'control-border-hover', hint: 'That edge under a pointer.' },
    ],
  },
  {
    id: 'signal',
    title: 'Signal states',
    summary: 'Success, warning and error - each an ink and the wash it is printed on.',
    tokens: [
      { token: 'signal-ok', hint: 'Success text and glyphs.' },
      { token: 'signal-ok-surface', hint: 'The wash behind a success message.' },
      { token: 'signal-warn', hint: 'Warning text and glyphs.' },
      { token: 'signal-warn-surface', hint: 'The wash behind a warning.' },
      { token: 'signal-error', hint: 'Error text and glyphs.' },
      { token: 'signal-error-surface', hint: 'The wash behind an error.' },
      { token: 'signal-on-surface', hint: 'Text printed on any of the three washes.' },
    ],
  },
  {
    id: 'focus',
    title: 'Focus and selection',
    summary: 'What the keyboard draws, and what a text selection looks like.',
    tokens: [
      { token: 'focus-ring', hint: 'The ring around the focused element. Never remove it.' },
      { token: 'selection-surface', hint: 'The highlight behind selected text.' },
      { token: 'selection-ink', hint: 'Selected text itself.' },
    ],
  },
];

/**
 * Every token appears in exactly one group.
 *
 * Asserted rather than trusted, because a token added to `THEMED_TOKENS` and
 * forgotten here would simply be uneditable, with nothing to show for it. The
 * check runs in the test suite; see tokenGroups.test.ts.
 */
export function ungroupedTokens(): readonly ThemedToken[] {
  const grouped = new Set(TOKEN_GROUPS.flatMap((group) => group.tokens.map((one) => one.token)));
  return THEMED_TOKENS.filter((token) => !grouped.has(token));
}

/** The hint for one token, or null when it has none. */
export function tokenHint(token: ThemedToken): string | null {
  for (const group of TOKEN_GROUPS) {
    for (const descriptor of group.tokens) {
      if (descriptor.token === token) return descriptor.hint;
    }
  }
  return null;
}
