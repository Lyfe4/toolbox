import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { HtmlView } from './HtmlView';
import { OutputView } from './OutputPanel';
import { TEXT_PREVIEW_CHARS, textPreview, textPreviewHint } from './textPreview';

/*
 * A textarea is laid out whole, and mounting one that holds a 5.6 MB result
 * held Gecko's main thread for about 575ms and WebKit's for seconds - once per
 * keystroke into a large field upstream, because a node re-mounts its output
 * after every run. The box is a preview past TEXT_PREVIEW_CHARS; what these
 * hold is that the preview is honest about it and the actions are not cut.
 */
describe('a text result bigger than its box', () => {
  const big = 'x'.repeat(TEXT_PREVIEW_CHARS * 3);

  it('shows all of a result that fits, with the plain count', () => {
    const preview = textPreview('hello');
    expect(preview).toEqual({ shown: 'hello', clipped: false });
    expect(textPreviewHint('hello', preview)).toBe('5 characters');
    expect(textPreview('y'.repeat(TEXT_PREVIEW_CHARS)).clipped).toBe(false);
  });

  it('cuts at the cap, and never through a surrogate pair', () => {
    expect(textPreview(big).shown).toHaveLength(TEXT_PREVIEW_CHARS);
    const emoji = `${'a'.repeat(TEXT_PREVIEW_CHARS - 1)}😀tail`;
    const shown = textPreview(emoji).shown;
    expect(shown).toBe('a'.repeat(TEXT_PREVIEW_CHARS - 1));
  });

  it('puts only the preview in the box, says so, and copies and downloads all of it', async () => {
    const onCopy = vi.fn();
    const onDownload = vi.fn();
    render(
      <OutputView
        value={{ type: 'text', text: big }}
        label="Result"
        baseFilename="tool"
        onCopy={onCopy}
        onCopyRich={() => undefined}
        onDownload={onDownload}
      />,
    );
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Result' });
    expect(box.value).toHaveLength(TEXT_PREVIEW_CHARS);
    expect(
      screen.getByText(
        'Showing the first 65,536 of 196,608 characters - Copy and Download take all of it',
      ),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(onCopy).toHaveBeenCalledWith(big);
    await userEvent.click(screen.getByRole('button', { name: 'Download' }));
    const blob = onDownload.mock.calls[0]?.[0] as Blob;
    expect(blob.size).toBe(big.length);
  });

  it('does the same for the HTML source view', async () => {
    const onCopy = vi.fn();
    const html = `<p>${big}</p>`;
    render(
      <HtmlView
        html={html}
        label="Rendered HTML"
        baseFilename="tool"
        onCopy={onCopy}
        onCopyRich={() => undefined}
        onDownload={() => undefined}
      />,
    );
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Rendered HTML' });
    expect(box.value).toHaveLength(TEXT_PREVIEW_CHARS);
    expect(screen.getByText(/^Showing the first 65,536 of/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Copy HTML' }));
    expect(onCopy).toHaveBeenCalledWith(html);
  });
});
