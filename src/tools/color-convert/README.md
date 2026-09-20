# Colour

Convert between hex, rgb(), hsl() and oklch(), with contrast checks.

## One interior representation

Everything is held as sRGB in 0–1 with an alpha channel — which is what
`ColorPayload` already was. Parsing widens whatever was typed into that;
formatting narrows it back into one notation.

That is the whole design decision. Adding a fifth notation later is one parser
and one formatter, rather than twenty pairwise conversions.

## OKLCH

sRGB → linear → LMS → cube roots → OKLab → OKLCH, using Björn Ottosson's
published matrices, and the exact inverse coming back. The cube roots in the
middle are what make OKLab perceptually uniform: equal numeric steps look like
equal steps, which is why it is worth having alongside HSL rather than instead
of it.

Two details worth naming:

- **A neutral colour has no meaningful hue.** Below a chroma of 1e-7 the hue is
  reported as 0 rather than whatever `atan2` makes of floating-point noise, so
  grey round-trips exactly.
- **Out-of-gamut is reported, not silently corrected — since round nine.** Most
  OKLCH values have no sRGB equivalent. `oklchToRgb` has returned
  `inGamut: false` alongside the clipped colour since the tool was written, and
  for five rounds `parseColor` destructured it away and no caller ever saw it:
  the sentence above was in this file, and in the conversion matrix, describing
  a feature that did not exist. `parseColor` now returns it, along with every
  component it had to clamp, and the `report` port carries both.

## Named colours are deliberately absent

`rebeccapurple` is refused. Resolving names would mean shipping the 148-entry
CSS list into a lazily-loaded chunk, and this tool is about conversion between
notations rather than about being a colour dictionary.

## Contrast

`lib/wcag.ts`, not this directory. Two very different consumers need it: the
tool (which reports ratios as data) and `ColorView` (which draws the badges).
Putting it in the tool would mean the view had to import a lazily-chunked tool
module in order to render, which would drag that chunk into the page that merely
lists tools.

The view states the verdict **in words** — "passes AA", "fails AA". A contrast
checker that reported pass and fail by colour alone would be an unusually
pointed failure.

The swatch sits on a chequerboard so a translucent colour reads as translucent
rather than as a slightly different opaque colour, and carries `role="img"` with
an accessible name so it is not merely decorative.

**Alpha is composited before the ratio, since round nine.** `#aabbccdd` used to
report ratios byte-identical to opaque `#aabbcc`, which is wrong for exactly the
colour somebody opens a contrast checker to ask about. Each row already names
its background, so the composite is determined rather than guessed:
source-over on the gamma-encoded channels, which is what a browser's own
compositor does and is asserted against one in `check:browsers`. Because it
moves numbers people may have written down, the table says so — the caption
names the compositing and the line beneath it names both composited colours.

## Outputs

| Port     | Label     | Type  | For                                                       |
| -------- | --------- | ----- | --------------------------------------------------------- |
| `output` | Converted | text  | The converted string in the chosen notation.              |
| `swatch` | Swatch    | color | The parsed colour — the preview, and what a wire carries. |
| `all`    | Notations | json  | All four notations at once, for a downstream tool.        |
| `report` | Report    | json  | What the parser had to change: a clip, a clamp, or none.  |

Two of those labels were changed by the [port
audit](../../../docs/architecture.md#the-port-set). `swatch` was labelled
**Colour**, the same word as the input port opposite it, which on a 224px node
is two identical words with nothing to tell them apart — and the input is the
one that cannot move, because a colour converter's input is a colour. `all` was
**Every notation**, fourteen characters in an 84px box, so every node carrying
one drew `Every notat…`.

`swatch` is a real `color` value rather than a string. That is what lets the
preview and the contrast table read it without re-parsing, and what lets a
colour be wired into another node without a lossy round-trip through text.

## Accepted syntax

- Hex: `#fff`, `#ffff`, `#ffffff`, `#ffffffff`, with or without the `#`.
- `rgb(59 130 246)`, `rgb(59, 130, 246)`, `rgba(...)`, `rgb(... / 50%)`.
- `hsl(217 91% 60%)`, `hsl(217 91 60)` and the legacy comma form.
- `oklch(0.62 0.19 259)`.

Five- and seven-digit hex are refused rather than guessed at: they are the
classic typo and both readings are equally plausible.

**A bare number in `hsl()` means that many percent**, which is what CSS Color 4
says and what `hsl(217 91 60)` means in a stylesheet. It used to be read as a
0–1 fraction, so 91 and 60 were clamped to 1 and that colour came back WHITE —
no error, and a colour is the one kind of answer nobody checks digit by digit.
It is also the spelling every Tailwind theme and every CSS custom property that
holds a colour as three numbers uses. A percentage where a HUE belongs is now
refused rather than scaled by 360.

## Tests

`color.test.ts` covers every accepted syntax, the refusals, alpha handling and
the precision option. The property tests are the ones that matter for a
converter: sRGB → HSL → sRGB is exact at 8-bit depth, sRGB → OKLCH → sRGB is
within one 8-bit step, and a full parse → format → parse cycle holds in all four
notations. A converter that quietly shifts people's design tokens by a step
every time they touch it would be worse than useless.

### The round trip was a lottery, and it had been losing

`round-trips every notation exactly at the default precision` was a `fc.assert`
over 400 randomly chosen colours with a fresh seed each run. It failed about one
run in four, which reads as flakiness in fast-check and was not: at the
then-default precision of four, **13,626 of the 16,777,216 sRGB colours did not
survive `oklch()`** — one in 1,231, so a 400-case run found one about 28% of the
time.

All 16.7 million were swept, precision by precision, and the numbers are in the
comment on `precision` in [`options.ts`](options.ts): 3,532,330 wrong at three
places, 13,626 at four, none at five. The default is five. The test is a fixed
stride through the cube rather than a random sample, so it now either passes for
everybody or fails for everybody, and the four specific cyans the sweep found
are named cases of their own.
