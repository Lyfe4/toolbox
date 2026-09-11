import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ToolValue } from '@/features/registry/types';
import { bytesValue } from '@/features/registry/types';
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
    renderValue(
      bytesValue(pngFixture({ width: 8, height: 8 }), {
        mediaType: 'image/png',
        filename: 'photo.png',
      }),
    );

    expect(screen.getByRole('img', { name: 'Tool Output' })).toBeInTheDocument();
    expect(screen.queryByText(/Binary output/)).not.toBeInTheDocument();
  });

  /*
   * The sniff decides, not the declaration. A file claiming `image/png` that
   * is really a ZIP must not be handed to an `<img>` to fail silently.
   */
  it('believes the bytes rather than the declared media type', () => {
    renderValue(
      bytesValue(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), {
        mediaType: 'image/png',
        filename: 'not-really.png',
      }),
    );

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText(/Binary output/)).toBeInTheDocument();
  });

  it('leaves text-shaped bytes with their text preview', () => {
    renderValue(bytesValue(new TextEncoder().encode('hello, world')));

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
    value: bytesValue(Uint8Array.from([1, 2, 3, 4]), { mediaType, filename: name }),
  });

  it('offers the source when the run was given an image', () => {
    expect(comparisonFor(loaded('a.png', 'image/png', 'PNG image'))).toEqual({
      blob: expect.any(File) as File,
      label: 'PNG image',
      byteLength: 4,
      // Four bytes that sniff as a PNG and are not one. A header that cannot
      // be read is reported as no ratio rather than as a guess: the preview
      // then behaves exactly as it did before ratios existed.
      ratio: null,
    });
  });

  /*
   * AND MEASURES IT WHERE THE BYTES ARE.
   *
   * The comparison carries a `Blob` rather than a copy of the bytes - it hands
   * over the `File` the browser is already holding, so that showing a
   * thumbnail of a 40 MB photograph does not put 40 MB into React state. That
   * leaves the preview with nothing to measure, so whoever still HAS the bytes
   * has to do it, and this is the assertion that says so. Without it the
   * "Before" image is the one that jumps into place a frame late.
   */
  it('reads the source aspect ratio here, where the bytes still exist', () => {
    const wide = pngFixture({ width: 640, height: 160 });
    const comparison = comparisonFor({
      file: new File([wide], 'wide.png'),
      sniff: { mediaType: 'image/png', label: 'PNG image', isProbablyText: false },
      value: bytesValue(wide, { mediaType: 'image/png', filename: 'wide.png' }),
    });

    expect(comparison?.ratio).toBeCloseTo(4, 10);
  });

  it('offers nothing for a file that is not an image', () => {
    expect(comparisonFor(loaded('a.csv', 'text/plain', 'Text'))).toBeNull();
  });

  /*
   * The sniff decides. Rename `payload.zip` to `photo.png` and the operating
   * system will cheerfully report an image; nothing here believes it.
   */
  it('offers nothing for a file whose bytes are not an image', () => {
    expect(comparisonFor(loaded('photo.png', null, 'Binary data'))).toBeNull();
  });

  it('offers nothing when there was no file', () => {
    expect(comparisonFor(null)).toBeNull();
  });
});

/* ========================================================================== *
 * HOW BIG THE BOX IS
 * ========================================================================== */

/**
 * A TEXT RESULT USED TO BE DRAWN IN A 200px BOX WHATEVER IT WAS.
 *
 * The output textarea shared `.editor` with the input editors, and an input's
 * floor is right for an input - it is a place to put something that is not
 * there yet. An output already knows how much of it there is, so the same rule
 * drew colour's `#3366cc`, seven characters, in a box 200px tall and 560px
 * wide, and hash's sixty-four-character digest in the same one. On the two
 * tools whose entire result is one short string, the box was the largest thing
 * on the page.
 *
 * `field-sizing: content` is the accurate half of the fix and jsdom cannot see
 * it - it has no layout engine, so nothing here is a height. What jsdom CAN
 * see is the `rows` attribute, which is the fallback for engines without
 * `field-sizing` and the only half that is computed in JavaScript. The
 * stylesheet clamps both paths to the same floor and the same cap; the real
 * heights are measured in `scripts/cross-browser-check.mjs`.
 */
describe('OutputView: a text result is sized by the text', () => {
  const rowsOf = (text: string): number => {
    const { unmount } = renderValue({ type: 'text', text });
    const rows = screen.getByRole('textbox').getAttribute('rows');
    unmount();
    return Number(rows);
  };

  it('asks for two rows for a one-line result rather than a fixed floor', () => {
    // A digest and a converted colour are each one line, and they are the two
    // cases the old floor was worst for.
    expect(rowsOf('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380bee9068bf7ace2efcde9')).toBe(2);
    expect(rowsOf('#3366cc')).toBe(2);
  });

  it('grows with the lines, so a small structure is drawn small', () => {
    expect(rowsOf('{\n  "a": 1,\n  "b": 2\n}')).toBe(4);
    expect(rowsOf(Array.from({ length: 9 }, (_, i) => `line ${String(i)}`).join('\n'))).toBe(9);
  });

  /*
   * THE CAP IS WHAT STOPS THIS BEING A WORSE PROBLEM THAN THE ONE IT FIXES.
   * A 4,000-line result asking for 4,000 rows would be a textarea taller than
   * the document. Twenty rows is where a result stops being something you read
   * in place and starts being something you copy or download.
   */
  it('stops at twenty rows however long the result is', () => {
    expect(rowsOf(Array.from({ length: 4000 }, () => 'x').join('\n'))).toBe(20);
  });

  /*
   * The one case `rows` gets wrong, recorded so the next reader knows it is
   * known. A 40 kB base64 string is ONE line to a newline count and forty
   * screens to a browser, so the fallback path asks for the floor and gets a
   * scrollbar. `field-sizing: content` measures the wrapped height and gets it
   * right; this is the price of the path that does not have it, and a
   * scrollbar is the correct failure rather than a wrong height.
   */
  it('counts newlines rather than wrapped lines, which is why it is the fallback', () => {
    expect(rowsOf('x'.repeat(40_000))).toBe(2);
  });
});
