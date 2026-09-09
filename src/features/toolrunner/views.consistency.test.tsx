import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { JsonValue } from '@/features/registry/types';
import { png as pngFixture } from '@/tools/image-convert/fixtures';

import { DiffView } from './DiffView';
import { HtmlView } from './HtmlView';
import { ImageView } from './ImageView';
import { JwtView } from './JwtView';
import { RegexView } from './RegexView';
import { ReportView } from './ReportView';

/**
 * ONE TOGGLE, NOT FOUR NEARLY-IDENTICAL ONES.
 *
 * This file is the test that stops the views drifting apart again, because
 * drift is precisely what happened the first time: the HTML output and the
 * conversion report each grew their own toggle with their own markup and two
 * byte-identical copies of the same CSS, and the diff and the regex report -
 * which render JSON as something that is emphatically not JSON - simply had no
 * way to reach their payload at all. Three implementations of one decision and
 * a fourth that had quietly opted out.
 *
 * The rule, stated once here and enforced for every view:
 *
 *  1. The toggle is a `role="group"` named "<output> view".
 *  2. Its buttons carry `aria-pressed`, and exactly one is pressed.
 *  3. A `role="status"` says which view is SHOWING, in words - because
 *     "Raw, pressed" describes the control and not the result.
 *  4. The payload is one press away, in a box named "<output> raw", with Copy
 *     and Download beside it.
 *
 * Bytes are the one documented exception and are asserted as such at the
 * bottom, rather than left to be rediscovered as an inconsistency.
 */

const LABEL = 'Output';

const noop = () => undefined;

/** A minimal payload for each view, real enough to render. */
const DIFF: JsonValue = {
  rows: [
    { kind: 'remove', oldLine: 1, newLine: null, text: 'a', parts: null },
    { kind: 'add', oldLine: null, newLine: 1, text: 'b', parts: null },
  ],
  stats: { added: 1, removed: 1, unchanged: 0, ignored: 0 },
  identical: false,
  equal: false,
  context: 3,
};

const REGEX: JsonValue = {
  pattern: '\\d+',
  flags: 'g',
  mode: 'match',
  count: 1,
  listed: 1,
  matches: [{ index: 0, line: 1, column: 1, match: '42', empty: false, groups: [] }],
  segments: [{ text: '42', match: 0 }],
  notes: [],
};

const REPORT: JsonValue = {
  summary: '1.0 kB → 800 B (-20.0%)',
  from: { format: 'image/png', size: '1.0 kB' },
  to: { format: 'image/webp', size: '800 B' },
  notes: [],
};

const JWT: JsonValue = {
  signature: {
    algorithm: 'HS256',
    verified: false,
    state: 'no-key',
    status: 'NOT VERIFIED - no key supplied.',
    detail: 'A JWT payload is base64, not encrypted.',
  },
  header: { alg: 'HS256' },
  payload: { sub: 'ada' },
  claims: {},
};

/**
 * Every view that renders a JSON payload as something else, with the name of
 * the control that goes back to the payload and the words its status line
 * says while the rendering is showing.
 */
const VIEWS = [
  {
    name: 'DiffView',
    payload: DIFF,
    rendering: 'Diff',
    status: 'Showing the rendered diff',
    render: (onCopy: (text: string) => void, onDownload: (blob: Blob, name: string) => void) => (
      <DiffView
        value={DIFF}
        label={LABEL}
        baseFilename="out"
        onCopy={onCopy}
        onDownload={onDownload}
      />
    ),
  },
  {
    name: 'RegexView',
    payload: REGEX,
    rendering: 'Matches',
    status: 'Showing the rendered matches',
    render: (onCopy: (text: string) => void, onDownload: (blob: Blob, name: string) => void) => (
      <RegexView
        value={REGEX}
        label={LABEL}
        baseFilename="out"
        onCopy={onCopy}
        onDownload={onDownload}
      />
    ),
  },
  {
    name: 'ReportView',
    payload: REPORT,
    rendering: 'Report',
    status: 'Showing the summarised report',
    render: (onCopy: (text: string) => void, onDownload: (blob: Blob, name: string) => void) => (
      <ReportView
        value={REPORT}
        label={LABEL}
        baseFilename="out"
        onCopy={onCopy}
        onDownload={onDownload}
      />
    ),
  },
  {
    name: 'JwtView',
    payload: JWT,
    rendering: 'Decoded',
    status: 'Showing the decoded token',
    render: (onCopy: (text: string) => void, onDownload: (blob: Blob, name: string) => void) => (
      <JwtView
        value={JWT}
        label={LABEL}
        baseFilename="out"
        onCopy={onCopy}
        onDownload={onDownload}
      />
    ),
  },
] as const;

