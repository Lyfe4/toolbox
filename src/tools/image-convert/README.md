# Image

Convert and resize images between PNG, JPEG and WebP.

This is the tool where a passing test proves the least. Dimensions and a
non-zero byte count are easy to assert and are satisfied by an image that is
upside down, grey, black where it should be white, or one frame of twelve — so
most of what is written down here is about how each decision is _checked_, not
just what it is.

- [Decisions](#decisions)
- [Decompression bombs](#decompression-bombs)
- [The format comes from the bytes](#the-format-comes-from-the-bytes)
- [Worker, with a documented main-thread fallback](#worker-with-a-documented-main-thread-fallback)
- [Other things that would otherwise be quiet failures](#other-things-that-would-otherwise-be-quiet-failures)
- [Options](#options)
- [Outputs](#outputs)
- [Known limitations](#known-limitations)
- [Tests](#tests)

## Decisions

Every one of these is a judgement call rather than a fact, so each is written
down with the reason.

| Question                                   | Answer                                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Transparency, when the target has none** | Composited onto **white**, and the tool says so — but only when a pixel really was transparent. Not configurable.                                       |
| **Metadata**                               | **Everything is stripped.** EXIF, GPS, timestamps, ICC profiles, XMP, IPTC, comments. The tool names what it found and states that none of it survived. |
| **EXIF orientation**                       | **Applied**, and the flag is not carried over. The output is upright with no rotation left to interpret.                                                |
| **Animation**                              | **First frame only**, with a warning naming the number of frames discarded.                                                                             |
| **Size caps**                              | 16,384 px per axis and 50 megapixels total, applied to the **container header** before anything is decoded.                                             |
| **Quality**                                | 0.1–1, JPEG and WebP only. The control is **hidden** for PNG rather than left there doing nothing.                                                      |
| **Longest edge**                           | A ceiling, never a target. An image already smaller than it is left alone and told so.                                                                  |

### Transparency becomes white

JPEG has no alpha channel, so every transparent pixel has to become
_something_. Left to the canvas it becomes black, and a transparent logo
converts to a black rectangle with the logo cut out of it — which reads as a
corrupt file rather than as a choice.

White matches every other converter, matches paper, and matches the page most
images end up on. It is deliberately not an option: a colour picker here would
be a setting almost nobody wants and everybody has to read past, and the honest
version of the feature is "convert to PNG or WebP instead", which the warning
says.

Asserted on pixels, not on a code path — `pnpm check:browsers` converts a
half-transparent PNG to JPEG, decodes the result and reads the formerly
transparent half back as `rgb(255, 255, 255)`.

**And the warning is only raised when it is true.** A container header can say
that a format _has_ an alpha channel; it cannot say that any pixel used one,
and plenty of files carry one without ever using it — every screenshot saved as
RGBA, both of this repository's own PNG assets. Warning that their transparency
was flattened would be false, and false warnings are how a true one gets
ignored on the day it matters.

So the drawn alpha is read back before the matte goes on. That costs one
readback of a canvas that had to be allocated anyway, and only for a source
that declares alpha on its way to a JPEG. It is arranged so nothing is drawn
twice: the image goes down first, its alpha is read, and then the white goes
_behind_ it with `destination-over`. Reading at the output size rather than the
source size loses nothing — a downscale averages a transparent pixel into its
neighbours, and an average including anything below 255 is itself below 255, so
shrinking makes transparency easier to detect rather than harder. If the
readback is refused the header's answer stands, because over-warning is the
safe direction.

### Metadata is stripped, and the tool says what it removed

Re-encoding through a canvas carries the pixels and nothing else. That has
always been true here; what is new is that it is a **stated guarantee** rather
than a side effect, that the tool tells you what it dropped, and that the
promise is asserted on the output bytes.

This is the decision this app's premise makes sharpest. A tool that silently
keeps GPS coordinates in an image somebody is about to post is a different
product from one that silently removes them, and both are different from one
that says what it did. Only the third is defensible when the whole pitch is
that nothing leaves your machine — stripping the data and _not mentioning it_
is still asking to be trusted rather than showing your working.

So `inspect.ts` reads the container before anything is decoded and names what
it finds: `EXIF`, `GPS location`, `ICC colour profile`, `XMP`, `IPTC`, `Text
comments`. Location is promoted from a list item to its own warning, because it
is the one with consequences. `info.to.metadata` is `[]` on every output, and
the cross-browser check greps the produced file for the EXIF header and for a
comment it planted in the source.

There is no option to keep it. A "preserve metadata" toggle would have to
re-inject the block by hand after encoding, which is a metadata writer's worth
of code in a tool that converts images — and the default would still have to be
off.

### Orientation is applied, not preserved

A phone photograph is very often stored sideways with an EXIF flag saying which
way is up. The two ways to get this wrong are symmetrical: drop the flag and
keep the pixels, and you hand back a sideways photograph; keep the flag and
re-encode through a canvas, and it gets rotated twice.

`createImageBitmap` is asked for `imageOrientation: 'from-image'` explicitly.
That is the spec default now and both Firefox and WebKit honour it — but the
option exists because the default used to be `'none'`, and asking removes the
question. A browser that has never heard of the dictionary member rejects with
a `TypeError`, and that one error retries without it; a genuine decode failure
does not retry.

Checked end to end: an orientation-6 JPEG that is 4×2 with a red left half
comes out 2×4 with a red top half, and carries no `Exif` bytes.

### The caps are 16,384 px and 50 megapixels

Both are needed and neither is sufficient — 60000×100 blows the per-axis limit
while staying under the pixel budget, and 8000×8000 does the reverse.

50 megapixels is about 200 MB of RGBA, which is a large but survivable
allocation in a browser tab. It is above every consumer camera and above every
phone except in a dedicated high-resolution mode; a 200 MP phone shot
(16320×12240) is refused, and that is the intended trade rather than an
oversight. The error says the limit is on pixels rather than on file size, and
says that resizing will not help — because the cost is paid decoding the
original, so "just make it smaller" is advice that cannot work.

## Decompression bombs

A 40 kB PNG can decode to a 60000×60000 canvas. That is roughly 14 GB of RGBA.

So the engine's `maxInputBytes` is **no protection at all** here — the dangerous
number is the pixel count, and it is only knowable after a header has been read.

### The guard used to run in the wrong place

It used to check `bitmap.width` after `createImageBitmap` resolved, and refuse
before allocating a canvas. That reads as safe and is not. Measured in
`pnpm check:browsers`:

> A 48 kB 1-bit greyscale PNG declaring 20000×20000 **decodes successfully** in
> about 2,000 ms in both Firefox and WebKit. By the time its dimensions could be
> read, the browser had already committed 1.6 GB of RGBA.

The canvas was never the expensive allocation. The decode was, and the old guard
ran after it.

### Where it runs now

[`inspect.ts`](inspect.ts) reads the dimensions out of the container — PNG's
`IHDR`, JPEG's `SOFn`, GIF's screen and frame descriptors, WebP's `VP8X`,
`VP8` keyframe or `VP8L` bit stream — and the limits are applied to those,
before `createImageBitmap` is called at all.

| Limit           | Value      | Catches                            |
| --------------- | ---------- | ---------------------------------- |
| `MAX_DIMENSION` | 16,384     | One enormous axis (60000×100).     |
| `MAX_PIXELS`    | 50,000,000 | Two merely large ones (8000×8000). |

Two rules keep this honest:

**A header may only ever refuse a file, never approve one.** A parser bug that
read a plausible-but-wrong _small_ number would otherwise wave a bomb straight
through, and one that read a wrong _large_ number would refuse a photograph. So
only the upper bounds are applied to header numbers, and the post-decode check
is still there as a backstop for a header that lies. `image.test.ts` asserts
both halves: a bomb whose header understates its size is still refused, and a
PNG with no readable `IHDR` still reaches the decoder.

**A GIF's frames are not obliged to fit inside its declared screen.** A file can
announce a 1×1 logical screen and then hold a 20000×20000 image descriptor, so
the size taken from a GIF is the largest extent any frame reaches, not the
screen descriptor.

The browser check proves the timing rather than trusting it: the bomb is refused
in **~230 ms**, against ~2,000 ms for the decode alone.

## The format comes from the bytes

A file's declared `type` comes from the operating system's extension mapping and
is trivially wrong — rename `payload.pdf` to `photo.png` and the browser will
report `image/png`. [`lib/sniff.ts`](../../lib/sniff.ts) reads the magic bytes
instead, and anything that is not PNG, JPEG, GIF or WebP is refused by name
before a decoder sees it.

The error says the check was on the bytes, because the user is looking at a file
their operating system is calling an image.

The WebP signature used to be the four bytes `WEBP` at offset 8 and nothing
else, so any file at all with those bytes in that position was announced as a
WebP image. It now requires the `RIFF` container they belong to, with the
four length bytes between them matched as wildcards.

**AVIF and SVG are deliberately absent.** AVIF decode support is uneven enough
that a silent failure would be likelier than a conversion; SVG is a document
format with script and external-reference semantics, and feeding one to a canvas
is not a decision to make casually in a tool whose whole premise is that nothing
leaves the machine.

## Worker, with a documented main-thread fallback

The fast path is `OffscreenCanvas` + `convertToBlob` inside the worker, so a
40-megapixel decode never touches the main thread.

`OffscreenCanvas` is not universal: Safari shipped it in 16.4, Firefox in 105.
A tool cannot discover this for itself, because by the time its `run` executes
it is **already** in a worker and cannot move. So the need is declared eagerly,
in the manifest:

```ts
requiresOffscreenCanvas: true;
```

`resolveExecutionMeta` in the engine reads it and downgrades the tool to
`strategy: 'main'` when the API is missing, where `convert.ts` falls back to a
DOM `<canvas>` and `toBlob`. This follows the precedent already set by
`requiresWasm`: a capability the tool needs is metadata, not a runtime probe.

The two branches are genuinely different APIs — `convertToBlob` returns a
promise, `toBlob` takes a callback — which is why they are not unified behind
one variable. Everything that decides what the pixels _are_ lives in one
`prepareContext`, so the two cannot drift in what they paint, and that is
asserted rather than assumed:

- `image.test.ts` runs the same conversion down both branches and asserts the
  recorded drawing sequences are **identical**, call for call.
- `pnpm check:browsers` runs the whole pixel suite in Firefox, which has
  `OffscreenCanvas`, and in Playwright's WebKit, which **has none at all** — so
  the two paths are each held to the same colour, orientation and transparency
  assertions in a real engine, for free.

## Other things that would otherwise be quiet failures

- **A tool may not throw across the worker boundary.** Every step of the encode
  can throw rather than return: `new OffscreenCanvas` on an allocation failure,
  and — measured — `convertToBlob` with `IndexSizeError` on a canvas with a zero
  axis in Firefox. None of it used to be caught. It is all a `ToolResult` now.
- **A decode can produce no pixels.** `checkDimensions` had an upper bound only,
  so a malformed file that decoded to 0×0 reached the canvas, which throws in
  Firefox and hands back a null blob in WebKit.
- **Some browsers silently substitute PNG** for a format they cannot encode.
  Measured: every unrecognised target — `image/gif`, `image/avif`, outright
  nonsense — comes back as `image/png` in both engines. The produced blob's type
  is checked against the requested one.
- **Scaling never rounds an edge to zero.** A 4000×1 banner scaled to a 512 px
  long edge would otherwise ask for a zero-height canvas, which throws.
- **`instanceof Error` is the wrong question about a DOMException.** It is true
  in Firefox, WebKit and Node, and false under jsdom — which is how the missing
  detail on an `IndexSizeError` was found. It is also false for anything that
  crossed a realm boundary, which a worker is. Errors are described by reading
  `name` and `message`.
- **The bitmap is closed in a `finally`.** Decoded pixels live outside the JS
  heap and the collector is in no hurry.
- **The input is decoded from a Blob copy**, so the caller's buffer stays valid
  and one image can fan out to several nodes on the canvas.
- **A download is never named `.png`.** `.gitignore` has its only dot stripped
  by the extension regex, leaving an empty base — and an empty filename slips
  past a `??` because `''` is not nullish. Both now fall back to `image`.

## Options

| Option       | Effect                                                                   |
| ------------ | ------------------------------------------------------------------------ |
| Convert to   | WebP, JPEG or PNG.                                                       |
| Quality      | 0.1–1. JPEG and WebP only; the control is hidden when the target is PNG. |
| Longest edge | 0 keeps the original size. A ceiling, not a target — it never enlarges.  |

**What quality means, measured.** It is passed straight to the browser's
encoder, so the mapping is the encoder's rather than ours, and it is not the
same in each. Firefox's WebP encoder switches to **lossless** at exactly 1.0 —
a 64×64 image comes back with a maximum channel error of 0 and at a fifth of
the size it had at 0.5. JPEG behaves as expected everywhere: 0.3 produced
2.7 kB where 0.95 produced 3.6 kB for the same source. PNG ignores the value
entirely, to the byte.

The floor is 0.1 rather than 0 because a JPEG at 0 is not a smaller picture, it
is a different one.

## Outputs

`output` is the encoded image as bytes, with a filename derived from the
input's.

`info` reports both formats, both sets of dimensions, both sizes and the signed
percentage change — `1.2 MB → 460.3 kB (-62.4%)` — plus, for the source, whether
it carried transparency, how many frames it had, and what metadata was in it.
`from.hasAlpha` is the measured answer where anything measured it and the
container's declaration otherwise, which is why an opaque RGBA screenshot
reports `false`.

It also carries `notes`, the same `{ level, title, body }` shape the regex tool
uses. Every note is a change to the image the user did not ask for:

| Note                           | Level  | When                                                     |
| ------------------------------ | ------ | -------------------------------------------------------- |
| Transparency flattened         | `warn` | The target is JPEG and a pixel really was transparent.   |
| Only the first frame was kept  | `warn` | The source is an animated GIF, animated WebP or APNG.    |
| GPS location was removed       | `warn` | The source's EXIF carries a GPS IFD pointer.             |
| Metadata was removed           | `info` | Any other metadata was found.                            |
| Quality does not apply         | `info` | The target is PNG.                                       |
| Re-encoding costs a generation | `info` | The source is already lossily compressed.                |
| The image was not enlarged     | `info` | A longest edge was set that the image is already inside. |

**Warn-level titles are repeated in `summary`.** The notes list is below the
fold in the JSON view, and a caveat nobody scrolls to has not been said.

## Known limitations

**Colour management is the browser's, and the browsers disagree.** A PNG
carrying a `gAMA` chunk decodes to different pixels in different engines, and
there is nothing this tool can do about it: the conversion happens inside
`createImageBitmap`, before any code here runs.

> Reproduction: a 4×4 PNG holding `rgb(128, 64, 192)` with a `gAMA` chunk of
> 100000 (gamma 1.0). Firefox ignores the chunk and decodes `(128, 64, 192)`.
> WebKit applies it and decodes `(186, 136, 224)`. A `cHRM` chunk on its own
> changes nothing in either.

The practical consequence is that a colour-managed source — a wide-gamut
photograph, a scan with an embedded profile — converts to sRGB, and _which_
sRGB depends on the browser. There is no workaround short of shipping a decoder
and a colour engine, which is not a reasonable thing for this tool to contain.
An embedded ICC profile is at least reported in `info.from.metadata`, so a
colour shift has a visible explanation rather than being a mystery.

**An animated source is flattened, and cannot be anything else.** None of the
three targets is written as an animation here. The warning names the frame
count; it is not a fixable loss.

**The frame count is capped at 1,000.** Past that the walk stops and the count
is reported as 1,000. It is only ever used to say how many frames were
discarded, so the difference between 1,000 and 4,000 buys nothing and the walk
over a hostile file is worth avoiding.

**A JPEG's dimensions are read from the first `SOFn` marker only.** A
multi-picture JPEG (the MPF extension some cameras write) is treated as its
first image, which is also what every browser decoder does.

## Tests

**In `image.test.ts` and `inspect.test.ts`** — everything that can be decided
without a decoder. The header parsers against every format and against
deliberate rubbish; the size guards and the order they run in; the scaling
arithmetic; the notes; the filename derivation; the error paths. And, through a
**recording canvas**, the drawing sequence itself: jsdom has no 2D context, but
it can capture the calls, and whether a white matte was laid down before the
draw is a question about the calls. That is also what lets the OffscreenCanvas
and DOM-canvas branches be asserted equal.

**In `scripts/cross-browser-check.mjs`** — everything that needs real pixels.
Each conversion goes through the whole product, and the produced file is
**decoded again in the page** and compared against the colours that went in:

- a PNG round trip reproduces all sixteen swatch colours with a worst channel
  error of **0**;
- WebP and JPEG stay within 3 and 8 levels respectively;
- transparency converted to JPEG comes back `rgb(255, 255, 255)`, and to WebP
  comes back with `alpha 0`;
- a sideways photograph comes out upright, with its axes swapped and its EXIF
  gone;
- an animated GIF comes out as its first frame, with the warning attached;
- 512 px of one-pixel stripes reduced to 64 px comes back **uniform grey**
  (`127–127`), which is what area averaging looks like and point sampling does
  not;
- a decompression bomb is refused in ~230 ms;
- and two **real files** — this repository's own 1200×630 screenshot and
  512×512 logo, written by a real encoder across several `IDAT` chunks — are
  parsed to the dimensions their encoder wrote, and are not warned about for
  transparency their alpha channels never carry. Those matter because the
  header parser now decides whether a file is opened at all, and a fixture
  built by the same hand that parses it cannot catch a parser that misreads
  what a browser actually writes.

### What is not asserted anywhere

Two things, both stated rather than quietly missing.

**Whether a photograph looks like the photograph.** Everything above compares
known colours at known coordinates. That catches inversion, matte colour,
rotation, aliasing and gross colour shift, and it does not catch subtle
perceptual damage — chroma subsampling on saturated red text, ringing around a
hard edge in a screenshot, banding in a smooth sky. Judging those needs an eye.

**Colours through a real colour-managed pipeline.** The engines disagree, as
above, so there is no single expected value to assert against. The divergence is
documented with a reproduction instead.
