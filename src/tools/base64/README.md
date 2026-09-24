# Base64

Encode text or files to base64, and decode base64 back to bytes.

## Why this tool exists in the reference set

It stresses two parts of the type system that nothing else would:

- **The binary path.** Decoding produces real `Uint8Array` bytes, not a string
  pretending to be bytes. A file can go in and a file can come out — on the
  canvas as well as on the tool page, since
  [a node's input can be a file](../../../docs/architecture.md#a-file-as-an-input).
- **The multi-type input port.** One port accepts `text` **or** `bytes`, so the
  run function has to narrow on the value's tag before it can touch a payload.
  If the narrowing is removed, the tool stops compiling.

## Why the output port is called Result

Every other converter in the set names its first output for the value it
carries — Converted, Digest, Decoded — and this one cannot. What it carries
depends on the mode: base64 text when encoding, decoded bytes when decoding.
Any specific name would be wrong half the time, and "Encoded or decoded" is
both longer than the 84px label box and less clear than the port's
description, which the Ports panel on the tool page shows. `Result` is what
`regex-tester` calls a value whose kind depends on a setting, for the same
reason.

**It was `Output` until round three**, and the rename was forced by the port
beside it rather than chosen. The runner prints a port's label only when a tool
has more than one output; adding a second made the word "Output" appear under a
panel heading that says "Output", which is the exact duplication
`ToolRunner.layout.test.tsx` exists to prevent - and which that test caught. A
label is a word for a person and free to improve; the id is still `output`, so
no share link, saved canvas or preset moved.

## The second output, and what it is for

`QQ==` and `QR==` both decode to the byte `A`: the final character of a partial
group carries bits that no byte of the result uses, and this decoder ignores
them rather than requiring them to be zero. RFC 4648 §3.5 permits either and
most decoders do the same, so the BYTES are right - and `base64 → bytes →
base64` is therefore not the identity on the TEXT.

That matters because the input is usually a signature or a digest somebody is
comparing. The `Report` port names the character as written and the canonical
spelling of the same bytes, so a string that does not survive a round trip here
is one whose own spelling was not canonical - a fact about the data rather than
about this tool. Encoding reports nothing: every byte has exactly one canonical
spelling, which is the whole asymmetry between the two directions.

That union is also why base64 is the tool that can still deliver a value a
downstream port refuses. Since the
[port audit](../../../docs/architecture.md#the-port-set) every port that reads
a document accepts `bytes`, so the only ports left that can refuse a decoded
value at runtime are the two that take a short literal: a JWT and a colour.
`base64 → jwt` is legal to draw and, in decode mode, delivers bytes to a
text-only port — which `validateInputs` refuses on the node that received it,
naming the type it got. The same happens the other way round in encode mode:
`image-convert` and `video-remux` take only `bytes`, so `base64 → image-convert`
is legal to draw and refused at runtime when what arrives is base64 text. This
paragraph used to say the two short literals were the only such ports.

## Approach

Encoding and decoding are written directly against bytes rather than built on
`btoa`/`atob`.

`btoa` operates on a "binary string" in which every code unit must be ≤ 0xFF, so
`btoa('héllo')` throws — the classic broken-emoji bug. Text is instead run
through `TextEncoder` first, which produces UTF-8 bytes, and every code point
survives including astral-plane characters like `𝄞`.

The decoder uses a single 128-entry lookup table with **both** alphabets loaded,
and `-`/`_` mapped to the same values as `+`/`/`. Decoding is therefore
alphabet-agnostic: pasting a URL-safe JWT segment works without first telling
the tool it is URL-safe, which is what people actually expect.

## Options

| Option            | Effect                                                       |
| ----------------- | ------------------------------------------------------------ |
| Mode              | Encode or decode.                                            |
| URL-safe alphabet | Emit `-` and `_` instead of `+` and `/`.                     |
| Padding           | Append `=` so the length is a multiple of four.              |
| Wrap at column    | Insert line breaks. 0 for one line, 64 for PEM, 76 for MIME. |

## Edge cases handled

- **Empty input** encodes to an empty string and decodes to zero bytes.
- **Full Unicode**, including combining marks and astral-plane characters.
- **Whitespace in the input** is ignored when decoding, so wrapped MIME blocks
  and PEM bodies paste in directly. CRLF and LF are both fine.
- **Missing padding** is accepted; `Zg` decodes the same as `Zg==`.
- **Either alphabet** is accepted when decoding, regardless of the option.
- **A UTF-8 BOM** in the input is data, and is preserved byte-for-byte.
- **Invalid characters** produce a `parse-error` naming the character and its
  exact line and column, rather than silently skipping it.
- **Truncated input** (a group of one leftover character, which can never encode
  a whole byte) is rejected rather than producing a partial result.
- **Data after the padding** and **more than two `=`** are both rejected.
- **Decoded bytes that are not valid UTF-8** still decode successfully — the
  result is bytes. Only the on-screen _preview_ shows U+FFFD replacements, and
  the download gives you the real bytes.
- **Lone surrogates** in input text cannot round-trip: `TextEncoder` replaces an
  unpaired surrogate with U+FFFD, because UTF-8 has no encoding for one. This is
  a property of UTF-8, not of this tool.

## Limits

The tool declares a 32 MB input ceiling and runs in a Web Worker. Encoding a
large file on the main thread would drop frames, so `strategy: 'worker'` is a
declared property of the tool rather than a decision made by the caller.

## Tests

`base64.test.ts` covers the RFC 4648 test vectors, each edge case above but
the last — no test feeds in a lone surrogate, and combining marks are reached
only through the text round-trip property — and three property-based
invariants: byte round-trip for arbitrary `Uint8Array`
inputs under every option combination, text round-trip for arbitrary well-formed
strings, and the guarantee that output only ever uses the declared alphabet.
