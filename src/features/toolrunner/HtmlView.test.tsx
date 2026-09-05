import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '@/lib/testing/axe';

import { copyRichText, HtmlView } from './HtmlView';

const HTML = '<h1>Title</h1>\n<p>Body <strong>text</strong>.</p>\n';

function renderView(html = HTML) {
  const onCopy = vi.fn();
  const onCopyRich = vi.fn();
  const onDownload = vi.fn();

  const result = render(
    <HtmlView
      html={html}
      label="Markdown Rendered HTML"
      baseFilename="markdown"
      onCopy={onCopy}
      onCopyRich={onCopyRich}
      onDownload={onDownload}
    />,
  );

  return { ...result, onCopy, onCopyRich, onDownload };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the source/preview toggle', () => {
  it('shows the source first, because the markup is what people came for', () => {
    renderView();

    expect(screen.getByRole('textbox', { name: 'Markdown Rendered HTML' })).toHaveValue(HTML);
    expect(screen.queryByTitle(/preview/i)).not.toBeInTheDocument();
  });

  it('says which view is showing, in words as well as pressed states', async () => {
    const user = userEvent.setup();
    renderView();

    expect(screen.getByRole('status')).toHaveTextContent('Showing HTML source');
    expect(screen.getByRole('button', { name: 'Source' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Preview' }));

    // "Preview, pressed" describes the CONTROL; this describes the RESULT.
    expect(screen.getByRole('status')).toHaveTextContent('Showing rendered preview');
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Source' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('switches back to the source', async () => {
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await user.click(screen.getByRole('button', { name: 'Source' }));

    expect(screen.getByRole('textbox', { name: 'Markdown Rendered HTML' })).toBeInTheDocument();
  });
});

describe('the preview iframe', () => {
  it('is sandboxed with nothing allowed', async () => {
    const user = userEvent.setup();
    const { container } = renderView();

    await user.click(screen.getByRole('button', { name: 'Preview' }));
    const frame = container.querySelector('iframe');

    expect(frame).not.toBeNull();
    /*
     * The EMPTY string, not a missing attribute: `sandbox=""` applies every
     * restriction. A missing attribute applies none.
     */
    expect(frame?.getAttribute('sandbox')).toBe('');
    // The two that matter most, and the pair that must never both appear:
    // allow-scripts WITH allow-same-origin lets framed content reach out and
    // remove its own sandbox attribute.
    expect(frame?.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(frame?.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });

  it('is populated by srcdoc rather than a URL', async () => {
    const user = userEvent.setup();
    const { container } = renderView();

    await user.click(screen.getByRole('button', { name: 'Preview' }));
    const frame = container.querySelector('iframe');

    // No request, nothing to revoke, and nothing that connect-src has to
    // make an exception for.
    expect(frame?.getAttribute('srcdoc')).toContain(HTML);
    expect(frame?.getAttribute('src')).toBeNull();
  });

  it('renders what the tool produced, not what the user typed', async () => {
    const user = userEvent.setup();
    // The tool sanitises on the way out; this view only ever receives that
    // output. Anything hostile is already gone by the time it gets here.
    const { container } = renderView('<p>safe</p>');

    await user.click(screen.getByRole('button', { name: 'Preview' }));

    expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('<p>safe</p>');
  });

  it('carries a stylesheet, because nothing else can reach the frame', async () => {
    const user = userEvent.setup();
    const { container } = renderView();

    await user.click(screen.getByRole('button', { name: 'Preview' }));
    const srcdoc = container.querySelector('iframe')?.getAttribute('srcdoc') ?? '';

    /*
     * Measured against the real policy: an unhashed <style>, a style attribute
     * and a <link> to this origin are ALL refused inside a sandboxed frame -
     * the last because an opaque origin is not `'self'`. A hashed inline style
     * block is the only route in, which is why it is inlined here rather than
     * linked. `pnpm check:browsers` asserts the result actually renders styled.
     */
    expect(srcdoc.startsWith('<meta charset="utf-8"><style>')).toBe(true);
    expect(srcdoc).toContain('border-collapse: collapse');
    expect(srcdoc).not.toContain('<link');
  });

  it('has a name a screen reader can announce', async () => {
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole('button', { name: 'Preview' }));

    // Without a title it is an unlabelled frame the user has to enter to
    // identify.
    expect(screen.getByTitle('Markdown Rendered HTML preview')).toBeInTheDocument();
  });
});

describe('copying', () => {
  it('offers plain and rich copy as two separate actions', async () => {
    const user = userEvent.setup();
    const { onCopy, onCopyRich } = renderView();

    await user.click(screen.getByRole('button', { name: 'Copy HTML' }));
    expect(onCopy).toHaveBeenCalledWith(HTML);

    await user.click(screen.getByRole('button', { name: /Copy as rich text/ }));
    expect(onCopyRich).toHaveBeenCalledWith(HTML);
  });

  /*
   * RICH TEXT IS THE FEATURE PEOPLE CAME FOR, and it used to be one of four
   * identical ghost buttons in a row with nothing to say so. These assert the
   * three things that fixed it, because each is easy to undo by accident.
   */
  it('names the plain copy for what lands on the clipboard', () => {
    renderView();

    // "Copy" beside "Copy as rich text" says nothing about the difference.
    expect(screen.getByRole('button', { name: 'Copy HTML' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
  });

  it('groups the two copies as alternatives to each other', () => {
    renderView();

    const group = screen.getByRole('group', { name: 'Copy Markdown Rendered HTML' });

    expect(within(group).getByRole('button', { name: 'Copy HTML' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: /Copy as rich text/ })).toBeInTheDocument();
    // Download is a different kind of thing and stays outside.
    expect(within(group).queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
  });

  it('describes what rich text actually does, on the button itself', () => {
    renderView();

    // On the button rather than merely nearby, so it is read by a screen
    // reader on arrival instead of only if the user walks past the paragraph.
    expect(screen.getByRole('button', { name: /Copy as rich text/ })).toHaveAccessibleDescription(
      /keeps the formatting when you paste into Word, Google Docs or an email/,
    );
  });

  it('says in the preview that this is what rich text pastes', async () => {
    const user = userEvent.setup();
    renderView();

    // Not while the source is showing: there it would be a claim about a view
    // you are not looking at.
    expect(screen.queryByText(/This is what Copy as rich text pastes/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Preview' }));

    expect(screen.getByText(/This is what Copy as rich text pastes/)).toBeInTheDocument();
  });

  it('writes both text/html and text/plain in one item', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const seen: Record<string, Blob>[] = [];

    // A vi.fn() rather than a class: it is constructible with `new`, records
    // what it was given, and does not trip the no-extraneous-class rule for a
    // stub that exists only to be instantiated.
    /*
     * A `function` expression, not an arrow: this stub is invoked with `new`,
     * and an arrow function has no [[Construct]] slot. vitest says so out
     * loud - "the vi.fn() mock did not use 'function' or 'class'" - which is a
     * better error than most.
     */
    vi.stubGlobal(
      'ClipboardItem',
      vi.fn(function (items: Record<string, Blob>) {
        seen.push(items);
      }),
    );
    vi.stubGlobal('navigator', { clipboard: { write } });

    const result = await copyRichText('<p>hi</p>', '<p>hi</p>');

    expect(result).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(1);
    // Both flavours, in ONE ClipboardItem - that is what lets the destination
    // choose, and what writeText could never do.
    expect(Object.keys(seen[0] ?? {})).toEqual(['text/html', 'text/plain']);
  });

  it('degrades with a clear message where ClipboardItem is missing', async () => {
    // Firefox shipped ClipboardItem years after Chrome and Safari, so this is
    // a real browser, not a hypothetical one.
    vi.stubGlobal('ClipboardItem', undefined);
    vi.stubGlobal('navigator', { clipboard: { write: vi.fn() } });

    const result = await copyRichText('<p>hi</p>', '<p>hi</p>');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/cannot put formatted text/i);
  });

  it('degrades where the whole clipboard API is missing', async () => {
    vi.stubGlobal('ClipboardItem', vi.fn());
    vi.stubGlobal('navigator', {});

    const result = await copyRichText('<p>hi</p>', '<p>hi</p>');

    expect(result.ok).toBe(false);
  });

  it('reports a refused permission as a refusal, not a generic failure', async () => {
    const error = new Error('denied');
    error.name = 'NotAllowedError';

    vi.stubGlobal('ClipboardItem', vi.fn());
    vi.stubGlobal('navigator', { clipboard: { write: vi.fn().mockRejectedValue(error) } });

    const result = await copyRichText('<p>hi</p>', '<p>hi</p>');

    expect(!result.ok && result.reason).toMatch(/refused clipboard access/i);
  });

  it('reports any other failure without pretending to know why', async () => {
    vi.stubGlobal('ClipboardItem', vi.fn());
    vi.stubGlobal('navigator', {
      clipboard: { write: vi.fn().mockRejectedValue(new Error('boom')) },
    });

    const result = await copyRichText('<p>hi</p>', '<p>hi</p>');

    expect(!result.ok && result.reason).toMatch(/could not write/i);
  });
});

describe('accessibility', () => {
  it('has no axe violations showing the source', async () => {
    const { container } = renderView();

    await expectNoAxeViolations(container);
  });

  it('has no axe violations showing the preview', async () => {
    const user = userEvent.setup();
    const { container } = renderView();

    await user.click(screen.getByRole('button', { name: 'Preview' }));

    /*
     * `iframes: false`, and it is the sandbox that makes it necessary rather
     * than a shortcut.
     *
     * axe descends into frames by posting a message to their window. This
     * frame has `sandbox=""` with no allow-same-origin, so it is an opaque
     * origin with no window anybody outside can reach - axe throws
     * "Respondable target must be a frame in the current window" trying. That
     * is the isolation doing exactly what it is there for.
     *
     * Nothing is lost by not scanning inside: the frame's contents are the
     * USER'S document, not this application's UI. What is ours - the toggle,
     * the frame's accessible name, the buttons around it - is all out here and
     * is still scanned.
     */
    await expectNoAxeViolations(container, { iframes: false });
  });
});
