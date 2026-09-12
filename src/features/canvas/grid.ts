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
 * The tile is the major square in screen pixels and the rules sit at fractions
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

/** Fine squares between two rules at full major weight. */
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
 * THE LADDER IS ANCHORED TO THE SCREEN, NOT TO THE WORLD, AND THAT IS THE
 * WHOLE OF IT. Every rank - the heavy one included - is a power of two times
 * `GRID` world units, and which power is chosen from the zoom, so that the
 * finest fully-inked rank is always between `GRID` and `2 * GRID` pixels
 * apart. The picture is therefore a function of `log2(zoom) mod 1` and nothing
 * else: the view at 40% and the view at 80% are the same arrangement of the
 * same five ranks at the same five screen pitches, down to the ink.
 *
 * THE MAJOR RULE CASCADES TOO, and it used not to. It was pinned at
 * `GRID * GRID_MAJOR_EVERY` world units at every scale, so that a major square
 * always meant the same thing - eight snap steps - and the reference did not
 * move under the user while they zoomed. What that cost was the one property
 * the grid exists for. A world-anchored major square is 16px across at 25%,
 * where every second rule on screen is a heavy one, and 160px at 250%, where
 * one rule in sixteen is: same ink, wholly different picture, and measured as
 * mean ink it was a drift of 1.7x across the range.
 *
 * So the trade was taken the other way round. A major square no longer means a
 * fixed number of snap steps - it means 32 of them at the bottom of the range
 * and 4 at the top - and NOBODY READING THE CANVAS WAS USING THAT FACT. There
 * is no ruler, no readout in squares, and the snap step is `GRID` whatever the
 * grid happens to be drawing. What is bought is that the backdrop is the same
 * backdrop at every zoom, which is the thing a person does read.
 */

/**
 * The ranks of the ladder, as multiples of `GRID`, coarsest first.
 *
 * Read them at the bottom of an octave, where {@link gridOctave} is 1: the
 * heavy rule every 64 world units, three minor ranks at 32, 16 and 8, and the
 * finest at 4 with no ink yet. Every one of them doubles as you zoom out past
 * a power of two, and the picture does not change.
 *
 * FIVE RANKS, AND THE COUNT IS DERIVED. Three of them span the distance the
 * heavy rule's weight has to travel (`GRID_MAJOR_EVERY` is 8, which is three
 * doublings), one is the rank that is fully inked, and one is the rank fading
 * in below it. Drop the last and the grid simply spreads from 8px to 16px
 * across every octave and snaps back - a factor of two in density at every
 * power of two, which is the defect this ladder exists to remove.
 *
 * THE FINEST RANK IS BELOW THE SNAP STEP, and at the top of the range it is
 * well below: at 250% it is 2 world units, a quarter of a snap step. The
 * ladder used to stop at `GRID` on the argument that a rule finer than the snap
 * step is a line nothing can land on. The argument is true and it was the wrong
 * conclusion, and once the ladder cascades it is not even coherent - no rank
 * has a fixed relationship to the snap step any more. A ruler's finest marks
 * are not places you put things either; they are what makes it a ruler.
 */
export const GRID_RANKS = [8, 4, 2, 1, 0.5] as const;

/**
 * On-screen pitch, in CSS px, at and above which a rank is drawn at full ink.
 *
 * `GRID` ITSELF, which is the one number in range that is not a guess about
 * legibility. The grid is authored at `GRID` world units, so `GRID` PIXELS is
 * what one of its squares looks like at 100% zoom - the scale everything about
 * this canvas was designed at. A rank is fully drawn once it looks the way the
 * grid was drawn.
 */
export const GRID_PITCH_FULL = GRID;

/**
 * On-screen pitch, in CSS px, below which a rank is not drawn at all.
 *
 * HALF `GRID_PITCH_FULL`, and the factor of two is doing more work than either
 * number. Twice the pitch is half the ink, so a rank at half its design pitch
 * is twice as dense as the grid was ever meant to be.
 *
 * And because the ranks are themselves an octave apart, a transition band
 * exactly one octave wide guarantees AT MOST ONE RANK IS EVER PARTIALLY
 * DRAWN: if one rank's pitch is mid-band, the rank above it is past the top
 * and the rank below is under the bottom. One soft edge at a time rather than
 * a general haze, asserted across the range in `grid.test.ts`.
 *
 * The fade exists at all because the alternative is a pop. Half the rules
 * vanishing in one frame is very visible during a continuous zoom, and would
 * undo the point of having made the zoom continuous.
 */
export const GRID_PITCH_MIN = GRID_PITCH_FULL / 2;

/** One rank of rules: how far apart they are, how much ink, and how heavy. */
export interface GridLevel {
  /** World units between two of this rank's rules. */
  readonly pitch: number;
  /** Ink, in [0, 1]. */
  readonly strength: number;
  /** How major the rule is, in [0, 1]: 0 is the minor ink, 1 the major. */
  readonly weight: number;
}

/**
 * The power of two the whole ladder is multiplied by at this zoom.
 *
 * Chosen so that `GRID * octave` world units is between `GRID_PITCH_FULL` and
 * twice it on screen: that rank is the finest one at full ink, and everything
 * else is a doubling away from it. `zoom * octave` is therefore always in
 * [1, 2), and it is the only thing the picture depends on.
 *
 * AN OFF-BY-ONE HERE IS INVISIBLE, which is why there is no epsilon guarding
 * the `ceil` at exact powers of two. Landing an octave out puts `zoom * octave`
 * at 2 rather than 1, and the ladder at 2 IS the ladder at 1 shifted by one
 * rank: same screen pitches, same ink, same weights. Scale invariance is not a
 * property this code approximates, so its own boundaries cost nothing.
 */
