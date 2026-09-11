import { clamp, GRID } from './geometry';

/**
 * The grid's maths: which rules are drawn, how strongly, and where.
 *
 * Free of the DOM, for the reason `pinch.ts` and `wheel.ts` are: everything
 * interesting here is arithmetic about device pixels, and the failures it
 * prevents - a rule between two device pixels, two rules rounding onto the
 * same one, a grid that drifts away from the nodes it is behind - are far
 * easier to pin down in a unit test than by photographing a canvas.
 *
 * WHY THE GRID IS DRAWN AND NOT COMPOSITED
 *
 * It used to be eight `linear-gradient` background layers, tiled at the major
 * square and subdivided by percentage. That is the right shape for the problem
 * and it was still wrong, for a reason no amount of restructuring the gradients
 * could fix: **a background gradient cannot put a one-pixel line on a device
 * pixel.**
 *
 * The tile is `GRID * GRID_MAJOR_EVERY * zoom` and the rules sit at fractions
 * of it, so at any zoom that is not a clean fraction their positions are
 * fractional. A 1px line at x = 7.0 rasterises as one pixel of full ink; the
 * same line at x = 7.5 rasterises as two pixels of half ink. Both carry the
 * same ink and they do not look the same - and because the subpixel offset
 * marches steadily across the tile and across tiles, the difference between
 * them ALIASES: the crisp lines and the split lines group into runs, and the
 * runs read as bands at a period of roughly `pitch / frac(pitch)`, which has
 * no relation to the grid's own spacing. That was the vertical banding.
 *
 * It is worse than a wash, too. Two half-ink pixels are composited in sRGB,
 * which is not linear, so a split line reads LIGHTER than a crisp one carrying
 * identical ink. The smaller the pitch the larger the share of the grid that is
 * split, so the whole surface drifts lighter as you zoom out. Measured on the
 * gradient build: the fraction of pixels away from the backdrop was about twice
 * the geometry's own answer at every zoom - every line was two pixels wide -
 * and the mean ink over a bare strip varied by a factor of nearly four across
 * the range.
 *
 * Drawing into a canvas is what makes the positions ours. Every rule is
 * rounded to a whole device pixel, so every rule is exactly one device pixel of
 * full ink: identical weight, no antialiasing, no aliasing of the antialiasing.
 *
 * THE PRICE, STATED PLAINLY. Each rule is rounded INDEPENDENTLY, so it sits
 * within half a device pixel of where the world says it should, and the error
 * never accumulates - which is exactly what snapping the tile, or snapping the
 * zoom, would have done instead. What it costs is that the gaps are not all
 * equal: each one is within a device pixel of the true pitch, so at a pitch of
 * 7.1 they run 7, 7, 7, 7, 8, 7, 7. That is a ripple of about one part in seven
 * in SPACING, against the one part in two a split rule was doing to the INK -
 * and spacing is the axis the eye reads least in a fine grid, where luminance
 * is the one it reads most.
 */

/** Minor grid squares between two major rules. */
export const GRID_MAJOR_EVERY = 8;

/**
 * WHAT CHANGES ABOUT THE GRID WITH SCALE, AND WHY SOMETHING HAS TO
 *
 * A grid at a fixed world pitch cannot read the same way at every zoom: `GRID`
 * world units is 2px apart at the minimum zoom and 20px apart at the maximum,
 * and a hairline every 2px is a tone rather than a grid. So something has to
 * change with scale, and what changes is WHICH WORLD LEVEL IS DRAWN. The ink
 * and the weight of a rule are the same at every zoom; a square just means
 * more world when you are further away.
 *
 * THE MAJOR SQUARE NEVER MOVES. It is `GRID * GRID_MAJOR_EVERY` world units at
 * every scale, so a major square always means the same thing - eight snap steps
 * - and the reference being measured against does not change under the user
 * while they zoom. Only the subdivisions inside it come and go, and they only
 * ever appear BETWEEN rules that are already there.
 */

