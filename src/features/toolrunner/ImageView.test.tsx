import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Bytes } from '@/features/registry/types';
import { expectNoAxeViolations } from '@/lib/testing/axe';
import { jpeg as jpegFixture, png as pngFixture } from '@/tools/image-convert/fixtures';

import {
  ImageView,
  isPreviewableImage,
  previewAspectRatio,
  type ImageComparison,
} from './ImageView';

/**
 * The bug these tests exist to prevent is not a crash. It is the runner
 * saying "Binary output. Download it rather than trying to read it here."
 * about an image — which is true of a ZIP and false of the one thing this
 * tool produces. You converted a picture at quality 0.6 and the only way to
 * find out what 0.6 looked like was to download the file and open it
 * somewhere else.
 *
 * The other half is object-URL lifetime. An object URL pins its blob for the
 * life of the document, so a preview that never revokes is a memory leak with
 * nothing on screen to explain it — and a leak is invisible in exactly the way
 * a test is good at catching.
 */

const png = pngFixture({ width: 8, height: 8 });

/**
 * Object URLs, counted.
 *
 * jsdom implements `createObjectURL`, so the view works without this — but
 * "was it revoked" is a question only a spy can answer, and it is the question
 * that matters here.
 */
let created: string[] = [];
let revoked: string[] = [];