export function gridOctave(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;

  return 2 ** Math.ceil(-Math.log2(zoom));
}

/**
 * How strongly one rank is inked at a given zoom, in [0, 1].
 *
 * LINEAR IN THE ON-SCREEN PITCH, AND THAT SHAPE IS DERIVED RATHER THAN LIKED.
 *
 * This was smoothstep, chosen so a rank would arrive without a corner, and
 * smoothstep is what made the surface's density wobble. Total ink per unit
 * length is what the eye reads as the grid's tone, and it is worth writing out.
 * A rank's rules land every `pitch`, but half of them are claimed by the rank
 * above, so each rank below the heaviest contributes `strength / (2 * pitch)`:
 *
 *     ink(z) = 1/(P z) + Σ  s_j / (2 * p_j * z)
 *
 * While rank `w` is fading, every coarser rank is at full ink, and their sum
 * telescopes, so the total is `(1 + s) / (2^k z)` for whichever rank is fading,
 * and holding that CONSTANT gives
 *
 *     1 + s = 2^k * z * ink     ->     s = (pitch - GRID_PITCH_MIN) / GRID_PITCH_MIN
 *
 * which is the plain linear ramp across the octave. Smoothstep sits above that
 * line through the middle of every octave and the surface therefore ran up to
 * 5% denser than it is authored at, peaking around 45% zoom - which is small,
 * and was still measurable as a lightness difference between one zoom and
 * another. A linear ramp holds the ink EXACTLY constant, and the corner it
 * leaves at each end of an octave is a change in the rate a hairline is fading
 * at, which nothing can see.
 *
 * It is also gentler per notch than smoothstep was: a sixth rather than a
 * quarter, over the six notches an octave takes.
 */
export function gridLevelStrength(worldPitch: number, zoom: number): number {
  const pitch = worldPitch * zoom;

  return clamp((pitch - GRID_PITCH_MIN) / (GRID_PITCH_FULL - GRID_PITCH_MIN), 0, 1);
}

/**
 * How heavy a rank's rules are, in [0, 1]: 0 the minor ink, 1 the major.
 *
 * THE SAME RAMP AS THE INK, AND FOR THE SAME REASON. A rank is heavy exactly
 * to the degree that the rank `GRID_MAJOR_EVERY` times finer than it is is
 * itself drawn - which is to say a rule is major once the eight squares it
 * would enclose are squares you can see. That is one line of code, and it is
 * also the answer that conserves ink, which is the only reason to prefer it to
 * any other curve with the same endpoints.
 *
 * Writing the weighted ink out with `M` for the major rule's ink per pixel and
 * `m` for the minor's, over an octave parameterised by `t = zoom * octave` in
 * [1, 2), and multiplying through by the heavy rank's screen pitch of `64t`:
 *
 *     64 t * ink = M + [m + (M - m) g] + 2m + 4m + 8m(t - 1)
 *
 * - the heavy rank, the rank taking the weight over at `g`, the two ranks
 * between them, and the rank fading in. Setting that proportional to `t`, so
 * that the ink per pixel does not move, gives `(M - m) g = (M - m)(t - 1)`, so
 * `g = t - 1` WHATEVER the two inks are. The crossfade is forced rather than
 * chosen, and a theme cannot break the density by picking a heavier major.
 *
 * AT MOST ONE RANK IS EVER PART-MAJOR, and it is never the rank that is
 * part-inked: the two ramps are three octaves apart on a five-rank ladder. So a
 * partial weight always sits on rules at full ink, which is what lets
 * `GridLayer` draw the crossfade as one fill over another rather than having to
 * interpolate two tokens it only has as strings.
 */
export function gridLevelWeight(worldPitch: number, zoom: number): number {
  return gridLevelStrength(worldPitch / GRID_MAJOR_EVERY, zoom);
}

/**
 * Every rank of the grid at a zoom, coarsest first.
 *
 * Index 0 is always at full ink and full weight - it is the heavy rule - and
 * index 1 may be part of the way to heavy. Ranks with no ink are still listed,
 * so the array's shape does not depend on the zoom and a caller can index it
 * without asking how many there are.
 */
export function gridLevels(zoom: number): readonly GridLevel[] {
  const octave = gridOctave(zoom);

  return GRID_RANKS.map((multiple) => {
    const pitch = GRID * multiple * octave;

    return {
      pitch,
      strength: gridLevelStrength(pitch, zoom),
      weight: gridLevelWeight(pitch, zoom),
    };
  });
}

/** The on-screen pitch of each rank, coarsest first, in CSS px. */
export function gridPitches(zoom: number): readonly number[] {
  return gridLevels(zoom).map((level) => level.pitch * zoom);
}

/** Just the ink of each rank, coarsest first. */
export function gridStrengths(zoom: number): readonly number[] {
  return gridLevels(zoom).map((level) => level.strength);
}

/** Just the weight of each rank, coarsest first. */
export function gridWeights(zoom: number): readonly number[] {
  return gridLevels(zoom).map((level) => level.weight);
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
 * the layer's size along it. A rule belongs to the COARSEST rank that lands on
 * it, which is what keeps the heavy rule heavy: a multiple of 64 is a multiple
 * of 8, 16 and 32 as well, and drawing it four times at four inks would make
 * every eighth rule darker than the token says.
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
   * the finest - the octave included, which is the reason it is a power of two
   * rather than any scale that would centre the ladder - so "does this rank
   * land here" is a remainder on an integer rather than a comparison of floats.
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
