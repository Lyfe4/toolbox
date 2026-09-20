import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '@/lib/testing/axe';

import { ColorView } from './ColorView';

const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const WHITE = { r: 1, g: 1, b: 1, a: 1 };
const MID_GREY = { r: 0.5, g: 0.5, b: 0.5, a: 1 };

describe('ColorView', () => {
  it('gives the swatch an accessible name rather than leaving it decorative', () => {
    render(<ColorView color={BLACK} label="Colour" />);
    expect(screen.getByRole('img', { name: 'Colour preview' })).toBeInTheDocument();
  });

  it('reports contrast against both black and white', () => {
    render(<ColorView color={MID_GREY} label="Colour" />);

    expect(screen.getByRole('rowheader', { name: /On black/ })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: /On white/ })).toBeInTheDocument();
  });

  it('gives black the maximum ratio against white', () => {
    render(<ColorView color={BLACK} label="Colour" />);
    expect(screen.getByText('21.00:1')).toBeInTheDocument();
  });

  /*
   * A contrast checker that reported pass and fail by colour alone would be an
   * unusually pointed failure. The verdict is words.
   */
  it('states pass and fail in words', () => {
    render(<ColorView color={WHITE} label="Colour" />);

    expect(screen.getByText('passes AAA')).toBeInTheDocument();
    expect(screen.getByText('fails AA')).toBeInTheDocument();
  });

  /*
   * THE CHEQUERBOARD, WHICH WAS DRAWN BEHIND EVERY COLOUR.
   *
   * `background-image` paints above `background-color`, so the four gradients
   * that make the chequerboard were drawn ON TOP of an opaque swatch: a solid
   * `#aabbcc` was shown as `#aabbcc` in 16px squares of `--pb-surface-raised`,
   * which is a picture of a colour nobody asked for. And because every swatch
   * had it, the pattern could not signal the one thing it exists to signal.
   *
   * jsdom has no layout engine and resolves nothing about how those gradients
   * PAINT, so this is asserted on the class and the flag rather than on pixels;
   * the geometric half belongs to `check:browsers`. The flag is the stable
   * half - it is what a check in either place can name - and it is asserted in
   * both directions, because a rule that fires on everything and a rule that
   * fires on nothing are equally useless here.
   */
  it.each([
    ['an opaque colour', { r: 0.6, g: 0.7, b: 0.8, a: 1 }, 'false'],
    ['a fully transparent colour', { r: 0.6, g: 0.7, b: 0.8, a: 0 }, 'true'],
    ['87% opaque, which is #aabbccdd', { r: 0.6, g: 0.7, b: 0.8, a: 0.8666 }, 'true'],
    // The boundary itself: one step below 1 is translucent, and 1 is not.
    ['a hair under opaque', { r: 0.6, g: 0.7, b: 0.8, a: 0.999 }, 'true'],
  ])('marks %s as translucent: %s', (_name, color, expected) => {
    render(<ColorView color={color} label="Colour" />);
    const swatch = screen.getByRole('img', { name: 'Colour preview' });

    expect(swatch).toHaveAttribute('data-translucent', expected);
    // And the class follows the flag, which is what actually decides the paint.
    expect(swatch.className.includes('translucent')).toBe(expected === 'true');
  });

  it('labels the table so its purpose is clear out of context', () => {
    render(<ColorView color={MID_GREY} label="Colour" />);
    expect(screen.getByRole('table', { name: 'Contrast, WCAG 2.1' })).toBeInTheDocument();
  });

  /*
   * CC-2: THE RATIOS THAT IGNORED ALPHA.
   *
   * `#aabbccdd` reported 10.69:1 and 1.96:1 - byte-identical to opaque
   * `#aabbcc` - because `relativeLuminance` has no alpha parameter and nothing
   * composited before calling it. The finding is exact and these are the
   * assertions that keep the fix: the numbers for a translucent colour must
   * MOVE, the numbers for an opaque one must not, and the table must say on
   * its own face that it is compositing.
   *
   * The check that should have caught it in the first place is instructive:
   * the only contrast assertion here was "black against white is 21", which a
   * function ignoring alpha satisfies perfectly, because both controls are
   * opaque. An assertion equally true of the correct code and the broken code.
   */
  describe('alpha in the contrast table', () => {
    // #aabbccdd and #aabbcc, exactly: the pair the finding measured.
    const TRANSLUCENT = { r: 170 / 255, g: 187 / 255, b: 204 / 255, a: 221 / 255 };
    const OPAQUE = { ...TRANSLUCENT, a: 1 };

    function ratios(color: { r: number; g: number; b: number; a: number }): string[] {
      const { container, unmount } = render(<ColorView color={color} label="Colour" />);
      const found = [...container.querySelectorAll('td')]
        .map((cell) => cell.textContent)
        .filter((text) => text.endsWith(':1'));
      unmount();
      return found;
    }

    it('gives a translucent colour different ratios from its opaque twin', () => {
      const translucent = ratios(TRANSLUCENT);
      const opaque = ratios(OPAQUE);

      expect(translucent).toHaveLength(2);
      expect(translucent).not.toEqual(opaque);
    });

    /*
     * AND THE OTHER HALF, which is what stops this being a change that broke
     * every number anybody ever recorded: at full opacity the composite is the
     * identity, so an opaque colour's ratios are exactly what they were.
     */
    it('leaves an opaque colour where it was', () => {
      // Black against black then white; white against black then white.
      expect(ratios({ r: 0, g: 0, b: 0, a: 1 })).toEqual(['1.00:1', '21.00:1']);
      expect(ratios({ r: 1, g: 1, b: 1, a: 1 })).toEqual(['21.00:1', '1.00:1']);
    });

    /*
     * A FULLY TRANSPARENT COLOUR IS ITS BACKGROUND, so it has no contrast
     * against it - 1:1 on both rows, which is the honest answer for text
     * nobody can see.
     *
     * It is also the case that catches a composite written the wrong way
     * round. With the weights swapped, `a: 0` would leave the colour itself
     * and this red would report 5.25:1 and 4.00:1; every opaque case in this
     * file passes either way, because at `a: 1` the two are the same
     * expression.
     */
    it('makes a fully transparent colour identical to whatever is under it', () => {
      expect(ratios({ r: 1, g: 0, b: 0, a: 0 })).toEqual(['1.00:1', '1.00:1']);
    });

    it('says on the table itself that it composited, and against what', () => {
      render(<ColorView color={TRANSLUCENT} label="Colour" />);

      expect(
        screen.getByRole('table', { name: /composited onto each background/ }),
      ).toBeInTheDocument();
      /*
       * The composited colours BY NAME, so a reader can check the ratio by
       * hand. Read off `textContent` rather than through `getByText`, because
       * React splits the interpolated values into their own text nodes and a
       * text query would be asking about fragments of the sentence.
       */
      const note = screen.getByText(/Ratios here used to ignore alpha/).textContent;
      expect(note).toContain('#93a2b1 on black');
      expect(note).toContain('#b5c4d3 on white');
      expect(note).toContain('87% opaque');
    });

    /*
     * The disclosure is a change notice, so it appears only where there is a
     * change: an opaque colour's ratios were always right and saying otherwise
     * is noise on nine swatches out of ten.
     */
    it('says none of that about an opaque colour', () => {
      render(<ColorView color={OPAQUE} label="Colour" />);

      expect(screen.getByRole('table', { name: 'Contrast, WCAG 2.1' })).toBeInTheDocument();
      expect(screen.queryByText(/composit/i)).not.toBeInTheDocument();
    });
  });

  it('has no axe violations', async () => {
    const { container } = render(<ColorView color={MID_GREY} label="Colour" />);
    await expectNoAxeViolations(container);
  });
});
