# Image

Convert and resize images between PNG, JPEG and WebP.

## Decompression bombs

A 40 kB PNG can decode to a 60000×60000 canvas. That is roughly 14 GB of RGBA.

So the engine's `maxInputBytes` is **no protection at all** here — the dangerous
number is the pixel count, and it is only knowable after the header has been
read. The guard is therefore applied the moment the bitmap's dimensions exist
and **before any canvas is allocated**:

| Limit           | Value      | Catches                            |
| --------------- | ---------- | ---------------------------------- |
| `MAX_DIMENSION` | 16,384     | One enormous axis (60000×100).     |
| `MAX_PIXELS`    | 50,000,000 | Two merely large ones (8000×8000). |

Both are needed: either one alone lets a bomb through. `image.test.ts` stubs
`createImageBitmap` to return a 60000×60000 bitmap and asserts that the
conversion is refused **and that no canvas was constructed**.

## The format comes from the bytes

A file's declared `type` comes from the operating system's extension mapping and
is trivially wrong — rename `payload.pdf` to `photo.png` and the browser will
report `image/png`. `lib/sniff.ts` reads the magic bytes instead, and anything
that is not PNG, JPEG, GIF or WebP is refused by name before a decoder sees it.

The error says the check was on the bytes, because the user is looking at a file
their operating system is calling an image.

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
one variable.

## Other things that would otherwise be quiet failures

- **JPEG has no alpha.** Without a white fill first, a transparent PNG converts
  to JPEG with black where the transparency was, which looks like corruption.
- **Some browsers silently substitute PNG** for a format they cannot encode. The
  produced blob's type is checked against the requested one, and a mismatch is
  reported rather than handing over a `.webp` file that is really a PNG.
- **Scaling never rounds an edge to zero.** A 4000×1 banner scaled to a 512 px
  long edge would otherwise ask for a zero-height canvas, which throws.
- **The bitmap is closed in a `finally`.** Decoded pixels live outside the JS
  heap and the collector is in no hurry.
- **The input is decoded from a Blob copy**, so the caller's buffer stays valid
  and one image can fan out to several nodes on the canvas.

## Options

| Option       | Effect                                                |
| ------------ | ----------------------------------------------------- |
| Convert to   | WebP, JPEG or PNG.                                    |
| Quality      | 0.1–1. JPEG and WebP only; PNG is lossless.           |
| Longest edge | 0 keeps the original size. Aspect ratio is preserved. |

## Outputs

`output` is the encoded image as bytes, with a filename derived from the input's.
`info` reports both formats, both sets of dimensions, both sizes and the signed
percentage change — `1.2 MB → 460.3 kB (-62.4%)`, which is the number people
actually want from a converter.

## Tests

`image.test.ts` covers the sniffing refusals, both dimension limits
independently, the bomb rejection with a stubbed decoder, the scaling maths
including the zero-edge case, and the size reporting. The encode path itself
needs a real canvas and is covered by the manual cross-browser check rather than
by a jsdom test that would only be testing a stub.