/**
 * The subdivisions of a major square, as multiples of `GRID`, coarsest first.
 *
 * Halves, quarters, eighths and sixteenths of the major square: 32, 16, 8 and 4
 * world units. Each is half the one before it, which is what lets exactly one
 * of them be mid-fade at a time - see `GRID_PITCH_FULL`.
 *
 * THE SIXTEENTH IS HALF A SNAP STEP, and it is here on purpose. The ladder used
 * to stop at `GRID` on the argument that a rule finer than the snap step is a
 * line nothing can land on. The argument is true and it was the wrong
 * conclusion: because the ladder stopped, so did the cascade, and from 100% to
 * 250% the finest rules simply spread from 8px to 20px apart. The grid lost
 * three fifths of its ink over that stretch, which is the one thing the cascade
 * exists to prevent. A ruler's finest marks are not places you put things
 * either; they are what makes it a ruler.
 */
export const GRID_SUBDIVISIONS = [4, 2, 1, 0.5] as const;

/**
 * On-screen pitch, in CSS px, at and above which a level is drawn at full ink.
 *
 * `GRID` ITSELF, which is the one number in range that is not a guess about
 * legibility. The grid is authored at `GRID` world units, so `GRID` PIXELS is
 * what one of its squares looks like at 100% zoom - the scale everything about
 * this canvas was designed at. A level is fully drawn once it looks the way the
 * grid was drawn.
 */
export const GRID_PITCH_FULL = GRID;

/**
 * On-screen pitch, in CSS px, below which a level is not drawn at all.
 *
 * HALF `GRID_PITCH_FULL`, and the factor of two is doing more work than either
 * number. Twice the pitch is half the ink, so a level at half its design pitch
 * is twice as dense as the grid was ever meant to be.
 *
 * And because the levels are themselves an octave apart, a transition band
 * exactly one octave wide guarantees AT MOST ONE LEVEL IS EVER PARTIALLY
 * DRAWN: if one level's pitch is mid-band, the level above it is past the top
 * and the level below is under the bottom. One soft edge at a time rather than
 * a general haze, asserted across the range in `grid.test.ts`.
 *
 * The fade exists at all because the alternative is a pop. Half the rules
 * vanishing in one frame is very visible during a continuous zoom, and would
 * undo the point of having made the zoom continuous.
 */
export const GRID_PITCH_MIN = GRID_PITCH_FULL / 2;

/** One rank of rules: how far apart they are in the world, and their ink. */
export interface GridLevel {
  /** World units between two of this level's rules. */
  readonly pitch: number;
  /** Ink, in [0, 1]. */
  readonly strength: number;
}

/**
 * How strongly one subdivision level is inked at a given zoom, in [0, 1].
 *
 * LINEAR IN THE ON-SCREEN PITCH, AND THAT SHAPE IS DERIVED RATHER THAN LIKED.
 *
 * This was smoothstep, chosen so a level would arrive without a corner, and
 * smoothstep is what made the surface's density wobble. Total ink per unit
 * length is what the eye reads as the grid's tone, and it is worth writing out.
 * A level's rules land every `pitch`, but half of them are claimed by the level
 * above, so each level below the major contributes `strength / (2 * pitch)`:
 *
 *     ink(z) = 1/(64z) + Σ  s_j / (2 * p_j * z)
 *
 * While level `w` is fading, every coarser level is at full ink, and their sum
 * telescopes - for `w` of 16 world units it is exactly `1/(32z)`, for 8 it is
 * `1/(16z)`, for 4 it is `1/(8z)`. So the total is `(1 + s) / (2^k z)` for
 * whichever level is fading, and holding that CONSTANT gives
 *
 *     1 + s = 2^k * z * ink     ->     s = (pitch - GRID_PITCH_MIN) / GRID_PITCH_MIN
 *
 * which is the plain linear ramp across the octave. Smoothstep sits above that
 * line through the middle of every octave and the surface therefore runs up to
 * 5% denser than it is authored at, peaking around 45% zoom - which is small,
 * and was still measurable as a lightness difference between one zoom and
 * another. A linear ramp holds the ink EXACTLY constant from the minimum zoom
 * to 200%, and the corner it leaves at each end of an octave is a change in the
 * rate a hairline is fading at, which nothing can see.
 *
 * It is also gentler per notch than smoothstep was: a sixth rather than a
 * quarter, over the six notches an octave takes.
 */
