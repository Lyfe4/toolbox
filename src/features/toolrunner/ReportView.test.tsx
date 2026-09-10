import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { JsonValue } from '@/features/registry/types';
import { expectNoAxeViolations } from '@/lib/testing/axe';

import { ReportView } from './ReportView';

/**
 * The payload the image tool actually emits, trimmed to what this view reads.
 *
 * Written out rather than generated, because the point of these tests is that
 * a change to the tool's output shape shows up here as a missing section
 * rather than as a crash inside a render.
 */
const report: JsonValue = {
  from: {
    format: 'image/png',
    width: 200,
    height: 120,
    bytes: 1056,
    size: '1.0 kB',
    hasAlpha: true,
    frames: 1,
    metadata: ['EXIF', 'GPS location'],
  },
  to: {
    format: 'image/jpeg',
    width: 200,
    height: 120,
    bytes: 1440,
    size: '1.4 kB',
    hasAlpha: false,
    frames: 1,
    metadata: [],
  },
  changePercent: 36.4,
  summary: '1.0 kB → 1.4 kB (+36.4%) · GPS location was removed',
  notes: [
    {
      level: 'warn',
      title: 'GPS location was removed',
      body: 'The source carried EXIF, GPS location. None of it is in the output.',
    },
    {
      level: 'info',
      title: 'Re-encoding a lossy image costs a generation',
      body: 'The source is already lossily compressed.',
    },
  ],
};

/**
 * The three callbacks belong to the raw view's Copy and Download, which the
 * report shares with every other output. Defaulted here so each test names
 * only what it is about.
 */
function renderReport(value: JsonValue = report) {
  const onCopy = vi.fn();
  const onDownload = vi.fn();
  const result = render(
    <ReportView
      value={value}
      label="Image Details"
      baseFilename="image-convert"
      onCopy={onCopy}
      onDownload={onDownload}
    />,
  );
  return { ...result, onCopy, onDownload };
}

