import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ToolValue } from '@/features/registry/types';
import { png as pngFixture } from '@/tools/image-convert/fixtures';

import { OutputView } from './OutputPanel';
import { comparisonFor } from './ToolRunner';

import type { LoadedFile } from './FileDrop';

/**
 * WHICH VIEW A VALUE GETS, and why the answer is not always the port.
 *
 * Two rules live here and they are deliberately different:
 *
 *  - A `json` value is drawn by whatever `presentation` its PORT declared,
 *    because four different tools emit JSON that means four different things
 *    and nothing in the value itself can tell them apart.
 *  - A `bytes` value is drawn by what the BYTES ARE, because that question has
 *    an answer and the branch was already asking half of it - the sniff is how
 *    it chose between a text preview and "binary output" in the first place.
 *
 * The second rule is why decoding a base64 `data:` URI shows the picture: the
 * base64 tool declares no presentation and never will, and it does not need to.
 */

const noop = () => undefined;

function renderValue(value: ToolValue, presentation?: 'jwt' | 'report') {
  return render(
    <OutputView
      value={value}
      label="Tool Output"
      baseFilename="tool"
      {...(presentation === undefined ? {} : { presentation })}
      onCopy={noop}
      onCopyRich={noop}
      onDownload={noop}
    />,
  );
}

describe('OutputView: choosing a view', () => {
  it('draws a JWT payload as a verdict rather than as braces', () => {
    renderValue(
      {
        type: 'json',
        data: {
          signature: {
            algorithm: 'HS256',
            verified: false,
            state: 'no-key',
            status: 'NOT VERIFIED - no key supplied.',
            detail: '',
          },
          header: { alg: 'HS256' },
          payload: { sub: 'ada' },
          claims: {},
        },
      },
      'jwt',
    );

    expect(document.querySelector('[data-trust]')).toHaveAttribute('data-trust', 'unverified');
  });

  /*
   * THE SENTENCE THIS REPLACED: "Binary output. Download it rather than trying
   * to read it here." True of a ZIP; false of the one thing the image tool
   * makes. You converted a picture and never saw it.
   */
  it('shows an image rather than telling you to download it', () => {
    renderValue({
      type: 'bytes',
      bytes: pngFixture({ width: 8, height: 8 }),
      mediaType: 'image/png',
      filename: 'photo.png',
    });

    expect(screen.getByRole('img', { name: 'Tool Output' })).toBeInTheDocument();
    expect(screen.queryByText(/Binary output/)).not.toBeInTheDocument();
  });

  /*
   * The sniff decides, not the declaration. A file claiming `image/png` that
   * is really a ZIP must not be handed to an `<img>` to fail silently.
   */
  it('believes the bytes rather than the declared media type', () => {
    renderValue({
      type: 'bytes',
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
      mediaType: 'image/png',
      filename: 'not-really.png',
    });

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText(/Binary output/)).toBeInTheDocument();
  });

  it('leaves text-shaped bytes with their text preview', () => {
    renderValue({
      type: 'bytes',
      bytes: new TextEncoder().encode('hello, world'),
      mediaType: null,
      filename: null,
    });

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('hello, world')).toBeInTheDocument();
  });

  it('still prints ordinary JSON as pretty JSON when no port said otherwise', () => {
    renderValue({ type: 'json', data: { a: 1 } });

    expect(screen.getByRole('textbox', { name: 'Tool Output' })).toHaveValue(
      JSON.stringify({ a: 1 }, null, 2),
    );
  });
});

/**
 * WHICH SOURCE A BEFORE-AND-AFTER IS DRAWN AGAINST.
 *
 * The comparison is captured when a run STARTS rather than read live off the
 * chosen file. Choosing a different picture without pressing Run again would
 * otherwise relabel the comparison without changing either image, which is a
 * comparison that quietly lies - and lying is worse than not offering one.
 */
describe('comparisonFor', () => {
  const loaded = (name: string, mediaType: string | null, label: string): LoadedFile => ({
    file: new File([new Uint8Array(4)], name),
    sniff: { mediaType, label, isProbablyText: mediaType === 'text/plain' },
  });

  const bytes = Uint8Array.from([1, 2, 3, 4]);

  it('offers the source when the run was given an image', () => {
    expect(comparisonFor(loaded('a.png', 'image/png', 'PNG image'), bytes)).toEqual({
      blob: expect.any(File) as File,
      label: 'PNG image',
      byteLength: 4,
    });
  });

  it('offers nothing for a file that is not an image', () => {
    expect(comparisonFor(loaded('a.csv', 'text/plain', 'Text'), bytes)).toBeNull();
  });

  /*
   * The sniff decides. Rename `payload.zip` to `photo.png` and the operating
   * system will cheerfully report an image; nothing here believes it.
   */
  it('offers nothing for a file whose bytes are not an image', () => {
    expect(comparisonFor(loaded('photo.png', null, 'Binary data'), bytes)).toBeNull();
  });

  it('offers nothing when the run read no bytes from the file', () => {
    expect(comparisonFor(loaded('a.png', 'image/png', 'PNG image'), null)).toBeNull();
  });

  it('offers nothing when there was no file', () => {
    expect(comparisonFor(null, bytes)).toBeNull();
  });
});