export function gridLevelStrength(worldPitch: number, zoom: number): number {
  const pitch = worldPitch * zoom;

  return clamp((pitch - GRID_PITCH_MIN) / (GRID_PITCH_FULL - GRID_PITCH_MIN), 0, 1);
}

/**
 * Every rank of the grid at a zoom, coarsest first, major rule included.
 *
 * The major is always at full ink and is always index 0. Levels with no ink are
 * still listed, so the array's shape does not depend on the zoom and a caller
 * can index it without asking how many there are.
 */
export function gridLevels(zoom: number): readonly GridLevel[] {
  return [
    { pitch: GRID * GRID_MAJOR_EVERY, strength: 1 },
    ...GRID_SUBDIVISIONS.map((multiple) => ({
      pitch: GRID * multiple,
      strength: gridLevelStrength(GRID * multiple, zoom),
    })),
  ];
}

/** The on-screen pitch of each level, coarsest first, in CSS px. */
export function gridPitches(zoom: number): readonly number[] {
  return gridLevels(zoom).map((level) => level.pitch * zoom);
}

/** Just the subdivision strengths, coarsest first. */
export function gridStrengths(zoom: number): readonly number[] {
  return gridLevels(zoom)
    .slice(1)
    .map((level) => level.strength);
}

/** One rule to draw: where it goes, and which rank it belongs to. */
export interface GridRule {
  /** Leading edge, in whole device pixels from the layer's origin. */
  readonly at: number;
  /** Index into {@link gridLevels}. */
  readonly level: number;
}

/**
 * Every rule crossing one axis of the layer, in whole device pixels.
 *
 * `origin` is the viewport's translation along this axis in CSS px and `extent`
 * the layer's size along it. A rule belongs to the COARSEST level that lands on
 * it, which is what keeps the major rule a major rule: world 64 is a multiple of
 * 8, 16 and 32 as well, and drawing it four times at four inks would make every
 * eighth rule heavier than the token says.
 */
export function gridRules(
  origin: number,
  extent: number,
  zoom: number,
  dpr: number,
): readonly GridRule[] {
  const levels = gridLevels(zoom);
  const drawn = levels.filter((level) => level.strength > 0);
  const finest = drawn.at(-1)?.pitch;
  if (finest === undefined || !Number.isFinite(zoom) || zoom <= 0 || extent <= 0) return [];

  /*
   * Stepped in INTEGER multiples of the finest drawn pitch rather than by
   * adding the pitch repeatedly, so a long pan cannot accumulate float error,
   * and so the level test below is exact: every pitch is a power of two times
   * the finest, which makes "does this level land here" a remainder on an
   * integer rather than a comparison of two floats.
   */
  const first = Math.floor(-origin / (finest * zoom));
  const last = Math.ceil((extent - origin) / (finest * zoom));

  const rules: GridRule[] = [];
  for (let index = first; index <= last; index += 1) {
    const world = index * finest;

    let level = levels.length - 1;
    for (let candidate = 0; candidate < levels.length; candidate += 1) {
      const every = levels[candidate]?.pitch;
      if (every === undefined || levels[candidate]?.strength === 0) continue;
      if (Number.isInteger(world / every)) {
        level = candidate;
        break;
      }
    }

    rules.push({ at: Math.round((world * zoom + origin) * dpr), level });
  }

  return rules;
}