describe('ReportView', () => {
  /*
   * THE REASON THIS VIEW EXISTS.
   *
   * The notes were correct, carefully worded and rendered as
   * `JSON.stringify(..., 2)` in a read-only textarea in the third output panel
   * - which is the same "a caveat nobody scrolls to has not been said" the
   * notes were written to fix, one level up. In an application whose pitch is
   * that your data does not move, this is the sentence that most needed
   * saying.
   */
  it('puts the warnings above the numbers, in words', () => {
    renderReport();

    const notes = screen.getByRole('list', { name: 'Image Details notes' });
    const table = screen.getByRole('table');

    expect(notes.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('GPS location was removed')).toBeInTheDocument();
    expect(screen.getByText(/None of it is in the output/)).toBeInTheDocument();
  });

  it('carries the level as a word, not only as a colour', () => {
    renderReport();

    // WCAG 1.4.1, and the same rule the regex notes follow.
    expect(screen.getByText('Warning')).toBeInTheDocument();
    expect(screen.getByText('Note')).toBeInTheDocument();
  });

  it('states each fact against its own row header, before and after', () => {
    renderReport();

    const rows = screen.getAllByRole('row');
    const transparency = rows.find((row) => row.textContent.startsWith('Transparency'));

    // `Yes` then `No` in one row, so "it had alpha and now does not" is one
    // glance rather than a comparison across two panels.
    expect(transparency?.textContent).toBe('TransparencyYesNo');
    expect(screen.getByRole('rowheader', { name: 'Metadata' })).toBeInTheDocument();
    expect(screen.getByText('EXIF, GPS location')).toBeInTheDocument();
  });

  it('names media types the way a person writes them', () => {
    renderReport();

    // `image/webp` is what the port carries; "WebP" is what the option that
    // produced it is called.
    expect(screen.getByText('PNG')).toBeInTheDocument();
    expect(screen.getByText('JPEG')).toBeInTheDocument();
  });

  /*
   * The same view, over a payload from a completely different tool.
   *
   * A row is dropped when neither side has anything to say, which is what lets
   * one view serve two tools that measure different things: the video tool has
   * a duration and no transparency, the image tool the other way round. Both
   * get a table with only their own rows in it, from one implementation.
   */
  it('serves a second tool without carrying the first tool’s empty rows', () => {
    renderReport({
      from: {
        format: 'Matroska · H.264 + AAC',
        width: 1920,
        height: 1080,
        duration: '1:02',
        frames: 1860,
        size: '92.6 MB',
        metadata: ['Recording date'],
      },
      to: {
        format: 'MP4 · H.264 + AAC',
        width: 1920,
        height: 1080,
        duration: '1:02',
        frames: 1860,
        size: '92.6 MB',
        metadata: [],
      },
      summary: 'Matroska · H.264 + AAC → MP4 · H.264 + AAC · 92.6 MB',
      notes: [],
    });

    const headers = screen.getAllByRole('rowheader').map((cell) => cell.textContent);
    expect(headers).toEqual(['Format', 'Dimensions', 'Duration', 'Size', 'Frames', 'Metadata']);
    // Transparency is an image question, and this report never asked it.
    expect(headers).not.toContain('Transparency');
    // Once on each side: a repackage does not change how long the film is.
    expect(screen.getAllByText('1:02', { selector: 'td' })).toHaveLength(2);
  });

  it('drops a row neither side can fill rather than showing an empty one', () => {
    renderReport({ summary: 'done', notes: [], from: { size: '1 kB' }, to: { size: '2 kB' } });

    expect(screen.getByRole('rowheader', { name: 'Size' })).toBeInTheDocument();
    expect(screen.queryByRole('rowheader', { name: 'Frames' })).not.toBeInTheDocument();
    expect(screen.queryByRole('rowheader', { name: 'Transparency' })).not.toBeInTheDocument();
  });

  /*
   * The payload crossed the worker boundary as plain JSON, so it is read back
   * with checks rather than cast. A shape this view does not recognise has to
   * degrade rather than throw inside a render.
   */
  it('says nothing to show rather than throwing on a shape it does not know', () => {
    renderReport(['not', 'a', 'report']);
    expect(screen.getByText('Nothing to show.')).toBeInTheDocument();
  });

  it('renders a report with no notes at all', () => {
    renderReport({ summary: '1.0 kB → 818 B (-22.5%)', notes: [], from: {}, to: {} });

    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('1.0 kB → 818 B (-22.5%)')).toBeInTheDocument();
  });

  /*
   * The raw payload stays reachable, and copyable, behind a toggle - the same
   * bargain the HTML output makes between its source and its preview. Losing
   * it would have been a silent removal: the exact byte counts and the note
   * levels are not in the summarised view, and they are what somebody would
   * wire into something else.
   */
  it('keeps the raw payload one press away, with Copy and Download', async () => {
    const user = userEvent.setup();
    const { onCopy, onDownload } = renderReport();

    // Report is the default, because the sentences are the part to be read.
    expect(screen.getByRole('button', { name: 'Report' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('textbox', { name: 'Image Details raw' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Raw' }));

    const box = screen.getByRole('textbox', { name: 'Image Details raw' });
    expect(box).toHaveValue(JSON.stringify(report, null, 2));
    // And the summarised view is gone rather than doubled up beneath it.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(onCopy).toHaveBeenCalledWith(JSON.stringify(report, null, 2));

    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(onDownload).toHaveBeenCalledWith(expect.any(Blob), 'image-convert.json');
  });

  it('says which view is showing in words, not only as a pressed state', () => {
    renderReport();

    // "Raw, pressed" describes the control; this describes the result.
    expect(screen.getByRole('status')).toHaveTextContent('Showing the summarised report');
  });

  it('has no axe violations', async () => {
    const { container } = renderReport();
    await expectNoAxeViolations(container);
  });
});