describe.each(VIEWS)('$name: the shared view toggle', (view) => {
  it('is a labelled group whose buttons say which is pressed', () => {
    render(view.render(noop, noop));

    const group = screen.getByRole('group', { name: `${LABEL} view` });
    const buttons = within(group).getAllByRole('button');

    expect(buttons.length).toBeGreaterThanOrEqual(2);
    expect(buttons.filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(
      1,
    );
  });

  it('opens on the rendering rather than on the payload', () => {
    render(view.render(noop, noop));

    expect(screen.getByRole('button', { name: view.rendering })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  /*
   * "Raw, pressed" describes the CONTROL. This describes the RESULT, and it is
   * the one a screen reader user is actually asking for.
   */
  it('says which view is showing in words', () => {
    render(view.render(noop, noop));
    expect(screen.getByRole('status')).toHaveTextContent(view.status);
  });

  /*
   * THE CONSTRAINT. A view is a presentation of an output, never a replacement
   * for it. DiffView and RegexView failed this until the toggle was shared:
   * their payloads were not reachable from the page at all.
   */
  it('puts the payload one press away, copyable and downloadable', async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn();
    const onDownload = vi.fn();
    render(view.render(onCopy, onDownload));

    await user.click(screen.getByRole('button', { name: 'Raw' }));

    const json = JSON.stringify(view.payload, null, 2);
    expect(screen.getByRole('textbox', { name: `${LABEL} raw` })).toHaveValue(json);
    expect(screen.getByRole('status')).toHaveTextContent(/^Showing the raw/);

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(onCopy).toHaveBeenCalledWith(json);

    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(onDownload).toHaveBeenCalledWith(expect.any(Blob), 'out.json');
  });
});

describe('HtmlView: the one view where the payload leads', () => {
  /*
   * HTML is the exception the rule names: the raw payload IS what the person
   * came for, so Source comes first and is the default. "Source" rather than
   * "Raw" because it is the more precise word for markup, and a preview you
   * have to dismiss before you can read the output would be in the way.
   */
  it('opens on the source, with the preview as the second option', () => {
    render(
      <HtmlView
        html="<p>hello</p>"
        label={LABEL}
        baseFilename="out"
        onCopy={noop}
        onCopyRich={noop}
        onDownload={noop}
      />,
    );

    const group = screen.getByRole('group', { name: `${LABEL} view` });
    const buttons = within(group).getAllByRole('button');

    expect(buttons[0]).toHaveTextContent('Source');
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Showing HTML source');
  });
});

describe('ImageView: the documented exception', () => {
  /*
   * Bytes have no textual payload: there is nothing to put in a textarea and
   * nothing to copy. So there is no Raw state, and Download is on screen in
   * every state instead — a stronger form of "the payload stays reachable"
   * rather than an exemption from it. Written down here so the absence reads
   * as a decision rather than as the next thing somebody notices is missing.
   */
  it('has no raw state, and offers Download unconditionally', () => {
    render(
      <ImageView
        bytes={pngFixture({ width: 8, height: 8 })}
        label={LABEL}
        filename="out.webp"
        comparison={null}
        onDownload={noop}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Raw' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: `${LABEL} raw` })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
  });
});
