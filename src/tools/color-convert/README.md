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
- **Out-of-gamut is reported, not silently corrected.** Most OKLCH values have no
  sRGB equivalent. `oklchToRgb` returns `inGamut: false` alongside the clipped
  colour, because "that colour cannot be shown, here is the nearest one" is
  information the user needs.

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

## Outputs

| Port     | Type  | For                                                       |
| -------- | ----- | --------------------------------------------------------- |
| `output` | text  | The converted string in the chosen notation.              |
| `swatch` | color | The parsed colour — the preview, and what a wire carries. |
| `all`    | json  | All four notations at once, for a downstream tool.        |

`swatch` is a real `color` value rather than a string. That is what lets the
preview and the contrast table read it without re-parsing, and what lets a
colour be wired into another node without a lossy round-trip through text.

## Accepted syntax

- Hex: `#fff`, `#ffff`, `#ffffff`, `#ffffffff`, with or without the `#`.
- `rgb(59 130 246)`, `rgb(59, 130, 246)`, `rgba(...)`, `rgb(... / 50%)`.
- `hsl(217 91% 60%)` and the legacy comma form.
- `oklch(0.62 0.19 259)`.

Five- and seven-digit hex are refused rather than guessed at: they are the
classic typo and both readings are equally plausible.

## Tests

`color.test.ts` covers every accepted syntax, the refusals, alpha handling and
the precision option. The property tests are the ones that matter for a
converter: sRGB → HSL → sRGB is exact at 8-bit depth, sRGB → OKLCH → sRGB is
within one 8-bit step, and a full parse → format → parse cycle holds in all four
notations. A converter that quietly shifts people's design tokens by a step
every time they touch it would be worse than useless.
