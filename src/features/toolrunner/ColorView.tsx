import type { ColorPayload } from '@/features/registry/types';
import { bestLevel, compositeOver, contrastRatio, relativeLuminance } from '@/lib/wcag';

import styles from './color.module.css';

/**
 * Colour preview with contrast checks.
 *
 * The contrast maths lives in `lib/wcag.ts` rather than in the colour tool,
 * because this view must not import a lazily-chunked tool module to render.
 * It is small, pure, and tested on its own.
 *
 * Pass and fail are stated in words, not in a green or red dot. A contrast
 * checker that communicates its result by colour alone is a joke that writes
 * itself, so the badge reads "AA" or "fails".
 */

const BACKDROPS = [
  { id: 'black', label: 'On black', color: '#000000', rgb: [0, 0, 0], luminance: 0 },
  { id: 'white', label: 'On white', color: '#ffffff', rgb: [1, 1, 1], luminance: 1 },
] as const;

function channel8(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

function cssColor(color: ColorPayload): string {
  return `rgb(${channel8(color.r).toString()} ${channel8(color.g).toString()} ${channel8(color.b).toString()} / ${color.a.toString()})`;
}

/**
 * Six hex digits, written here rather than imported.
 *
 * `formatColor` would do it, and importing it would pull the colour tool's
 * lazily-chunked module into the page that merely LISTS tools - which is the
 * same reason the contrast maths is in `lib/wcag.ts`. Three `toString(16)`
 * calls are the cheaper half of that trade.
 */
function hex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((value) => channel8(value).toString(16).padStart(2, '0')).join('')}`;
}

export interface ColorViewProps {
  readonly color: ColorPayload;
  readonly label: string;
}

export function ColorView({ color, label }: ColorViewProps) {
  /*
   * ALPHA IS COMPOSITED, AND THAT CHANGED NUMBERS PEOPLE MAY HAVE WRITTEN
   * DOWN.
   *
   * `#aabbccdd` reported 10.69:1 and 1.96:1 - byte-identical to opaque
   * `#aabbcc` - because the ratio was taken from the colour's own luminance
   * and `relativeLuminance` has no alpha parameter. A ratio that ignores alpha
   * is wrong for exactly the colour somebody opens a contrast checker to ask
   * about, and every row here already names its background, so nothing had to
   * be guessed to fix it.
   *
   * It is a CHANGE rather than an improvement, so the table says so on its own
   * face instead of quietly reporting different numbers: the caption names the
   * compositing and the line under the table names the two composited colours.
   * Opaque colours are unaffected - `a === 1` makes the composite the identity
   * - which is why every number anyone recorded for an opaque colour still
   * holds.
   */
  const translucent = color.a < 1;
  const rows = BACKDROPS.map((backdrop) => {
    const composited = compositeOver(color, backdrop.rgb);
    return {
      ...backdrop,
      composited,
      ratio: contrastRatio(relativeLuminance(...composited), backdrop.luminance),
    };
  });

  return (
    <div className={styles.wrapper}>
      {/*
        A swatch is decorative on its own; the accessible name is what makes it
        meaningful, and role="img" is what makes the name be read at all.
      */}
      {/*
        THE CHEQUERBOARD IS FOR TRANSLUCENCY, so it is drawn only when there is
        translucency to show. Painted under every colour it did the opposite of
        its job twice over: an opaque swatch was covered in squares of
        `--pb-surface-raised` showing through nothing, so a solid colour was
        misrepresented - and because every swatch had the pattern, having it
        stopped meaning the colour was translucent. The one case the backdrop
        exists for became the case it could not signal.
      */}
      <div
        className={`${styles.swatch ?? ''} ${color.a < 1 ? (styles.translucent ?? '') : ''}`}
        role="img"
        aria-label={`${label} preview`}
        data-translucent={color.a < 1 ? 'true' : 'false'}
        style={{ backgroundColor: cssColor(color) }}
      />

      <table className={styles.table}>
        <caption className={styles.caption}>
          {translucent
            ? 'Contrast, WCAG 2.1, composited onto each background'
            : 'Contrast, WCAG 2.1'}
        </caption>
        <thead>
          <tr>
            <th scope="col">Background</th>
            <th scope="col">Ratio</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((backdrop) => {
            const level = bestLevel(backdrop.ratio);

            return (
              <tr key={backdrop.id}>
                <th scope="row">
                  <span
                    className={styles.chip}
                    aria-hidden="true"
                    style={{ backgroundColor: backdrop.color, color: cssColor(color) }}
                  >
                    Aa
                  </span>
                  {backdrop.label}
                </th>
                <td className={styles.ratio}>{backdrop.ratio.toFixed(2)}:1</td>
                <td>
                  {/* Stated in words. Never a coloured dot - see the note above. */}
                  {level === null ? (
                    <span className={styles.fail}>fails AA</span>
                  ) : (
                    <span className={styles.pass}>passes {level}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {translucent ? (
        <p className={styles.note}>
          This colour is {Math.round(color.a * 100)}% opaque, so each ratio is taken after
          compositing it onto that row&rsquo;s background: {hex(rows[0]?.composited ?? [0, 0, 0])}{' '}
          on black and {hex(rows[1]?.composited ?? [1, 1, 1])} on white. Ratios here used to ignore
          alpha entirely and report the opaque colour&rsquo;s numbers, so a figure recorded before
          may differ.
        </p>
      ) : null}

      <p className={styles.note}>
        AA needs 4.5:1 for body text and 3:1 for large text; AAA needs 7:1.
      </p>
    </div>
  );
}