beforeEach(() => {
  created = [];
  revoked = [];
  let next = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    next += 1;
    const url = `blob:test/${next.toString()}`;
    created.push(url);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
    revoked.push(url);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderImage(
  bytes: Bytes = png,
  comparison: ImageComparison | null = null,
  filename = 'photo.webp',
) {
  const onDownload = vi.fn();
  const result = render(
    <ImageView
      bytes={bytes}
      label="Image Converted image"
      filename={filename}
      comparison={comparison}
      onDownload={onDownload}
    />,
  );
  return { ...result, onDownload };
}

/** A stand-in source image, as the runner supplies it from the chosen File. */
function sourceOf(): ImageComparison {
  return {
    blob: new Blob([png], { type: 'image/png' }),
    label: 'PNG image',
    byteLength: 2048,
    ratio: previewAspectRatio(png),
  };
}

describe('previewAspectRatio', () => {
  /*
   * THE JUMP THIS PREVENTS.
   *
   * An `<img>` whose src has not decoded yet has no intrinsic size, and this
   * one is `inline-size: 100%` with its height left to the picture - so the
   * panel was zero pixels tall and then up to 420px tall, one frame after a
   * run finished, with everything below it moving under the cursor at the
   * moment somebody was reaching for it.
   *
   * The reason it lasted is worth keeping: the stylesheet had a `.placeholder`
   * block written to hold the box open, and no component had ever named it, so
   * the rule had never once been on an element. Nothing failed, because a
   * class nobody names produces no error.
   *
   * A fixed reserved height would only move the jump - a favicon would open a
   * 420px hole and collapse it - so the box has to be right from the first
   * frame, which means reading the ratio out of the header.
   */
  it('reads a landscape ratio out of a PNG header', () => {
    expect(previewAspectRatio(pngFixture({ width: 800, height: 400 }))).toBeCloseTo(2, 10);
  });

  it('reads a portrait ratio out of a JPEG header', () => {
    expect(previewAspectRatio(jpegFixture({ width: 300, height: 900 }))).toBeCloseTo(1 / 3, 10);
  });

  /*
   * Degrading to null rather than to a guess. A wrong ratio is worse than
   * none: none is today's jump, and a wrong one is a box that resizes to
   * something ELSE once the picture arrives.
   */
  it('has no ratio for bytes that are not an image it previews', () => {
    expect(previewAspectRatio(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it('has no ratio for a header truncated before its dimensions', () => {
    const truncated = pngFixture({ width: 8, height: 8 }).slice(0, 12);
    expect(previewAspectRatio(truncated)).toBeNull();
  });
});

describe('the reserved preview box', () => {
  it('gives the result image its aspect ratio before anything has decoded', () => {
    renderImage(pngFixture({ width: 800, height: 400 }));

    // The style is on the element from the first render: nothing here has
    // loaded, and jsdom never will.
    expect(screen.getByRole('img')).toHaveStyle({ aspectRatio: '2' });
  });

  it('gives the compared source its own ratio rather than the result one', async () => {
    const user = userEvent.setup();
    renderImage(pngFixture({ width: 800, height: 400 }), {
      blob: new Blob([png], { type: 'image/png' }),
      label: 'PNG image',
      byteLength: 2048,
      ratio: previewAspectRatio(pngFixture({ width: 300, height: 900 })),
    });

    await user.click(screen.getByRole('button', { name: 'Compare' }));

    const [before, after] = screen.getAllByRole('img');
    expect(before).toHaveStyle({ aspectRatio: String(1 / 3) });
    expect(after).toHaveStyle({ aspectRatio: '2' });
  });

  it('leaves the element alone when the header cannot be read', () => {
    /*
     * A GIF this view will preview but whose header is a stub. The point is
     * that an unreadable header costs the old behaviour and nothing more - no
     * `aspect-ratio: NaN`, which would collapse the box permanently rather
     * than for one frame.
     */
    renderImage(new Uint8Array([0x47, 0x49, 0x46, 0x38]));

    expect(screen.getByRole('img').getAttribute('style')).toBeNull();
  });
});

describe('isPreviewableImage', () => {
  /*
   * Keyed on the SNIFF rather than on a port hint, so base64's decoded output
   * gets the preview too — pasting a `data:` URI, decoding it and seeing the
   * picture is a real thing people do with that tool.
   */
  it('recognises an image from its bytes, not from a declared type', () => {
    expect(isPreviewableImage(png)).toBe(true);
  });

  it('leaves anything that is not an image to the binary summary', () => {
    // A ZIP really is a thing you can only download.
    expect(isPreviewableImage(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe(false);
    expect(isPreviewableImage(new TextEncoder().encode('hello, world'))).toBe(false);
  });
});

describe('ImageView', () => {
  it('shows the image instead of telling you to download it', () => {
    renderImage();

    const image = screen.getByRole('img', { name: 'Image Converted image' });
    expect(image).toHaveAttribute('src', created[0]);
    expect(screen.queryByText(/Binary output/)).not.toBeInTheDocument();
  });

  it('states the format and the size beside it', () => {
    renderImage();
    expect(screen.getByText(/PNG image/)).toBeInTheDocument();
  });

  /*
   * The raw payload for bytes is a FILE, not text: there is nothing to put in
   * a textarea and nothing to copy. So Download is on screen in every state
   * rather than behind a Raw toggle, which is a stronger form of "the payload
   * stays reachable" rather than an exemption from it.
   */
  it('keeps Download on screen rather than behind a view toggle', async () => {
    const user = userEvent.setup();
    const { onDownload } = renderImage(png, sourceOf());

    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(onDownload).toHaveBeenCalledWith(expect.any(Blob), 'photo.webp');

    await user.click(screen.getByRole('button', { name: 'Compare' }));
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
  });
});

describe('ImageView: before and after', () => {
  /*
   * Judging a lossy conversion means comparing. The numbers in the report
   * cannot tell you whether quality 0.6 is acceptable for THIS picture; only
   * the two images side by side can.
   */
  it('offers the source beside the result when the page still has it', async () => {
    const user = userEvent.setup();
    renderImage(png, sourceOf());

    await user.click(screen.getByRole('button', { name: 'Compare' }));

    expect(screen.getByText('Before')).toBeInTheDocument();
    expect(screen.getByText('After')).toBeInTheDocument();
    expect(screen.getAllByRole('img')).toHaveLength(2);
  });

  /*
   * Result is the default, not Compare. At 320px two images side by side are
   * two images too small to judge anything by, and "what did I just make"
   * comes before "how does it differ".
   */
  it('opens on the result rather than on the comparison', () => {
    renderImage(png, sourceOf());

    expect(screen.getByRole('button', { name: 'Result' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });

  it('offers no toggle at all when there is nothing to compare against', () => {
    renderImage();
    expect(screen.queryByRole('button', { name: 'Compare' })).not.toBeInTheDocument();
  });

  /*
   * The source's bitmap is not paid for by somebody who never presses Compare.
   * One image on screen is one object URL - and pressing Compare ADDS one
   * rather than tearing down the result and decoding it a second time, which
   * is what the keys on the two figures are for.
   */
  it('does not decode the source until the comparison is asked for', async () => {
    const user = userEvent.setup();
    renderImage(png, sourceOf());

    expect(created).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Compare' }));
    expect(created).toHaveLength(2);
    expect(revoked).toHaveLength(0);
  });

  /*
   * And going back releases it. The original stays decoded for the rest of the
   * session otherwise, which is the leak this whole arrangement is about.
   */
  it('releases the source when the comparison is closed again', async () => {
    const user = userEvent.setup();
    renderImage(png, sourceOf());

    await user.click(screen.getByRole('button', { name: 'Compare' }));
    await user.click(screen.getByRole('button', { name: 'Result' }));

    expect(revoked).toEqual([created[1]]);
  });
});

describe('ImageView: memory', () => {
  /*
   * An object URL pins its blob for the life of the DOCUMENT. Thirty
   * conversions in one sitting with no revoke is thirty images held with
   * nothing on screen to explain the memory — a leak that is invisible right
   * up until it is not.
   */
  it('revokes the object URL when the view goes away', () => {
    const { unmount } = renderImage();

    expect(created).toHaveLength(1);
    expect(revoked).toHaveLength(0);

    unmount();
    expect(revoked).toEqual(created);
  });

  it('revokes the previous URL when a new result replaces the old one', () => {
    const { rerender } = renderImage();
    const first = created[0];

    rerender(
      <ImageView
        bytes={pngFixture({ width: 16, height: 16 })}
        label="Image Converted image"
        filename="photo.webp"
        comparison={null}
        onDownload={() => undefined}
      />,
    );

    expect(revoked).toContain(first);
    expect(created.length).toBeGreaterThan(1);
  });

  /*
   * A preview costs a decoded bitmap whatever the file size — a 40-megapixel
   * PNG is around 160 MB of RGBA — and the compare view holds two. Over the
   * limit the cost is stated and the decision is the user's, rather than the
   * tab locking up for somebody who only wanted the byte count.
   */
  it('refuses to decode a very large image until asked', async () => {
    const user = userEvent.setup();
    const huge: Bytes = new Uint8Array(new ArrayBuffer(9 * 1024 * 1024));
    huge.set(png.subarray(0, 8));

    renderImage(huge);

    expect(created).toHaveLength(0);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    // The facts are still there: the size is what that person probably came for.
    expect(screen.getByText(/9\.0 MB/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show preview anyway' }));
    expect(created).toHaveLength(1);
    expect(screen.getByRole('img')).toBeInTheDocument();
  });
});

describe('ImageView: accessibility', () => {
  it('has no axe violations showing a result', async () => {
    const { container } = renderImage();
    await expectNoAxeViolations(container);
  });

  it('has no axe violations in the comparison', async () => {
    const user = userEvent.setup();
    const { container } = renderImage(png, sourceOf());

    await user.click(screen.getByRole('button', { name: 'Compare' }));
    await expectNoAxeViolations(container);
  });

  it('has no axe violations in the over-the-limit state', async () => {
    const huge: Bytes = new Uint8Array(new ArrayBuffer(9 * 1024 * 1024));
    huge.set(png.subarray(0, 8));

    const { container } = renderImage(huge);
    await expectNoAxeViolations(container);
  });
});
