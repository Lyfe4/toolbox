import type { ColorPayload } from '@/features/registry/types';
import { bestLevel, contrastRatio, relativeLuminance } from '@/lib/wcag';

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
  { id: 'black', label: 'On black', color: '#000000', luminance: 0 },
  { id: 'white', label: 'On white', color: '#ffffff', luminance: 1 },
] as const;

function cssColor(color: ColorPayload): string {
  const channel = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 255);
  return `rgb(${channel(color.r).toString()} ${channel(color.g).toString()} ${channel(color.b).toString()} / ${color.a.toString()})`;
}

export interface ColorViewProps {
  readonly color: ColorPayload;
  readonly label: string;
}

export function ColorView({ color, label }: ColorViewProps) {
  const luminance = relativeLuminance(color.r, color.g, color.b);

  return (
    <div className={styles.wrapper}>
      {/*
        A swatch is decorative on its own; the accessible name is what makes it
        meaningful, and role="img" is what makes the name be read at all.
      */}
      <div
        className={styles.swatch}
        role="img"
        aria-label={`${label} preview`}
        style={{ backgroundColor: cssColor(color) }}
      />

      <table className={styles.table}>
        <caption className={styles.caption}>Contrast, WCAG 2.1</caption>
        <thead>
          <tr>
            <th scope="col">Background</th>
            <th scope="col">Ratio</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {BACKDROPS.map((backdrop) => {
            const ratio = contrastRatio(luminance, backdrop.luminance);
            const level = bestLevel(ratio);

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
                <td className={styles.ratio}>{ratio.toFixed(2)}:1</td>
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

      <p className={styles.note}>
        AA needs 4.5:1 for body text and 3:1 for large text; AAA needs 7:1.
      </p>
    </div>
  );
}
